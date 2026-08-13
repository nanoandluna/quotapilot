CREATE TABLE `worker_locks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`lockName` varchar(96) NOT NULL,
	`holderId` varchar(160) NOT NULL,
	`leaseExpiresAt` timestamp NOT NULL,
	`acquiredAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `worker_locks_id` PRIMARY KEY(`id`),
	CONSTRAINT `worker_locks_workspace_name_unique` UNIQUE(`workspaceId`,`lockName`)
);
--> statement-breakpoint
ALTER TABLE `worker_locks` ADD CONSTRAINT `worker_locks_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `worker_locks_lease_expiry_idx` ON `worker_locks` (`leaseExpiresAt`);