CREATE TABLE `experiment_execution_ledger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`taskId` int NOT NULL,
	`attemptId` int NOT NULL,
	`modelRegistryId` int,
	`provider` varchar(64) NOT NULL,
	`requestedModelId` varchar(160),
	`actualModelId` varchar(160) NOT NULL,
	`ledgerPriority` enum('P0','P1','P2','P3') NOT NULL,
	`ledgerTaskClass` enum('formal_experiment','experiment_pipeline','development','convenience') NOT NULL,
	`ledgerResultClass` enum('official','fallback','exploratory','recovery') NOT NULL,
	`ledgerAttemptStatus` enum('completed','failed','cancelled') NOT NULL,
	`fallback` boolean NOT NULL,
	`ledgerFallbackReason` enum('quota_low','rate_limit','timeout','provider_error','model_unavailable','context_overflow','tool_error','manual'),
	`ledgerFailureReason` enum('QUOTA','RATE_LIMIT','TIMEOUT','PROVIDER_ERROR','MODEL_UNAVAILABLE','CONTEXT_OVERFLOW','TOOL_ERROR','UNKNOWN'),
	`ledgerQuotaState` enum('GREEN','YELLOW','ORANGE','DRAIN_PROTECTION','RED'),
	`tokens` json NOT NULL,
	`estimatedCostUsd` decimal(12,6) NOT NULL,
	`actualCostUsd` decimal(12,6) NOT NULL,
	`promptHash` varchar(128),
	`experimentId` varchar(128),
	`runId` varchar(128),
	`executionPlan` json,
	`recordedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `experiment_execution_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `experiment_ledger_attempt_unique` UNIQUE(`attemptId`)
);
--> statement-breakpoint
ALTER TABLE `experiment_execution_ledger` ADD CONSTRAINT `experiment_execution_ledger_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `experiment_execution_ledger` ADD CONSTRAINT `experiment_execution_ledger_taskId_research_tasks_id_fk` FOREIGN KEY (`taskId`) REFERENCES `research_tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `experiment_execution_ledger` ADD CONSTRAINT `experiment_execution_ledger_attemptId_task_attempts_id_fk` FOREIGN KEY (`attemptId`) REFERENCES `task_attempts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `experiment_execution_ledger` ADD CONSTRAINT `experiment_execution_ledger_modelRegistryId_model_registry_id_fk` FOREIGN KEY (`modelRegistryId`) REFERENCES `model_registry`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `experiment_ledger_workspace_recorded_idx` ON `experiment_execution_ledger` (`workspaceId`,`recordedAt`);--> statement-breakpoint
CREATE INDEX `experiment_ledger_experiment_run_idx` ON `experiment_execution_ledger` (`experimentId`,`runId`);