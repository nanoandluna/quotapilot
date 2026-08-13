import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const doubles = vi.hoisted(() => ({
  getDb: vi.fn(),
  requireWorkspaceRole: vi.fn(),
  ensurePersonalWorkspace: vi.fn(),
  listWorkspaceDashboard: vi.fn(),
  recordTaskAttemptExecution: vi.fn(),
  reserveTaskBudget: vi.fn(),
  saveUsageImport: vi.fn(),
  scoreCandidateModels: vi.fn(),
  evaluateRouteLabPolicy: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: doubles.getDb }));
vi.mock("./quotaService", () => ({
  requireWorkspaceRole: doubles.requireWorkspaceRole,
  ensurePersonalWorkspace: doubles.ensurePersonalWorkspace,
  listWorkspaceDashboard: doubles.listWorkspaceDashboard,
  recordTaskAttemptExecution: doubles.recordTaskAttemptExecution,
  reserveTaskBudget: doubles.reserveTaskBudget,
  saveUsageImport: doubles.saveUsageImport,
  scoreCandidateModels: doubles.scoreCandidateModels,
  evaluateRouteLabPolicy: doubles.evaluateRouteLabPolicy,
}));

import { quotaRouter } from "./routers/quota";

function selectRows<T>(rows: T[]) {
  const query = {
    limit: async () => rows,
    then: <TResult1 = T[], TResult2 = never>(
      onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(rows).then(onfulfilled, onrejected),
  };
  return { from: () => ({ where: () => query }) };
}

function authenticatedContext(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "owner",
      name: "Owner",
      email: "owner@example.test",
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("QuotaPilot V2 route decision state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.requireWorkspaceRole.mockResolvedValue({ role: "researcher" });
  });

  it("rejects an already consumed route decision before changing its task", async () => {
    const transaction = { select: vi.fn(() => selectRows([])), update: vi.fn() };
    doubles.getDb.mockResolvedValue({ transaction: vi.fn((work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)) });

    const caller = quotaRouter.createCaller(authenticatedContext());
    await expect(caller.actOnRouteDecision({ workspaceId: 7, decisionId: 99, action: "hold" })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(transaction.update).not.toHaveBeenCalled();
  });

  it("does not update a task when the decision CAS loses a concurrent race", async () => {
    const rows = [
      [{ id: 99, workspaceId: 7, taskId: 42, admissionDecision: "HOLD", selectedModelId: "candidate", actedAt: null }],
      [{ id: 42, workspaceId: 7, status: "paused", admissionDecision: "HOLD", requestedModelId: "candidate" }],
    ];
    const setRouteDecision = vi.fn(() => ({ where: async () => [{ affectedRows: 0 }] }));
    const transaction = {
      select: vi.fn(() => selectRows(rows.shift() ?? [])),
      update: vi.fn(() => ({ set: setRouteDecision })),
    };
    doubles.getDb.mockResolvedValue({ transaction: vi.fn((work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)) });

    const caller = quotaRouter.createCaller(authenticatedContext());
    await expect(caller.actOnRouteDecision({ workspaceId: 7, decisionId: 99, action: "hold" })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(transaction.update).toHaveBeenCalledTimes(1);
  });

  it("sends Route Lab scenarios to the protected server-side policy evaluator", async () => {
    doubles.evaluateRouteLabPolicy.mockResolvedValue({ evaluationId: 12, decision: "QUEUE", providerCallsDisabled: true });
    const caller = quotaRouter.createCaller(authenticatedContext());

    const result = await caller.evaluateRouteLab({
      workspaceId: 7,
      priority: "P2",
      routeMode: "balanced",
      scenario: "rate_limit",
      requirements: { code: 6, speed: 8 },
      estimatedCostUsd: 0.08,
      requestedModelId: "deepseek-v4-flash",
    });

    expect(result).toMatchObject({ evaluationId: 12, decision: "QUEUE", providerCallsDisabled: true });
    expect(doubles.evaluateRouteLabPolicy).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 7,
      priority: "P2",
      routeMode: "balanced",
      scenario: "rate_limit",
      estimatedCostUsd: 0.08,
    }));
  });

  it.each(["none", "rate_limit", "quota_low", "timeout", "context_overflow"] as const)("accepts the %s Route Lab scenario through the protected policy boundary", async scenario => {
    doubles.evaluateRouteLabPolicy.mockResolvedValue({ evaluationId: 13, decision: "QUEUE", providerCallsDisabled: true });
    const caller = quotaRouter.createCaller(authenticatedContext());

    await caller.evaluateRouteLab({
      workspaceId: 7,
      priority: "P2",
      routeMode: "balanced",
      scenario,
      requirements: { code: 6 },
      estimatedCostUsd: 0.08,
    });

    expect(doubles.evaluateRouteLabPolicy).toHaveBeenLastCalledWith(expect.objectContaining({ scenario, workspaceId: 7 }));
  });

  it("requires reviewer authority for imported consumption, formal tasks, official results, and route decisions", async () => {
    const caller = quotaRouter.createCaller(authenticatedContext());
    doubles.reserveTaskBudget.mockResolvedValue({ taskId: 12 });
    doubles.recordTaskAttemptExecution.mockResolvedValue({ taskStatus: "completed" });
    doubles.saveUsageImport.mockResolvedValue({ acceptedRows: 1 });

    await caller.importUsage({ workspaceId: 7, filename: "usage.csv", mimeType: "text/csv", content: "provider,model_id\nopencode_go,deepseek-v4-flash" });
    expect(doubles.requireWorkspaceRole).toHaveBeenLastCalledWith(7, 1, "reviewer");

    await caller.createTask({ workspaceId: 7, title: "正式复现实验", priority: "P1", taskClass: "formal_experiment", resultClass: "official", estimatedCostUsd: 0.2, taskBudgetUsd: 1 });
    expect(doubles.requireWorkspaceRole).toHaveBeenLastCalledWith(7, 1, "reviewer");

    await caller.recordAttempt({ workspaceId: 7, taskId: 12, attemptId: 19, actualModelId: "deepseek-v4-pro", actualCostUsd: 0.2, status: "completed", fallback: false, resultClass: "official" });
    expect(doubles.requireWorkspaceRole).toHaveBeenLastCalledWith(7, 1, "reviewer");

    doubles.getDb.mockResolvedValue(null);
    await expect(caller.actOnRouteDecision({ workspaceId: 7, decisionId: 10, action: "hold" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(doubles.requireWorkspaceRole).toHaveBeenLastCalledWith(7, 1, "reviewer");
  });

  it("keeps non-official development task creation available to researchers", async () => {
    doubles.reserveTaskBudget.mockResolvedValue({ taskId: 13 });
    const caller = quotaRouter.createCaller(authenticatedContext());

    await caller.createTask({ workspaceId: 7, title: "开发验证", priority: "P2", taskClass: "development", resultClass: "exploratory", estimatedCostUsd: 0.05, taskBudgetUsd: 0.5 });

    expect(doubles.requireWorkspaceRole).toHaveBeenLastCalledWith(7, 1, "researcher");
  });

  it("binds a manually selected migration candidate to the queued attempt before releasing the task back to queue", async () => {
    const rows = [
      [{ id: 100, workspaceId: 7, taskId: 43, admissionDecision: "MIGRATE", selectedModelId: "deepseek-v4-flash", actedAt: null }],
      [{ id: 43, workspaceId: 7, status: "paused", admissionDecision: "MIGRATE", requestedModelId: "deepseek-v4-flash", requirements: {}, estimatedCostUsd: "0.100000" }],
      [{ id: 88, provider: "opencode_go", modelId: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", inputPerMillionUsd: "0.4", outputPerMillionUsd: "0.8", scarcityFactor: "0.7", maxConcurrency: 2, maxContextTokens: 128000, capability: {}, isActive: true }],
      [{ id: 5, provider: "opencode_go", connectionState: "connected", secretState: "configured" }],
      [{ id: 8, providerConnectionId: 5, window: "five_hour", limitUsd: "10", consumedUsd: "1", reservedUsd: "0" }],
      [],
    ];
    const updateSets = vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] }));
    const eventValues = vi.fn(async () => undefined);
    const transaction = {
      select: vi.fn(() => selectRows(rows.shift() ?? [])),
      update: vi.fn(() => ({ set: updateSets })),
      insert: vi.fn(() => ({ values: eventValues })),
    };
    doubles.scoreCandidateModels.mockReturnValue([{ modelId: "deepseek-v4-pro" }]);
    doubles.getDb.mockResolvedValue({ transaction: vi.fn((work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)) });

    const caller = quotaRouter.createCaller(authenticatedContext());
    const result = await caller.actOnRouteDecision({ workspaceId: 7, decisionId: 100, action: "migrate", candidateModelId: "deepseek-v4-pro" });

    expect(result).toMatchObject({ ok: true, taskId: 43, status: "queued" });
    expect(updateSets.mock.calls[0]?.[0]).toMatchObject({
      requestedModelId: "deepseek-v4-pro",
      actualModelId: "deepseek-v4-pro",
      modelRegistryId: 88,
      provider: "opencode_go",
      executionPlan: { preserveRequestedModel: false },
    });
    expect(eventValues).toHaveBeenCalledWith(expect.objectContaining({ kind: "route_decision", actorUserId: 1, payload: expect.objectContaining({ action: "migrate", selectedModelId: "deepseek-v4-pro" }) }));
    expect(eventValues).toHaveBeenCalledWith(expect.objectContaining({ kind: "task_resumed", actorUserId: 1, payload: expect.objectContaining({ source: "route_decision", status: "queued" }) }));
  });

  it("accepts a pending invite only for the invited email and binds the member transactionally", async () => {
    const transaction = {
      select: vi.fn(() => selectRows([{
        id: 55,
        token: "abcdefghijklmnopqrstuvwx",
        email: "owner@example.test",
        role: "researcher",
        status: "pending",
        workspaceId: 7,
        expiresAt: new Date(Date.now() + 60_000),
      }])),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] })) })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onDuplicateKeyUpdate: async () => undefined })) })),
    };
    doubles.getDb.mockResolvedValue({ transaction: vi.fn((work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)) });

    const caller = quotaRouter.createCaller(authenticatedContext());
    const result = await caller.acceptInvite({ token: "abcdefghijklmnopqrstuvwx" });

    expect(result).toMatchObject({ workspaceId: 7, role: "researcher" });
    expect(transaction.update).toHaveBeenCalledTimes(1);
    expect(transaction.insert).toHaveBeenCalledTimes(2);
  });

  it("returns a model's version trail through the protected history endpoint", async () => {
    const rows = [
      { id: 12, modelId: "deepseek-v4-pro", isActive: true, effectiveFrom: new Date("2026-08-13T00:00:00.000Z"), effectiveUntil: null },
      { id: 11, modelId: "deepseek-v4-pro", isActive: false, effectiveFrom: new Date("2026-08-01T00:00:00.000Z"), effectiveUntil: new Date("2026-08-13T00:00:00.000Z") },
    ];
    const db = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) })),
    };
    doubles.getDb.mockResolvedValue(db);

    const caller = quotaRouter.createCaller(authenticatedContext());
    const result = await caller.modelVersions({ workspaceId: 7, modelId: "deepseek-v4-pro" });

    expect(result).toEqual(rows);
    expect(result.map(version => version.isActive)).toEqual([true, false]);
  });
});
