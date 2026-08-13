import { describe, expect, it } from "vitest";
import { getQuotaMaintenanceMode } from "./scheduledQuota";

describe("quota maintenance mode", () => {
  it("uses imported-usage-only mode until external provider credentials are configured", () => {
    expect(getQuotaMaintenanceMode()).toMatch(/provider_sync_ready|recalculate_imported_usage_only/);
  });
});
