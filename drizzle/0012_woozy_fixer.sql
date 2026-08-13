CREATE TABLE `quota_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`providerConnectionId` int NOT NULL,
	`providerBudgetId` int NOT NULL,
	`snapshotWindow` enum('five_hour','daily','weekly','monthly') NOT NULL,
	`limitUsd` decimal(12,4) NOT NULL,
	`consumedUsd` decimal(12,4) NOT NULL,
	`reservedUsd` decimal(12,4) NOT NULL,
	`dynamicReserveUsd` decimal(12,4) NOT NULL,
	`snapshotBudgetState` enum('GREEN','YELLOW','ORANGE','DRAIN_PROTECTION','RED') NOT NULL,
	`snapshotSource` enum('manual','import','scheduled_sync') NOT NULL,
	`capturedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `quota_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `usage_events` ADD `usageBudgetWindow` enum('five_hour','daily','weekly','monthly');--> statement-breakpoint
ALTER TABLE `usage_events` ADD `costUnit` varchar(12) DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `costBasis` enum('estimated','actual','mixed') DEFAULT 'actual' NOT NULL;--> statement-breakpoint
ALTER TABLE `quota_snapshots` ADD CONSTRAINT `quota_snapshots_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quota_snapshots` ADD CONSTRAINT `quota_snapshots_providerConnectionId_provider_connections_id_fk` FOREIGN KEY (`providerConnectionId`) REFERENCES `provider_connections`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quota_snapshots` ADD CONSTRAINT `quota_snapshots_providerBudgetId_provider_budgets_id_fk` FOREIGN KEY (`providerBudgetId`) REFERENCES `provider_budgets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `quota_snapshots_workspace_captured_idx` ON `quota_snapshots` (`workspaceId`,`capturedAt`);--> statement-breakpoint
CREATE INDEX `quota_snapshots_budget_captured_idx` ON `quota_snapshots` (`providerBudgetId`,`capturedAt`);