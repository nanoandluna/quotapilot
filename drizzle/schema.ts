import {
  boolean,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export type CapabilityMatrix = {
  code: number;
  reasoning: number;
  longContext: number;
  vision: number;
  toolUse: number;
  chinese: number;
  research: number;
  agent: number;
  speed: number;
  reliability: number;
};

export type UsageTokenPayload = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type TaskRequirements = Partial<CapabilityMatrix> & {
  requiresVision?: boolean;
  requiresToolUse?: boolean;
  maxContextTokens?: number;
};

export type RoutePlanCandidate = {
  modelId: string;
  provider: "opencode_go" | "openai_api" | "local";
  score: number;
  eligible: boolean;
  reasons: string[];
};

export type RoutePlanSnapshot = {
  routeMode: "strict" | "balanced" | "emergency";
  requestedModelId?: string;
  selectedModelId?: string;
  budgetWindow: "five_hour";
  candidates: RoutePlanCandidate[];
  generatedAt: string;
};

export type FailurePolicySnapshot = {
  recommendedAction: "migrate" | "queue" | "hold" | "manual_handoff";
  retryAfterSeconds: number | null;
  retryMode: "none" | "backoff" | "after_remediation";
  circuitScope: "provider_window" | "provider" | "model" | "task" | "tool" | "unknown";
  degradationSteps: string[];
  requiresHumanHandoff: boolean;
};

export type AttemptExecutionPlan = {
  contextReductionRatio: number;
  outputReductionRatio: number;
  maxToolCalls: number | null;
  maxAgentSteps: number | null;
  chunkInput: boolean;
  splitTask: boolean;
  preserveRequestedModel: boolean;
};

/** Core user table backing the Manus OAuth flow. */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const workspaces = mysqlTable("workspaces", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  slug: varchar("slug", { length: 96 }).notNull(),
  researchPhase: mysqlEnum("researchPhase", ["development", "paper", "final_submission"])
    .default("development")
    .notNull(),
  timezone: varchar("timezone", { length: 64 }).default("Asia/Shanghai").notNull(),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [uniqueIndex("workspaces_slug_unique").on(table.slug)]);

export const workspaceMembers = mysqlTable("workspace_members", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: mysqlEnum("workspaceRole", ["owner", "admin", "researcher", "reviewer", "viewer"])
    .default("researcher")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("workspace_members_workspace_user_unique").on(table.workspaceId, table.userId),
  index("workspace_members_user_idx").on(table.userId),
]);

export const workspaceInvites = mysqlTable("workspace_invites", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 320 }).notNull(),
  role: mysqlEnum("inviteRole", ["admin", "researcher", "reviewer", "viewer"]).default("researcher").notNull(),
  status: mysqlEnum("inviteStatus", ["pending", "accepted", "revoked", "expired"]).default("pending").notNull(),
  token: varchar("token", { length: 96 }),
  invitedByUserId: int("invitedByUserId").notNull().references(() => users.id),
  acceptedByUserId: int("acceptedByUserId").references(() => users.id, { onDelete: "set null" }),
  acceptedAt: timestamp("acceptedAt"),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("workspace_invites_workspace_idx").on(table.workspaceId), uniqueIndex("workspace_invites_token_unique").on(table.token)]);

/** Append-only governance trail for team and sensitive workspace operations. */
export const workspaceAuditLogs = mysqlTable("workspace_audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  actorUserId: int("actorUserId").references(() => users.id, { onDelete: "set null" }),
  action: mysqlEnum("auditAction", ["member_invited", "invite_accepted", "member_role_changed", "member_removed", "ownership_transferred", "route_decision_acted", "task_claimed", "attempt_settled"]).notNull(),
  targetType: varchar("targetType", { length: 48 }).notNull(),
  targetId: varchar("targetId", { length: 96 }),
  before: json("before"),
  after: json("after"),
  metadata: json("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  index("workspace_audit_logs_workspace_created_idx").on(table.workspaceId, table.createdAt),
  index("workspace_audit_logs_target_idx").on(table.targetType, table.targetId),
]);

