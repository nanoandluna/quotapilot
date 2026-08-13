import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import {
  budgetReservations,
  budgetAlerts,
  experimentExecutionLedger,
  modelConcurrencyBudgets,
  modelRegistry,
  providerBudgets,
  providerConnections,
  quotaSnapshots,
  researchTasks,
  routeDecisions,
  routePolicyEvaluations,
  schedulerSettings,
  taskAttempts,
  usageEvents,
  usageImportBatches,
  workspaceMembers,
  workspaces,
  type CapabilityMatrix,
  type RoutePlanSnapshot,
  type TaskRequirements,
  type UsageTokenPayload,
} from "../drizzle/schema";
import { getDb } from "./db";
import { getProviderCredentialStatus } from "./providerCredentials";
import { storagePut } from "./storage";

export type BudgetState = "GREEN" | "YELLOW" | "ORANGE" | "DRAIN_PROTECTION" | "RED";
export type WorkspaceRole = "owner" | "admin" | "researcher" | "reviewer" | "viewer";
export type FailureDomain = "QUOTA" | "RATE_LIMIT" | "TIMEOUT" | "PROVIDER_ERROR" | "MODEL_UNAVAILABLE" | "CONTEXT_OVERFLOW" | "TOOL_ERROR" | "UNKNOWN";
export type FailureExecutionPlan = {
  contextReductionRatio: number;
  outputReductionRatio: number;
  maxToolCalls: number | null;
  maxAgentSteps: number | null;
  chunkInput: boolean;
  preserveRequestedModel: boolean;
};

export function getFailurePolicy(domain: FailureDomain, priority: "P0" | "P1" | "P2" | "P3") {
  const strictResearch = priority === "P0" || priority === "P1";
  const policies: Record<FailureDomain, { recommendedAction: "migrate" | "queue" | "hold" | "manual_handoff"; retryAfterSeconds: number | null; retryMode: "none" | "backoff" | "after_remediation"; circuitScope: "provider_window" | "provider" | "model" | "task" | "tool" | "unknown"; degradationSteps: string[]; requiresHumanHandoff: boolean }> = {
    QUOTA: { recommendedAction: strictResearch ? "hold" : "migrate", retryAfterSeconds: null, retryMode: "after_remediation", circuitScope: "provider_window", degradationSteps: ["保留正式任务预算", "等待共享窗口重置或选择已验证候选模型"], requiresHumanHandoff: strictResearch },
    RATE_LIMIT: { recommendedAction: "queue", retryAfterSeconds: strictResearch ? 15 : 30, retryMode: "backoff", circuitScope: "provider", degradationSteps: ["指数退避", "降低并发", "保留请求语义"], requiresHumanHandoff: false },
    TIMEOUT: { recommendedAction: "queue", retryAfterSeconds: 10, retryMode: "backoff", circuitScope: "model", degradationSteps: ["缩小输出上限", "拆分任务", "降低 Agent 步数"], requiresHumanHandoff: false },
    PROVIDER_ERROR: { recommendedAction: "queue", retryAfterSeconds: 60, retryMode: "backoff", circuitScope: "provider", degradationSteps: ["短路异常 provider", "等待健康检查恢复", "不静默切换正式结果"], requiresHumanHandoff: strictResearch },
    MODEL_UNAVAILABLE: { recommendedAction: strictResearch ? "manual_handoff" : "migrate", retryAfterSeconds: null, retryMode: "after_remediation", circuitScope: "model", degradationSteps: ["验证候选模型能力", "重新执行额度与上下文准入", "标记 fallback 或 recovery"], requiresHumanHandoff: strictResearch },
    CONTEXT_OVERFLOW: { recommendedAction: "queue", retryAfterSeconds: 0, retryMode: "backoff", circuitScope: "task", degradationSteps: ["压缩上下文", "分块输入", "减少工具输出"], requiresHumanHandoff: false },
    TOOL_ERROR: { recommendedAction: "queue", retryAfterSeconds: 20, retryMode: "backoff", circuitScope: "tool", degradationSteps: ["缩小工具调用", "重试幂等步骤", "隔离失败工具"], requiresHumanHandoff: false },
    UNKNOWN: { recommendedAction: "manual_handoff", retryAfterSeconds: null, retryMode: "none", circuitScope: "unknown", degradationSteps: ["保留失败证据", "人工复核后再重试"], requiresHumanHandoff: true },
  };
  return policies[domain];
}

export function getFailureExecutionPlan(domain: FailureDomain): FailureExecutionPlan {
  const baseline: FailureExecutionPlan = { contextReductionRatio: 1, outputReductionRatio: 1, maxToolCalls: null, maxAgentSteps: null, chunkInput: false, preserveRequestedModel: true };
  const plans: Partial<Record<FailureDomain, FailureExecutionPlan>> = {
    TIMEOUT: { ...baseline, outputReductionRatio: 0.7, maxToolCalls: 3, maxAgentSteps: 4 },
    CONTEXT_OVERFLOW: { ...baseline, contextReductionRatio: 0.7, outputReductionRatio: 0.8, maxToolCalls: 3, maxAgentSteps: 3, chunkInput: true },
    TOOL_ERROR: { ...baseline, maxToolCalls: 2, maxAgentSteps: 3 },
  };
  return plans[domain] ?? baseline;
}

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

const OPENCODE_GO_DOCS_URL = "https://opencode.ai/docs/go/";
const OPENCODE_GO_POLICY_VERSION = "opencode-go-policy-2026-08-13";

export function needsNewModelVersion(current: {
  inputPerMillionUsd: string;
  outputPerMillionUsd: string;
  cacheReadPerMillionUsd: string | null;
  scarcityFactor: string;
  maxConcurrency: number;
  capability: CapabilityMatrix;
  pricingVersion: string;
  capabilityVersion: string;
}, desired: ModelSeed) {
  return current.inputPerMillionUsd !== desired.input
    || current.outputPerMillionUsd !== desired.output
    || (current.cacheReadPerMillionUsd ?? undefined) !== desired.cacheRead
    || current.scarcityFactor !== desired.scarcity
    || current.maxConcurrency !== desired.concurrency
    || JSON.stringify(current.capability) !== JSON.stringify(desired.capability)
    || current.pricingVersion !== OPENCODE_GO_POLICY_VERSION
    || current.capabilityVersion !== OPENCODE_GO_POLICY_VERSION;
}

async function syncWorkspacePolicyModelInTransaction(db: any, model: ModelSeed) {
  const verifiedAt = new Date();
  const activeVersion = (await db.select().from(modelRegistry).where(and(
    eq(modelRegistry.provider, "opencode_go"),
    eq(modelRegistry.modelId, model.modelId),
    eq(modelRegistry.isActive, true),
  )).limit(1))[0];
  if (activeVersion && !needsNewModelVersion(activeVersion, model)) {
    await db.update(modelRegistry).set({
      metadataVerifiedAt: verifiedAt,
      metadataSourceUrl: OPENCODE_GO_DOCS_URL,
      updatedAt: verifiedAt,
    }).where(eq(modelRegistry.id, activeVersion.id));
    return { action: "refreshed" as const, previousVersionId: activeVersion.id };
  }
  if (activeVersion) {
    await db.update(modelRegistry).set({
      isActive: false,
      effectiveUntil: verifiedAt,
      updatedAt: verifiedAt,
    }).where(eq(modelRegistry.id, activeVersion.id));
  }
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
    pricingVersion: OPENCODE_GO_POLICY_VERSION,
    capabilityVersion: OPENCODE_GO_POLICY_VERSION,
    metadataVerifiedAt: verifiedAt,
    metadataSourceUrl: OPENCODE_GO_DOCS_URL,
    effectiveFrom: verifiedAt,
  });
  return { action: activeVersion ? "replaced" as const : "inserted" as const, previousVersionId: activeVersion?.id };
}

