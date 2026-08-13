import { describe, expect, it } from "vitest";
import { getProviderCredentialStatus } from "./providerCredentials";

describe("provider credential guard", () => {
  it("keeps both external providers disconnected when credentials have not been supplied", () => {
    const status = getProviderCredentialStatus({});

    expect(status).toEqual({
      opencodeGo: "not_configured",
      openaiAdmin: "not_configured",
    });
  });

  it("only reports the provider whose server-side credential is present as configured", () => {
    const status = getProviderCredentialStatus({ OPENCODE_GO_API_KEY: "test-key" });

    expect(status).toEqual({
      opencodeGo: "configured",
      openaiAdmin: "not_configured",
    });
  });
});
