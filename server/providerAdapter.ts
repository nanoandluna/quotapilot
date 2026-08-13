import { TRPCError } from "@trpc/server";
import { getProviderCredentialStatus } from "./providerCredentials";

export type AdapterProvider = "opencode_go" | "openai_api" | "chatgpt_plus_manual" | "local";

export type ProviderQuotaSnapshot = {
  provider: AdapterProvider;
  observedAt: Date;
  source: "offline_policy" | "provider_api";
  state: "ready" | "manual_only" | "pending_configuration" | "disabled";
  remainingUsd?: number;
  resetAt?: Date;
  message: string;
};

export type ProviderExecutionRequest = {
  taskId: number;
  attemptId: number;
  modelId: string;
  idempotencyKey: string;
  executionPlan?: {
    contextReductionRatio: number;
    outputReductionRatio: number;
    maxToolCalls: number | null;
    maxAgentSteps: number | null;
    chunkInput: boolean;
    splitTask: boolean;
    switchModel: boolean;
    preserveRequestedModel: boolean;
  } | null;
};

export type ProviderExecutionReceipt = {
  providerRunId: string;
  acceptedAt: Date;
};

export interface ProviderAdapter {
  readonly provider: AdapterProvider;
  getQuotaSnapshot(): Promise<ProviderQuotaSnapshot>;
  execute(request: ProviderExecutionRequest): Promise<ProviderExecutionReceipt>;
}

class OfflineProviderAdapter implements ProviderAdapter {
  constructor(readonly provider: AdapterProvider) {}

  async getQuotaSnapshot(): Promise<ProviderQuotaSnapshot> {
    const credentials = getProviderCredentialStatus();
    const configured = this.provider === "opencode_go"
      ? credentials.opencodeGo === "configured"
      : this.provider === "openai_api"
        ? credentials.openaiAdmin === "configured"
        : false;
    if (this.provider === "chatgpt_plus_manual") {
      return { provider: this.provider, observedAt: new Date(), source: "offline_policy", state: "manual_only", message: "ChatGPT Plus 仅作为人工研究救援通道，不参与自动执行。" };
    }
    if (configured) {
      return { provider: this.provider, observedAt: new Date(), source: "offline_policy", state: "ready", message: "凭据已检测到；当前版本仍未启用真实 provider 请求，等待 Adapter 实现与显式发布。" };
    }
    return { provider: this.provider, observedAt: new Date(), source: "offline_policy", state: this.provider === "local" ? "disabled" : "pending_configuration", message: "未配置可执行 provider 凭据；仅支持导入、策略决策、本地领取和人工账本结算。" };
  }

  async execute(_request: ProviderExecutionRequest): Promise<ProviderExecutionReceipt> {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "真实 provider 执行已禁用：当前 Adapter 仅提供离线控制平面契约，且不会发起外部请求。",
    });
  }
}

export function getProviderAdapter(provider: AdapterProvider): ProviderAdapter {
  return new OfflineProviderAdapter(provider);
}
