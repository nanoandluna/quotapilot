CREATE TABLE `workspace_audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`actorUserId` int,
	`auditAction` enum('member_invited','invite_accepted','member_role_changed','member_removed','route_decision_acted','task_claimed','attempt_settled') NOT NULL,
	`targetType` varchar(48) NOT NULL,
	`targetId` varchar(96),
	`before` json,
	`after` json,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspace_audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `workspace_audit_logs` ADD CONSTRAINT `workspace_audit_logs_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_audit_logs` ADD CONSTRAINT `workspace_audit_logs_actorUserId_users_id_fk` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `workspace_audit_logs_workspace_created_idx` ON `workspace_audit_logs` (`workspaceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `workspace_audit_logs_target_idx` ON `workspace_audit_logs` (`targetType`,`targetId`);