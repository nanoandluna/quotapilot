import { beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  getDb: vi.fn(),
  storagePut: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: doubles.getDb }));
vi.mock("./storage", () => ({ storagePut: doubles.storagePut }));

import { claimInitialHardReservation, claimTaskForLocalExecution, listWorkspaceDashboard, queueTaskRetry, recordTaskAttemptExecution, saveUsageImport } from "./quotaService";
import { taskEvents } from "../drizzle/schema";

function selectRows<T>(rows: T[]) {
  const query = {
    limit: async () => rows,
    orderBy: () => query,
    then: <TResult1 = T[], TResult2 = never>(
      onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(rows).then(onfulfilled, onrejected),
  };
  return {
    from: () => ({
      where: () => query,
    }),
  };
}

function sequenceSelect(rows: unknown[][]) {
  return vi.fn(() => selectRows(rows.shift() ?? []));
}

describe("QuotaPilot V0.2 transaction guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a duplicate import before uploading or creating a second batch", async () => {
    const db = {
      select: vi.fn(() => selectRows([{ id: 41 }])),
    };
    doubles.getDb.mockResolvedValue(db);

    await expect(saveUsageImport({
      workspaceId: 7,
      userId: 11,
      filename: "august.csv",
      mimeType: "text/csv",
      content: "occurred_at,provider,model_id,actual_cost_usd\n2026-08-13T08:00:00Z,opencode_go,deepseek-v4-flash,0.002",
    })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("admits at most one concurrent initial hard reservation against the same shared budget", async () => {
    let capacityClaimsRemaining = 1;
    const buildTransaction = () => ({
      update: vi.fn(() => ({
        set: () => ({
          where: async () => [{ affectedRows: capacityClaimsRemaining-- > 0 ? 1 : 0 }],
        }),
      })),
    });

    const outcomes = await Promise.all([
      claimInitialHardReservation(buildTransaction(), 8, 0.5),
      claimInitialHardReservation(buildTransaction(), 8, 0.5),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(outcomes.filter(outcome => !outcome)).toHaveLength(1);
  });

  it("returns only the current ACTIVE model versions in the default workspace dashboard", async () => {
    const activeModel = { id: 22, modelId: "deepseek-v4-pro", isActive: true };
    const db = {
      select: sequenceSelect([
        [{ id: 7, name: "Research" }],
        [], [], [], [activeModel], [], [], [], [], [], [],
      ]),
    };
    doubles.getDb.mockResolvedValue(db);

    const dashboard = await listWorkspaceDashboard(7);

    expect(dashboard.models).toEqual([activeModel]);
    expect(dashboard.models.every(model => model.isActive)).toBe(true);
  });

  it("records a retryable failed batch when object storage rejects an import", async () => {
    const batchValues = vi.fn(async () => undefined);
    const db = {
      select: vi.fn(() => selectRows([])),
      insert: vi.fn(() => ({ values: batchValues })),
    };
    doubles.getDb.mockResolvedValue(db);
    doubles.storagePut.mockRejectedValue(new Error("object storage unavailable"));

    await expect(saveUsageImport({
      workspaceId: 7,
      userId: 11,
      filename: "august.csv",
      mimeType: "text/csv",
      content: "occurred_at,provider,model_id,actual_cost_usd\n2026-08-13T08:00:00Z,opencode_go,deepseek-v4-flash,0.002",
    })).rejects.toThrow("object storage unavailable");

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(batchValues).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      rowsAccepted: 0,
      rowsRejected: 1,
      storageKey: undefined,
      storageUrl: undefined,
    }));
  });

  it("rejects a second settlement when the attempt is already terminal", async () => {
    const selections = [
      [{ id: 100, taskBudgetUsd: "2.000000", requestedModelId: "deepseek-v4-flash" }],
      [{ id: 200, status: "completed", estimatedCostUsd: "0.100000" }],
    ];
    const transaction = {
      select: vi.fn(() => selectRows(selections.shift() ?? [])),
    };
    const db = {
      transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
    };
    doubles.getDb.mockResolvedValue(db);

    await expect(recordTaskAttemptExecution({
      workspaceId: 7,
      taskId: 100,
      attemptId: 200,
      actualModelId: "deepseek-v4-flash",
      actualCostUsd: 0.1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      status: "completed",
      fallback: false,
      resultClass: "official",
    })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(transaction.select).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["completed", "CONSUMED"],
    ["failed", "RELEASED"],
    ["cancelled", "RELEASED"],
  ] as const)("settles a %s attempt by marking its hard reservation %s and writing a usage event", async (status, expectedReservationStatus) => {
    const transactionSets = vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] }));
    const eventValues = vi.fn(async () => undefined);
    const transaction = {
      select: sequenceSelect([
        [{ id: 100, taskBudgetUsd: "2.000000", priority: "P1", taskClass: "formal_experiment", resultClass: "official", experimentId: "exp-7", runId: "run-3", requestedModelId: "deepseek-v4-flash" }],
        [{ id: 200, status: "running", modelRegistryId: 22, provider: "opencode_go", quotaState: "GREEN", promptHash: "prompt-abc", estimatedCostUsd: "0.100000" }],
        [{ id: 5, provider: "opencode_go" }],
      ]),
      update: vi.fn(() => ({ set: transactionSets })),
      insert: vi.fn(() => ({ values: eventValues })),
    };
    const refreshSets = vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] }));
    const snapshotValues = vi.fn(async () => undefined);
    const db = {
      transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
      select: sequenceSelect([
        [{ id: 7, researchPhase: "development" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "10.0000", consumedUsd: "0", reservedUsd: "0", dynamicReserveUsd: "0", resetPolicy: "rolling", resetAt: new Date("2026-08-13T18:00:00.000Z"), providerReportedResetAt: null }],
        [], [], [],
      ]),
      update: vi.fn(() => ({ set: refreshSets })),
      insert: vi.fn(() => ({ values: snapshotValues })),
    };
    doubles.getDb.mockResolvedValue(db);

    const result = await recordTaskAttemptExecution({
      workspaceId: 7,
      taskId: 100,
      attemptId: 200,
      actualModelId: "deepseek-v4-flash",
      actualCostUsd: 0.1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      status,
      fallback: false,
      failureReason: status === "failed" ? "RATE_LIMIT" : undefined,
      resultClass: "official",
    });

    expect(result.reservationStatus).toBe(expectedReservationStatus);
    if (status === "failed") {
      expect(transactionSets.mock.calls[0]?.[0]).toMatchObject({ failureReason: "RATE_LIMIT", failurePolicy: { recommendedAction: "queue", retryAfterSeconds: 15 } });
      expect(result).toMatchObject({ taskStatus: "queued", retryScheduledAt: expect.any(Date) });
      expect(transactionSets.mock.calls[1]?.[0]).toMatchObject({ status: "queued", completedAt: null });
      expect(eventValues).toHaveBeenCalledWith(expect.objectContaining({ attemptNumber: 2, retryNotBefore: expect.any(Date), status: "queued" }));
      expect(eventValues).toHaveBeenCalledWith(expect.objectContaining({ kind: "retry_queued", taskId: 100, attemptId: null }));
      expect(transactionSets.mock.calls[3]?.[0]).toMatchObject({ connectionState: "degraded", circuitReason: "RATE_LIMIT", circuitOpenUntil: expect.any(Date) });
    }
    expect(transactionSets.mock.calls[1]?.[0]).toMatchObject({ actualCostUsd: "0.100000", remainingBudgetUsd: "1.900000" });
    expect(transactionSets.mock.calls[2]?.[0]).toMatchObject({ status: expectedReservationStatus });
    expect(eventValues).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 200,
      modelRegistryId: 22,
      priority: "P1",
      taskClass: "formal_experiment",
      resultClass: "official",
      experimentId: "exp-7",
      runId: "run-3",
      promptHash: "prompt-abc",
      tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      actualCostUsd: "0.100000",
    }));
    expect(eventValues).toHaveBeenCalledWith(expect.objectContaining({ source: "task_attempt", externalRef: "attempt:200:settled" }));
    expect(eventValues).toHaveBeenCalledWith(expect.objectContaining({ kind: "attempt_settled", taskId: 100, attemptId: 200, payload: expect.objectContaining({ status, taskStatus: result.taskStatus }) }));
    expect(snapshotValues).toHaveBeenCalledWith(expect.objectContaining({ providerBudgetId: 8, window: "five_hour", limitUsd: "10.0000", state: "GREEN" }));
  });

  it("blocks a claim when the task remaining budget cannot cover its estimated execution cost", async () => {
    const transaction = {
      select: sequenceSelect([
        [{ id: 45, workspaceId: 7, status: "queued", estimatedCostUsd: "0.600000", taskBudgetUsd: "0.800000", cumulativeCostCapUsd: "0.800000", actualCostUsd: "0.000000", remainingBudgetUsd: "0.500000" }],
        [{ id: 203, taskId: 45, workspaceId: 7, status: "queued", provider: "opencode_go" }],
        [{ id: 302, taskId: 45, providerBudgetId: 8, reservationKind: "hard", status: "RESERVED" }],
        [{ id: 5, provider: "opencode_go" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "12.0000", consumedUsd: "1.0000", reservedUsd: "0.5000" }],
      ]),
      update: vi.fn(),
    };
    const db = {
      transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
    };
    doubles.getDb.mockResolvedValue(db);

    await expect(claimTaskForLocalExecution({ workspaceId: 7, taskId: 45 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it("blocks a queued retry until its failure-policy cooldown has elapsed", async () => {
    const transaction = {
      select: sequenceSelect([
        [{ id: 46, workspaceId: 7, status: "queued", estimatedCostUsd: "0.100000", taskBudgetUsd: "0.500000", cumulativeCostCapUsd: "0.500000", actualCostUsd: "0.100000", remainingBudgetUsd: "0.400000" }],
        [{ id: 204, taskId: 46, workspaceId: 7, status: "queued", provider: "opencode_go", retryNotBefore: new Date(Date.now() + 30_000) }],
      ]),
      update: vi.fn(),
    };
    doubles.getDb.mockResolvedValue({ transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction) });

    await expect(claimTaskForLocalExecution({ workspaceId: 7, taskId: 46 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it("blocks a claim while the target provider connection is circuit-open", async () => {
    const transaction = {
      select: sequenceSelect([
        [{ id: 48, workspaceId: 7, status: "queued", estimatedCostUsd: "0.100000", taskBudgetUsd: "0.500000", cumulativeCostCapUsd: "0.500000", actualCostUsd: "0.100000", remainingBudgetUsd: "0.400000" }],
        [{ id: 206, taskId: 48, workspaceId: 7, status: "queued", provider: "opencode_go", retryNotBefore: null }],
        [{ id: 303, taskId: 48, providerBudgetId: 8, reservationKind: "hard", status: "RESERVED" }],
        [{ id: 5, provider: "opencode_go", circuitReason: "RATE_LIMIT", circuitOpenUntil: new Date(Date.now() + 30_000) }],
      ]),
      update: vi.fn(),
    };
    doubles.getDb.mockResolvedValue({ transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction) });

    await expect(claimTaskForLocalExecution({ workspaceId: 7, taskId: 48 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it("pauses a model-unavailable failure and records an auditable migration decision instead of silently switching models", async () => {
    const transactionSets = vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] }));
    const insertValues = vi.fn(async () => undefined);
    const transaction = {
      select: sequenceSelect([
        [{ id: 47, workspaceId: 7, priority: "P2", taskBudgetUsd: "0.500000", cumulativeCostCapUsd: "0.500000", actualCostUsd: "0.000000", remainingBudgetUsd: "0.500000", requestedModelId: "deepseek-v4-flash" }],
        [{ id: 205, taskId: 47, status: "running", attemptNumber: 1, estimatedCostUsd: "0.100000", provider: "opencode_go", quotaState: "YELLOW" }],
        [{ id: 5, provider: "opencode_go" }],
      ]),
      update: vi.fn(() => ({ set: transactionSets })),
      insert: vi.fn(() => ({ values: insertValues })),
    };
    const refreshSets = vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] }));
    const db = {
      transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
      select: sequenceSelect([
        [{ id: 7, researchPhase: "development" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "10.0000", consumedUsd: "0", reservedUsd: "0", dynamicReserveUsd: "0", resetPolicy: "rolling", resetAt: new Date("2026-08-13T18:00:00.000Z"), providerReportedResetAt: null }],
        [], [], [],
      ]),
      update: vi.fn(() => ({ set: refreshSets })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    };
    doubles.getDb.mockResolvedValue(db);

    const result = await recordTaskAttemptExecution({
      workspaceId: 7,
      taskId: 47,
      attemptId: 205,
      actualModelId: "deepseek-v4-flash",
      actualCostUsd: 0.1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      status: "failed",
      fallback: false,
      failureReason: "MODEL_UNAVAILABLE",
      resultClass: "official",
    });

    expect(result).toMatchObject({ taskStatus: "paused", failurePolicy: { recommendedAction: "migrate", retryMode: "after_remediation" } });
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ admissionDecision: "MIGRATE", recommendedAction: "migrate", requiresHumanHandoff: false }));
  });

  it("queues a context-overflow retry with persisted executable compression constraints", async () => {
    const transactionSets = vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] }));
    const insertValues = vi.fn(async () => undefined);
    const transaction = {
      select: sequenceSelect([
        [{ id: 49, workspaceId: 7, priority: "P2", maxAttempts: 3, taskBudgetUsd: "0.500000", cumulativeCostCapUsd: "0.500000", actualCostUsd: "0.000000", remainingBudgetUsd: "0.500000", requestedModelId: "deepseek-v4-flash" }],
        [{ id: 207, taskId: 49, status: "running", attemptNumber: 1, estimatedCostUsd: "0.100000", provider: "opencode_go", quotaState: "GREEN" }],
        [{ id: 5, provider: "opencode_go" }],
      ]),
      update: vi.fn(() => ({ set: transactionSets })),
      insert: vi.fn(() => ({ values: insertValues })),
    };
    const db = {
      transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
      select: sequenceSelect([
        [{ id: 7, researchPhase: "development" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "10.0000", consumedUsd: "0", reservedUsd: "0", dynamicReserveUsd: "0", resetPolicy: "rolling", resetAt: new Date("2026-08-13T18:00:00.000Z"), providerReportedResetAt: null }],
        [], [], [],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] })) })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    };
    doubles.getDb.mockResolvedValue(db);

    const result = await recordTaskAttemptExecution({
      workspaceId: 7,
      taskId: 49,
      attemptId: 207,
      actualModelId: "deepseek-v4-flash",
      actualCostUsd: 0.1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      status: "failed",
      fallback: false,
      failureReason: "CONTEXT_OVERFLOW",
      resultClass: "official",
    });

    expect(result).toMatchObject({ taskStatus: "queued", failureExecutionPlan: { contextReductionRatio: 0.7, outputReductionRatio: 0.8, chunkInput: true } });
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      attemptNumber: 2,
      executionPlan: expect.objectContaining({ contextReductionRatio: 0.7, outputReductionRatio: 0.8, maxToolCalls: 3, maxAgentSteps: 3, chunkInput: true }),
    }));
  });

  it.each([
    { domain: "TIMEOUT" as const, priority: "P2", taskStatus: "queued", retryMode: "backoff", executionPlan: { outputReductionRatio: 0.7 }, routeAction: undefined, circuit: false },
    { domain: "PROVIDER_ERROR" as const, priority: "P2", taskStatus: "queued", retryMode: "backoff", executionPlan: { contextReductionRatio: 1 }, routeAction: undefined, circuit: true },
    { domain: "TOOL_ERROR" as const, priority: "P2", taskStatus: "queued", retryMode: "backoff", executionPlan: { maxToolCalls: 2, maxAgentSteps: 3 }, routeAction: undefined, circuit: false },
    { domain: "QUOTA" as const, priority: "P0", taskStatus: "paused", retryMode: "after_remediation", executionPlan: undefined, routeAction: "hold", circuit: true },
    { domain: "UNKNOWN" as const, priority: "P2", taskStatus: "paused", retryMode: "none", executionPlan: undefined, routeAction: "manual_handoff", circuit: false },
  ])("executes the $domain failure path", async ({ domain, priority, taskStatus, retryMode, executionPlan, routeAction, circuit }) => {
    const transactionSets = vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] }));
    const insertValues = vi.fn(async () => undefined);
    const transaction = {
      select: sequenceSelect([
        [{ id: 90, workspaceId: 7, priority, maxAttempts: 3, taskBudgetUsd: "0.500000", cumulativeCostCapUsd: "0.500000", actualCostUsd: "0.000000", remainingBudgetUsd: "0.500000", requestedModelId: "deepseek-v4-flash" }],
        [{ id: 290, taskId: 90, status: "running", attemptNumber: 1, estimatedCostUsd: "0.100000", provider: "opencode_go", quotaState: "GREEN" }],
        [{ id: 5, provider: "opencode_go" }],
      ]),
      update: vi.fn(() => ({ set: transactionSets })),
      insert: vi.fn(() => ({ values: insertValues })),
    };
    const db = {
      transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
      select: sequenceSelect([
        [{ id: 7, researchPhase: "development" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "10.0000", consumedUsd: "0", reservedUsd: "0", dynamicReserveUsd: "0", resetPolicy: "rolling", resetAt: new Date("2026-08-13T18:00:00.000Z"), providerReportedResetAt: null }],
        [], [], [],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] })) })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    };
    doubles.getDb.mockResolvedValue(db);

    const result = await recordTaskAttemptExecution({
      workspaceId: 7,
      taskId: 90,
      attemptId: 290,
      actualModelId: "deepseek-v4-flash",
      actualCostUsd: 0.1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      status: "failed",
      fallback: false,
      failureReason: domain,
      resultClass: "official",
    });

    expect(result).toMatchObject({ taskStatus, failurePolicy: { retryMode } });
    if (executionPlan) {
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ attemptNumber: 2, executionPlan: expect.objectContaining(executionPlan) }));
    } else {
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ recommendedAction: routeAction }));
    }
    if (circuit) {
      expect(transactionSets).toHaveBeenCalledWith(expect.objectContaining({ connectionState: "degraded", circuitReason: domain, circuitOpenUntil: expect.any(Date) }));
    }
  });

  it("rejects settlement when cumulative actual cost would exceed the task cap", async () => {
    const transaction = {
      select: sequenceSelect([
        [{ id: 101, workspaceId: 7, taskBudgetUsd: "0.500000", cumulativeCostCapUsd: "0.500000", actualCostUsd: "0.400000", remainingBudgetUsd: "0.100000", requestedModelId: "deepseek-v4-flash" }],
        [{ id: 201, status: "running", estimatedCostUsd: "0.100000", provider: "opencode_go" }],
      ]),
      update: vi.fn(),
    };
    const db = {
      transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
    };
    doubles.getDb.mockResolvedValue(db);

    await expect(recordTaskAttemptExecution({
      workspaceId: 7,
      taskId: 101,
      attemptId: 201,
      actualModelId: "deepseek-v4-flash",
      actualCostUsd: 0.11,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      status: "completed",
      fallback: false,
      resultClass: "official",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it("queues one next attempt below the configured limit and rejects retries at the limit", async () => {
    const attemptValues = vi.fn(async () => [{ insertId: 202 }]);
    const taskUpdate = vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] })) }));
    const transaction = {
      select: sequenceSelect([
        [{ id: 102, workspaceId: 7, status: "failed", maxAttempts: 2, requestedModelId: "deepseek-v4-flash", resultClass: "official", estimatedCostUsd: "0.100000" }],
        [{ id: 200, taskId: 102, attemptNumber: 1, provider: "opencode_go", quotaState: "GREEN" }],
      ]),
      insert: vi.fn(() => ({ values: attemptValues })),
      update: taskUpdate,
    };
    const db = {
      transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
    };
    doubles.getDb.mockResolvedValue(db);

    await expect(queueTaskRetry({ workspaceId: 7, taskId: 102 })).resolves.toMatchObject({ taskId: 102, attemptId: 202, attemptNumber: 2 });
    expect(attemptValues).toHaveBeenCalledWith(expect.objectContaining({ attemptNumber: 2, status: "queued" }));
    expect(attemptValues).toHaveBeenCalledWith(expect.objectContaining({ kind: "retry_queued", taskId: 102, attemptId: 202, payload: expect.objectContaining({ source: "manual_retry" }) }));

    const limitedTransaction = {
      select: sequenceSelect([
        [{ id: 103, workspaceId: 7, status: "failed", maxAttempts: 1, requestedModelId: "deepseek-v4-flash", resultClass: "official", estimatedCostUsd: "0.100000" }],
        [{ id: 201, taskId: 103, attemptNumber: 1, provider: "opencode_go", quotaState: "GREEN" }],
      ]),
      insert: vi.fn(),
      update: vi.fn(),
    };
    doubles.getDb.mockResolvedValue({ transaction: async (work: (tx: typeof limitedTransaction) => Promise<unknown>) => work(limitedTransaction) });

    await expect(queueTaskRetry({ workspaceId: 7, taskId: 103 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(limitedTransaction.insert).not.toHaveBeenCalled();
    expect(limitedTransaction.update).not.toHaveBeenCalled();
  });

  it("upgrades a P2 soft reservation only after an execution-time hard budget claim succeeds", async () => {
    const transaction = {
      select: sequenceSelect([
        [{ id: 42, workspaceId: 7, status: "queued", estimatedCostUsd: "0.400000" }],
        [{ id: 200, taskId: 42, workspaceId: 7, status: "queued", provider: "opencode_go" }],
        [{ id: 300, taskId: 42, providerBudgetId: 8, reservationKind: "soft", status: "RESERVED" }],
        [{ id: 5, provider: "opencode_go" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "12.0000", consumedUsd: "1.0000", reservedUsd: "0.5000" }],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] })) })),
      insert: vi.fn(() => ({ values: async () => undefined })),
    };
    const db = {
      transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
      select: sequenceSelect([
        [{ id: 7, researchPhase: "development" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "12.0000", consumedUsd: "1.0000", reservedUsd: "0.9000", dynamicReserveUsd: "0", resetAt: new Date("2026-08-13T18:00:00.000Z"), state: "GREEN" }],
        [],
        [],
        [],
        [],
        [],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] })) })),
      insert: vi.fn(() => ({ values: async () => undefined })),
    };
    doubles.getDb.mockResolvedValue(db);

    const result = await claimTaskForLocalExecution({ workspaceId: 7, taskId: 42 });

    expect(result).toMatchObject({ taskId: 42, attemptId: 200, claimKind: "soft_upgraded" });
    expect(transaction.update).toHaveBeenCalledTimes(4);
    expect(transaction.select).toHaveBeenCalledTimes(5);
    expect(transaction.insert).toHaveBeenCalledWith(taskEvents);
  });

  it("does not start a soft-reserved task when the execution-time budget claim loses capacity", async () => {
    const conditionalReserve = vi.fn(() => ({ where: async () => [{ affectedRows: 0 }] }));
    const transaction = {
      select: sequenceSelect([
        [{ id: 43, workspaceId: 7, status: "queued", estimatedCostUsd: "0.700000" }],
        [{ id: 201, taskId: 43, workspaceId: 7, status: "queued", provider: "opencode_go" }],
        [{ id: 301, taskId: 43, providerBudgetId: 8, reservationKind: "soft", status: "RESERVED" }],
        [{ id: 5, provider: "opencode_go" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "12.0000", consumedUsd: "11.5000", reservedUsd: "0.0000" }],
      ]),
      update: vi.fn(() => ({ set: conditionalReserve })),
    };
    const db = {
      transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
    };
    doubles.getDb.mockResolvedValue(db);

    await expect(claimTaskForLocalExecution({ workspaceId: 7, taskId: 43 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(transaction.update).toHaveBeenCalledTimes(1);
    expect(conditionalReserve).toHaveBeenCalledTimes(1);
  });

  it("creates a temporary hard reservation for a P3 task only when it is actually claimed", async () => {
    const transaction = {
      select: sequenceSelect([
        [{ id: 44, workspaceId: 7, status: "queued", estimatedCostUsd: "0.050000" }],
        [{ id: 202, taskId: 44, workspaceId: 7, status: "queued", provider: "opencode_go", executionPlan: { contextReductionRatio: 0.7, outputReductionRatio: 0.8, maxToolCalls: 3, maxAgentSteps: 3, chunkInput: true, preserveRequestedModel: true } }],
        [],
        [{ id: 5, provider: "opencode_go" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "12.0000", consumedUsd: "1.0000", reservedUsd: "0.5000" }],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] })) })),
      insert: vi.fn(() => ({ values: async () => undefined })),
    };
    const db = {
      transaction: vi.fn(async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)),
      select: sequenceSelect([
        [{ id: 7, researchPhase: "development" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "12.0000", consumedUsd: "1.0000", reservedUsd: "0.5500", dynamicReserveUsd: "0", resetAt: new Date("2026-08-13T18:00:00.000Z"), state: "GREEN" }],
        [],
        [],
        [],
        [],
        [],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] })) })),
      insert: vi.fn(() => ({ values: async () => undefined })),
    };
    doubles.getDb.mockResolvedValue(db);

    const result = await claimTaskForLocalExecution({ workspaceId: 7, taskId: 44 });

    expect(result).toMatchObject({ taskId: 44, attemptId: 202, claimKind: "p3_hard", executionPlan: { contextReductionRatio: 0.7, outputReductionRatio: 0.8, chunkInput: true } });
    expect(transaction.insert).toHaveBeenCalledTimes(2);
    expect(transaction.insert).toHaveBeenCalledWith(taskEvents);
  });

  it("blocks a claim when the provider-level concurrency budget is full", async () => {
    const transaction = {
      select: sequenceSelect([
        [{ id: 50, workspaceId: 7, status: "queued", estimatedCostUsd: "0.100000", taskBudgetUsd: "0.500000", cumulativeCostCapUsd: "0.500000", actualCostUsd: "0", remainingBudgetUsd: "0.500000" }],
        [{ id: 208, taskId: 50, workspaceId: 7, status: "queued", provider: "opencode_go", modelRegistryId: 77 }],
        [{ id: 304, taskId: 50, providerBudgetId: 8, reservationKind: "hard", status: "RESERVED" }],
        [{ id: 5, provider: "opencode_go", maxConcurrentExecutions: 1, runningExecutions: 1, circuitOpenUntil: null }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "12.0000", consumedUsd: "1.0000", reservedUsd: "0.5000" }],
        [{ id: 77, modelId: "deepseek-v4-flash", maxConcurrency: 2, isActive: true }],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 0 }] })) })),
      insert: vi.fn(),
    };
    doubles.getDb.mockResolvedValue({ transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction) });

    await expect(claimTaskForLocalExecution({ workspaceId: 7, taskId: 50 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(transaction.update).toHaveBeenCalledTimes(1);
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it("resolves a legacy NULL modelRegistryId before enforcing provider concurrency instead of bypassing the three-tier budget", async () => {
    const transaction = {
      select: sequenceSelect([
        [{ id: 52, workspaceId: 7, status: "queued", estimatedCostUsd: "0.100000", taskBudgetUsd: "0.500000", cumulativeCostCapUsd: "0.500000", actualCostUsd: "0", remainingBudgetUsd: "0.500000", requestedModelId: "deepseek-v4-flash" }],
        [{ id: 210, taskId: 52, workspaceId: 7, status: "queued", provider: "opencode_go", modelRegistryId: null, requestedModelId: "deepseek-v4-flash" }],
        [{ id: 306, taskId: 52, providerBudgetId: 8, reservationKind: "hard", status: "RESERVED" }],
        [{ id: 5, provider: "opencode_go", maxConcurrentExecutions: 1, runningExecutions: 1, circuitOpenUntil: null }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "12.0000", consumedUsd: "1.0000", reservedUsd: "0.5000" }],
        [{ id: 79, modelId: "deepseek-v4-flash", provider: "opencode_go", maxConcurrency: 2, isActive: true }],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 0 }] })) })),
      insert: vi.fn(),
    };
    doubles.getDb.mockResolvedValue({ transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction) });

    await expect(claimTaskForLocalExecution({ workspaceId: 7, taskId: 52 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(transaction.select).toHaveBeenCalledTimes(6);
    expect(transaction.update).toHaveBeenCalledTimes(1);
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it("releases a provider slot when the model-level concurrency claim loses its race", async () => {
    const updateResults = [1, 0, 1];
    const transaction = {
      select: sequenceSelect([
        [{ id: 51, workspaceId: 7, status: "queued", estimatedCostUsd: "0.100000", taskBudgetUsd: "0.500000", cumulativeCostCapUsd: "0.500000", actualCostUsd: "0", remainingBudgetUsd: "0.500000" }],
        [{ id: 209, taskId: 51, workspaceId: 7, status: "queued", provider: "opencode_go", modelRegistryId: 78 }],
        [{ id: 305, taskId: 51, providerBudgetId: 8, reservationKind: "hard", status: "RESERVED" }],
        [{ id: 5, provider: "opencode_go", maxConcurrentExecutions: 2, runningExecutions: 0, circuitOpenUntil: null }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "12.0000", consumedUsd: "1.0000", reservedUsd: "0.5000" }],
        [{ id: 78, modelId: "deepseek-v4-flash", maxConcurrency: 1, isActive: true }],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: updateResults.shift() ?? 1 }] })) })),
      insert: vi.fn(() => ({ values: () => ({ onDuplicateKeyUpdate: async () => undefined }) })),
    };
    doubles.getDb.mockResolvedValue({ transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction) });

    await expect(claimTaskForLocalExecution({ workspaceId: 7, taskId: 51 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(transaction.update).toHaveBeenCalledTimes(3);
    expect(transaction.insert).toHaveBeenCalledTimes(1);
  });

  it("admits at most one concurrent P2 soft-to-hard claim against the same remaining shared budget", async () => {
    let capacityClaimsRemaining = 1;
    const buildTransaction = (taskId: number, attemptId: number) => {
      const conditionalBudgetResult = capacityClaimsRemaining-- > 0 ? 1 : 0;
      const updateResults = conditionalBudgetResult === 1 ? [1, 1, 1, 1] : [0];
      return {
      select: sequenceSelect([
        [{ id: taskId, workspaceId: 7, status: "queued", estimatedCostUsd: "0.500000" }],
        [{ id: attemptId, taskId, workspaceId: 7, status: "queued", provider: "opencode_go" }],
        [{ id: taskId + 1000, taskId, providerBudgetId: 8, reservationKind: "soft", status: "RESERVED" }],
        [{ id: 5, provider: "opencode_go" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "1.0000", consumedUsd: "0.5000", reservedUsd: "0.0000" }],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: updateResults.shift() ?? 1 }] })) })),
      insert: vi.fn(() => ({ values: async () => undefined })),
    };
    };
    const transactions = [buildTransaction(60, 260), buildTransaction(61, 261)];
    const db = {
      transaction: vi.fn((work: (tx: (typeof transactions)[number]) => Promise<unknown>) => work(transactions.shift()!)),
      select: sequenceSelect([
        [{ id: 7, researchPhase: "development" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "1.0000", consumedUsd: "0.5000", reservedUsd: "0.5000", dynamicReserveUsd: "0", resetAt: new Date("2026-08-13T18:00:00.000Z"), state: "GREEN" }],
        [], [], [], [], [],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] })) })),
      insert: vi.fn(() => ({ values: async () => undefined })),
    };
    doubles.getDb.mockResolvedValue(db);

    const outcomes = await Promise.allSettled([
      claimTaskForLocalExecution({ workspaceId: 7, taskId: 60 }),
      claimTaskForLocalExecution({ workspaceId: 7, taskId: 61 }),
    ]);

    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    expect(transactions).toHaveLength(0);
  });

  it("admits at most one concurrent P3 claim when neither task has a prior reservation", async () => {
    let capacityClaimsRemaining = 1;
    const buildP3Transaction = (taskId: number, attemptId: number) => {
      const conditionalBudgetResult = capacityClaimsRemaining-- > 0 ? 1 : 0;
      const updateResults = conditionalBudgetResult === 1 ? [1, 1, 1] : [0];
      return {
        select: sequenceSelect([
          [{ id: taskId, workspaceId: 7, status: "queued", estimatedCostUsd: "0.500000" }],
          [{ id: attemptId, taskId, workspaceId: 7, status: "queued", provider: "opencode_go" }],
          [],
          [{ id: 5, provider: "opencode_go" }],
          [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "1.0000", consumedUsd: "0.5000", reservedUsd: "0.0000" }],
        ]),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: updateResults.shift() ?? 1 }] })) })),
        insert: vi.fn(() => ({ values: async () => undefined })),
      };
    };
    const transactions = [buildP3Transaction(70, 270), buildP3Transaction(71, 271)];
    const db = {
      transaction: vi.fn((work: (tx: (typeof transactions)[number]) => Promise<unknown>) => work(transactions.shift()!)),
      select: sequenceSelect([
        [{ id: 7, researchPhase: "development" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "1.0000", consumedUsd: "0.5000", reservedUsd: "0.5000", dynamicReserveUsd: "0", resetAt: new Date("2026-08-13T18:00:00.000Z"), state: "GREEN" }],
        [], [], [], [], [],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] })) })),
      insert: vi.fn(() => ({ values: async () => undefined })),
    };
    doubles.getDb.mockResolvedValue(db);

    const outcomes = await Promise.allSettled([
      claimTaskForLocalExecution({ workspaceId: 7, taskId: 70 }),
      claimTaskForLocalExecution({ workspaceId: 7, taskId: 71 }),
    ]);

    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
  });

  it("shares the same execution-time capacity between a P2 soft reservation and a P3 best-effort task", async () => {
    let capacityClaimsRemaining = 1;
    const buildTransaction = (taskId: number, attemptId: number, reservationKind: "soft" | undefined) => {
      const conditionalBudgetResult = capacityClaimsRemaining-- > 0 ? 1 : 0;
      const updateResults = conditionalBudgetResult === 1 ? (reservationKind ? [1, 1, 1, 1] : [1, 1, 1]) : [0];
      return {
        select: sequenceSelect([
          [{ id: taskId, workspaceId: 7, status: "queued", estimatedCostUsd: "0.500000" }],
          [{ id: attemptId, taskId, workspaceId: 7, status: "queued", provider: "opencode_go" }],
          reservationKind ? [{ id: taskId + 1000, taskId, providerBudgetId: 8, reservationKind, status: "RESERVED" }] : [],
          [{ id: 5, provider: "opencode_go" }],
          [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "1.0000", consumedUsd: "0.5000", reservedUsd: "0.0000" }],
        ]),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: updateResults.shift() ?? 1 }] })) })),
        insert: vi.fn(() => ({ values: async () => undefined })),
      };
    };
    const transactions = [buildTransaction(80, 280, "soft"), buildTransaction(81, 281, undefined)];
    const db = {
      transaction: vi.fn((work: (tx: (typeof transactions)[number]) => Promise<unknown>) => work(transactions.shift()!)),
      select: sequenceSelect([
        [{ id: 7, researchPhase: "development" }],
        [{ id: 8, workspaceId: 7, providerConnectionId: 5, window: "five_hour", limitUsd: "1.0000", consumedUsd: "0.5000", reservedUsd: "0.5000", dynamicReserveUsd: "0", resetAt: new Date("2026-08-13T18:00:00.000Z"), state: "GREEN" }],
        [], [], [], [], [],
      ]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] })) })),
      insert: vi.fn(() => ({ values: async () => undefined })),
    };
    doubles.getDb.mockResolvedValue(db);

    const outcomes = await Promise.allSettled([
      claimTaskForLocalExecution({ workspaceId: 7, taskId: 80 }),
      claimTaskForLocalExecution({ workspaceId: 7, taskId: 81 }),
    ]);

    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
  });
});
