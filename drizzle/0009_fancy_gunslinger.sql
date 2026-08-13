ALTER TABLE `model_registry` ADD `pricingVersion` varchar(64) DEFAULT 'workspace-policy-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE `model_registry` ADD `capabilityVersion` varchar(64) DEFAULT 'workspace-policy-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE `model_registry` ADD `effectiveFrom` timestamp DEFAULT (now()) NOT NULL;--> statement-breakpoint
ALTER TABLE `model_registry` ADD `effectiveUntil` timestamp;--> statement-breakpoint
ALTER TABLE `model_registry` ADD `metadataVerifiedAt` timestamp;--> statement-breakpoint
ALTER TABLE `model_registry` ADD `metadataSourceUrl` varchar(512);