export type ProviderCredentialStatus = {
  opencodeGo: "configured" | "not_configured";
  openaiAdmin: "configured" | "not_configured";
};

export function getProviderCredentialStatus(env: NodeJS.ProcessEnv = process.env): ProviderCredentialStatus {
  return {
    opencodeGo: env.OPENCODE_GO_API_KEY ? "configured" : "not_configured",
    openaiAdmin: env.OPENAI_ADMIN_API_KEY ? "configured" : "not_configured",
  };
}
