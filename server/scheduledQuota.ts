import type { Request, Response } from "express";
import { and, eq, lte } from "drizzle-orm";
import { budgetReservations, providerConnections, schedulerSettings } from "../drizzle/schema";
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

export async function runQuotaMaintenance(workspaceId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const now = new Date();
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
      lastRunStatus: result.mode === "provider_sync_ready" ? "success" : "skipped",
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
