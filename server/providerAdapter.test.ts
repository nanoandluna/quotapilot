import { describe, expect, it } from "vitest";
import { getProviderAdapter } from "./providerAdapter";

describe("QuotaPilot offline Provider Adapter", () => {
  it("reports ChatGPT Plus as manual only and never exposes it as an automatic provider", async () => {
    const snapshot = await getProviderAdapter("chatgpt_plus_manual").getQuotaSnapshot();
    expect(snapshot).toMatchObject({ provider: "chatgpt_plus_manual", source: "offline_policy", state: "manual_only" });
  });

  it("rejects execution even when an adapter instance exists", async () => {
    await expect(getProviderAdapter("opencode_go").execute({ taskId: 1, attemptId: 2, modelId: "deepseek-v4-pro", idempotencyKey: "attempt-2", executionPlan: { contextReductionRatio: 1, outputReductionRatio: 1, maxToolCalls: null, maxAgentSteps: null, chunkInput: false, splitTask: false, switchModel: true, preserveRequestedModel: false } }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
