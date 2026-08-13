CREATE TABLE `task_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`taskId` int NOT NULL,
	`attemptId` int,
	`actorUserId` int,
	`taskEventKind` enum('task_created','attempt_queued','attempt_claimed','attempt_settled','retry_queued','route_decision','task_paused','task_resumed','task_cancelled') NOT NULL,
	`payload` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `task_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `task_events` ADD CONSTRAINT `task_events_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_events` ADD CONSTRAINT `task_events_taskId_research_tasks_id_fk` FOREIGN KEY (`taskId`) REFERENCES `research_tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_events` ADD CONSTRAINT `task_events_attemptId_task_attempts_id_fk` FOREIGN KEY (`attemptId`) REFERENCES `task_attempts`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `task_events` ADD CONSTRAINT `task_events_actorUserId_users_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `task_events_workspace_created_idx` ON `task_events` (`workspaceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `task_events_task_created_idx` ON `task_events` (`taskId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `task_events_attempt_idx` ON `task_events` (`attemptId`);