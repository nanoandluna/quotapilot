CREATE TABLE `budget_alerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`providerBudgetId` int,
	`alertSeverity` enum('info','warning','critical') NOT NULL,
	`alertKind` enum('budget_state','forecast_exhaustion','connection','queue_blocked','reservation','import') NOT NULL,
	`title` varchar(255) NOT NULL,
	`message` text NOT NULL,
	`dedupeKey` varchar(255) NOT NULL,
	`acknowledgedAt` timestamp,
	`acknowledgedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `budget_alerts_id` PRIMARY KEY(`id`),
	CONSTRAINT `budget_alerts_workspace_dedupe_unique` UNIQUE(`workspaceId`,`dedupeKey`)
);
--> statement-breakpoint
CREATE TABLE `budget_reservations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`providerBudgetId` int NOT NULL,
	`taskId` int NOT NULL,
	`amountUsd` decimal(12,6) NOT NULL,
	`reservationStatus` enum('AVAILABLE','RESERVED','CONSUMED','RELEASED') NOT NULL DEFAULT 'AVAILABLE',
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `budget_reservations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `model_registry` (
	`id` int AUTO_INCREMENT NOT NULL,
	`registryProvider` enum('opencode_go','openai_api','local') NOT NULL,
	`modelId` varchar(160) NOT NULL,
	`displayName` varchar(160) NOT NULL,
	`inputPerMillionUsd` decimal(12,6) NOT NULL,
	`outputPerMillionUsd` decimal(12,6) NOT NULL,
	`cacheReadPerMillionUsd` decimal(12,6),
	`cacheWritePerMillionUsd` decimal(12,6),
	`scarcityFactor` decimal(4,3) NOT NULL DEFAULT '0.500',
	`maxConcurrency` int NOT NULL DEFAULT 1,
	`capability` json NOT NULL,
	`modelSource` enum('provider_registry','workspace_policy') NOT NULL DEFAULT 'provider_registry',
	`isActive` boolean NOT NULL DEFAULT true,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `model_registry_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_registry_provider_model_unique` UNIQUE(`registryProvider`,`modelId`)
);
--> statement-breakpoint
CREATE TABLE `provider_budgets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`providerConnectionId` int NOT NULL,
	`budgetWindow` enum('five_hour','daily','weekly','monthly') NOT NULL,
	`limitUsd` decimal(12,4) NOT NULL,
	`consumedUsd` decimal(12,4) NOT NULL DEFAULT '0',
	`reservedUsd` decimal(12,4) NOT NULL DEFAULT '0',
	`dynamicReserveUsd` decimal(12,4) NOT NULL DEFAULT '0',
	`burnRate15m` decimal(12,4) NOT NULL DEFAULT '0',
	`burnRate1h` decimal(12,4) NOT NULL DEFAULT '0',
	`burnRate5h` decimal(12,4) NOT NULL DEFAULT '0',
	`burnRate24h` decimal(12,4) NOT NULL DEFAULT '0',
	`forecastExhaustionAt` timestamp,
	`resetAt` timestamp NOT NULL,
	`budgetState` enum('GREEN','YELLOW','ORANGE','DRAIN_PROTECTION','RED') NOT NULL DEFAULT 'GREEN',
	`budgetSource` enum('manual','import','scheduled_sync') NOT NULL DEFAULT 'manual',
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `provider_budgets_id` PRIMARY KEY(`id`),
	CONSTRAINT `provider_budgets_connection_window_unique` UNIQUE(`providerConnectionId`,`budgetWindow`)
);
--> statement-breakpoint
CREATE TABLE `provider_connections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`provider` enum('opencode_go','openai_api','chatgpt_plus_manual','local') NOT NULL,
	`displayName` varchar(128) NOT NULL,
	`syncMode` enum('scheduled','manual','import_only','disabled') NOT NULL DEFAULT 'disabled',
	`connectionState` enum('pending_configuration','connected','degraded','error','disabled') NOT NULL DEFAULT 'pending_configuration',
	`secretState` enum('not_configured','configured') NOT NULL DEFAULT 'not_configured',
	`lastSyncAt` timestamp,
	`lastSyncError` text,
	`syncIntervalMinutes` int NOT NULL DEFAULT 15,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `provider_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `provider_connections_workspace_provider_unique` UNIQUE(`workspaceId`,`provider`)
);
--> statement-breakpoint
CREATE TABLE `research_tasks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`createdByUserId` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`taskPriority` enum('P0','P1','P2','P3') NOT NULL DEFAULT 'P2',
	`taskClass` enum('formal_experiment','experiment_pipeline','development','convenience') NOT NULL DEFAULT 'development',
	`taskStatus` enum('draft','queued','reserved','running','paused','completed','failed','cancelled') NOT NULL DEFAULT 'draft',
	`routeMode` enum('strict','balanced','emergency') NOT NULL DEFAULT 'balanced',
	`resultClass` enum('official','fallback','exploratory','recovery') NOT NULL DEFAULT 'exploratory',
	`experimentId` varchar(128),
	`runId` varchar(128),
	`requirements` json NOT NULL,
	`requestedModelId` varchar(160),
	`estimatedInputTokens` int NOT NULL DEFAULT 0,
	`estimatedOutputTokens` int NOT NULL DEFAULT 0,
	`estimatedCostUsd` decimal(12,6) NOT NULL DEFAULT '0',
	`taskBudgetUsd` decimal(12,6) NOT NULL DEFAULT '0',
	`actualCostUsd` decimal(12,6) NOT NULL DEFAULT '0',
	`maxAttempts` int NOT NULL DEFAULT 3,
	`queuedAt` timestamp,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `research_tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `scheduler_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`schedule_cron_task_uid` varchar(65),
	`cronExpression` varchar(64) NOT NULL DEFAULT '0 */15 * * * *',
	`enabled` boolean NOT NULL DEFAULT false,
	`lastRunAt` timestamp,
	`lastRunStatus` enum('idle','success','failed','skipped') NOT NULL DEFAULT 'idle',
	`lastRunMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `scheduler_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `scheduler_settings_workspace_unique` UNIQUE(`workspaceId`)
);
--> statement-breakpoint
CREATE TABLE `task_attempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`taskId` int NOT NULL,
	`attemptNumber` int NOT NULL,
	`requestedModelId` varchar(160),
	`actualModelId` varchar(160),
	`provider` varchar(64),
	`fallback` boolean NOT NULL DEFAULT false,
	`fallbackReason` enum('quota_low','rate_limit','timeout','provider_error','model_unavailable','context_overflow','tool_error','manual'),
	`attemptQuotaState` enum('GREEN','YELLOW','ORANGE','DRAIN_PROTECTION','RED'),
	`failureReason` enum('QUOTA','RATE_LIMIT','TIMEOUT','PROVIDER_ERROR','MODEL_UNAVAILABLE','CONTEXT_OVERFLOW','TOOL_ERROR','UNKNOWN'),
	`attemptStatus` enum('queued','running','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
	`estimatedCostUsd` decimal(12,6) NOT NULL DEFAULT '0',
	`actualCostUsd` decimal(12,6),
	`promptHash` varchar(128),
	`routeVersion` varchar(64) NOT NULL DEFAULT 'qars-v2',
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `task_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `task_attempts_task_number_unique` UNIQUE(`taskId`,`attemptNumber`)
);
--> statement-breakpoint
CREATE TABLE `usage_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`providerConnectionId` int,
	`importBatchId` int,
	`modelRegistryId` int,
	`provider` varchar(64) NOT NULL,
	`modelId` varchar(160) NOT NULL,
	`tokens` json NOT NULL,
	`estimatedCostUsd` decimal(12,6) NOT NULL DEFAULT '0',
	`actualCostUsd` decimal(12,6),
	`usageSource` enum('import','manual','scheduled_sync','task_attempt') NOT NULL,
	`occurredAt` timestamp NOT NULL,
	`externalRef` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `usage_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `usage_events_external_ref_unique` UNIQUE(`workspaceId`,`externalRef`)
);
--> statement-breakpoint
CREATE TABLE `usage_import_batches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`importedByUserId` int NOT NULL,
	`filename` varchar(255) NOT NULL,
	`mimeType` varchar(128) NOT NULL,
	`storageKey` varchar(512),
	`storageUrl` text,
	`checksum` varchar(128) NOT NULL,
	`importFormat` enum('csv','json') NOT NULL,
	`importStatus` enum('processing','completed','failed','rolled_back') NOT NULL DEFAULT 'processing',
	`rowsReceived` int NOT NULL DEFAULT 0,
	`rowsAccepted` int NOT NULL DEFAULT 0,
	`rowsRejected` int NOT NULL DEFAULT 0,
	`errorSummary` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `usage_import_batches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openId` varchar(64) NOT NULL,
	`name` text,
	`email` varchar(320),
	`loginMethod` varchar(64),
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastSignedIn` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_openId_unique` UNIQUE(`openId`)
);
--> statement-breakpoint
CREATE TABLE `workspace_invites` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`email` varchar(320) NOT NULL,
	`inviteRole` enum('admin','researcher','reviewer','viewer') NOT NULL DEFAULT 'researcher',
	`inviteStatus` enum('pending','accepted','revoked','expired') NOT NULL DEFAULT 'pending',
	`invitedByUserId` int NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspace_invites_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`workspaceRole` enum('owner','admin','researcher','reviewer','viewer') NOT NULL DEFAULT 'researcher',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspace_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspace_members_workspace_user_unique` UNIQUE(`workspaceId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(128) NOT NULL,
	`slug` varchar(96) NOT NULL,
	`researchPhase` enum('development','paper','final_submission') NOT NULL DEFAULT 'development',
	`timezone` varchar(64) NOT NULL DEFAULT 'Asia/Shanghai',
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaces_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspaces_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `budget_alerts` ADD CONSTRAINT `budget_alerts_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `budget_alerts` ADD CONSTRAINT `budget_alerts_providerBudgetId_provider_budgets_id_fk` FOREIGN KEY (`providerBudgetId`) REFERENCES `provider_budgets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `budget_alerts` ADD CONSTRAINT `budget_alerts_acknowledgedByUserId_users_id_fk` FOREIGN KEY (`acknowledgedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `budget_reservations` ADD CONSTRAINT `budget_reservations_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `budget_reservations` ADD CONSTRAINT `budget_reservations_providerBudgetId_provider_budgets_id_fk` FOREIGN KEY (`providerBudgetId`) REFERENCES `provider_budgets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `budget_reservations` ADD CONSTRAINT `budget_reservations_taskId_research_tasks_id_fk` FOREIGN KEY (`taskId`) REFERENCES `research_tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `provider_budgets` ADD CONSTRAINT `provider_budgets_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `provider_budgets` ADD CONSTRAINT `provider_budgets_providerConnectionId_provider_connections_id_fk` FOREIGN KEY (`providerConnectionId`) REFERENCES `provider_connections`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD CONSTRAINT `provider_connections_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `research_tasks` ADD CONSTRAINT `research_tasks_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `research_tasks` ADD CONSTRAINT `research_tasks_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `scheduler_settings` ADD CONSTRAINT `scheduler_settings_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_attempts` ADD CONSTRAINT `task_attempts_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_attempts` ADD CONSTRAINT `task_attempts_taskId_research_tasks_id_fk` FOREIGN KEY (`taskId`) REFERENCES `research_tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `usage_events` ADD CONSTRAINT `usage_events_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `usage_events` ADD CONSTRAINT `usage_events_providerConnectionId_provider_connections_id_fk` FOREIGN KEY (`providerConnectionId`) REFERENCES `provider_connections`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `usage_events` ADD CONSTRAINT `usage_events_importBatchId_usage_import_batches_id_fk` FOREIGN KEY (`importBatchId`) REFERENCES `usage_import_batches`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `usage_events` ADD CONSTRAINT `usage_events_modelRegistryId_model_registry_id_fk` FOREIGN KEY (`modelRegistryId`) REFERENCES `model_registry`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `usage_import_batches` ADD CONSTRAINT `usage_import_batches_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `usage_import_batches` ADD CONSTRAINT `usage_import_batches_importedByUserId_users_id_fk` FOREIGN KEY (`importedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_invites` ADD CONSTRAINT `workspace_invites_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_invites` ADD CONSTRAINT `workspace_invites_invitedByUserId_users_id_fk` FOREIGN KEY (`invitedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD CONSTRAINT `workspace_members_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD CONSTRAINT `workspace_members_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspaces` ADD CONSTRAINT `workspaces_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `budget_alerts_workspace_created_idx` ON `budget_alerts` (`workspaceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `budget_reservations_budget_status_idx` ON `budget_reservations` (`providerBudgetId`,`reservationStatus`);--> statement-breakpoint
CREATE INDEX `budget_reservations_task_idx` ON `budget_reservations` (`taskId`);--> statement-breakpoint
CREATE INDEX `provider_budgets_workspace_idx` ON `provider_budgets` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `research_tasks_workspace_status_idx` ON `research_tasks` (`workspaceId`,`taskStatus`);--> statement-breakpoint
CREATE INDEX `research_tasks_workspace_priority_idx` ON `research_tasks` (`workspaceId`,`taskPriority`);--> statement-breakpoint
CREATE INDEX `scheduler_settings_task_uid_idx` ON `scheduler_settings` (`schedule_cron_task_uid`);--> statement-breakpoint
CREATE INDEX `task_attempts_workspace_created_idx` ON `task_attempts` (`workspaceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `usage_events_workspace_time_idx` ON `usage_events` (`workspaceId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `usage_events_model_time_idx` ON `usage_events` (`modelId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `usage_import_batches_workspace_idx` ON `usage_import_batches` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `workspace_invites_workspace_idx` ON `workspace_invites` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`userId`);