CREATE TABLE `model_concurrency_budgets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`modelRegistryId` int NOT NULL,
	`maxConcurrentExecutions` int NOT NULL DEFAULT 1,
	`runningExecutions` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `model_concurrency_budgets_id` PRIMARY KEY(`id`),
	CONSTRAINT `model_concurrency_workspace_model_unique` UNIQUE(`workspaceId`,`modelRegistryId`)
);
--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `maxConcurrentExecutions` int DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `runningExecutions` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_attempts` ADD `modelRegistryId` int;--> statement-breakpoint
ALTER TABLE `task_attempts` ADD `concurrencyClaimed` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `model_concurrency_budgets` ADD CONSTRAINT `model_concurrency_budgets_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `model_concurrency_budgets` ADD CONSTRAINT `model_concurrency_budgets_modelRegistryId_model_registry_id_fk` FOREIGN KEY (`modelRegistryId`) REFERENCES `model_registry`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `model_concurrency_workspace_idx` ON `model_concurrency_budgets` (`workspaceId`);--> statement-breakpoint
ALTER TABLE `task_attempts` ADD CONSTRAINT `task_attempts_modelRegistryId_model_registry_id_fk` FOREIGN KEY (`modelRegistryId`) REFERENCES `model_registry`(`id`) ON DELETE set null ON UPDATE no action;