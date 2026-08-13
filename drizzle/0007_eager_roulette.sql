ALTER TABLE `model_registry` ADD `maxContextTokens` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_budgets` ADD `resetPolicy` enum('rolling','fixed','calendar','provider_reported') DEFAULT 'rolling' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_budgets` ADD `windowOrigin` timestamp;--> statement-breakpoint
ALTER TABLE `provider_budgets` ADD `windowTimezone` varchar(64) DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_budgets` ADD `providerReportedRemainingUsd` decimal(12,4);--> statement-breakpoint
ALTER TABLE `provider_budgets` ADD `providerReportedResetAt` timestamp;--> statement-breakpoint
ALTER TABLE `route_decisions` ADD `routePlan` json;