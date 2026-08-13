import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { and, eq, lte, or } from "drizzle-orm";
import { budgetReservations, providerConnections, schedulerSettings, workerLocks } from "../drizzle/schema";
import { getDb } from "./db";
import { getProviderCredentialStatus } from "./providerCredentials";
import { refreshWorkspaceBudgets } from "./quotaService";
import { sdk } from "./_core/sdk";

export function getQuotaMaintenanceMode() {
  const credentials = getProviderCredentialStatus();
  return credentials.opencodeGo === "configured" || credentials.openaiAdmin === "configured"
    ? "provider_sync_ready"
    : "recalculate_imported_usage_only";
}

function affectedRows(result: unknown) {
  const header = Array.isArray(result) ? result[0] : result;
  return Number((header as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}

export async function acquireWorkerLease(db: any, input: {
  workspaceId: number;
  lockName: string;
  holderId: string;
  now?: Date;
  leaseMs?: number;
}) {
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + (input.leaseMs ?? 110_000));
  const renewed = await db.update(workerLocks)
    .set({ holderId: input.holderId, leaseExpiresAt, updatedAt: now })
    .where(and(
      eq(workerLocks.workspaceId, input.workspaceId),
      eq(workerLocks.lockName, input.lockName),
      or(lte(workerLocks.leaseExpiresAt, now), eq(workerLocks.holderId, input.holderId)),
    ));
  if (affectedRows(renewed) > 0) return { acquired: true, leaseExpiresAt };

  try {
    await db.insert(workerLocks).values({
      workspaceId: input.workspaceId,
      lockName: input.lockName,
      holderId: input.holderId,
      leaseExpiresAt,
      acquiredAt: now,
      updatedAt: now,
    });
    return { acquired: true, leaseExpiresAt };
  } catch {
    return { acquired: false, leaseExpiresAt: null };
  }
}

export async function releaseWorkerLease(db: any, input: {
  workspaceId: number;
  lockName: string;
  holderId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  await db.update(workerLocks)
    .set({ leaseExpiresAt: now, updatedAt: now })
    .where(and(
      eq(workerLocks.workspaceId, input.workspaceId),
      eq(workerLocks.lockName, input.lockName),
      eq(workerLocks.holderId, input.holderId),
    ));
}

export async function runQuotaMaintenance(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const holderId = `quota-maintenance:${randomUUID()}`;
  const lease = await acquireWorkerLease(db, {
    workspaceId,
    lockName: "quota-maintenance",
    holderId,
  });
  if (!lease.acquired) {
    const mode = getQuotaMaintenanceMode();
    return {
      expiredReservationsReleased: 0,
      mode,
      providerCount: 0,
      skipped: "worker_lock_held" as const,
      message: "另一维护实例仍持有工作区租约；当前回调安全跳过。",
    };
  }
  const now = new Date();
  try {
    const expired = await db.select().from(budgetReservations).where(and(eq(budgetReservations.workspaceId, workspaceId), eq(budgetReservations.status, "RESERVED"), lte(budgetReservations.expiresAt, now)));
    if (expired.length) {
      await db.update(budgetReservations).set({ status: "RELEASED", updatedAt: now }).where(and(eq(budgetReservations.workspaceId, workspaceId), eq(budgetReservations.status, "RESERVED"), lte(budgetReservations.expiresAt, now)));
    }
    await refreshWorkspaceBudgets(workspaceId);
    const connections = await db.select().from(providerConnections).where(eq(providerConnections.workspaceId, workspaceId));
    const mode = getQuotaMaintenanceMode();
    const providerCount = connections.filter(connection => connection.secretState === "configured").length;
    return {
      expiredReservationsReleased: expired.length,
      mode,
      providerCount,
      message: mode === "provider_sync_ready"
        ? "预算与预留已重算；provider adapter 可在凭据启用后执行同步。"
        : "未配置 provider 凭据：已基于已导入用量、预留和任务预算完成重算。",
    };
  } finally {
    await releaseWorkerLease(db, { workspaceId, lockName: "quota-maintenance", holderId });
  }
}

export async function quotaMaintenanceHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron-only" });
    const db = await getDb();
    if (!db) return res.status(500).json({ error: "database-unavailable", timestamp: new Date().toISOString() });
    const setting = (await db.select().from(schedulerSettings).where(eq(schedulerSettings.scheduleCronTaskUid, user.taskUid)).limit(1))[0];
    if (!setting) return res.json({ ok: true, skipped: "orphan" });
    if (!setting.enabled) return res.json({ ok: true, skipped: "disabled" });

    const result = await runQuotaMaintenance(setting.workspaceId);
    await db.update(schedulerSettings).set({
      lastRunAt: new Date(),
      lastRunStatus: result.skipped ? "skipped" : result.mode === "provider_sync_ready" ? "success" : "skipped",
      lastRunMessage: result.message,
      updatedAt: new Date(),
    }).where(eq(schedulerSettings.id, setting.id));
    return res.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[scheduled/quota-maintenance]", error);
    return res.status(500).json({
      error: message,
      context: { path: "/api/scheduled/quota-maintenance" },
      timestamp: new Date().toISOString(),
    });
  }
}