export async function syncWorkspacePolicyModel(db: any, model: ModelSeed) {
  return db.transaction((tx: any) => syncWorkspacePolicyModelInTransaction(tx, model));
}

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

function taskCostCapUsd(task: { cumulativeCostCapUsd: string | number | null; taskBudgetUsd: string | number | null; estimatedCostUsd?: string | number | null }) {
  const explicitCap = asNumber(task.cumulativeCostCapUsd);
  const taskBudget = asNumber(task.taskBudgetUsd);
  return explicitCap > 0 ? explicitCap : taskBudget > 0 ? taskBudget : asNumber(task.estimatedCostUsd);
}

export function getTaskBudgetAdmission(input: { estimatedCostUsd: number; taskBudgetUsd: number }) {
  if (!Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0 || !Number.isFinite(input.taskBudgetUsd) || input.taskBudgetUsd <= 0) {
    return { admitted: false, reason: "任务预计成本必须为非负数，任务成本上限必须为正数。" } as const;
  }
  if (input.estimatedCostUsd > input.taskBudgetUsd) {
    return { admitted: false, reason: "首轮预计成本超过任务累计成本上限；请提高任务预算或拆分任务。" } as const;
  }
  return { admitted: true, reason: null } as const;
}

export function getTaskRetryAdmission(input: { attemptCount: number; maxAttempts: number }) {
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    return { admitted: false, reason: "任务最大尝试次数必须为至少 1 的整数。" } as const;
  }
  if (input.attemptCount >= input.maxAttempts) {
    return { admitted: false, reason: "任务已达到最大尝试次数，拒绝创建新的 attempt。" } as const;
  }
  return { admitted: true, reason: null } as const;
}

function budgetWindowMs(window: "five_hour" | "daily" | "weekly" | "monthly") {
  return window === "five_hour" ? 5 * 3_600_000 : window === "weekly" ? 7 * 24 * 3_600_000 : window === "monthly" ? 30 * 24 * 3_600_000 : 24 * 3_600_000;
}

