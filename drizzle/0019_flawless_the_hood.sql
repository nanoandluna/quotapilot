CREATE TABLE `route_policy_evaluations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`evaluationPriority` enum('P0','P1','P2','P3') NOT NULL,
	`evaluationRouteMode` enum('strict','balanced','emergency') NOT NULL,
	`evaluationScenario` enum('none','rate_limit','quota_low','timeout','context_overflow') NOT NULL DEFAULT 'none',
	`requirements` json NOT NULL,
	`estimatedCostUsd` decimal(12,6) NOT NULL,
	`requestedModelId` varchar(160),
	`selectedModelId` varchar(160),
	`evaluationDecision` enum('ADMIT','RESERVE','MIGRATE','QUEUE','HOLD') NOT NULL,
	`evaluationBudgetState` enum('GREEN','YELLOW','ORANGE','DRAIN_PROTECTION','RED') NOT NULL,
	`reason` text NOT NULL,
	`routePlan` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `route_policy_evaluations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `route_policy_evaluations` ADD CONSTRAINT `route_policy_evaluations_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `route_policy_evaluations_workspace_created_idx` ON `route_policy_evaluations` (`workspaceId`,`createdAt`);