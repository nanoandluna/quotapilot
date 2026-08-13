import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import {
  budgetReservations,
  budgetAlerts,
  modelRegistry,
  providerBudgets,
  providerConnections,
  researchTasks,
  routeDecisions,
  schedulerSettings,
  taskAttempts,
  usageEvents,
  usageImportBatches,
  workspaceMembers,
  workspaces,
  type CapabilityMatrix,
  type TaskRequirements,
  type UsageTokenPayload,
} from "../drizzle/schema";
import { getDb } from "./db";
import { getProviderCredentialStatus } from "./providerCredentials";
import { storagePut } from "./storage";

export type BudgetState = "GREEN" | "YELLOW" | "ORANGE" | "DRAIN_PROTECTION" | "RED";
export type WorkspaceRole = "owner" | "admin" | "researcher" | "reviewer" | "viewer";

type ModelSeed = {
  modelId: string;
  displayName: string;
  input: string;
  output: string;
  cacheRead?: string;
  scarcity: string;
  concurrency: number;
  capability: CapabilityMatrix;
};

const capability = (partial: Partial<CapabilityMatrix>): CapabilityMatrix => ({
  code: 6,
  reasoning: 6,
  longContext: 6,
  vision: 0,
  toolUse: 5,
  chinese: 6,
  research: 6,
  agent: 5,
  speed: 6,
  reliability: 7,
  ...partial,
});