export function resolveBudgetResetAt(input: {
  window: "five_hour" | "daily" | "weekly" | "monthly";
  policy: "rolling" | "fixed" | "calendar" | "provider_reported";
  resetAt: Date;
  providerReportedResetAt?: Date | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (input.policy === "provider_reported" && input.providerReportedResetAt && input.providerReportedResetAt > now) return input.providerReportedResetAt;
  if (input.resetAt > now) return input.resetAt;
  const windowMs = budgetWindowMs(input.window);
  if (input.policy === "rolling") return new Date(now.getTime() + windowMs);
  let next = new Date(input.resetAt);
  while (next <= now) next = new Date(next.getTime() + windowMs);
  return next;
}

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

export function getReservationKind(priority: "P0" | "P1" | "P2" | "P3"): "hard" | "soft" | undefined {
  if (priority === "P0" || priority === "P1") return "hard";
  if (priority === "P2") return "soft";
  return undefined;
}

export async function claimInitialHardReservation(tx: any, providerBudgetId: number, amountUsd: number) {
  const conditionalReserve = await tx.update(providerBudgets).set({
    reservedUsd: sql`${providerBudgets.reservedUsd} + ${amountUsd.toFixed(6)}`,
    updatedAt: new Date(),
  }).where(and(
    eq(providerBudgets.id, providerBudgetId),
    sql`${providerBudgets.limitUsd} - ${providerBudgets.consumedUsd} - ${providerBudgets.reservedUsd} >= ${amountUsd.toFixed(6)}`,
  ));
  return conditionalReserve[0].affectedRows === 1;
}

export type RoutingModel = {
  provider?: "opencode_go" | "openai_api" | "local";
  modelId: string;
  displayName: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  scarcityFactor: number;
  maxConcurrency: number;
  activeConcurrency?: number;
  maxContextTokens?: number;
  capability: CapabilityMatrix;
};

export type RouteMode = "strict" | "balanced" | "emergency";

export type ProviderRouteContext = {
  provider: "opencode_go" | "openai_api" | "local";
  availableUsd?: number;
  connectionState?: "pending_configuration" | "connected" | "degraded" | "error" | "disabled";
  secretState?: "not_configured" | "configured";
};

export type TaskRoutingResolution = {
  candidates: Array<RoutingModel & { score: number; reason: string }>;
  recommendedModelId?: string;
  blockedByCapability: boolean;
  reason: string;
};

export type UnifiedRoutePlan = TaskRoutingResolution & {
  selectedProvider?: "opencode_go" | "openai_api" | "local";
  blockedByBudget: boolean;
  routePlan: RoutePlanSnapshot;
};

export function scoreCandidateModels(requirements: TaskRequirements, models: RoutingModel[]) {
  const requiredCapabilities = (Object.entries(requirements) as Array<[keyof TaskRequirements, unknown]>).filter(([key, value]) => key in capability({}) && typeof value === "number" && value > 0) as Array<[keyof CapabilityMatrix, number]>;
  return models
    .filter(model => model.maxConcurrency > 0)
    .filter(model => !requirements.requiresVision || model.capability.vision > 0)
    .filter(model => !requirements.requiresToolUse || model.capability.toolUse > 0)
    .filter(model => !requirements.maxContextTokens || (model.maxContextTokens ?? 0) >= requirements.maxContextTokens)
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

export function resolveTaskRouting(
  requirements: TaskRequirements,
  models: RoutingModel[],
  input: { routeMode: RouteMode; requestedModelId?: string },
): TaskRoutingResolution {
  const candidates = scoreCandidateModels(requirements, models);
  const requestedCandidate = input.requestedModelId
    ? candidates.find(candidate => candidate.modelId === input.requestedModelId)
    : undefined;

  if (input.routeMode === "strict") {
    if (!input.requestedModelId) {
      return { candidates, blockedByCapability: true, reason: "严格模式必须指定 requested model；系统不会自行选择替代模型。" };
    }
    if (!requestedCandidate) {
      return { candidates, recommendedModelId: input.requestedModelId, blockedByCapability: true, reason: "指定模型未激活、并发不可用或不满足任务能力硬约束；严格模式禁止自动替换。" };
    }
    return { candidates: [requestedCandidate], recommendedModelId: requestedCandidate.modelId, blockedByCapability: false, reason: "严格模式保留能力合格的指定模型。" };
  }

  if (input.routeMode === "balanced" && requestedCandidate) {
    return { candidates, recommendedModelId: requestedCandidate.modelId, blockedByCapability: false, reason: "平衡模式优先采用能力合格的指定模型；若后续配额或连接校验失败，可生成替代 Route Plan。" };
  }

  return {
    candidates,
    recommendedModelId: candidates[0]?.modelId ?? input.requestedModelId,
    blockedByCapability: candidates.length === 0,
    reason: candidates.length === 0 ? "没有模型满足任务能力硬约束。" : input.routeMode === "emergency" ? "应急模式按能力、可靠性、成本与稀缺性选择当前最优候选。" : "平衡模式未找到可用指定模型，改为选择当前最优候选。",
  };
}

export function buildUnifiedRoutePlan(input: {
  requirements: TaskRequirements;
  models: Array<RoutingModel & { provider?: "opencode_go" | "openai_api" | "local" }>;
  routeMode: RouteMode;
  requestedModelId?: string;
  estimatedCostUsd: number;
  providerContexts: ProviderRouteContext[];
}): UnifiedRoutePlan {
  const base = resolveTaskRouting(input.requirements, input.models, { routeMode: input.routeMode, requestedModelId: input.requestedModelId });
  const contextByProvider = new Map(input.providerContexts.map(context => [context.provider, context]));
  const scoredByModelId = new Map(base.candidates.map(candidate => [candidate.modelId, candidate]));
  const candidates = base.candidates.map(candidate => {
    const provider = candidate.provider ?? "opencode_go";
    const context = contextByProvider.get(provider);
    const hasBudget = typeof context?.availableUsd === "number" && context.availableUsd >= input.estimatedCostUsd;
    const reasons = [candidate.reason];
    if (!context) reasons.push("未发现 provider 五小时预算上下文。");
    else if (!hasBudget) reasons.push(`provider 当前可用额度不足：${(context.availableUsd ?? 0).toFixed(4)} USD。`);
    if (context && context.secretState !== "configured") reasons.push("provider 凭据尚未配置；该计划只能人工执行或导入结算。");
    if (context && context.connectionState !== "connected") reasons.push(`provider 连接状态为 ${context.connectionState ?? "unknown"}。`);
    return { candidate, provider, hasBudget, reasons };
  });
  const eligible = candidates.filter(candidate => candidate.hasBudget);
  const requested = input.requestedModelId ? candidates.find(candidate => candidate.candidate.modelId === input.requestedModelId) : undefined;
  let selected: (typeof candidates)[number] | undefined = eligible[0];
  let reason = base.reason;
  let blockedByCapability = base.blockedByCapability;
  let blockedByBudget = false;

  if (input.routeMode === "strict") {
    selected = requested?.hasBudget ? requested : undefined;
    if (!requested) blockedByCapability = true;
    if (requested && !requested.hasBudget) blockedByBudget = true;
    if (blockedByBudget) reason = "严格模式指定模型满足能力要求，但其 provider 额度不足；禁止自动换模。";
  } else if (input.routeMode === "balanced" && requested?.hasBudget) {
    selected = requested;
  } else if (eligible.length === 0 && !blockedByCapability) {
    selected = undefined;
    blockedByBudget = true;
    reason = "存在能力合格模型，但没有任何候选 provider 具备覆盖本任务的共享可用额度。";
  }

  const routePlan: RoutePlanSnapshot = {
    routeMode: input.routeMode,
    requestedModelId: input.requestedModelId,
    selectedModelId: selected?.candidate.modelId,
    budgetWindow: "five_hour",
    candidates: input.models.map(model => {
      const scored = scoredByModelId.get(model.modelId);
      const candidate = candidates.find(item => item.candidate.modelId === model.modelId);
      const provider = model.provider ?? "opencode_go";
      return {
        modelId: model.modelId,
        provider,
        score: scored?.score ?? 0,
        eligible: Boolean(candidate?.hasBudget),
        reasons: candidate?.reasons ?? [
          model.maxConcurrency <= (model.activeConcurrency ?? 0)
            ? `模型并发已满：${model.activeConcurrency}/${model.maxConcurrency}。`
            : "未满足任务能力硬约束、上下文容量或并发条件。",
        ],
      };
    }),
    generatedAt: new Date().toISOString(),
  };

  return {
    candidates: base.candidates,
    recommendedModelId: selected?.candidate.modelId ?? base.recommendedModelId,
    selectedProvider: selected?.provider,
    blockedByCapability,
    blockedByBudget,
    reason,
    routePlan,
  };
}

function describeRouteDecision(decision: "ADMIT" | "RESERVE" | "MIGRATE" | "QUEUE" | "HOLD") {
  if (decision === "RESERVE") return { reason: "P0/P1 任务通过共享预算检查，需先锁定可预估成本。", action: "reserve" as const, human: false };
  if (decision === "MIGRATE") return { reason: "当前窗口接近动态保护仓；非关键任务应迁移到能力合格、成本更低的模型。", action: "migrate" as const, human: true };
  if (decision === "QUEUE") return { reason: "动态保护仓或 DRAIN_PROTECTION 正在保护 P0/P1 连续性，任务需等待预算恢复。", action: "queue" as const, human: false };
  if (decision === "HOLD") return { reason: "共享窗口余额不足以覆盖任务预估成本，不能静默降级。", action: "manual_handoff" as const, human: true };
  return { reason: "能力、成本和共享预算均满足当前任务准入条件。", action: "run" as const, human: false };
}

export type UsageImportRecord = {
  provider: string;
  modelId: string;
  tokens: UsageTokenPayload;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  occurredAt: Date;
  externalRef?: string;
};

export type UsageImportRowError = {
  row: number;
  reason: string;
  fields: string[];
};

export function parseUsageImportDetailed(content: string, format: "csv" | "json"): { events: UsageImportRecord[]; errors: UsageImportRowError[] } {
  const rawRows: Record<string, unknown>[] = format === "json" ? parseJsonRows(content) : parseCsvRows(content);
  if (!rawRows.length) throw new Error("未检测到可导入的用量记录。");

  const events: UsageImportRecord[] = [];
  const errors: UsageImportRowError[] = [];
  rawRows.forEach((row, index) => {
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

    if (!modelId) {
      errors.push({ row: index + 1, reason: "缺少 model_id。", fields: ["model_id"] });
      return;
    }
    if (Number.isNaN(occurredAt.getTime())) {
      errors.push({ row: index + 1, reason: "occurred_at 无法解析。", fields: ["occurred_at"] });
      return;
    }

    const parsedActual = actualCost === undefined ? undefined : Number(actualCost);
    const parsedEstimate = estimatedCost === undefined ? 0 : Number(estimatedCost);
    if (Number.isNaN(parsedEstimate) || (parsedActual !== undefined && Number.isNaN(parsedActual))) {
      errors.push({ row: index + 1, reason: "成本字段必须为数字。", fields: ["actual_cost_usd", "estimated_cost_usd"] });
      return;
    }

    events.push({
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
    });
  });
  return { events, errors };
}

export function parseUsageImport(content: string, format: "csv" | "json"): UsageImportRecord[] {
  const parsed = parseUsageImportDetailed(content, format);
  if (parsed.errors.length) {
    const first = parsed.errors[0];
    throw new Error(`第 ${first.row} 行${first.reason}`);
  }
  return parsed.events;
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
    await syncWorkspacePolicyModel(db, model);
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
    const resetAt = resolveBudgetResetAt({
      window: budget.window,
      policy: budget.resetPolicy,
      resetAt: budget.resetAt,
      providerReportedResetAt: budget.providerReportedResetAt,
      now,
    });
    if (resetAt.getTime() !== budget.resetAt.getTime()) {
      await db.update(providerBudgets).set({ resetAt, updatedAt: now }).where(eq(providerBudgets.id, budget.id));
    }
    await db.update(budgetReservations).set({ status: "RELEASED", updatedAt: now }).where(and(
      eq(budgetReservations.providerBudgetId, budget.id),
      eq(budgetReservations.status, "RESERVED"),
      lte(budgetReservations.expiresAt, now),
    ));
    const windowMs = budgetWindowMs(budget.window);
    const start = new Date(now.getTime() - windowMs);
    const events = await db.select().from(usageEvents).where(and(eq(usageEvents.workspaceId, workspaceId), eq(usageEvents.providerConnectionId, budget.providerConnectionId), gte(usageEvents.occurredAt, start)));
    const consumed = events.reduce((sum, event) => sum + asNumber(event.actualCostUsd ?? event.estimatedCostUsd), 0);
    const activeReservations = await db.select().from(budgetReservations).where(and(eq(budgetReservations.providerBudgetId, budget.id), eq(budgetReservations.status, "RESERVED"), eq(budgetReservations.reservationKind, "hard")));
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
    const state = calculateBudgetState({ limitUsd: asNumber(budget.limitUsd), consumedUsd: consumed, reservedUsd: reserved, dynamicReserveUsd: dynamicReserve, burnRates: [burn15m, burn1h, burn5h], resetAt, now });
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
    await db.insert(quotaSnapshots).values({
      workspaceId,
      providerConnectionId: budget.providerConnectionId,
      providerBudgetId: budget.id,
      window: budget.window,
      limitUsd: budget.limitUsd,
      consumedUsd: consumed.toFixed(4),
      reservedUsd: reserved.toFixed(4),
      dynamicReserveUsd: dynamicReserve.toFixed(4),
      state: state.state,
      source: budget.source,
      capturedAt: now,
    });
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
    if (state.forecastExhaustionAt && state.forecastExhaustionAt.getTime() < resetAt.getTime()) {
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
  const parsedImport = parseUsageImportDetailed(input.content, format);
  const { events, errors } = parsedImport;
  if (!events.length) {
    const first = errors[0];
    throw new TRPCError({ code: "BAD_REQUEST", message: first ? `没有可导入的有效记录：第 ${first.row} 行${first.reason}` : "未检测到可导入的用量记录。" });
  }
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
    const models = await db.select().from(modelRegistry).where(eq(modelRegistry.isActive, true));
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
          rowsReceived: events.length + errors.length,
          rowsAccepted: 0,
          rowsRejected: errors.length,
          status: "processing",
          errorSummary: errors.length ? JSON.stringify(errors.slice(0, 100)) : null,
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
          rowsReceived: events.length + errors.length,
          rowsAccepted: 0,
          rowsRejected: errors.length,
          errorSummary: errors.length ? JSON.stringify(errors.slice(0, 100)) : null,
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
          budgetWindow: "five_hour" as const,
          costUnit: "USD",
          costBasis: event.actualCostUsd === undefined ? "estimated" as const : event.estimatedCostUsd > 0 ? "mixed" as const : "actual" as const,
          source: "import" as const,
          occurredAt: event.occurredAt,
          externalRef: event.externalRef || `batch:${createdBatchId}:row:${index}`,
        };
      }));
      await tx.update(usageImportBatches).set({ status: "completed", rowsAccepted: events.length, rowsRejected: errors.length, errorSummary: errors.length ? JSON.stringify(errors.slice(0, 100)) : null, updatedAt: new Date() }).where(eq(usageImportBatches.id, createdBatchId!));
      return createdBatchId!;
    });
    await refreshWorkspaceBudgets(input.workspaceId).catch(error => console.error("[QuotaPilot] import committed but budget refresh failed", error));
    return { batchId, accepted: events.length, rejected: errors.length, errors, storageUrl: uploaded.url };
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
  maxAttempts?: number;
  requestedModelId?: string;
  requirements: TaskRequirements;
  experimentId?: string;
  runId?: string;
}) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
  const taskBudgetAdmission = getTaskBudgetAdmission(input);
  if (!taskBudgetAdmission.admitted) {
    const code = input.estimatedCostUsd > input.taskBudgetUsd ? "PRECONDITION_FAILED" : "BAD_REQUEST";
    throw new TRPCError({ code, message: taskBudgetAdmission.reason });
  }
  await refreshWorkspaceBudgets(input.workspaceId);
  const [models, connections, budgets, runningAttempts] = await Promise.all([
    db.select().from(modelRegistry).where(eq(modelRegistry.isActive, true)),
    db.select().from(providerConnections).where(eq(providerConnections.workspaceId, input.workspaceId)),
    db.select().from(providerBudgets).where(and(eq(providerBudgets.workspaceId, input.workspaceId), eq(providerBudgets.window, "five_hour"))),
    db.select().from(taskAttempts).where(and(eq(taskAttempts.workspaceId, input.workspaceId), eq(taskAttempts.status, "running"))),
  ]);
  const activeConcurrencyByModel = new Map<string, number>();
  for (const attempt of runningAttempts) {
    const modelId = attempt.actualModelId ?? attempt.requestedModelId;
    if (modelId) activeConcurrencyByModel.set(modelId, (activeConcurrencyByModel.get(modelId) ?? 0) + 1);
  }
  const budgetByConnectionId = new Map(budgets.map(budget => [budget.providerConnectionId, budget]));
  const providerContexts = connections.map(connection => {
    const budget = budgetByConnectionId.get(connection.id);
    return {
      provider: connection.provider as "opencode_go" | "openai_api" | "local",
      availableUsd: budget ? asNumber(budget.limitUsd) - asNumber(budget.consumedUsd) - asNumber(budget.reservedUsd) : undefined,
      connectionState: connection.connectionState,
      secretState: connection.secretState,
    };
  });
  const routingModels = models.map(model => ({
    provider: model.provider,
    modelId: model.modelId,
    displayName: model.displayName,
    inputPerMillionUsd: asNumber(model.inputPerMillionUsd),
    outputPerMillionUsd: asNumber(model.outputPerMillionUsd),
    scarcityFactor: asNumber(model.scarcityFactor),
    maxConcurrency: Math.max(0, model.maxConcurrency - (activeConcurrencyByModel.get(model.modelId) ?? 0)),
    activeConcurrency: activeConcurrencyByModel.get(model.modelId) ?? 0,
    maxContextTokens: model.maxContextTokens,
    capability: model.capability,
  }));
  const routing = buildUnifiedRoutePlan({
    requirements: input.requirements,
    models: routingModels,
    routeMode: input.routeMode,
    requestedModelId: input.requestedModelId,
    estimatedCostUsd: input.estimatedCostUsd,
    providerContexts,
  });
  const { candidates, recommendedModelId } = routing;
  const selectedModel = routingModels.find(model => model.modelId === recommendedModelId);
  const selectedRegistryModel = models.find(model => model.modelId === recommendedModelId && model.provider === (routing.selectedProvider ?? selectedModel?.provider));
  const attemptProvider = routing.selectedProvider ?? selectedModel?.provider ?? "opencode_go";
  const budget = budgets.find(candidate => candidate.providerConnectionId === connections.find(connection => connection.provider === attemptProvider)?.id) ?? budgets[0];
  if (!budget) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "缺少可用于任务预留的五小时共享预算。" });
  const available = asNumber(budget.limitUsd) - asNumber(budget.consumedUsd) - asNumber(budget.reservedUsd);
  const reservationKind = getReservationKind(input.priority);
  const admission = routing.blockedByCapability || routing.blockedByBudget ? "HOLD" as const : getAdmissionDecision({
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
      cumulativeCostCapUsd: input.taskBudgetUsd.toFixed(6),
      remainingBudgetUsd: input.taskBudgetUsd.toFixed(6),
      maxAttempts: input.maxAttempts ?? 3,
      experimentId: input.experimentId,
      runId: input.runId,
      status: "queued",
      queuedAt: new Date(),
    });
    const taskId = Number(taskResult[0].insertId);
    let effectiveAdmission = admission;
    let hardReservationCommitted = false;
    let softReservationCommitted = false;
    if (reservationKind === "hard" && admission !== "HOLD") {
      hardReservationCommitted = await claimInitialHardReservation(tx, budget.id, input.estimatedCostUsd);
      if (hardReservationCommitted) {
        await tx.insert(budgetReservations).values({
          workspaceId: input.workspaceId,
          providerBudgetId: budget.id,
          taskId,
          amountUsd: input.estimatedCostUsd.toFixed(6),
          reservationKind: "hard",
          status: "RESERVED",
          expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
        });
      } else {
        effectiveAdmission = "HOLD";
      }
    } else if (reservationKind === "soft" && admission !== "HOLD") {
      await tx.insert(budgetReservations).values({
        workspaceId: input.workspaceId,
        providerBudgetId: budget.id,
        taskId,
        amountUsd: input.estimatedCostUsd.toFixed(6),
        reservationKind: "soft",
        status: "RESERVED",
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      });
      softReservationCommitted = true;
    }
    const decisionDetails = routing.blockedByCapability || routing.blockedByBudget
      ? { reason: routing.blockedByBudget ? "没有候选 provider 具备覆盖任务的共享可用额度；不能静默绕过预算。" : "没有模型满足任务的能力硬约束；不能为保持队列而静默降级。", action: "manual_handoff" as const, human: true }
      : describeRouteDecision(effectiveAdmission);
    const selectedCandidate = candidates.find(candidate => candidate.modelId === recommendedModelId);
    const candidateReason = selectedCandidate
      ? `${decisionDetails.reason} ${routing.reason} 候选模型：${selectedCandidate.displayName}（评分 ${selectedCandidate.score}）。`
      : `${decisionDetails.reason} ${routing.reason}`;
    const taskStatus = hardReservationCommitted ? "reserved" : effectiveAdmission === "HOLD" || effectiveAdmission === "MIGRATE" ? "paused" : "queued";
    await tx.update(researchTasks).set({ status: taskStatus, admissionDecision: effectiveAdmission, updatedAt: new Date() }).where(eq(researchTasks.id, taskId));
    const attemptResult = await tx.insert(taskAttempts).values({
      workspaceId: input.workspaceId,
      taskId,
      attemptNumber: 1,
      requestedModelId: recommendedModelId,
      actualModelId: recommendedModelId,
      modelRegistryId: selectedRegistryModel?.id,
      provider: attemptProvider,
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
      routePlan: routing.routePlan,
      requiresHumanHandoff: decisionDetails.human,
    });
    return {
      taskId,
      reserved: hardReservationCommitted,
      softReserved: softReservationCommitted,
      reservationKind,
      state: hardReservationCommitted ? "RESERVED" as const : effectiveAdmission === "HOLD" ? "PAUSED" as const : "QUEUED" as const,
      admission: effectiveAdmission,
    };
  });
  await refreshWorkspaceBudgets(input.workspaceId).catch(error => console.error("[QuotaPilot] reservation committed but budget refresh failed", error));
  return result;
}

