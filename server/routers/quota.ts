import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { budgetAlerts, researchTasks, routeDecisions, workspaceInvites, workspaceMembers } from "../../drizzle/schema";
import { getDb } from "../db";
import {
  ensurePersonalWorkspace,
  listWorkspaceDashboard,
  requireWorkspaceRole,
  recordTaskAttemptExecution,
  reserveTaskBudget,
  saveUsageImport,
  type WorkspaceRole,
} from "../quotaService";
import { protectedProcedure, router } from "../_core/trpc";

const workspaceInput = z.object({ workspaceId: z.number().int().positive() });
const roleSchema = z.enum(["owner", "admin", "researcher", "reviewer", "viewer"]);
const prioritySchema = z.enum(["P0", "P1", "P2", "P3"]);

export const quotaRouter = router({
  bootstrap: protectedProcedure.mutation(async ({ ctx }) => {
    const workspaceId = await ensurePersonalWorkspace(ctx.user);
    return { workspaceId };
  }),
  dashboard: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id);
    return listWorkspaceDashboard(input.workspaceId);
  }),
  importUsage: protectedProcedure.input(z.object({
    workspaceId: z.number().int().positive(),
    filename: z.string().min(1).max(255),
    mimeType: z.enum(["text/csv", "application/json", "text/plain"]),
    content: z.string().min(2).max(4_000_000),
  })).mutation(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id, "researcher");
    if (!/\.(csv|json)$/i.test(input.filename)) throw new TRPCError({ code: "BAD_REQUEST", message: "只支持 .csv 或 .json 文件。" });
    return saveUsageImport({ ...input, userId: ctx.user.id });
  }),
  createTask: protectedProcedure.input(z.object({
    workspaceId: z.number().int().positive(),
    title: z.string().min(3).max(255),
    description: z.string().max(5000).optional(),
    priority: prioritySchema,
    taskClass: z.enum(["formal_experiment", "experiment_pipeline", "development", "convenience"]),
    routeMode: z.enum(["strict", "balanced", "emergency"]).default("balanced"),
    resultClass: z.enum(["official", "fallback", "exploratory", "recovery"]),
    estimatedCostUsd: z.number().positive().max(60),
    taskBudgetUsd: z.number().positive().max(100),
    requestedModelId: z.string().max(160).optional(),
    requirements: z.record(z.string(), z.union([z.number().min(0).max(10), z.boolean()])).default({}),
    experimentId: z.string().max(128).optional(),
    runId: z.string().max(128).optional(),
  })).mutation(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id, "researcher");
    return reserveTaskBudget({ ...input, userId: ctx.user.id, requirements: input.requirements });
  }),
  recordAttempt: protectedProcedure.input(z.object({
    workspaceId: z.number().int().positive(),
    taskId: z.number().int().positive(),
    attemptId: z.number().int().positive(),
    actualModelId: z.string().min(1).max(160),
    actualCostUsd: z.number().min(0).max(100),
    inputTokens: z.number().int().min(0).default(0),
    outputTokens: z.number().int().min(0).default(0),
    cacheReadTokens: z.number().int().min(0).default(0),
    cacheWriteTokens: z.number().int().min(0).default(0),
    status: z.enum(["completed", "failed", "cancelled"]),
    fallback: z.boolean().default(false),
    fallbackReason: z.enum(["quota_low", "rate_limit", "timeout", "provider_error", "model_unavailable", "context_overflow", "tool_error", "manual"]).optional(),
    resultClass: z.enum(["official", "fallback", "exploratory", "recovery"]),
  })).mutation(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id, "researcher");
    return recordTaskAttemptExecution(input);
  }),
  actOnRouteDecision: protectedProcedure.input(z.object({
    workspaceId: z.number().int().positive(),
    decisionId: z.number().int().positive(),
    action: z.enum(["migrate", "queue", "hold", "manual_handoff"]),
    candidateModelId: z.string().min(1).max(160).optional(),
  })).mutation(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id, "researcher");
    if (input.action === "migrate" && !input.candidateModelId) throw new TRPCError({ code: "BAD_REQUEST", message: "迁移操作需要指定候选模型。" });
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
    const decision = (await db.select().from(routeDecisions).where(and(eq(routeDecisions.id, input.decisionId), eq(routeDecisions.workspaceId, input.workspaceId))).limit(1))[0];
    if (!decision) throw new TRPCError({ code: "NOT_FOUND", message: "route decision 不存在。" });
    const update = input.action === "migrate"
      ? { status: "queued" as const, admissionDecision: "MIGRATE" as const, requestedModelId: input.candidateModelId, updatedAt: new Date() }
      : input.action === "queue"
        ? { status: "queued" as const, admissionDecision: "QUEUE" as const, updatedAt: new Date() }
        : { status: "paused" as const, admissionDecision: "HOLD" as const, updatedAt: new Date() };
    await db.update(researchTasks).set(update).where(and(eq(researchTasks.id, decision.taskId), eq(researchTasks.workspaceId, input.workspaceId)));
    await db.update(routeDecisions).set({
      actedAt: new Date(),
      actedByUserId: ctx.user.id,
      recommendedAction: input.action,
      selectedModelId: input.action === "migrate" ? input.candidateModelId : decision.selectedModelId,
    }).where(eq(routeDecisions.id, decision.id));
    return { ok: true, taskId: decision.taskId, status: update.status };
  }),
  alerts: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
    return db.select().from(budgetAlerts).where(eq(budgetAlerts.workspaceId, input.workspaceId)).orderBy(desc(budgetAlerts.createdAt)).limit(50);
  }),
  acknowledgeAlert: protectedProcedure.input(z.object({ workspaceId: z.number().int().positive(), alertId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id, "reviewer");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
    await db.update(budgetAlerts).set({ acknowledgedAt: new Date(), acknowledgedByUserId: ctx.user.id }).where(and(eq(budgetAlerts.id, input.alertId), eq(budgetAlerts.workspaceId, input.workspaceId)));
    return { ok: true };
  }),
  members: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
    return db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, input.workspaceId));
  }),
  inviteMember: protectedProcedure.input(z.object({ workspaceId: z.number().int().positive(), email: z.string().email(), role: z.enum(["admin", "researcher", "reviewer", "viewer"]) })).mutation(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id, "admin");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const result = await db.insert(workspaceInvites).values({ workspaceId: input.workspaceId, email: input.email, role: input.role, invitedByUserId: ctx.user.id, expiresAt });
    return { inviteId: Number(result[0].insertId), expiresAt, delivery: "pending_manual_delivery" as const };
  }),
  changeMemberRole: protectedProcedure.input(z.object({ workspaceId: z.number().int().positive(), memberUserId: z.number().int().positive(), role: roleSchema })).mutation(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id, "owner");
    if (input.memberUserId === ctx.user.id && input.role !== "owner") throw new TRPCError({ code: "BAD_REQUEST", message: "工作区拥有者不能在此处移除自己的 owner 角色。" });
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
    await db.update(workspaceMembers).set({ role: input.role as WorkspaceRole, updatedAt: new Date() }).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.memberUserId)));
    return { ok: true };
  }),
});
