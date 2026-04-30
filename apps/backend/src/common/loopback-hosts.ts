/**
 * Hosts the WHATWG URL parser surfaces as `parsed.hostname` for the
 * three loopback origins we treat as local-dev:
 * - `localhost` (DNS-resolved)
 * - `127.0.0.1` (IPv4 loopback — the conventional address)
 * - `[::1]` (IPv6 loopback — Node's URL parser keeps the brackets in
 *   `parsed.hostname` for IPv6 literals, so the comparison must include
 *   them)
 *
 * Shared so the review-photo URL validator (`review.dto.ts`) and the
 * managed-origin checker in `reviews.service.ts` can't drift if a new
 * loopback alias is added to one but not the other — a URL passing
 * DTO validation while being untrusted by the service would silently
 * skip ownership checks and bypass cascade deletes.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);