/** Metadata only; credentials remain in server-side secrets and are never stored in this table. */
export const providerConnections = mysqlTable("provider_connections", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: mysqlEnum("provider", ["opencode_go", "openai_api", "chatgpt_plus_manual", "local"])
    .notNull(),
  displayName: varchar("displayName", { length: 128 }).notNull(),
  syncMode: mysqlEnum("syncMode", ["scheduled", "manual", "import_only", "disabled"]).default("disabled").notNull(),
  connectionState: mysqlEnum("connectionState", ["pending_configuration", "connected", "degraded", "error", "disabled"])
    .default("pending_configuration")
    .notNull(),
  secretState: mysqlEnum("secretState", ["not_configured", "configured"]).default("not_configured").notNull(),
  lastSyncAt: timestamp("lastSyncAt"),
  lastSyncError: text("lastSyncError"),
  circuitOpenUntil: timestamp("circuitOpenUntil"),
  circuitReason: mysqlEnum("circuitReason", ["QUOTA", "RATE_LIMIT", "TIMEOUT", "PROVIDER_ERROR", "MODEL_UNAVAILABLE", "CONTEXT_OVERFLOW", "TOOL_ERROR", "UNKNOWN"]),
  maxConcurrentExecutions: int("maxConcurrentExecutions").default(4).notNull(),
  runningExecutions: int("runningExecutions").default(0).notNull(),
  syncIntervalMinutes: int("syncIntervalMinutes").default(15).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [uniqueIndex("provider_connections_workspace_provider_unique").on(table.workspaceId, table.provider)]);

export const providerBudgets = mysqlTable("provider_budgets", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  providerConnectionId: int("providerConnectionId").notNull().references(() => providerConnections.id, { onDelete: "cascade" }),
  window: mysqlEnum("budgetWindow", ["five_hour", "daily", "weekly", "monthly"])
    .notNull(),
  limitUsd: decimal("limitUsd", { precision: 12, scale: 4 }).notNull(),
  consumedUsd: decimal("consumedUsd", { precision: 12, scale: 4 }).default("0").notNull(),
  reservedUsd: decimal("reservedUsd", { precision: 12, scale: 4 }).default("0").notNull(),
  dynamicReserveUsd: decimal("dynamicReserveUsd", { precision: 12, scale: 4 }).default("0").notNull(),
  burnRate15m: decimal("burnRate15m", { precision: 12, scale: 4 }).default("0").notNull(),
  burnRate1h: decimal("burnRate1h", { precision: 12, scale: 4 }).default("0").notNull(),
  burnRate5h: decimal("burnRate5h", { precision: 12, scale: 4 }).default("0").notNull(),
  burnRate24h: decimal("burnRate24h", { precision: 12, scale: 4 }).default("0").notNull(),
  forecastExhaustionAt: timestamp("forecastExhaustionAt"),
  resetPolicy: mysqlEnum("resetPolicy", ["rolling", "fixed", "calendar", "provider_reported"]).default("rolling").notNull(),
  windowOrigin: timestamp("windowOrigin"),
  windowTimezone: varchar("windowTimezone", { length: 64 }).default("UTC").notNull(),
  providerReportedRemainingUsd: decimal("providerReportedRemainingUsd", { precision: 12, scale: 4 }),
  providerReportedResetAt: timestamp("providerReportedResetAt"),
  resetAt: timestamp("resetAt").notNull(),
  state: mysqlEnum("budgetState", ["GREEN", "YELLOW", "ORANGE", "DRAIN_PROTECTION", "RED"])
    .default("GREEN")
    .notNull(),
  source: mysqlEnum("budgetSource", ["manual", "import", "scheduled_sync"]).default("manual").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("provider_budgets_connection_window_unique").on(table.providerConnectionId, table.window),
  index("provider_budgets_workspace_idx").on(table.workspaceId),
]);

