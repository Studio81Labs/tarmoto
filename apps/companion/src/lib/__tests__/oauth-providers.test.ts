import { getEnabledOAuthProviders } from "@/lib/oauth-providers";

describe("getEnabledOAuthProviders", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns only the providers with configured credentials", () => {
    vi.stubEnv("AUTH_GOOGLE_ID", "google-client-id");
    vi.stubEnv("AUTH_APPLE_ID", "");

    expect(getEnabledOAuthProviders()).toEqual(["google"]);
  });

  it("returns both providers when both credentials are configured", () => {
    vi.stubEnv("AUTH_GOOGLE_ID", "google-client-id");
    vi.stubEnv("AUTH_APPLE_ID", "apple-client-id");

    expect(getEnabledOAuthProviders()).toEqual(["google", "apple"]);
  });
});