const OPEN_CODE_MODELS: ModelSeed[] = [
  { modelId: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", input: "0.14", output: "0.28", cacheRead: "0.0028", scarcity: "0.200", concurrency: 6, capability: capability({ code: 7, reasoning: 6, longContext: 8, speed: 10, reliability: 8 }) },
  { modelId: "gpt-5.6-luna", displayName: "GPT 5.6 Luna", input: "0.20", output: "1.20", cacheRead: "0.020", scarcity: "0.350", concurrency: 5, capability: capability({ code: 7, reasoning: 7, longContext: 8, speed: 9, reliability: 8 }) },
  { modelId: "kimi-k2.7-code", displayName: "Kimi K2.7 Code", input: "0.95", output: "4.00", cacheRead: "0.190", scarcity: "0.500", concurrency: 3, capability: capability({ code: 9, reasoning: 8, longContext: 8, toolUse: 8, agent: 8, reliability: 8 }) },
  { modelId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", input: "0.435", output: "0.870", cacheRead: "0.003625", scarcity: "0.700", concurrency: 2, capability: capability({ code: 9, reasoning: 9, longContext: 10, toolUse: 9, research: 9, agent: 9, reliability: 9 }) },
  { modelId: "grok-4.5", displayName: "Grok 4.5", input: "2.00", output: "6.00", cacheRead: "0.300", scarcity: "1.000", concurrency: 1, capability: capability({ code: 9, reasoning: 9, longContext: 9, vision: 8, toolUse: 9, research: 9, agent: 10, reliability: 8 }) },
  { modelId: "kimi-k3", displayName: "Kimi K3", input: "3.00", output: "15.00", cacheRead: "0.300", scarcity: "1.000", concurrency: 1, capability: capability({ code: 8, reasoning: 9, longContext: 10, research: 9, agent: 9, reliability: 8 }) },
  { modelId: "glm-5.2", displayName: "GLM-5.2", input: "1.40", output: "4.40", cacheRead: "0.260", scarcity: "0.750", concurrency: 2, capability: capability({ code: 8, reasoning: 8, chinese: 10, research: 8, reliability: 8 }) },
  { modelId: "minimax-m3", displayName: "MiniMax M3", input: "0.30", output: "1.20", cacheRead: "0.060", scarcity: "0.350", concurrency: 4, capability: capability({ code: 7, reasoning: 7, speed: 8, reliability: 7 }) },
];

const PHASE_RESERVE_RATIO = {
  development: 0.1,
  paper: 0.2,
  final_submission: 0.3,
} as const;

const ROLE_WEIGHT: Record<WorkspaceRole, number> = {
  viewer: 0,
  reviewer: 1,
  researcher: 2,
  admin: 3,
  owner: 4,
};

export const asNumber = (value: string | number | null | undefined): number => Number(value ?? 0);

export function calculateBudgetState(input: {
  limitUsd: number;
  consumedUsd: number;
  reservedUsd: number;
  dynamicReserveUsd: number;
  burnRates: number[];
  resetAt: Date;
  now?: Date;
}): { availableUsd: number; forecastExhaustionAt: Date | null; state: BudgetState } {
  const now = input.now ?? new Date();
  const availableUsd = Math.max(0, input.limitUsd - input.consumedUsd - input.reservedUsd);
  const worstBurn = Math.max(0, ...input.burnRates);
  const forecastExhaustionAt = worstBurn > 0 ? new Date(now.getTime() + (availableUsd / worstBurn) * 3_600_000) : null;
  const spendableBeforeReserve = Math.max(0, availableUsd - input.dynamicReserveUsd);
  const ratio = input.limitUsd > 0 ? availableUsd / input.limitUsd : 0;

  if (availableUsd <= 0) return { availableUsd, forecastExhaustionAt, state: "RED" };
  if (forecastExhaustionAt && forecastExhaustionAt < input.resetAt) {
    return { availableUsd, forecastExhaustionAt, state: "DRAIN_PROTECTION" };
  }
  if (spendableBeforeReserve <= 0 || ratio <= 0.2) return { availableUsd, forecastExhaustionAt, state: "ORANGE" };
  if (ratio <= 0.4) return { availableUsd, forecastExhaustionAt, state: "YELLOW" };
  return { availableUsd, forecastExhaustionAt, state: "GREEN" };
}

export function getAdmissionDecision(input: {
  priority: "P0" | "P1" | "P2" | "P3";
  routeMode: "strict" | "balanced" | "emergency";
  estimatedCostUsd: number;
  availableUsd: number;
  dynamicReserveUsd: number;
  budgetState: BudgetState;
}): "ADMIT" | "RESERVE" | "MIGRATE" | "QUEUE" | "HOLD" {
  if (input.availableUsd < input.estimatedCostUsd || input.budgetState === "RED") return "HOLD";
  if (input.priority === "P0" || input.priority === "P1") return "RESERVE";
  const spendableAboveReserve = input.availableUsd - input.dynamicReserveUsd;
  if (input.budgetState === "DRAIN_PROTECTION" || spendableAboveReserve < input.estimatedCostUsd) {
    return input.routeMode === "emergency" && input.priority === "P3" ? "MIGRATE" : "QUEUE";
  }
  if (input.budgetState === "ORANGE" && (input.priority === "P2" || input.priority === "P3")) return "MIGRATE";
  return "ADMIT";
}

export type RoutingModel = {
  modelId: string;
  displayName: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  scarcityFactor: number;
  maxConcurrency: number;
  capability: CapabilityMatrix;
};

export function scoreCandidateModels(requirements: TaskRequirements, models: RoutingModel[]) {
  const requiredCapabilities = (Object.entries(requirements) as Array<[keyof TaskRequirements, unknown]>).filter(([key, value]) => key in capability({}) && typeof value === "number" && value > 0) as Array<[keyof CapabilityMatrix, number]>;
  return models
    .filter(model => model.maxConcurrency > 0)
    .filter(model => !requirements.requiresVision || model.capability.vision > 0)
    .filter(model => !requirements.requiresToolUse || model.capability.toolUse > 0)
    .filter(model => requiredCapabilities.every(([key, required]) => model.capability[key] >= required))
    .map(model => {
      const capabilityFit = requiredCapabilities.length
        ? requiredCapabilities.reduce((total, [key, required]) => total + Math.min(1, model.capability[key] / Math.max(1, required)), 0) / requiredCapabilities.length
        : 0.6;
      const quality = (capabilityFit * 0.55) + ((model.capability.reliability / 10) * 0.25) + ((model.capability.speed / 10) * 0.1);
      const price = model.inputPerMillionUsd + model.outputPerMillionUsd;
      const score = (quality * 100) - (price * 1.5) - (model.scarcityFactor * 12);
      return { ...model, score: Number(score.toFixed(3)), reason: `能力满足硬约束；可靠性 ${model.capability.reliability}/10，稀缺性 ${model.scarcityFactor.toFixed(2)}。` };
    })
    .sort((left, right) => right.score - left.score);
}

export function resolveTaskRouting(requirements: TaskRequirements, models: RoutingModel[], requestedModelId?: string) {
  const candidates = scoreCandidateModels(requirements, models);
  return {
    candidates,
    recommendedModelId: candidates[0]?.modelId ?? requestedModelId,
    blockedByCapability: candidates.length === 0,
  };
}

function describeRouteDecision(decision: "ADMIT" | "RESERVE" | "MIGRATE" | "QUEUE" | "HOLD") {
  if (decision === "RESERVE") return { reason: "P0/P1 任务通过共享预算检查，需先锁定可预估成本。", action: "reserve" as const, human: false };
  if (decision === "MIGRATE") return { reason: "当前窗口接近动态保护仓；非关键任务应迁移到能力合格、成本更低的模型。", action: "migrate" as const, human: true };
  if (decision === "QUEUE") return { reason: "动态保护仓或 DRAIN_PROTECTION 正在保护 P0/P1 连续性，任务需等待预算恢复。", action: "queue" as const, human: false };
  if (decision === "HOLD") return { reason: "共享窗口余额不足以覆盖任务预估成本，不能静默降级。", action: "manual_handoff" as const, human: true };
  return { reason: "能力、成本和共享预算均满足当前任务准入条件。", action: "run" as const, human: false };
}

export function parseUsageImport(content: string, format: "csv" | "json"): Array<{
  provider: string;
  modelId: string;
  tokens: UsageTokenPayload;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  occurredAt: Date;
  externalRef?: string;
}> {
  const rawRows: Record<string, unknown>[] = format === "json" ? parseJsonRows(content) : parseCsvRows(content);
  if (!rawRows.length) throw new Error("未检测到可导入的用量记录。");

  return rawRows.map((row, index) => {
    const value = (keys: string[]) => {
      const key = keys.find(candidate => row[candidate] !== undefined && row[candidate] !== "");
      return key ? row[key] : undefined;
    };
    const provider = String(value(["provider", "provider_id"]) ?? "opencode_go");
    const modelId = String(value(["model_id", "model", "modelId"]) ?? "").trim();
    const occurredRaw = value(["occurred_at", "timestamp", "occurredAt", "time"]);
    const occurredAt = new Date(String(occurredRaw ?? ""));
    const actualCost = value(["actual_cost_usd", "actual_cost", "cost_usd", "cost"]);
    const estimatedCost = value(["estimated_cost_usd", "estimated_cost"]);

    if (!modelId) throw new Error(`第 ${index + 1} 行缺少 model_id。`);
    if (Number.isNaN(occurredAt.getTime())) throw new Error(`第 ${index + 1} 行的 occurred_at 无法解析。`);

    const parsedActual = actualCost === undefined ? undefined : Number(actualCost);
    const parsedEstimate = estimatedCost === undefined ? 0 : Number(estimatedCost);
    if (Number.isNaN(parsedEstimate) || (parsedActual !== undefined && Number.isNaN(parsedActual))) {
      throw new Error(`第 ${index + 1} 行的成本字段必须为数字。`);
    }

    return {
      provider,
      modelId,
      tokens: {
        inputTokens: numeric(value(["input_tokens", "inputTokens"])),
        outputTokens: numeric(value(["output_tokens", "outputTokens"])),
        cacheReadTokens: numeric(value(["cache_read_tokens", "cacheReadTokens"])),
        cacheWriteTokens: numeric(value(["cache_write_tokens", "cacheWriteTokens"])),
      },
      estimatedCostUsd: parsedEstimate,
      actualCostUsd: parsedActual,
      occurredAt,
      externalRef: String(value(["external_ref", "externalRef", "id"]) ?? "").trim() || undefined,
    };
  });
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseJsonRows(content: string): Record<string, unknown>[] {
  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { events?: unknown }).events)) {
    return (parsed as { events: Record<string, unknown>[] }).events;
  }
  throw new Error("JSON 需为用量记录数组，或包含 events 数组的对象。");
}