/** Immutable budget observations for historical reconstruction; providerBudgets remains the current mutable window state. */
export const quotaSnapshots = mysqlTable("quota_snapshots", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  providerConnectionId: int("providerConnectionId").notNull().references(() => providerConnections.id, { onDelete: "cascade" }),
  providerBudgetId: int("providerBudgetId").notNull().references(() => providerBudgets.id, { onDelete: "cascade" }),
  window: mysqlEnum("snapshotWindow", ["five_hour", "daily", "weekly", "monthly"]).notNull(),
  limitUsd: decimal("limitUsd", { precision: 12, scale: 4 }).notNull(),
  consumedUsd: decimal("consumedUsd", { precision: 12, scale: 4 }).notNull(),
  reservedUsd: decimal("reservedUsd", { precision: 12, scale: 4 }).notNull(),
  dynamicReserveUsd: decimal("dynamicReserveUsd", { precision: 12, scale: 4 }).notNull(),
  state: mysqlEnum("snapshotBudgetState", ["GREEN", "YELLOW", "ORANGE", "DRAIN_PROTECTION", "RED"]).notNull(),
  source: mysqlEnum("snapshotSource", ["manual", "import", "scheduled_sync"]).notNull(),
  capturedAt: timestamp("capturedAt").defaultNow().notNull(),
}, table => [
  index("quota_snapshots_workspace_captured_idx").on(table.workspaceId, table.capturedAt),
  index("quota_snapshots_budget_captured_idx").on(table.providerBudgetId, table.capturedAt),
]);

export const modelRegistry = mysqlTable("model_registry", {
  id: int("id").autoincrement().primaryKey(),
  provider: mysqlEnum("registryProvider", ["opencode_go", "openai_api", "local"]).notNull(),
  modelId: varchar("modelId", { length: 160 }).notNull(),
  displayName: varchar("displayName", { length: 160 }).notNull(),
  inputPerMillionUsd: decimal("inputPerMillionUsd", { precision: 12, scale: 6 }).notNull(),
  outputPerMillionUsd: decimal("outputPerMillionUsd", { precision: 12, scale: 6 }).notNull(),
  cacheReadPerMillionUsd: decimal("cacheReadPerMillionUsd", { precision: 12, scale: 6 }),
  cacheWritePerMillionUsd: decimal("cacheWritePerMillionUsd", { precision: 12, scale: 6 }),
  scarcityFactor: decimal("scarcityFactor", { precision: 4, scale: 3 }).default("0.500").notNull(),
  maxConcurrency: int("maxConcurrency").default(1).notNull(),
  maxContextTokens: int("maxContextTokens").default(0).notNull(),
  capability: json("capability").$type<CapabilityMatrix>().notNull(),
  source: mysqlEnum("modelSource", ["provider_registry", "workspace_policy"]).default("provider_registry").notNull(),
  pricingVersion: varchar("pricingVersion", { length: 64 }).default("workspace-policy-v1").notNull(),
  capabilityVersion: varchar("capabilityVersion", { length: 64 }).default("workspace-policy-v1").notNull(),
  effectiveFrom: timestamp("effectiveFrom").defaultNow().notNull(),
  effectiveUntil: timestamp("effectiveUntil"),
  metadataVerifiedAt: timestamp("metadataVerifiedAt"),
  metadataSourceUrl: varchar("metadataSourceUrl", { length: 512 }),
  isActive: boolean("isActive").default(true).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("model_registry_provider_model_idx").on(table.provider, table.modelId)]);

/** Workspace-local model slots prevent one model's running tasks from exceeding the capacity declared by its active registry version. */
export const modelConcurrencyBudgets = mysqlTable("model_concurrency_budgets", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  modelRegistryId: int("modelRegistryId").notNull().references(() => modelRegistry.id, { onDelete: "cascade" }),
  maxConcurrentExecutions: int("maxConcurrentExecutions").default(1).notNull(),
  runningExecutions: int("runningExecutions").default(0).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("model_concurrency_workspace_model_unique").on(table.workspaceId, table.modelRegistryId),
  index("model_concurrency_workspace_idx").on(table.workspaceId),
]);

