ALTER TABLE `workspace_invites` ADD `token` varchar(96);--> statement-breakpoint
ALTER TABLE `workspace_invites` ADD `acceptedByUserId` int;--> statement-breakpoint
ALTER TABLE `workspace_invites` ADD `acceptedAt` timestamp;--> statement-breakpoint
ALTER TABLE `workspace_invites` ADD CONSTRAINT `workspace_invites_token_unique` UNIQUE(`token`);--> statement-breakpoint
ALTER TABLE `workspace_invites` ADD CONSTRAINT `workspace_invites_acceptedByUserId_users_id_fk` FOREIGN KEY (`acceptedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;