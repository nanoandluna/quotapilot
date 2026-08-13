CREATE TABLE `route_decisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`taskId` int NOT NULL,
	`attemptId` int,
	`routeDecision` enum('ADMIT','RESERVE','MIGRATE','QUEUE','HOLD') NOT NULL,
	`routeBudgetState` enum('GREEN','YELLOW','ORANGE','DRAIN_PROTECTION','RED') NOT NULL,
	`availableUsd` decimal(12,6) NOT NULL,
	`dynamicReserveUsd` decimal(12,6) NOT NULL,
	`estimatedCostUsd` decimal(12,6) NOT NULL,
	`reason` text NOT NULL,
	`recommendedAction` enum('run','reserve','migrate','queue','hold','manual_handoff') NOT NULL,
	`requiresHumanHandoff` boolean NOT NULL DEFAULT false,
	`actedAt` timestamp,
	`actedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `route_decisions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `route_decisions` ADD CONSTRAINT `route_decisions_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `route_decisions` ADD CONSTRAINT `route_decisions_taskId_research_tasks_id_fk` FOREIGN KEY (`taskId`) REFERENCES `research_tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `route_decisions` ADD CONSTRAINT `route_decisions_attemptId_task_attempts_id_fk` FOREIGN KEY (`attemptId`) REFERENCES `task_attempts`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `route_decisions` ADD CONSTRAINT `route_decisions_actedByUserId_users_id_fk` FOREIGN KEY (`actedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `route_decisions_task_created_idx` ON `route_decisions` (`taskId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `route_decisions_workspace_created_idx` ON `route_decisions` (`workspaceId`,`createdAt`);