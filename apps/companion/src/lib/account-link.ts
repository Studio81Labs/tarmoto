const ACCOUNT_LINK_PATH = "tarmoto://link-account";

export function buildLinkAccountDeepLink(email: string): string {
  const trimmed = email.trim();
  if (!trimmed) return ACCOUNT_LINK_PATH;

  const query = new URLSearchParams({ email: trimmed });
  return `${ACCOUNT_LINK_PATH}?${query.toString()}`;
}
