ALTER TABLE `provider_connections` ADD `circuitOpenUntil` timestamp;--> statement-breakpoint
ALTER TABLE `provider_connections` ADD `circuitReason` enum('QUOTA','RATE_LIMIT','TIMEOUT','PROVIDER_ERROR','MODEL_UNAVAILABLE','CONTEXT_OVERFLOW','TOOL_ERROR','UNKNOWN');--> statement-breakpoint
ALTER TABLE `task_attempts` ADD `retryNotBefore` timestamp;