function parseCsvRows(content: string): Record<string, unknown>[] {
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV 需要包含表头和至少一行数据。");
  const headers = splitCsvLine(lines[0]).map(item => item.trim());
  return lines.slice(1).map(line => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

export async function requireWorkspaceRole(workspaceId: number, userId: number, minimumRole: WorkspaceRole = "viewer") {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
  const membership = (await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).limit(1))[0];
  if (!membership || ROLE_WEIGHT[membership.role] < ROLE_WEIGHT[minimumRole]) {
    throw new TRPCError({ code: "FORBIDDEN", message: "当前工作区角色没有执行此操作的权限。" });
  }
  return membership;
}

export async function ensurePersonalWorkspace(user: { id: number; name?: string | null }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });

  const currentMembership = (await db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, user.id)).limit(1))[0];
  if (currentMembership) return currentMembership.workspaceId;

  const slug = `research-${user.id}`;
  await db.insert(workspaces).values({ name: `${user.name || "研究"}的 QuotaPilot`, slug, createdByUserId: user.id }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
  const workspace = (await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1))[0];
  if (!workspace) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "无法初始化研究工作区。" });

  await db.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: "owner" }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
  await seedWorkspaceDefaults(workspace.id);
  return workspace.id;
}

async function seedWorkspaceDefaults(workspaceId: number) {
  const db = await getDb();
  if (!db) return;
  const credentials = getProviderCredentialStatus();
  const connectionSeeds = [
    { provider: "opencode_go" as const, displayName: "OpenCode Go · 共享池", syncMode: "scheduled" as const, secretState: credentials.opencodeGo === "configured" ? "configured" as const : "not_configured" as const },
    { provider: "openai_api" as const, displayName: "OpenAI API · 组织用量", syncMode: "scheduled" as const, secretState: credentials.openaiAdmin === "configured" ? "configured" as const : "not_configured" as const },
    { provider: "chatgpt_plus_manual" as const, displayName: "ChatGPT Plus · 人工救援", syncMode: "manual" as const, secretState: "not_configured" as const },
  ];

  for (const seed of connectionSeeds) {
    await db.insert(providerConnections).values({
      workspaceId,
      provider: seed.provider,
      displayName: seed.displayName,
      syncMode: seed.syncMode,
      secretState: seed.secretState,
      connectionState: seed.secretState === "configured" ? "connected" : "pending_configuration",
    }).onDuplicateKeyUpdate({ set: { secretState: seed.secretState, updatedAt: new Date() } });
  }

  const goConnection = (await db.select().from(providerConnections).where(and(eq(providerConnections.workspaceId, workspaceId), eq(providerConnections.provider, "opencode_go"))).limit(1))[0];
  if (goConnection) {
    const windows = [
      { window: "five_hour" as const, limitUsd: "12.0000", resetAt: new Date(Date.now() + 5 * 60 * 60 * 1000) },
      { window: "weekly" as const, limitUsd: "30.0000", resetAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
      { window: "monthly" as const, limitUsd: "60.0000", resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    ];
    for (const item of windows) {
      await db.insert(providerBudgets).values({ workspaceId, providerConnectionId: goConnection.id, ...item }).onDuplicateKeyUpdate({ set: { limitUsd: item.limitUsd, resetAt: item.resetAt, updatedAt: new Date() } });
    }
  }

  for (const model of OPEN_CODE_MODELS) {
    await db.insert(modelRegistry).values({
      provider: "opencode_go",
      modelId: model.modelId,
      displayName: model.displayName,
      inputPerMillionUsd: model.input,
      outputPerMillionUsd: model.output,
      cacheReadPerMillionUsd: model.cacheRead,
      scarcityFactor: model.scarcity,
      maxConcurrency: model.concurrency,
      capability: model.capability,
      source: "workspace_policy",
    }).onDuplicateKeyUpdate({ set: { displayName: model.displayName, capability: model.capability, scarcityFactor: model.scarcity, maxConcurrency: model.concurrency, updatedAt: new Date() } });
  }

  await db.insert(schedulerSettings).values({ workspaceId }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
}

async function createUnacknowledgedAlert(input: {
  workspaceId: number;
  providerBudgetId?: number;
  severity: "info" | "warning" | "critical";
  kind: "budget_state" | "forecast_exhaustion" | "connection" | "queue_blocked" | "reservation" | "import";
  title: string;
  message: string;
}) {
  const db = await getDb();
  if (!db) return;
  const dedupeKey = `${input.kind}:${input.providerBudgetId ?? "workspace"}`;
  const existing = (await db.select({ id: budgetAlerts.id }).from(budgetAlerts).where(and(
    eq(budgetAlerts.workspaceId, input.workspaceId),
    eq(budgetAlerts.dedupeKey, dedupeKey),
  )).limit(1))[0];
  if (!existing) await db.insert(budgetAlerts).values({ ...input, dedupeKey });
}

export async function refreshWorkspaceBudgets(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
  const workspace = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0];
  if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "工作区不存在。" });
  const budgets = await db.select().from(providerBudgets).where(eq(providerBudgets.workspaceId, workspaceId));
  const now = new Date();

  for (const budget of budgets) {
    const windowMs = budget.window === "five_hour" ? 5 * 3_600_000 : budget.window === "weekly" ? 7 * 24 * 3_600_000 : budget.window === "monthly" ? 30 * 24 * 3_600_000 : 24 * 3_600_000;
    const start = new Date(now.getTime() - windowMs);
    const events = await db.select().from(usageEvents).where(and(eq(usageEvents.workspaceId, workspaceId), eq(usageEvents.providerConnectionId, budget.providerConnectionId), gte(usageEvents.occurredAt, start)));
    const consumed = events.reduce((sum, event) => sum + asNumber(event.actualCostUsd ?? event.estimatedCostUsd), 0);
    const activeReservations = await db.select().from(budgetReservations).where(and(eq(budgetReservations.providerBudgetId, budget.id), eq(budgetReservations.status, "RESERVED")));
    const reserved = activeReservations.reduce((sum, reservation) => sum + asNumber(reservation.amountUsd), 0);
    const p0p1Tasks = await db.select().from(researchTasks).where(and(eq(researchTasks.workspaceId, workspaceId), lte(researchTasks.priority, "P1")));
    const commitment = p0p1Tasks.filter(task => ["queued", "reserved", "running"].includes(task.status)).reduce((sum, task) => sum + asNumber(task.estimatedCostUsd), 0);
    const burn15m = sumCostSince(events, now, 15 * 60_000) * 4;
    const burn1h = sumCostSince(events, now, 60 * 60_000);
    const burn5h = sumCostSince(events, now, 5 * 60 * 60_000) / 5;
    const burn24h = sumCostSince(events, now, 24 * 60 * 60_000) / 24;
    const phaseFloor = asNumber(budget.limitUsd) * PHASE_RESERVE_RATIO[workspace.researchPhase];
    const burnRiskBuffer = Math.min(asNumber(budget.limitUsd) * 0.15, Math.max(burn15m, burn1h, burn5h) * 0.5);
    const dynamicReserve = Math.max(phaseFloor, commitment) + burnRiskBuffer;
    const state = calculateBudgetState({ limitUsd: asNumber(budget.limitUsd), consumedUsd: consumed, reservedUsd: reserved, dynamicReserveUsd: dynamicReserve, burnRates: [burn15m, burn1h, burn5h], resetAt: budget.resetAt, now });
    await db.update(providerBudgets).set({
      consumedUsd: consumed.toFixed(4),
      reservedUsd: reserved.toFixed(4),
      dynamicReserveUsd: dynamicReserve.toFixed(4),
      burnRate15m: burn15m.toFixed(4),
      burnRate1h: burn1h.toFixed(4),
      burnRate5h: burn5h.toFixed(4),
      burnRate24h: burn24h.toFixed(4),
      forecastExhaustionAt: state.forecastExhaustionAt,
      state: state.state,
      updatedAt: new Date(),
    }).where(eq(providerBudgets.id, budget.id));
    if (state.state !== "GREEN") {
      await createUnacknowledgedAlert({
        workspaceId,
        providerBudgetId: budget.id,
        severity: state.state === "RED" || state.state === "DRAIN_PROTECTION" ? "critical" : "warning",
        kind: "budget_state",
        title: `${budget.window} 共享预算处于 ${state.state}`,
        message: `可用余额 ${state.availableUsd.toFixed(4)} USD；动态保护仓 ${dynamicReserve.toFixed(4)} USD。`,
      });
    }
    if (state.forecastExhaustionAt && state.forecastExhaustionAt.getTime() < budget.resetAt.getTime()) {
      await createUnacknowledgedAlert({
        workspaceId,
        providerBudgetId: budget.id,
        severity: "warning",
        kind: "forecast_exhaustion",
        title: `${budget.window} 预计在重置前耗尽`,
        message: `预测耗尽时间：${state.forecastExhaustionAt.toISOString()}；请迁移非关键任务或降低任务消耗。`,
      });
    }
  }
  const pausedTask = (await db.select({ id: researchTasks.id }).from(researchTasks).where(and(eq(researchTasks.workspaceId, workspaceId), eq(researchTasks.status, "paused"))).limit(1))[0];
  if (pausedTask) await createUnacknowledgedAlert({
    workspaceId,
    severity: "warning",
    kind: "queue_blocked",
    title: "任务队列存在暂停项",
    message: "至少一个任务无法通过共享预算准入检查；请补充额度、等待重置或手动调整任务预算。",
  });
  const pendingConnection = (await db.select().from(providerConnections).where(eq(providerConnections.workspaceId, workspaceId))).find(connection => connection.syncMode === "scheduled" && (connection.secretState !== "configured" || connection.connectionState === "error"));
  if (pendingConnection) await createUnacknowledgedAlert({
    workspaceId,
    severity: "info",
    kind: "connection",
    title: "自动额度同步待配置",
    message: `${pendingConnection.displayName} 尚未建立可用同步连接；CSV/JSON 导入、预算策略、任务队列和实验账本仍可本地使用。`,
  });
}

