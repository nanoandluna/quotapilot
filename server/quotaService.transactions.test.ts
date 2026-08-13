import { beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  getDb: vi.fn(),
  storagePut: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: doubles.getDb }));
vi.mock("./storage", () => ({ storagePut: doubles.storagePut }));

import { claimTaskForLocalExecution, recordTaskAttemptExecution, saveUsageImport } from "./quotaService";

function selectRows<T>(rows: T[]) {
  const query = {
    limit: async () => rows,
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
    };
    doubles.getDb.mockResolvedValue(db);

    const result = await claimTaskForLocalExecution({ workspaceId: 7, taskId: 42 });

    expect(result).toMatchObject({ taskId: 42, attemptId: 200, claimKind: "soft_upgraded" });
    expect(transaction.update).toHaveBeenCalledTimes(4);
    expect(transaction.select).toHaveBeenCalledTimes(5);
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
        [{ id: 202, taskId: 44, workspaceId: 7, status: "queued", provider: "opencode_go" }],
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
    };
    doubles.getDb.mockResolvedValue(db);

    const result = await claimTaskForLocalExecution({ workspaceId: 7, taskId: 44 });

    expect(result).toMatchObject({ taskId: 44, attemptId: 202, claimKind: "p3_hard" });
    expect(transaction.insert).toHaveBeenCalledTimes(1);
  });
});
