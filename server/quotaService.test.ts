import { describe, expect, it } from "vitest";
import { calculateBudgetState, getAdmissionDecision, parseUsageImport } from "./quotaService";

describe("QuotaPilot V2 budget engine", () => {
  it("enters drain protection when the conservative burn rate exhausts budget before reset", () => {
    const result = calculateBudgetState({
      limitUsd: 12,
      consumedUsd: 7.2,
      reservedUsd: 1.5,
      dynamicReserveUsd: 1,
      burnRates: [0.9, 1.4, 2.1],
      resetAt: new Date("2026-08-13T12:00:00.000Z"),
      now: new Date("2026-08-13T10:00:00.000Z"),
    });

    expect(result.availableUsd).toBeCloseTo(3.3);
    expect(result.state).toBe("DRAIN_PROTECTION");
  });

  it("parses CSV usage imports with token and cost fields", () => {
    const events = parseUsageImport(
      "occurred_at,provider,model_id,input_tokens,output_tokens,actual_cost_usd,external_ref\n2026-08-13T08:00:00Z,opencode_go,deepseek-v4-flash,1200,400,0.002,evt-001",
      "csv",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "opencode_go",
      modelId: "deepseek-v4-flash",
      actualCostUsd: 0.002,
      externalRef: "evt-001",
    });
  });

  it("queues noncritical work before it consumes a protected drain window", () => {
    const decision = getAdmissionDecision({
      priority: "P2",
      routeMode: "balanced",
      estimatedCostUsd: 0.2,
      availableUsd: 1.1,
      dynamicReserveUsd: 1,
      budgetState: "DRAIN_PROTECTION",
    });

    expect(decision).toBe("QUEUE");
  });

  it("migrates noncritical work in an orange budget state before it touches the reserve", () => {
    expect(getAdmissionDecision({
      priority: "P3",
      routeMode: "balanced",
      estimatedCostUsd: 0.2,
      availableUsd: 1.5,
      dynamicReserveUsd: 0.5,
      budgetState: "ORANGE",
    })).toBe("MIGRATE");
  });

  it("holds work when the shared budget is red or below the task estimate", () => {
    expect(getAdmissionDecision({
      priority: "P1",
      routeMode: "strict",
      estimatedCostUsd: 0.5,
      availableUsd: 0.4,
      dynamicReserveUsd: 0.1,
      budgetState: "RED",
    })).toBe("HOLD");
  });
});