export async function evaluateRouteLabPolicy(input: {
  workspaceId: number;
  priority: "P0" | "P1" | "P2" | "P3";
  routeMode: RouteMode;
  scenario: "none" | "rate_limit" | "quota_low" | "timeout" | "context_overflow";
  requirements: TaskRequirements;
  estimatedCostUsd: number;
  requestedModelId?: string;
}) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
  await refreshWorkspaceBudgets(input.workspaceId);
  const [models, connections, budgets, runningAttempts] = await Promise.all([
    db.select().from(modelRegistry).where(eq(modelRegistry.isActive, true)),
    db.select().from(providerConnections).where(eq(providerConnections.workspaceId, input.workspaceId)),
    db.select().from(providerBudgets).where(and(eq(providerBudgets.workspaceId, input.workspaceId), eq(providerBudgets.window, "five_hour"))),
    db.select().from(taskAttempts).where(and(eq(taskAttempts.workspaceId, input.workspaceId), eq(taskAttempts.status, "running"))),
  ]);
  const activeConcurrencyByModel = new Map<string, number>();
  for (const attempt of runningAttempts) {
    const modelId = attempt.actualModelId ?? attempt.requestedModelId;
    if (modelId) activeConcurrencyByModel.set(modelId, (activeConcurrencyByModel.get(modelId) ?? 0) + 1);
  }
  const budgetByConnectionId = new Map(budgets.map(budget => [budget.providerConnectionId, budget]));
  const providerContexts = connections
    .filter(connection => connection.provider !== "chatgpt_plus_manual")
    .map(connection => {
      const budget = budgetByConnectionId.get(connection.id);
      return {
        provider: connection.provider as "opencode_go" | "openai_api" | "local",
        availableUsd: budget ? asNumber(budget.limitUsd) - asNumber(budget.consumedUsd) - asNumber(budget.reservedUsd) : undefined,
        connectionState: connection.connectionState,
        secretState: connection.secretState,
      };
    });
  const routing = buildUnifiedRoutePlan({
    requirements: input.requirements,
    models: models.map(model => ({
      provider: model.provider,
      modelId: model.modelId,
      displayName: model.displayName,
      inputPerMillionUsd: asNumber(model.inputPerMillionUsd),
      outputPerMillionUsd: asNumber(model.outputPerMillionUsd),
      scarcityFactor: asNumber(model.scarcityFactor),
      maxConcurrency: Math.max(0, model.maxConcurrency - (activeConcurrencyByModel.get(model.modelId) ?? 0)),
      activeConcurrency: activeConcurrencyByModel.get(model.modelId) ?? 0,
      maxContextTokens: model.maxContextTokens,
      capability: model.capability,
    })),
    routeMode: input.routeMode,
    requestedModelId: input.requestedModelId,
    estimatedCostUsd: input.estimatedCostUsd,
    providerContexts,
  });
  const selectedConnection = connections.find(connection => connection.provider === routing.selectedProvider);
  const selectedBudget = selectedConnection ? budgetByConnectionId.get(selectedConnection.id) : budgets[0];
  const budgetState = selectedBudget?.state ?? "GREEN";
  const availableUsd = selectedBudget ? asNumber(selectedBudget.limitUsd) - asNumber(selectedBudget.consumedUsd) - asNumber(selectedBudget.reservedUsd) : 0;
  const baseDecision = routing.blockedByCapability || routing.blockedByBudget
    ? "HOLD" as const
    : getAdmissionDecision({ priority: input.priority, routeMode: input.routeMode, estimatedCostUsd: input.estimatedCostUsd, availableUsd, dynamicReserveUsd: asNumber(selectedBudget?.dynamicReserveUsd), budgetState });
  const scenarioDecision = input.scenario === "rate_limit" || input.scenario === "timeout" || input.scenario === "context_overflow"
    ? "QUEUE" as const
    : input.scenario === "quota_low"
      ? input.routeMode === "strict" ? "HOLD" as const : "MIGRATE" as const
      : baseDecision;
  const scenarioReason = input.scenario === "rate_limit"
    ? "Route Lab 场景注入 RATE_LIMIT：服务端建议受退避时间约束地排队，不发起真实请求。"
    : input.scenario === "quota_low"
      ? "Route Lab 场景注入共享额度低：严格模式保持暂停，其他模式仅建议能力合格的迁移候选。"
      : input.scenario === "timeout"
        ? "Route Lab 场景注入 TIMEOUT：服务端建议应用输出与工具降级配置后排队。"
        : input.scenario === "context_overflow"
          ? "Route Lab 场景注入 CONTEXT_OVERFLOW：服务端建议应用上下文压缩与分块配置后排队。"
          : routing.reason;
  const inserted = await db.insert(routePolicyEvaluations).values({
    workspaceId: input.workspaceId,
    priority: input.priority,
    routeMode: input.routeMode,
    scenario: input.scenario,
    requirements: input.requirements,
    estimatedCostUsd: input.estimatedCostUsd.toFixed(6),
    requestedModelId: input.requestedModelId,
    selectedModelId: routing.recommendedModelId,
    admissionDecision: scenarioDecision,
    budgetState,
    reason: scenarioReason,
    routePlan: routing.routePlan,
  });
  return { evaluationId: Number(inserted[0].insertId), decision: scenarioDecision, budgetState, availableUsd, selectedModelId: routing.recommendedModelId, reason: scenarioReason, routePlan: routing.routePlan, providerCallsDisabled: true };
}

