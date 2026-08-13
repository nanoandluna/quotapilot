ALTER TABLE `experiment_execution_ledger` ADD `sourceRevision` varchar(128);--> statement-breakpoint
ALTER TABLE `research_tasks` ADD `inputHash` varchar(128);--> statement-breakpoint
ALTER TABLE `research_tasks` ADD `sourceRevision` varchar(128);--> statement-breakpoint
ALTER TABLE `task_attempts` ADD `sourceRevision` varchar(128);