export const usageImportBatches = mysqlTable("usage_import_batches", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  importedByUserId: int("importedByUserId").notNull().references(() => users.id),
  filename: varchar("filename", { length: 255 }).notNull(),
  mimeType: varchar("mimeType", { length: 128 }).notNull(),
  storageKey: varchar("storageKey", { length: 512 }),
  storageUrl: text("storageUrl"),
  checksum: varchar("checksum", { length: 128 }).notNull(),
  format: mysqlEnum("importFormat", ["csv", "json"]).notNull(),
  status: mysqlEnum("importStatus", ["processing", "completed", "failed", "rolled_back"])
    .default("processing")
    .notNull(),
  rowsReceived: int("rowsReceived").default(0).notNull(),
  rowsAccepted: int("rowsAccepted").default(0).notNull(),
  rowsRejected: int("rowsRejected").default(0).notNull(),
  errorSummary: text("errorSummary"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  index("usage_import_batches_workspace_idx").on(table.workspaceId),
  uniqueIndex("usage_import_batches_workspace_checksum_unique").on(table.workspaceId, table.checksum),
]);

export const usageEvents = mysqlTable("usage_events", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  providerConnectionId: int("providerConnectionId").references(() => providerConnections.id, { onDelete: "set null" }),
  importBatchId: int("importBatchId").references(() => usageImportBatches.id, { onDelete: "set null" }),
  modelRegistryId: int("modelRegistryId").references(() => modelRegistry.id, { onDelete: "set null" }),
  provider: varchar("provider", { length: 64 }).notNull(),
  modelId: varchar("modelId", { length: 160 }).notNull(),
  tokens: json("tokens").$type<UsageTokenPayload>().notNull(),
  estimatedCostUsd: decimal("estimatedCostUsd", { precision: 12, scale: 6 }).default("0").notNull(),
  actualCostUsd: decimal("actualCostUsd", { precision: 12, scale: 6 }),
  budgetWindow: mysqlEnum("usageBudgetWindow", ["five_hour", "daily", "weekly", "monthly"]),
  costUnit: varchar("costUnit", { length: 12 }).default("USD").notNull(),
  costBasis: mysqlEnum("costBasis", ["estimated", "actual", "mixed"]).default("actual").notNull(),
  source: mysqlEnum("usageSource", ["import", "manual", "scheduled_sync", "task_attempt"]).notNull(),
  occurredAt: timestamp("occurredAt").notNull(),
  externalRef: varchar("externalRef", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  index("usage_events_workspace_time_idx").on(table.workspaceId, table.occurredAt),
  index("usage_events_model_time_idx").on(table.modelId, table.occurredAt),
  uniqueIndex("usage_events_external_ref_unique").on(table.workspaceId, table.externalRef),
]);

