ALTER TABLE `research_tasks` ADD `cumulativeCostCapUsd` decimal(12,6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `research_tasks` ADD `cumulativeCostCapUsd` decimal(12,6) DEFAULT '0' NOT NULL;
ALTER TABLE `research_tasks` ADD `remainingBudgetUsd` decimal(12,6) DEFAULT '0' NOT NULL;
UPDATE `research_tasks`
SET `cumulativeCostCapUsd` = `taskBudgetUsd`,
    `remainingBudgetUsd` = GREATEST(`taskBudgetUsd` - `actualCostUsd`, 0)
WHERE `cumulativeCostCapUsd` = 0 AND `remainingBudgetUsd` = 0;