function sumCostSince(events: Array<typeof usageEvents.$inferSelect>, now: Date, rangeMs: number) {
  const start = now.getTime() - rangeMs;
  return events.filter(event => event.occurredAt.getTime() >= start).reduce((sum, event) => sum + asNumber(event.actualCostUsd ?? event.estimatedCostUsd), 0);
}

export async function saveUsageImport(input: {
  workspaceId: number;
  userId: number;
  filename: string;
  mimeType: string;
  content: string;
}) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
  const format = input.filename.toLowerCase().endsWith(".json") ? "json" : "csv";
  const events = parseUsageImport(input.content, format);
  const checksum = createHash("sha256").update(input.content).digest("hex");
  const duplicate = (await db.select().from(usageImportBatches).where(and(eq(usageImportBatches.workspaceId, input.workspaceId), eq(usageImportBatches.checksum, checksum))).limit(1))[0];
  if (duplicate && duplicate.status !== "failed") throw new TRPCError({ code: "CONFLICT", message: "该文件内容已导入过，请勿重复上传。" });

  let uploaded: { key: string; url: string } | undefined;
  try {
    uploaded = await storagePut(`quota-pilot/${input.workspaceId}/imports/${checksum}.${format}`, input.content, input.mimeType);
    const stored = uploaded;
    if (!stored) throw new Error("对象存储未返回导入文件引用。");
    const connections = await db.select().from(providerConnections).where(eq(providerConnections.workspaceId, input.workspaceId));
    const connectionByProvider = new Map(connections.map(connection => [connection.provider, connection]));
    const models = await db.select().from(modelRegistry);
    const modelByProviderAndId = new Map(models.map(model => [`${model.provider}:${model.modelId}`, model]));
    const batchId = await db.transaction(async tx => {
      let createdBatchId = duplicate?.status === "failed" ? duplicate.id : undefined;
      if (createdBatchId) {
        await tx.update(usageImportBatches).set({
          importedByUserId: input.userId,
          filename: input.filename,
          mimeType: input.mimeType,
          storageKey: stored.key,
          storageUrl: stored.url,
          format,
          rowsReceived: events.length,
          rowsAccepted: 0,
          rowsRejected: 0,
          status: "processing",
          errorSummary: null,
          updatedAt: new Date(),
        }).where(eq(usageImportBatches.id, createdBatchId));
      } else {
        const batchResult = await tx.insert(usageImportBatches).values({
          workspaceId: input.workspaceId,
          importedByUserId: input.userId,
          filename: input.filename,
          mimeType: input.mimeType,
          storageKey: stored.key,
          storageUrl: stored.url,
          checksum,
          format,
          rowsReceived: events.length,
          rowsAccepted: 0,
          status: "processing",
        });
        createdBatchId = Number(batchResult[0].insertId);
      }
      await tx.insert(usageEvents).values(events.map((event, index) => {
        const connection = connectionByProvider.get(event.provider as "opencode_go" | "openai_api" | "chatgpt_plus_manual" | "local");
        const model = modelByProviderAndId.get(`${event.provider}:${event.modelId}`);
        return {
          workspaceId: input.workspaceId,
          providerConnectionId: connection?.id,
          importBatchId: createdBatchId!,
          modelRegistryId: model?.id,
          provider: event.provider,
          modelId: event.modelId,
          tokens: event.tokens,
          estimatedCostUsd: event.estimatedCostUsd.toFixed(6),
          actualCostUsd: event.actualCostUsd?.toFixed(6),
          source: "import" as const,
          occurredAt: event.occurredAt,
          externalRef: event.externalRef || `batch:${createdBatchId}:row:${index}`,
        };
      }));
      await tx.update(usageImportBatches).set({ status: "completed", rowsAccepted: events.length, updatedAt: new Date() }).where(eq(usageImportBatches.id, createdBatchId!));
      return createdBatchId!;
    });
    await refreshWorkspaceBudgets(input.workspaceId).catch(error => console.error("[QuotaPilot] import committed but budget refresh failed", error));
    return { batchId, accepted: events.length, storageUrl: uploaded.url };
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new TRPCError({ code: "CONFLICT", message: "该文件内容已导入过，请勿重复上传。" });
    const failure = {
      workspaceId: input.workspaceId,
      importedByUserId: input.userId,
      filename: input.filename,
      mimeType: input.mimeType,
      storageKey: uploaded?.key,
      storageUrl: uploaded?.url,
      checksum,
      format,
      rowsReceived: events.length,
      rowsAccepted: 0,
      rowsRejected: events.length,
      status: "failed" as const,
      errorSummary: error instanceof Error ? error.message.slice(0, 2000) : "导入事务失败",
      updatedAt: new Date(),
    } satisfies typeof usageImportBatches.$inferInsert;
    if (duplicate?.status === "failed") {
      await db.update(usageImportBatches).set(failure).where(eq(usageImportBatches.id, duplicate.id)).catch(() => undefined);
    } else {
      await db.insert(usageImportBatches).values(failure).catch(() => undefined);
    }
    throw error;
  }
}