export const researchTasks = mysqlTable("research_tasks", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdByUserId: int("createdByUserId").notNull().references(() => users.id),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  priority: mysqlEnum("taskPriority", ["P0", "P1", "P2", "P3"]).default("P2").notNull(),
  taskClass: mysqlEnum("taskClass", ["formal_experiment", "experiment_pipeline", "development", "convenience"])
    .default("development")
    .notNull(),
  status: mysqlEnum("taskStatus", ["draft", "queued", "reserved", "running", "paused", "completed", "failed", "cancelled"])
    .default("draft")
    .notNull(),
  routeMode: mysqlEnum("routeMode", ["strict", "balanced", "emergency"]).default("balanced").notNull(),
  admissionDecision: mysqlEnum("admissionDecision", ["ADMIT", "RESERVE", "MIGRATE", "QUEUE", "HOLD"])
    .default("ADMIT")
    .notNull(),
  resultClass: mysqlEnum("resultClass", ["official", "fallback", "exploratory", "recovery"]).default("exploratory").notNull(),
  experimentId: varchar("experimentId", { length: 128 }),
  runId: varchar("runId", { length: 128 }),
  requirements: json("requirements").$type<TaskRequirements>().notNull(),
  requestedModelId: varchar("requestedModelId", { length: 160 }),
  estimatedInputTokens: int("estimatedInputTokens").default(0).notNull(),
  estimatedOutputTokens: int("estimatedOutputTokens").default(0).notNull(),
  estimatedCostUsd: decimal("estimatedCostUsd", { precision: 12, scale: 6 }).default("0").notNull(),
  taskBudgetUsd: decimal("taskBudgetUsd", { precision: 12, scale: 6 }).default("0").notNull(),
  cumulativeCostCapUsd: decimal("cumulativeCostCapUsd", { precision: 12, scale: 6 }).default("0").notNull(),
  actualCostUsd: decimal("actualCostUsd", { precision: 12, scale: 6 }).default("0").notNull(),
  remainingBudgetUsd: decimal("remainingBudgetUsd", { precision: 12, scale: 6 }).default("0").notNull(),
  maxAttempts: int("maxAttempts").default(3).notNull(),
  queuedAt: timestamp("queuedAt"),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  index("research_tasks_workspace_status_idx").on(table.workspaceId, table.status),
  index("research_tasks_workspace_priority_idx").on(table.workspaceId, table.priority),
]);

export const budgetReservations = mysqlTable("budget_reservations", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  providerBudgetId: int("providerBudgetId").notNull().references(() => providerBudgets.id, { onDelete: "cascade" }),
  taskId: int("taskId").notNull().references(() => researchTasks.id, { onDelete: "cascade" }),
  amountUsd: decimal("amountUsd", { precision: 12, scale: 6 }).notNull(),
  reservationKind: mysqlEnum("reservationKind", ["hard", "soft"]).default("hard").notNull(),
  status: mysqlEnum("reservationStatus", ["AVAILABLE", "RESERVED", "CONSUMED", "RELEASED"])
    .default("AVAILABLE")
    .notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  index("budget_reservations_budget_status_idx").on(table.providerBudgetId, table.status),
  index("budget_reservations_task_idx").on(table.taskId),
  uniqueIndex("budget_reservations_task_unique").on(table.taskId),
]);