export async function claimTaskForLocalExecution(input: { workspaceId: number; taskId: number }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
  const result = await db.transaction(async tx => {
    const task = (await tx.select().from(researchTasks).where(and(
      eq(researchTasks.id, input.taskId),
      eq(researchTasks.workspaceId, input.workspaceId),
      inArray(researchTasks.status, ["queued", "reserved"]),
    )).limit(1))[0];
    if (!task) throw new TRPCError({ code: "CONFLICT", message: "任务不存在、已被领取或当前状态不可执行。" });
    const attempt = (await tx.select().from(taskAttempts).where(and(
      eq(taskAttempts.taskId, task.id),
      eq(taskAttempts.workspaceId, input.workspaceId),
      eq(taskAttempts.status, "queued"),
    )).limit(1))[0];
    if (!attempt) throw new TRPCError({ code: "CONFLICT", message: "任务没有可领取的 queued attempt。" });
    if (attempt.retryNotBefore && attempt.retryNotBefore > new Date()) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `该 attempt 正在退避，最早可于 ${attempt.retryNotBefore.toISOString()} 重新领取。` });
    }
    const reservation = (await tx.select().from(budgetReservations).where(eq(budgetReservations.taskId, task.id)).limit(1))[0];
    const connection = (await tx.select().from(providerConnections).where(and(
      eq(providerConnections.workspaceId, input.workspaceId),
      eq(providerConnections.provider, attempt.provider as "opencode_go" | "openai_api" | "chatgpt_plus_manual" | "local"),
    )).limit(1))[0];
    if (connection?.circuitOpenUntil && connection.circuitOpenUntil > new Date()) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Provider 因 ${connection.circuitReason ?? "未知故障"} 正处于短路冷却期，最早可于 ${connection.circuitOpenUntil.toISOString()} 后重新领取。` });
    }
    const budget = connection ? (await tx.select().from(providerBudgets).where(and(
      eq(providerBudgets.providerConnectionId, connection.id),
      eq(providerBudgets.window, "five_hour"),
    )).limit(1))[0] : undefined;
    if (!budget) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "任务模型缺少可执行的五小时共享预算。" });
    const remainingTaskBudget = task.remainingBudgetUsd === null || task.remainingBudgetUsd === undefined
      ? Math.max(0, taskCostCapUsd(task) - asNumber(task.actualCostUsd))
      : asNumber(task.remainingBudgetUsd);
    if (asNumber(task.estimatedCostUsd) > remainingTaskBudget) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "执行前任务成本上限校验失败；预计成本超过任务剩余预算。" });
    }

    const concurrencyModel = attempt.modelRegistryId
      ? (await tx.select().from(modelRegistry).where(and(eq(modelRegistry.id, attempt.modelRegistryId), eq(modelRegistry.isActive, true))).limit(1))[0]
      : attempt.modelRegistryId === null
        ? (await tx.select().from(modelRegistry).where(and(
          eq(modelRegistry.modelId, attempt.requestedModelId ?? task.requestedModelId ?? ""),
          eq(modelRegistry.provider, attempt.provider as "opencode_go" | "openai_api" | "local"),
          eq(modelRegistry.isActive, true),
        )).limit(1))[0]
        : undefined;
    if (attempt.modelRegistryId === null && !concurrencyModel) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "旧 attempt 无法匹配活跃模型版本；拒绝绕过模型并发预算领取。" });
    }
    let providerConcurrencyClaimed = false;
    let modelConcurrencyClaimed = false;
    const releaseConcurrency = async () => {
      if (modelConcurrencyClaimed && concurrencyModel) {
        await tx.update(modelConcurrencyBudgets).set({ runningExecutions: sql`GREATEST(${modelConcurrencyBudgets.runningExecutions} - 1, 0)`, updatedAt: new Date() }).where(and(
          eq(modelConcurrencyBudgets.workspaceId, input.workspaceId),
          eq(modelConcurrencyBudgets.modelRegistryId, concurrencyModel.id),
        ));
      }
      if (providerConcurrencyClaimed && connection) {
        await tx.update(providerConnections).set({ runningExecutions: sql`GREATEST(${providerConnections.runningExecutions} - 1, 0)`, updatedAt: new Date() }).where(eq(providerConnections.id, connection.id));
      }
    };
    if (concurrencyModel && connection) {
      const providerClaim = await tx.update(providerConnections).set({ runningExecutions: sql`${providerConnections.runningExecutions} + 1`, updatedAt: new Date() }).where(and(
        eq(providerConnections.id, connection.id),
        sql`${providerConnections.runningExecutions} < ${providerConnections.maxConcurrentExecutions}`,
      ));
      if (providerClaim[0].affectedRows !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Provider 并发槽位已满；任务保持排队。" });
      providerConcurrencyClaimed = true;
      await tx.insert(modelConcurrencyBudgets).values({
        workspaceId: input.workspaceId,
        modelRegistryId: concurrencyModel.id,
        maxConcurrentExecutions: concurrencyModel.maxConcurrency,
      }).onDuplicateKeyUpdate({ set: { maxConcurrentExecutions: concurrencyModel.maxConcurrency, updatedAt: new Date() } });
      const modelClaim = await tx.update(modelConcurrencyBudgets).set({ runningExecutions: sql`${modelConcurrencyBudgets.runningExecutions} + 1`, updatedAt: new Date() }).where(and(
        eq(modelConcurrencyBudgets.workspaceId, input.workspaceId),
        eq(modelConcurrencyBudgets.modelRegistryId, concurrencyModel.id),
        sql`${modelConcurrencyBudgets.runningExecutions} < ${modelConcurrencyBudgets.maxConcurrentExecutions}`,
      ));
      if (modelClaim[0].affectedRows !== 1) {
        await releaseConcurrency();
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "模型并发槽位已满；任务保持排队。" });
      }
      modelConcurrencyClaimed = true;
    }

    let claimKind: "existing_hard" | "soft_upgraded" | "p3_hard" = "existing_hard";
    if (!reservation || reservation.reservationKind === "soft" || reservation.status !== "RESERVED") {
      const conditionalReserve = await tx.update(providerBudgets).set({
        reservedUsd: sql`${providerBudgets.reservedUsd} + ${task.estimatedCostUsd}`,
        updatedAt: new Date(),
      }).where(and(
        eq(providerBudgets.id, budget.id),
        sql`${providerBudgets.limitUsd} - ${providerBudgets.consumedUsd} - ${providerBudgets.reservedUsd} >= ${task.estimatedCostUsd}`,
      ));
      if (conditionalReserve[0].affectedRows !== 1) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "执行前共享额度二次准入失败；任务保持排队且不会超卖预算。" });
      }
      if (reservation) {
        await tx.update(budgetReservations).set({ amountUsd: task.estimatedCostUsd, reservationKind: "hard", status: "RESERVED", expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000), updatedAt: new Date() }).where(eq(budgetReservations.id, reservation.id));
        claimKind = reservation.reservationKind === "soft" ? "soft_upgraded" : "p3_hard";
      } else {
        await tx.insert(budgetReservations).values({
          workspaceId: input.workspaceId,
          providerBudgetId: budget.id,
          taskId: task.id,
          amountUsd: task.estimatedCostUsd,
          reservationKind: "hard",
          status: "RESERVED",
          expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        });
        claimKind = "p3_hard";
      }
    }

    const taskClaim = await tx.update(researchTasks).set({ status: "running", startedAt: new Date(), updatedAt: new Date() }).where(and(
      eq(researchTasks.id, task.id),
      inArray(researchTasks.status, ["queued", "reserved"]),
    ));
    if (taskClaim[0].affectedRows !== 1) {
      await releaseConcurrency();
      throw new TRPCError({ code: "CONFLICT", message: "任务已被其他执行者领取。" });
    }
    const attemptClaim = await tx.update(taskAttempts).set({ status: "running", modelRegistryId: concurrencyModel?.id ?? attempt.modelRegistryId, concurrencyClaimed: modelConcurrencyClaimed, startedAt: new Date() }).where(and(eq(taskAttempts.id, attempt.id), eq(taskAttempts.status, "queued")));
    if (attemptClaim[0].affectedRows !== 1) {
      await releaseConcurrency();
      throw new TRPCError({ code: "CONFLICT", message: "attempt 已被其他执行者领取。" });
    }
    return { taskId: task.id, attemptId: attempt.id, claimKind, provider: attempt.provider ?? "unknown", executionPlan: attempt.executionPlan ?? null };
  });
  await refreshWorkspaceBudgets(input.workspaceId);
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
  failureReason?: FailureDomain;
  resultClass: "official" | "fallback" | "exploratory" | "recovery";
}) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
  if (!Number.isFinite(input.actualCostUsd) || input.actualCostUsd < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "实际成本必须为非负数。" });
  }
  const settled = await db.transaction(async tx => {
    const task = (await tx.select().from(researchTasks).where(and(eq(researchTasks.id, input.taskId), eq(researchTasks.workspaceId, input.workspaceId))).limit(1))[0];
    const attempt = (await tx.select().from(taskAttempts).where(and(eq(taskAttempts.id, input.attemptId), eq(taskAttempts.taskId, input.taskId), eq(taskAttempts.workspaceId, input.workspaceId))).limit(1))[0];
    if (!task || !attempt) throw new TRPCError({ code: "NOT_FOUND", message: "任务或执行 attempt 不存在。" });
    if (["completed", "failed", "cancelled"].includes(attempt.status)) throw new TRPCError({ code: "CONFLICT", message: "该 attempt 已结算，拒绝重复记账。" });
    if ((input.fallback || input.actualModelId !== task.requestedModelId) && input.resultClass === "official") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "模型切换后的 attempt 不能写入 official 结果；请标记为 fallback 或 recovery。" });
    }
    const cumulativeCostCapUsd = taskCostCapUsd(task);
    const remainingTaskBudget = task.remainingBudgetUsd === null || task.remainingBudgetUsd === undefined
      ? Math.max(0, cumulativeCostCapUsd - asNumber(task.actualCostUsd))
      : asNumber(task.remainingBudgetUsd);
    const nextActualCostUsd = asNumber(task.actualCostUsd) + input.actualCostUsd;
    if (input.actualCostUsd > remainingTaskBudget || nextActualCostUsd > cumulativeCostCapUsd) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "实际成本超过任务累计成本上限或剩余预算，系统拒绝写入结算。" });
    }
    const finalResultClass = input.fallback || input.actualModelId !== task.requestedModelId
      ? input.resultClass === "official" ? "fallback" : input.resultClass
      : input.resultClass;
    const failureReason = input.status === "failed" ? input.failureReason ?? "UNKNOWN" : null;
    const failurePolicy = failureReason ? getFailurePolicy(failureReason, task.priority) : null;
    const failureExecutionPlan = failureReason ? getFailureExecutionPlan(failureReason) : null;
    const maxAttempts = task.maxAttempts ?? 3;
    const attemptNumber = attempt.attemptNumber ?? 1;
    const canScheduleRetry = input.status === "failed"
      && failurePolicy?.retryMode === "backoff"
      && Number(attemptNumber) < maxAttempts;
    const retryNotBefore = canScheduleRetry
      ? new Date(Date.now() + (failurePolicy?.retryAfterSeconds ?? 0) * 1_000)
      : null;
    const finalTaskStatus = input.status === "completed"
      ? "completed"
      : input.status === "cancelled"
        ? "cancelled"
        : canScheduleRetry
          ? "queued"
          : failurePolicy?.recommendedAction === "hold" || failurePolicy?.recommendedAction === "migrate" || failurePolicy?.recommendedAction === "manual_handoff"
            ? "paused"
            : "failed";
    const completedAt = canScheduleRetry ? null : new Date();
    const didFallback = input.fallback || input.actualModelId !== task.requestedModelId;
    const fallbackReason = didFallback ? input.fallbackReason ?? "manual" : null;
    const tokenSnapshot = { inputTokens: input.inputTokens, outputTokens: input.outputTokens, cacheReadTokens: input.cacheReadTokens, cacheWriteTokens: input.cacheWriteTokens };
    await tx.update(taskAttempts).set({ actualModelId: input.actualModelId, fallback: didFallback, fallbackReason, failureReason, failurePolicy, resultClass: finalResultClass, status: input.status, actualCostUsd: input.actualCostUsd.toFixed(6), completedAt: new Date() }).where(eq(taskAttempts.id, attempt.id));
    await tx.insert(experimentExecutionLedger).values({
      workspaceId: input.workspaceId,
      taskId: task.id,
      attemptId: attempt.id,
      modelRegistryId: attempt.modelRegistryId,
      provider: attempt.provider ?? "opencode_go",
      requestedModelId: task.requestedModelId,
      actualModelId: input.actualModelId,
      priority: task.priority,
      taskClass: task.taskClass,
      resultClass: finalResultClass,
      status: input.status,
      fallback: didFallback,
      fallbackReason,
      failureReason,
      quotaState: attempt.quotaState,
      tokens: tokenSnapshot,
      estimatedCostUsd: attempt.estimatedCostUsd,
      actualCostUsd: input.actualCostUsd.toFixed(6),
      promptHash: attempt.promptHash,
      experimentId: task.experimentId,
      runId: task.runId,
      executionPlan: attempt.executionPlan,
    });
    await tx.update(researchTasks).set({ actualCostUsd: nextActualCostUsd.toFixed(6), remainingBudgetUsd: Math.max(0, cumulativeCostCapUsd - nextActualCostUsd).toFixed(6), resultClass: finalResultClass, status: finalTaskStatus, queuedAt: canScheduleRetry ? new Date() : task.queuedAt, completedAt, updatedAt: new Date() }).where(eq(researchTasks.id, task.id));
    if (canScheduleRetry) {
      await tx.insert(taskAttempts).values({
        workspaceId: input.workspaceId,
        taskId: task.id,
        attemptNumber: Number(attemptNumber) + 1,
        requestedModelId: task.requestedModelId,
        actualModelId: task.requestedModelId,
        modelRegistryId: attempt.modelRegistryId,
        provider: attempt.provider,
        quotaState: attempt.quotaState,
        resultClass: finalResultClass,
        estimatedCostUsd: attempt.estimatedCostUsd,
        executionPlan: failureExecutionPlan,
        retryNotBefore,
        status: "queued",
      });
    }
    if (failurePolicy && !canScheduleRetry && failurePolicy.recommendedAction !== "queue") {
      const admissionDecision = failurePolicy.recommendedAction === "migrate"
        ? "MIGRATE" as const
        : failurePolicy.recommendedAction === "hold"
          ? "HOLD" as const
          : "HOLD" as const;
      await tx.insert(routeDecisions).values({
        workspaceId: input.workspaceId,
        taskId: task.id,
        attemptId: attempt.id,
        admissionDecision,
        budgetState: attempt.quotaState ?? "GREEN",
        availableUsd: "0.000000",
        dynamicReserveUsd: "0.000000",
        estimatedCostUsd: attempt.estimatedCostUsd,
        reason: `执行失败域 ${failureReason}：${failurePolicy.degradationSteps.join("；")}。`,
        recommendedAction: failurePolicy.recommendedAction,
        selectedModelId: task.requestedModelId,
        requiresHumanHandoff: failurePolicy.requiresHumanHandoff,
      });
    }
    const reservationStatus = input.status === "completed" ? "CONSUMED" : "RELEASED";
    await tx.update(budgetReservations).set({ status: reservationStatus, updatedAt: new Date() }).where(and(eq(budgetReservations.taskId, task.id), eq(budgetReservations.status, "RESERVED")));
    const connection = (await tx.select().from(providerConnections).where(and(eq(providerConnections.workspaceId, input.workspaceId), eq(providerConnections.provider, (attempt.provider ?? "opencode_go") as "opencode_go" | "openai_api" | "chatgpt_plus_manual" | "local"))).limit(1))[0];
    if (attempt.concurrencyClaimed) {
      if (attempt.modelRegistryId) {
        await tx.update(modelConcurrencyBudgets).set({ runningExecutions: sql`GREATEST(${modelConcurrencyBudgets.runningExecutions} - 1, 0)`, updatedAt: new Date() }).where(and(
          eq(modelConcurrencyBudgets.workspaceId, input.workspaceId),
          eq(modelConcurrencyBudgets.modelRegistryId, attempt.modelRegistryId),
        ));
      }
      if (connection) {
        await tx.update(providerConnections).set({ runningExecutions: sql`GREATEST(${providerConnections.runningExecutions} - 1, 0)`, updatedAt: new Date() }).where(eq(providerConnections.id, connection.id));
      }
    }
    if (failurePolicy && (failurePolicy.circuitScope === "provider" || failurePolicy.circuitScope === "provider_window") && connection) {
      const circuitOpenUntil = retryNotBefore ?? new Date(Date.now() + 5 * 60 * 1_000);
      await tx.update(providerConnections).set({ connectionState: "degraded", circuitOpenUntil, circuitReason: failureReason, updatedAt: new Date() }).where(eq(providerConnections.id, connection.id));
    }
    await tx.insert(usageEvents).values({ workspaceId: input.workspaceId, providerConnectionId: connection?.id, modelRegistryId: attempt.modelRegistryId, provider: attempt.provider ?? "opencode_go", modelId: input.actualModelId, tokens: tokenSnapshot, estimatedCostUsd: attempt.estimatedCostUsd, actualCostUsd: input.actualCostUsd.toFixed(6), budgetWindow: "five_hour", costUnit: "USD", costBasis: "mixed", source: "task_attempt", occurredAt: new Date(), externalRef: `attempt:${attempt.id}:settled` });
    return { taskStatus: finalTaskStatus, resultClass: finalResultClass, reservationStatus, failurePolicy, failureExecutionPlan, retryScheduledAt: retryNotBefore };
  });
  await refreshWorkspaceBudgets(input.workspaceId);
  return settled;
}

export async function queueTaskRetry(input: { workspaceId: number; taskId: number }) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
  return db.transaction(async tx => {
    const task = (await tx.select().from(researchTasks).where(and(
      eq(researchTasks.id, input.taskId),
      eq(researchTasks.workspaceId, input.workspaceId),
      inArray(researchTasks.status, ["failed", "cancelled"]),
    )).limit(1))[0];
    if (!task) throw new TRPCError({ code: "CONFLICT", message: "任务当前不可重试；请先完成或取消正在运行的 attempt。" });
    const attempts = await tx.select().from(taskAttempts).where(and(
      eq(taskAttempts.taskId, task.id),
      eq(taskAttempts.workspaceId, input.workspaceId),
    ));
    const retryAdmission = getTaskRetryAdmission({ attemptCount: attempts.length, maxAttempts: task.maxAttempts });
    if (!retryAdmission.admitted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: retryAdmission.reason });
    const previousAttempt = attempts.reduce((latest, attempt) => attempt.attemptNumber > latest.attemptNumber ? attempt : latest, attempts[0]);
    const nextAttemptNumber = Math.max(...attempts.map(attempt => attempt.attemptNumber)) + 1;
    const insertResult = await tx.insert(taskAttempts).values({
      workspaceId: input.workspaceId,
      taskId: task.id,
      attemptNumber: nextAttemptNumber,
      requestedModelId: task.requestedModelId,
      actualModelId: task.requestedModelId,
      modelRegistryId: previousAttempt?.modelRegistryId,
      provider: previousAttempt?.provider ?? "opencode_go",
      quotaState: previousAttempt?.quotaState,
      resultClass: task.resultClass,
      estimatedCostUsd: task.estimatedCostUsd,
      status: "queued",
    });
    await tx.update(researchTasks).set({ status: "queued", queuedAt: new Date(), completedAt: null, updatedAt: new Date() }).where(eq(researchTasks.id, task.id));
    return { taskId: task.id, attemptId: Number(insertResult[0].insertId), attemptNumber: nextAttemptNumber };
  });
}

export async function listWorkspaceDashboard(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const connections = await db.select().from(providerConnections).where(eq(providerConnections.workspaceId, workspaceId));
  const budgets = await db.select().from(providerBudgets).where(eq(providerBudgets.workspaceId, workspaceId));
  const snapshots = await db.select().from(quotaSnapshots).where(eq(quotaSnapshots.workspaceId, workspaceId)).orderBy(desc(quotaSnapshots.capturedAt)).limit(72);
  const models = await db.select().from(modelRegistry).where(eq(modelRegistry.isActive, true));
  const tasks = await db.select().from(researchTasks).where(eq(researchTasks.workspaceId, workspaceId)).orderBy(desc(researchTasks.createdAt)).limit(24);
  const attempts = await db.select().from(taskAttempts).where(eq(taskAttempts.workspaceId, workspaceId)).orderBy(desc(taskAttempts.createdAt)).limit(36);
  const events = await db.select().from(usageEvents).where(and(eq(usageEvents.workspaceId, workspaceId), gte(usageEvents.occurredAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)))).orderBy(desc(usageEvents.occurredAt));
  const reservations = await db.select().from(budgetReservations).where(and(eq(budgetReservations.workspaceId, workspaceId), eq(budgetReservations.status, "RESERVED")));
  const alerts = await db.select().from(budgetAlerts).where(eq(budgetAlerts.workspaceId, workspaceId)).orderBy(desc(budgetAlerts.createdAt)).limit(12);
  const decisions = await db.select().from(routeDecisions).where(eq(routeDecisions.workspaceId, workspaceId)).orderBy(desc(routeDecisions.createdAt)).limit(24);
  return { workspace, connections, budgets, snapshots, models, tasks, attempts, events, reservations, alerts, decisions };
}