function isDuplicateKeyError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ER_DUP_ENTRY";
}

export async function reserveTaskBudget(input: {
  workspaceId: number;
  userId: number;
  title: string;
  description?: string;
  priority: "P0" | "P1" | "P2" | "P3";
  taskClass: "formal_experiment" | "experiment_pipeline" | "development" | "convenience";
  routeMode: "strict" | "balanced" | "emergency";
  resultClass: "official" | "fallback" | "exploratory" | "recovery";
  estimatedCostUsd: number;
  taskBudgetUsd: number;
  requestedModelId?: string;
  requirements: TaskRequirements;
  experimentId?: string;
  runId?: string;
}) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
  const routingModels = (await db.select().from(modelRegistry).where(eq(modelRegistry.isActive, true))).map(model => ({
    modelId: model.modelId,
    displayName: model.displayName,
    inputPerMillionUsd: asNumber(model.inputPerMillionUsd),
    outputPerMillionUsd: asNumber(model.outputPerMillionUsd),
    scarcityFactor: asNumber(model.scarcityFactor),
    maxConcurrency: model.maxConcurrency,
    capability: model.capability,
  }));
  const routing = resolveTaskRouting(input.requirements, routingModels, input.requestedModelId);
  const { candidates, recommendedModelId } = routing;
  const capabilityBlocked = routing.blockedByCapability;
  await refreshWorkspaceBudgets(input.workspaceId);
  const budget = (await db.select().from(providerBudgets).where(and(eq(providerBudgets.workspaceId, input.workspaceId), eq(providerBudgets.window, "five_hour"))).limit(1))[0];
  if (!budget) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "缺少可用于任务预留的五小时共享预算。" });
  const available = asNumber(budget.limitUsd) - asNumber(budget.consumedUsd) - asNumber(budget.reservedUsd);
  const requiresReservation = input.priority === "P0" || input.priority === "P1";
  const admission = capabilityBlocked ? "HOLD" as const : getAdmissionDecision({
    priority: input.priority,
    routeMode: input.routeMode,
    estimatedCostUsd: input.estimatedCostUsd,
    availableUsd: available,
    dynamicReserveUsd: asNumber(budget.dynamicReserveUsd),
    budgetState: budget.state,
  });
  const result = await db.transaction(async tx => {
    const taskResult = await tx.insert(researchTasks).values({
      workspaceId: input.workspaceId,
      createdByUserId: input.userId,
      title: input.title,
      description: input.description,
      priority: input.priority,
      taskClass: input.taskClass,
      routeMode: input.routeMode,
      resultClass: input.resultClass,
      requestedModelId: recommendedModelId,
      requirements: input.requirements,
      estimatedCostUsd: input.estimatedCostUsd.toFixed(6),
      taskBudgetUsd: input.taskBudgetUsd.toFixed(6),
      experimentId: input.experimentId,
      runId: input.runId,
      status: "queued",
      queuedAt: new Date(),
    });
    const taskId = Number(taskResult[0].insertId);
    let effectiveAdmission = admission;
    let reservationCommitted = false;
    if (requiresReservation && admission !== "HOLD") {
      const conditionalReserve = await tx.update(providerBudgets).set({
        reservedUsd: sql`${providerBudgets.reservedUsd} + ${input.estimatedCostUsd.toFixed(6)}`,
        updatedAt: new Date(),
      }).where(and(
        eq(providerBudgets.id, budget.id),
        sql`${providerBudgets.limitUsd} - ${providerBudgets.consumedUsd} - ${providerBudgets.reservedUsd} >= ${input.estimatedCostUsd.toFixed(6)}`,
      ));
      reservationCommitted = conditionalReserve[0].affectedRows === 1;
      if (reservationCommitted) {
        await tx.insert(budgetReservations).values({
          workspaceId: input.workspaceId,
          providerBudgetId: budget.id,
          taskId,
          amountUsd: input.estimatedCostUsd.toFixed(6),
          status: "RESERVED",
          expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
        });
      } else {
        effectiveAdmission = "HOLD";
      }
    }
    const decisionDetails = capabilityBlocked
      ? { reason: "没有模型满足任务的能力硬约束；不能为保持队列而静默降级。", action: "manual_handoff" as const, human: true }
      : describeRouteDecision(effectiveAdmission);
    const candidateReason = candidates[0]
      ? `${decisionDetails.reason} 候选模型：${candidates[0].displayName}（评分 ${candidates[0].score}）。`
      : decisionDetails.reason;
    const taskStatus = reservationCommitted ? "reserved" : effectiveAdmission === "HOLD" || effectiveAdmission === "MIGRATE" ? "paused" : "queued";
    await tx.update(researchTasks).set({ status: taskStatus, admissionDecision: effectiveAdmission, updatedAt: new Date() }).where(eq(researchTasks.id, taskId));
    const attemptResult = await tx.insert(taskAttempts).values({
      workspaceId: input.workspaceId,
      taskId,
      attemptNumber: 1,
      requestedModelId: recommendedModelId,
      actualModelId: recommendedModelId,
      provider: "opencode_go",
      quotaState: budget.state,
      resultClass: input.resultClass,
      estimatedCostUsd: input.estimatedCostUsd.toFixed(6),
      status: "queued",
    });
    await tx.insert(routeDecisions).values({
      workspaceId: input.workspaceId,
      taskId,
      attemptId: Number(attemptResult[0].insertId),
      admissionDecision: effectiveAdmission,
      budgetState: budget.state,
      availableUsd: available.toFixed(6),
      dynamicReserveUsd: asNumber(budget.dynamicReserveUsd).toFixed(6),
      estimatedCostUsd: input.estimatedCostUsd.toFixed(6),
      reason: candidateReason,
      recommendedAction: decisionDetails.action,
      selectedModelId: recommendedModelId,
      requiresHumanHandoff: decisionDetails.human,
    });
    return { taskId, reserved: reservationCommitted, state: reservationCommitted ? "RESERVED" as const : effectiveAdmission === "HOLD" ? "PAUSED" as const : "QUEUED" as const, admission: effectiveAdmission };
  });
  await refreshWorkspaceBudgets(input.workspaceId).catch(error => console.error("[QuotaPilot] reservation committed but budget refresh failed", error));
  return result;
}