export const taskAttempts = mysqlTable("task_attempts", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  taskId: int("taskId").notNull().references(() => researchTasks.id, { onDelete: "cascade" }),
  attemptNumber: int("attemptNumber").notNull(),
  requestedModelId: varchar("requestedModelId", { length: 160 }),
  actualModelId: varchar("actualModelId", { length: 160 }),
  modelRegistryId: int("modelRegistryId").references(() => modelRegistry.id, { onDelete: "set null" }),
  provider: varchar("provider", { length: 64 }),
  fallback: boolean("fallback").default(false).notNull(),
  fallbackReason: mysqlEnum("fallbackReason", ["quota_low", "rate_limit", "timeout", "provider_error", "model_unavailable", "context_overflow", "tool_error", "manual"]),
  quotaState: mysqlEnum("attemptQuotaState", ["GREEN", "YELLOW", "ORANGE", "DRAIN_PROTECTION", "RED"]),
  failureReason: mysqlEnum("failureReason", ["QUOTA", "RATE_LIMIT", "TIMEOUT", "PROVIDER_ERROR", "MODEL_UNAVAILABLE", "CONTEXT_OVERFLOW", "TOOL_ERROR", "UNKNOWN"]),
  failurePolicy: json("failurePolicy").$type<FailurePolicySnapshot>(),
  resultClass: mysqlEnum("attemptResultClass", ["official", "fallback", "exploratory", "recovery"])
    .default("exploratory")
    .notNull(),
  status: mysqlEnum("attemptStatus", ["queued", "running", "completed", "failed", "cancelled"])
    .default("queued")
    .notNull(),
  estimatedCostUsd: decimal("estimatedCostUsd", { precision: 12, scale: 6 }).default("0").notNull(),
  actualCostUsd: decimal("actualCostUsd", { precision: 12, scale: 6 }),
  promptHash: varchar("promptHash", { length: 128 }),
  routeVersion: varchar("routeVersion", { length: 64 }).default("qars-v2").notNull(),
  executionPlan: json("executionPlan").$type<AttemptExecutionPlan>(),
  retryNotBefore: timestamp("retryNotBefore"),
  concurrencyClaimed: boolean("concurrencyClaimed").default(false).notNull(),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("task_attempts_task_number_unique").on(table.taskId, table.attemptNumber),
  index("task_attempts_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);

/** Immutable per-attempt research ledger. The row is appended only when an attempt is settled and never used as mutable queue state. */
export const experimentExecutionLedger = mysqlTable("experiment_execution_ledger", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  taskId: int("taskId").notNull().references(() => researchTasks.id, { onDelete: "cascade" }),
  attemptId: int("attemptId").notNull().references(() => taskAttempts.id, { onDelete: "cascade" }),
  modelRegistryId: int("modelRegistryId").references(() => modelRegistry.id, { onDelete: "set null" }),
  provider: varchar("provider", { length: 64 }).notNull(),
  requestedModelId: varchar("requestedModelId", { length: 160 }),
  actualModelId: varchar("actualModelId", { length: 160 }).notNull(),
  priority: mysqlEnum("ledgerPriority", ["P0", "P1", "P2", "P3"]).notNull(),
  taskClass: mysqlEnum("ledgerTaskClass", ["formal_experiment", "experiment_pipeline", "development", "convenience"]).notNull(),
  resultClass: mysqlEnum("ledgerResultClass", ["official", "fallback", "exploratory", "recovery"]).notNull(),
  status: mysqlEnum("ledgerAttemptStatus", ["completed", "failed", "cancelled"]).notNull(),
  fallback: boolean("fallback").notNull(),
  fallbackReason: mysqlEnum("ledgerFallbackReason", ["quota_low", "rate_limit", "timeout", "provider_error", "model_unavailable", "context_overflow", "tool_error", "manual"]),
  failureReason: mysqlEnum("ledgerFailureReason", ["QUOTA", "RATE_LIMIT", "TIMEOUT", "PROVIDER_ERROR", "MODEL_UNAVAILABLE", "CONTEXT_OVERFLOW", "TOOL_ERROR", "UNKNOWN"]),
  quotaState: mysqlEnum("ledgerQuotaState", ["GREEN", "YELLOW", "ORANGE", "DRAIN_PROTECTION", "RED"]),
  tokens: json("tokens").$type<UsageTokenPayload>().notNull(),
  estimatedCostUsd: decimal("estimatedCostUsd", { precision: 12, scale: 6 }).notNull(),
  actualCostUsd: decimal("actualCostUsd", { precision: 12, scale: 6 }).notNull(),
  promptHash: varchar("promptHash", { length: 128 }),
  experimentId: varchar("experimentId", { length: 128 }),
  runId: varchar("runId", { length: 128 }),
  executionPlan: json("executionPlan").$type<AttemptExecutionPlan>(),
  recordedAt: timestamp("recordedAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("experiment_ledger_attempt_unique").on(table.attemptId),
  index("experiment_ledger_workspace_recorded_idx").on(table.workspaceId, table.recordedAt),
  index("experiment_ledger_experiment_run_idx").on(table.experimentId, table.runId),
]);

/** Append-only evidence for Route Lab policy evaluations; it records a decision without creating a task or invoking a provider. */
export const routePolicyEvaluations = mysqlTable("route_policy_evaluations", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  priority: mysqlEnum("evaluationPriority", ["P0", "P1", "P2", "P3"]).notNull(),
  routeMode: mysqlEnum("evaluationRouteMode", ["strict", "balanced", "emergency"]).notNull(),
  scenario: mysqlEnum("evaluationScenario", ["none", "rate_limit", "quota_low", "timeout", "context_overflow"]).default("none").notNull(),
  requirements: json("requirements").$type<TaskRequirements>().notNull(),
  estimatedCostUsd: decimal("estimatedCostUsd", { precision: 12, scale: 6 }).notNull(),
  requestedModelId: varchar("requestedModelId", { length: 160 }),
  selectedModelId: varchar("selectedModelId", { length: 160 }),
  admissionDecision: mysqlEnum("evaluationDecision", ["ADMIT", "RESERVE", "MIGRATE", "QUEUE", "HOLD"]).notNull(),
  budgetState: mysqlEnum("evaluationBudgetState", ["GREEN", "YELLOW", "ORANGE", "DRAIN_PROTECTION", "RED"]).notNull(),
  reason: text("reason").notNull(),
  routePlan: json("routePlan").$type<RoutePlanSnapshot>().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  index("route_policy_evaluations_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);

export const routeDecisions = mysqlTable("route_decisions", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  taskId: int("taskId").notNull().references(() => researchTasks.id, { onDelete: "cascade" }),
  attemptId: int("attemptId").references(() => taskAttempts.id, { onDelete: "set null" }),
  admissionDecision: mysqlEnum("routeDecision", ["ADMIT", "RESERVE", "MIGRATE", "QUEUE", "HOLD"]).notNull(),
  budgetState: mysqlEnum("routeBudgetState", ["GREEN", "YELLOW", "ORANGE", "DRAIN_PROTECTION", "RED"]).notNull(),
  availableUsd: decimal("availableUsd", { precision: 12, scale: 6 }).notNull(),
  dynamicReserveUsd: decimal("dynamicReserveUsd", { precision: 12, scale: 6 }).notNull(),
  estimatedCostUsd: decimal("estimatedCostUsd", { precision: 12, scale: 6 }).notNull(),
  reason: text("reason").notNull(),
  recommendedAction: mysqlEnum("recommendedAction", ["run", "reserve", "migrate", "queue", "hold", "manual_handoff"]).notNull(),
  selectedModelId: varchar("selectedModelId", { length: 160 }),
  routePlan: json("routePlan").$type<RoutePlanSnapshot>(),
  requiresHumanHandoff: boolean("requiresHumanHandoff").default(false).notNull(),
  actedAt: timestamp("actedAt"),
  actedByUserId: int("actedByUserId").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  index("route_decisions_task_created_idx").on(table.taskId, table.createdAt),
  index("route_decisions_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);

export const budgetAlerts = mysqlTable("budget_alerts", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  providerBudgetId: int("providerBudgetId").references(() => providerBudgets.id, { onDelete: "set null" }),
  severity: mysqlEnum("alertSeverity", ["info", "warning", "critical"]).notNull(),
  kind: mysqlEnum("alertKind", ["budget_state", "forecast_exhaustion", "connection", "queue_blocked", "reservation", "import"])
    .notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message").notNull(),
  dedupeKey: varchar("dedupeKey", { length: 255 }).notNull(),
  acknowledgedAt: timestamp("acknowledgedAt"),
  acknowledgedByUserId: int("acknowledgedByUserId").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  uniqueIndex("budget_alerts_workspace_dedupe_unique").on(table.workspaceId, table.dedupeKey),
  index("budget_alerts_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);

export const schedulerSettings = mysqlTable("scheduler_settings", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  scheduleCronTaskUid: varchar("schedule_cron_task_uid", { length: 65 }),
  cronExpression: varchar("cronExpression", { length: 64 }).default("0 */15 * * * *").notNull(),
  enabled: boolean("enabled").default(false).notNull(),
  lastRunAt: timestamp("lastRunAt"),
  lastRunStatus: mysqlEnum("lastRunStatus", ["idle", "success", "failed", "skipped"]).default("idle").notNull(),
  lastRunMessage: text("lastRunMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [
  uniqueIndex("scheduler_settings_workspace_unique").on(table.workspaceId),
  index("scheduler_settings_task_uid_idx").on(table.scheduleCronTaskUid),
]);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
