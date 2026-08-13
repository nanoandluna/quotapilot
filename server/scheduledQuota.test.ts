import { describe, expect, it, vi } from "vitest";
import { acquireWorkerLease, getQuotaMaintenanceMode, releaseWorkerLease } from "./scheduledQuota";

describe("quota maintenance mode", () => {
  it("uses imported-usage-only mode until external provider credentials are configured", () => {
    expect(getQuotaMaintenanceMode()).toMatch(/provider_sync_ready|recalculate_imported_usage_only/);
  });

  it("renews an expired worker lease before attempting a competing insert", async () => {
    const set = vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] }));
    const insert = vi.fn();
    const db = { update: vi.fn(() => ({ set })), insert };

    const result = await acquireWorkerLease(db, {
      workspaceId: 7,
      lockName: "quota-maintenance",
      holderId: "run-a",
      now: new Date("2026-08-13T08:00:00.000Z"),
      leaseMs: 60_000,
    });

    expect(result).toMatchObject({ acquired: true, leaseExpiresAt: new Date("2026-08-13T08:01:00.000Z") });
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates a first lease and safely declines when another holder wins the insert race", async () => {
    const firstInsertValues = vi.fn(async () => undefined);
    const firstDb = {
      update: vi.fn(() => ({ set: () => ({ where: async () => [{ affectedRows: 0 }] }) })),
      insert: vi.fn(() => ({ values: firstInsertValues })),
    };
    const first = await acquireWorkerLease(firstDb, { workspaceId: 7, lockName: "quota-maintenance", holderId: "run-a" });
    expect(first.acquired).toBe(true);
    expect(firstInsertValues).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 7, holderId: "run-a" }));

    const competingDb = {
      update: vi.fn(() => ({ set: () => ({ where: async () => [{ affectedRows: 0 }] }) })),
      insert: vi.fn(() => ({ values: async () => { throw new Error("duplicate key"); } })),
    };
    await expect(acquireWorkerLease(competingDb, { workspaceId: 7, lockName: "quota-maintenance", holderId: "run-b" }))
      .resolves.toMatchObject({ acquired: false, leaseExpiresAt: null });
  });

  it("releases a lease only when the current holder matches", async () => {
    const set = vi.fn(() => ({ where: async () => [{ affectedRows: 1 }] }));
    const db = { update: vi.fn(() => ({ set })) };

    await releaseWorkerLease(db, { workspaceId: 7, lockName: "quota-maintenance", holderId: "run-a", now: new Date("2026-08-13T08:02:00.000Z") });

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ leaseExpiresAt: new Date("2026-08-13T08:02:00.000Z") }));
  });
});