export async function recordTaskAttemptExecution(input: {
  workspaceId: number;
  taskId: number;
  attemptId: number;
  actualModelId: string;
  actualCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  status: "completed" | "failed" | "cancelled";
  fallback: boolean;
  fallbackReason?: "quota_low" | "rate_limit" | "timeout" | "provider_error" | "model_unavailable" | "context_overflow" | "tool_error" | "manual";
  resultClass: "official" | "fallback" | "exploratory" | "recovery";
}) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
  const settled = await db.transaction(async tx => {
    const task = (await tx.select().from(researchTasks).where(and(eq(researchTasks.id, input.taskId), eq(researchTasks.workspaceId, input.workspaceId))).limit(1))[0];
    const attempt = (await tx.select().from(taskAttempts).where(and(eq(taskAttempts.id, input.attemptId), eq(taskAttempts.taskId, input.taskId), eq(taskAttempts.workspaceId, input.workspaceId))).limit(1))[0];
    if (!task || !attempt) throw new TRPCError({ code: "NOT_FOUND", message: "任务或执行 attempt 不存在。" });
    if (["completed", "failed", "cancelled"].includes(attempt.status)) throw new TRPCError({ code: "CONFLICT", message: "该 attempt 已结算，拒绝重复记账。" });
    if ((input.fallback || input.actualModelId !== task.requestedModelId) && input.resultClass === "official") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "模型切换后的 attempt 不能写入 official 结果；请标记为 fallback 或 recovery。" });
    }
    if (input.actualCostUsd > asNumber(task.taskBudgetUsd)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "实际成本超过任务预算，系统拒绝写入完成结果。" });
    }
    const finalTaskStatus = input.status === "completed" ? "completed" : input.status === "cancelled" ? "cancelled" : "failed";
    const finalResultClass = input.fallback || input.actualModelId !== task.requestedModelId
      ? input.resultClass === "official" ? "fallback" : input.resultClass
      : input.resultClass;
    await tx.update(taskAttempts).set({ actualModelId: input.actualModelId, fallback: input.fallback || input.actualModelId !== task.requestedModelId, fallbackReason: input.fallback || input.actualModelId !== task.requestedModelId ? input.fallbackReason ?? "manual" : null, resultClass: finalResultClass, status: input.status, actualCostUsd: input.actualCostUsd.toFixed(6), completedAt: new Date() }).where(eq(taskAttempts.id, attempt.id));
    await tx.update(researchTasks).set({ actualCostUsd: input.actualCostUsd.toFixed(6), resultClass: finalResultClass, status: finalTaskStatus, completedAt: new Date(), updatedAt: new Date() }).where(eq(researchTasks.id, task.id));
    const reservationStatus = input.status === "completed" ? "CONSUMED" : "RELEASED";
    await tx.update(budgetReservations).set({ status: reservationStatus, updatedAt: new Date() }).where(and(eq(budgetReservations.taskId, task.id), eq(budgetReservations.status, "RESERVED")));
    const connection = (await tx.select().from(providerConnections).where(and(eq(providerConnections.workspaceId, input.workspaceId), eq(providerConnections.provider, "opencode_go"))).limit(1))[0];
    await tx.insert(usageEvents).values({ workspaceId: input.workspaceId, providerConnectionId: connection?.id, provider: "opencode_go", modelId: input.actualModelId, tokens: { inputTokens: input.inputTokens, outputTokens: input.outputTokens, cacheReadTokens: input.cacheReadTokens, cacheWriteTokens: input.cacheWriteTokens }, estimatedCostUsd: attempt.estimatedCostUsd, actualCostUsd: input.actualCostUsd.toFixed(6), source: "task_attempt", occurredAt: new Date(), externalRef: `attempt:${attempt.id}:settled` });
    return { taskStatus: finalTaskStatus, resultClass: finalResultClass, reservationStatus };
  });
  await refreshWorkspaceBudgets(input.workspaceId);
  return settled;
}

