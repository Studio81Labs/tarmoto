import { SetMetadata } from '@nestjs/common';
import type { SystemFeatureKey } from '@tarmoto/shared';

export const REQUIRED_SYSTEM_SWITCH_KEY = 'required_system_switch';

/**
 * Declare that a route (or a whole controller) is gated by an operator
 * system switch. Pair with `SystemSwitchGuard` so the request is rejected
 * with 503 the moment an operator flips the switch off — and, crucially,
 * BEFORE interceptors like `FilesInterceptor` parse and buffer the request
 * body, so the kill switch actually sheds the upload/spam load it exists
 * to stop:
 *
 *   @UseGuards(SystemSwitchGuard, AuthGuard)
 *   @RequireSystemSwitch('sys_poi_ratings')
 *
 * Unlike `@RequireFeature`, this needs no authenticated user — a system
 * switch is global — so the guard may run before `AuthGuard`. Service-level
 * gates remain the authoritative write guarantee; this decorator adds the
 * early rejection for routes that do expensive per-request work up front.
 */
export const RequireSystemSwitch = (key: SystemFeatureKey) =>
  SetMetadata(REQUIRED_SYSTEM_SWITCH_KEY, key);
