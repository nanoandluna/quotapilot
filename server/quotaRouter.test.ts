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
}));

import { quotaRouter } from "./routers/quota";

function selectRows<T>(rows: T[]) {
  return { from: () => ({ where: () => ({ limit: async () => rows }) }) };
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
});
