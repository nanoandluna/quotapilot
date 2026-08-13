import { describe, expect, it, vi } from "vitest";
import { buildUnifiedRoutePlan, calculateBudgetState, getAdmissionDecision, getReservationKind, getTaskBudgetAdmission, getTaskRetryAdmission, needsNewModelVersion, parseUsageImport, parseUsageImportDetailed, resolveBudgetResetAt, resolveTaskRouting, scoreCandidateModels, syncWorkspacePolicyModel } from "./quotaService";

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

  it("returns line-level import feedback while preserving valid records", () => {
    const parsed = parseUsageImportDetailed(
      "occurred_at,provider,model_id,actual_cost_usd\n2026-08-13T08:00:00Z,opencode_go,deepseek-v4-flash,0.002\ninvalid-time,opencode_go,,not-a-number",
      "csv",
    );

    expect(parsed.events).toHaveLength(1);
    expect(parsed.errors).toEqual([{ row: 2, reason: "缺少 model_id。", fields: ["model_id"] }]);
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

  it("uses hard reservations for P0/P1, soft reservations for P2, and no reservation for P3", () => {
    expect(getReservationKind("P0")).toBe("hard");
    expect(getReservationKind("P1")).toBe("hard");
    expect(getReservationKind("P2")).toBe("soft");
    expect(getReservationKind("P3")).toBeUndefined();
  });

  it("blocks a task before reservation when its first attempt would exceed the cumulative cost cap", () => {
    expect(getTaskBudgetAdmission({ estimatedCostUsd: 0.51, taskBudgetUsd: 0.5 })).toEqual({
      admitted: false,
      reason: "首轮预计成本超过任务累计成本上限；请提高任务预算或拆分任务。",
    });
    expect(getTaskBudgetAdmission({ estimatedCostUsd: 0.5, taskBudgetUsd: 0.5 })).toEqual({ admitted: true, reason: null });
  });

  it("rejects retry admission once a task reaches its configured maximum attempt count", () => {
    expect(getTaskRetryAdmission({ attemptCount: 2, maxAttempts: 3 })).toEqual({ admitted: true, reason: null });
    expect(getTaskRetryAdmission({ attemptCount: 3, maxAttempts: 3 })).toEqual({
      admitted: false,
      reason: "任务已达到最大尝试次数，拒绝创建新的 attempt。",
    });
  });

  it("advances expired reset windows according to policy while honoring future provider-reported reset times", () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    expect(resolveBudgetResetAt({ window: "five_hour", policy: "rolling", resetAt: new Date("2026-08-13T06:00:00.000Z"), now }).toISOString())
      .toBe("2026-08-13T17:00:00.000Z");
    expect(resolveBudgetResetAt({ window: "daily", policy: "fixed", resetAt: new Date("2026-08-10T00:00:00.000Z"), now }).toISOString())
      .toBe("2026-08-14T00:00:00.000Z");
    expect(resolveBudgetResetAt({ window: "weekly", policy: "provider_reported", resetAt: new Date("2026-08-10T00:00:00.000Z"), providerReportedResetAt: new Date("2026-08-15T03:00:00.000Z"), now }).toISOString())
      .toBe("2026-08-15T03:00:00.000Z");
  });

  it("creates a new model version only when routing-relevant policy metadata changes", () => {
    const desired = { modelId: "sample", displayName: "Sample", input: "0.2", output: "0.4", cacheRead: "0.02", scarcity: "0.5", concurrency: 2, capability: { code: 8, reasoning: 8, longContext: 8, vision: 1, toolUse: 8, chinese: 8, research: 8, agent: 8, speed: 8, reliability: 8 } };
    const current = { inputPerMillionUsd: "0.2", outputPerMillionUsd: "0.4", cacheReadPerMillionUsd: "0.02", scarcityFactor: "0.5", maxConcurrency: 2, capability: desired.capability, pricingVersion: "opencode-go-policy-2026-08-13", capabilityVersion: "opencode-go-policy-2026-08-13" };
    expect(needsNewModelVersion(current, desired)).toBe(false);
    expect(needsNewModelVersion({ ...current, maxConcurrency: 1 }, desired)).toBe(true);
  });

  it("closes a changed active model version and inserts a new current version", async () => {
    const oldVersion = { id: 10, inputPerMillionUsd: "0.2", outputPerMillionUsd: "0.4", cacheReadPerMillionUsd: "0.02", scarcityFactor: "0.5", maxConcurrency: 1, capability: { code: 8, reasoning: 8, longContext: 8, vision: 1, toolUse: 8, chinese: 8, research: 8, agent: 8, speed: 8, reliability: 8 }, pricingVersion: "opencode-go-policy-2026-08-13", capabilityVersion: "opencode-go-policy-2026-08-13" };
    const closeSet = vi.fn(() => ({ where: async () => undefined }));
    const insertValues = vi.fn(async () => undefined);
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [oldVersion] }) }) }),
      update: vi.fn(() => ({ set: closeSet })),
      insert: vi.fn(() => ({ values: insertValues })),
      transaction: vi.fn((work: (tx: unknown) => Promise<unknown>) => work(db)),
    };
    const result = await syncWorkspacePolicyModel(db, { modelId: "sample", displayName: "Sample", input: "0.2", output: "0.4", cacheRead: "0.02", scarcity: "0.5", concurrency: 2, capability: oldVersion.capability });
    expect(result).toMatchObject({ action: "replaced", previousVersionId: 10 });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(closeSet).toHaveBeenCalledWith(expect.objectContaining({ isActive: false, effectiveUntil: expect.any(Date) }));
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ modelId: "sample", effectiveFrom: expect.any(Date), pricingVersion: "opencode-go-policy-2026-08-13" }));
  });

  it("filters models that cannot meet research requirements before ranking cost and scarcity", () => {
    const candidates = scoreCandidateModels({ reasoning: 8, longContext: 8, requiresToolUse: true }, [
      { modelId: "fast", displayName: "Fast", inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.2, scarcityFactor: 0.2, maxConcurrency: 4, capability: { code: 7, reasoning: 7, longContext: 8, vision: 0, toolUse: 8, chinese: 7, research: 7, agent: 6, speed: 10, reliability: 8 } },
      { modelId: "research", displayName: "Research", inputPerMillionUsd: 0.5, outputPerMillionUsd: 1, scarcityFactor: 0.6, maxConcurrency: 2, capability: { code: 9, reasoning: 9, longContext: 10, vision: 2, toolUse: 9, chinese: 8, research: 9, agent: 9, speed: 7, reliability: 9 } },
    ]);
    expect(candidates.map(candidate => candidate.modelId)).toEqual(["research"]);
  });

  it("blocks a task for manual handoff when no model satisfies its capability hard constraints", () => {
    const routing = resolveTaskRouting({ vision: 8, requiresToolUse: true }, [
      { modelId: "text-only", displayName: "Text only", inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.2, scarcityFactor: 0.2, maxConcurrency: 4, capability: { code: 7, reasoning: 7, longContext: 8, vision: 0, toolUse: 8, chinese: 7, research: 7, agent: 6, speed: 10, reliability: 8 } },
    ], { routeMode: "balanced", requestedModelId: "text-only" });

    expect(routing.candidates).toEqual([]);
    expect(routing.blockedByCapability).toBe(true);
    expect(routing.recommendedModelId).toBe("text-only");
  });

  it("never silently replaces an invalid requested model in strict mode", () => {
    const routing = resolveTaskRouting({ reasoning: 8 }, [
      { modelId: "general", displayName: "General", inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.2, scarcityFactor: 0.2, maxConcurrency: 4, capability: { code: 7, reasoning: 7, longContext: 8, vision: 1, toolUse: 8, chinese: 7, research: 7, agent: 6, speed: 10, reliability: 8 } },
      { modelId: "research", displayName: "Research", inputPerMillionUsd: 0.5, outputPerMillionUsd: 1, scarcityFactor: 0.6, maxConcurrency: 2, capability: { code: 9, reasoning: 9, longContext: 10, vision: 2, toolUse: 9, chinese: 8, research: 9, agent: 9, speed: 7, reliability: 9 } },
    ], { routeMode: "strict", requestedModelId: "general" });

    expect(routing.blockedByCapability).toBe(true);
    expect(routing.recommendedModelId).toBe("general");
    expect(routing.candidates.map(candidate => candidate.modelId)).toEqual(["research"]);
  });

  it("prioritizes a valid requested model in balanced mode but selects the top candidate in emergency mode", () => {
    const models = [
      { modelId: "requested", displayName: "Requested", inputPerMillionUsd: 0.8, outputPerMillionUsd: 1.6, scarcityFactor: 0.8, maxConcurrency: 2, capability: { code: 8, reasoning: 8, longContext: 8, vision: 1, toolUse: 8, chinese: 8, research: 8, agent: 7, speed: 7, reliability: 8 } },
      { modelId: "preferred", displayName: "Preferred", inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.2, scarcityFactor: 0.2, maxConcurrency: 5, capability: { code: 9, reasoning: 9, longContext: 9, vision: 1, toolUse: 9, chinese: 8, research: 9, agent: 8, speed: 9, reliability: 9 } },
    ];

    expect(resolveTaskRouting({ reasoning: 8 }, models, { routeMode: "balanced", requestedModelId: "requested" }).recommendedModelId).toBe("requested");
    expect(resolveTaskRouting({ reasoning: 8 }, models, { routeMode: "emergency", requestedModelId: "requested" }).recommendedModelId).toBe("preferred");
  });

  it("selects an affordable provider candidate and records unavailable provider evidence in a unified route plan", () => {
    const plan = buildUnifiedRoutePlan({
      requirements: { reasoning: 8 },
      routeMode: "emergency",
      requestedModelId: "expensive",
      estimatedCostUsd: 0.5,
      providerContexts: [
        { provider: "opencode_go", availableUsd: 0.2, connectionState: "connected", secretState: "configured" },
        { provider: "openai_api", availableUsd: 1, connectionState: "pending_configuration", secretState: "not_configured" },
      ],
      models: [
        { modelId: "expensive", provider: "opencode_go", displayName: "Expensive", inputPerMillionUsd: 0.2, outputPerMillionUsd: 0.4, scarcityFactor: 0.2, maxConcurrency: 2, maxContextTokens: 128000, capability: { code: 9, reasoning: 9, longContext: 8, vision: 1, toolUse: 8, chinese: 8, research: 9, agent: 8, speed: 9, reliability: 9 } },
        { modelId: "affordable", provider: "openai_api", displayName: "Affordable", inputPerMillionUsd: 0.4, outputPerMillionUsd: 0.8, scarcityFactor: 0.3, maxConcurrency: 2, maxContextTokens: 128000, capability: { code: 8, reasoning: 8, longContext: 8, vision: 1, toolUse: 8, chinese: 8, research: 8, agent: 7, speed: 8, reliability: 8 } },
      ],
    });

    expect(plan.recommendedModelId).toBe("affordable");
    expect(plan.selectedProvider).toBe("openai_api");
    expect(plan.routePlan.candidates.find(candidate => candidate.modelId === "expensive")?.eligible).toBe(false);
    expect(plan.routePlan.candidates.find(candidate => candidate.modelId === "affordable")?.reasons).toContain("provider 凭据尚未配置；该计划只能人工执行或导入结算。");
  });

  it("holds a strict route when the specified model cannot cover the task from its provider budget", () => {
    const plan = buildUnifiedRoutePlan({
      requirements: { reasoning: 8 },
      routeMode: "strict",
      requestedModelId: "requested",
      estimatedCostUsd: 1,
      providerContexts: [{ provider: "opencode_go", availableUsd: 0.5, connectionState: "connected", secretState: "configured" }],
      models: [{ modelId: "requested", provider: "opencode_go", displayName: "Requested", inputPerMillionUsd: 0.2, outputPerMillionUsd: 0.4, scarcityFactor: 0.2, maxConcurrency: 2, maxContextTokens: 128000, capability: { code: 9, reasoning: 9, longContext: 8, vision: 1, toolUse: 8, chinese: 8, research: 9, agent: 8, speed: 9, reliability: 9 } }],
    });

    expect(plan.blockedByCapability).toBe(false);
    expect(plan.blockedByBudget).toBe(true);
    expect(plan.recommendedModelId).toBe("requested");
  });

  it("excludes models whose verified context capacity is below the task requirement", () => {
    const candidates = scoreCandidateModels({ reasoning: 8, maxContextTokens: 128_000 }, [
      { modelId: "short", displayName: "Short", inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.2, scarcityFactor: 0.2, maxConcurrency: 4, maxContextTokens: 32_000, capability: { code: 9, reasoning: 9, longContext: 9, vision: 1, toolUse: 8, chinese: 8, research: 9, agent: 8, speed: 9, reliability: 9 } },
      { modelId: "long", displayName: "Long", inputPerMillionUsd: 0.2, outputPerMillionUsd: 0.4, scarcityFactor: 0.3, maxConcurrency: 2, maxContextTokens: 256_000, capability: { code: 8, reasoning: 8, longContext: 9, vision: 1, toolUse: 8, chinese: 8, research: 8, agent: 7, speed: 8, reliability: 8 } },
    ]);

    expect(candidates.map(candidate => candidate.modelId)).toEqual(["long"]);
  });
});
