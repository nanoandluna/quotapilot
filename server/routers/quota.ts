import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { budgetAlerts, modelRegistry, providerBudgets, providerConnections, researchTasks, routeDecisions, taskAttempts, workspaceInvites, workspaceMembers } from "../../drizzle/schema";
import { getDb } from "../db";
import {
  ensurePersonalWorkspace,
  claimTaskForLocalExecution,
  listWorkspaceDashboard,
  requireWorkspaceRole,
  recordTaskAttemptExecution,
  reserveTaskBudget,
  saveUsageImport,
  scoreCandidateModels,
  type WorkspaceRole,
} from "../quotaService";
import { protectedProcedure, router } from "../_core/trpc";

const workspaceInput = z.object({ workspaceId: z.number().int().positive() });
const roleSchema = z.enum(["owner", "admin", "researcher", "reviewer", "viewer"]);
const memberRoleSchema = z.enum(["admin", "researcher", "reviewer", "viewer"]);
const prioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
const taskRequirementsSchema = z.object({
  code: z.number().min(0).max(10).optional(),
  reasoning: z.number().min(0).max(10).optional(),
  longContext: z.number().min(0).max(10).optional(),
  vision: z.number().min(0).max(10).optional(),
  toolUse: z.number().min(0).max(10).optional(),
  chinese: z.number().min(0).max(10).optional(),
  research: z.number().min(0).max(10).optional(),
  agent: z.number().min(0).max(10).optional(),
  speed: z.number().min(0).max(10).optional(),
  reliability: z.number().min(0).max(10).optional(),
  requiresVision: z.boolean().optional(),
  requiresToolUse: z.boolean().optional(),
  maxContextTokens: z.number().int().positive().max(10_000_000).optional(),
}).strict();

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
    requirements: taskRequirementsSchema.default({}),
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
  claimTask: protectedProcedure.input(z.object({ workspaceId: z.number().int().positive(), taskId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id, "researcher");
    return claimTaskForLocalExecution(input);
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
    return db.transaction(async tx => {
      const decision = (await tx.select().from(routeDecisions).where(and(
        eq(routeDecisions.id, input.decisionId),
        eq(routeDecisions.workspaceId, input.workspaceId),
        isNull(routeDecisions.actedAt),
      )).limit(1))[0];
      if (!decision) throw new TRPCError({ code: "CONFLICT", message: "route decision 不存在、已被处理或已过期。" });
      if (!["MIGRATE", "QUEUE", "HOLD"].includes(decision.admissionDecision)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "当前 route decision 不需要人工处置。" });
      const task = (await tx.select().from(researchTasks).where(and(eq(researchTasks.id, decision.taskId), eq(researchTasks.workspaceId, input.workspaceId))).limit(1))[0];
      if (!task || !["paused", "queued"].includes(task.status) || task.admissionDecision !== decision.admissionDecision) {
        throw new TRPCError({ code: "CONFLICT", message: "任务状态已变化，拒绝使用过期 route decision。" });
      }

      let requestedModelId = task.requestedModelId;
      let status: "queued" | "paused" = input.action === "queue" || input.action === "migrate" ? "queued" : "paused";
      let admissionDecision: "MIGRATE" | "QUEUE" | "HOLD" = input.action === "migrate" ? "MIGRATE" : input.action === "queue" ? "QUEUE" : "HOLD";
      if (input.action === "migrate") {
        const candidate = (await tx.select().from(modelRegistry).where(and(eq(modelRegistry.modelId, input.candidateModelId!), eq(modelRegistry.isActive, true))).limit(1))[0];
        if (!candidate) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "候选模型不存在或未启用。" });
        const compatible = scoreCandidateModels(task.requirements, [{
          provider: candidate.provider,
          modelId: candidate.modelId,
          displayName: candidate.displayName,
          inputPerMillionUsd: Number(candidate.inputPerMillionUsd),
          outputPerMillionUsd: Number(candidate.outputPerMillionUsd),
          scarcityFactor: Number(candidate.scarcityFactor),
          maxConcurrency: candidate.maxConcurrency,
          maxContextTokens: candidate.maxContextTokens,
          capability: candidate.capability,
        }]);
        if (!compatible.length) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "候选模型不满足任务能力、上下文或并发硬约束。" });
        const connection = (await tx.select().from(providerConnections).where(and(eq(providerConnections.workspaceId, input.workspaceId), eq(providerConnections.provider, candidate.provider))).limit(1))[0];
        if (!connection || connection.connectionState !== "connected" || connection.secretState !== "configured") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "候选模型的 provider 连接未就绪；请完成配置或进行人工交接。" });
        }
        const budget = (await tx.select().from(providerBudgets).where(and(eq(providerBudgets.providerConnectionId, connection.id), eq(providerBudgets.window, "five_hour"))).limit(1))[0];
        const available = budget ? Number(budget.limitUsd) - Number(budget.consumedUsd) - Number(budget.reservedUsd) : 0;
        if (!budget || available < Number(task.estimatedCostUsd)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "候选模型所在 provider 的共享额度不足。" });
        const runningAttempts = await tx.select().from(taskAttempts).where(and(eq(taskAttempts.workspaceId, input.workspaceId), eq(taskAttempts.status, "running")));
        const activeConcurrency = runningAttempts.filter(attempt => (attempt.actualModelId ?? attempt.requestedModelId) === candidate.modelId).length;
        if (activeConcurrency >= candidate.maxConcurrency) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "候选模型当前并发已满。" });
        requestedModelId = candidate.modelId;
      }

      const consumed = await tx.update(routeDecisions).set({
        actedAt: new Date(),
        actedByUserId: ctx.user.id,
        recommendedAction: input.action,
        selectedModelId: input.action === "migrate" ? requestedModelId : decision.selectedModelId,
      }).where(and(eq(routeDecisions.id, decision.id), isNull(routeDecisions.actedAt)));
      if (consumed[0].affectedRows !== 1) throw new TRPCError({ code: "CONFLICT", message: "route decision 已被并发处理。" });
      await tx.update(researchTasks).set({ status, admissionDecision, requestedModelId, updatedAt: new Date() }).where(eq(researchTasks.id, task.id));
      return { ok: true, taskId: decision.taskId, status };
    });
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
  changeMemberRole: protectedProcedure.input(z.object({ workspaceId: z.number().int().positive(), memberUserId: z.number().int().positive(), role: memberRoleSchema })).mutation(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id, "owner");
    if (input.memberUserId === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "工作区拥有者不能在此处变更自己的角色；请使用所有权转移流程。" });
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
    await db.update(workspaceMembers).set({ role: input.role as WorkspaceRole, updatedAt: new Date() }).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.memberUserId)));
    return { ok: true };
  }),
  transferOwnership: protectedProcedure.input(z.object({ workspaceId: z.number().int().positive(), newOwnerUserId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id, "owner");
    if (input.newOwnerUserId === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "当前 owner 无需向自己转移所有权。" });
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
    await db.transaction(async tx => {
      const [currentOwner, nextOwner] = await Promise.all([
        tx.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, ctx.user.id), eq(workspaceMembers.role, "owner"))).limit(1),
        tx.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.newOwnerUserId))).limit(1),
      ]);
      if (!currentOwner[0]) throw new TRPCError({ code: "CONFLICT", message: "当前账户已不再是工作区 owner。" });
      if (!nextOwner[0]) throw new TRPCError({ code: "NOT_FOUND", message: "新的 owner 必须是当前工作区成员。" });
      await tx.update(workspaceMembers).set({ role: "admin", updatedAt: new Date() }).where(eq(workspaceMembers.id, currentOwner[0].id));
      await tx.update(workspaceMembers).set({ role: "owner", updatedAt: new Date() }).where(eq(workspaceMembers.id, nextOwner[0].id));
    });
    return { ok: true, previousOwnerUserId: ctx.user.id, newOwnerUserId: input.newOwnerUserId };
  }),
  removeMember: protectedProcedure.input(z.object({ workspaceId: z.number().int().positive(), memberUserId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    await requireWorkspaceRole(input.workspaceId, ctx.user.id, "admin");
    if (input.memberUserId === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "不能通过此操作移除当前账户；请先转移工作区拥有权。" });
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "数据库连接不可用。" });
    const member = (await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.memberUserId))).limit(1))[0];
    if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "成员不存在。" });
    if (member.role === "owner") throw new TRPCError({ code: "BAD_REQUEST", message: "不能移除工作区拥有者。" });
    await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.memberUserId)));
    return { ok: true };
  }),
});
