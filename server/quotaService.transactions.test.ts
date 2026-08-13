import { beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  getDb: vi.fn(),
  storagePut: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: doubles.getDb }));
vi.mock("./storage", () => ({ storagePut: doubles.storagePut }));

import { recordTaskAttemptExecution, saveUsageImport } from "./quotaService";

function selectRows<T>(rows: T[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  };
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
});