export async function listWorkspaceDashboard(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const connections = await db.select().from(providerConnections).where(eq(providerConnections.workspaceId, workspaceId));
  const budgets = await db.select().from(providerBudgets).where(eq(providerBudgets.workspaceId, workspaceId));
  const models = await db.select().from(modelRegistry).where(eq(modelRegistry.isActive, true));
  const tasks = await db.select().from(researchTasks).where(eq(researchTasks.workspaceId, workspaceId)).orderBy(desc(researchTasks.createdAt)).limit(24);
  const attempts = await db.select().from(taskAttempts).where(eq(taskAttempts.workspaceId, workspaceId)).orderBy(desc(taskAttempts.createdAt)).limit(36);
  const events = await db.select().from(usageEvents).where(and(eq(usageEvents.workspaceId, workspaceId), gte(usageEvents.occurredAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)))).orderBy(desc(usageEvents.occurredAt));
  const reservations = await db.select().from(budgetReservations).where(and(eq(budgetReservations.workspaceId, workspaceId), eq(budgetReservations.status, "RESERVED")));
  const alerts = await db.select().from(budgetAlerts).where(eq(budgetAlerts.workspaceId, workspaceId)).orderBy(desc(budgetAlerts.createdAt)).limit(12);
  const decisions = await db.select().from(routeDecisions).where(eq(routeDecisions.workspaceId, workspaceId)).orderBy(desc(routeDecisions.createdAt)).limit(24);
  return { workspace, connections, budgets, models, tasks, attempts, events, reservations, alerts, decisions };
}
