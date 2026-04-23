export type OAuthProvider = "google" | "apple";

function hasConfiguredValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function getEnabledOAuthProviders(
  env: NodeJS.ProcessEnv = process.env,
): OAuthProvider[] {
  const providers: OAuthProvider[] = [];

  if (hasConfiguredValue(env.AUTH_GOOGLE_ID)) providers.push("google");
  if (hasConfiguredValue(env.AUTH_APPLE_ID)) providers.push("apple");

  return providers;
}
