import type { UnitSystem } from "@tarmoto/shared";
import { usersApi } from "@/lib/api/users";

let inFlight: Promise<void> | null = null;
let queued: UnitSystem | null = null;

/**
 * Persist the rider's unit choice to the account, serializing rapid toggles:
 * at most one PATCH in flight, and when the rider changes units again before
 * it settles, only the LATEST selection is sent afterwards. Two unordered
 * concurrent writes could land stale-last on the server, and the
 * account-wins reconciliation (PreferencesSync) would then propagate that
 * stale value back over the rider's real choice on the next mount.
 *
 * Failures are logged and swallowed — the local store/cookie already carry
 * the choice for this device, and the next authenticated mount's
 * reconciliation backfills the account.
 */
export function persistUnitPreference(units: UnitSystem): void {
  if (inFlight) {
    queued = units;
    return;
  }
  inFlight = usersApi
    .updateMe({ preferences: { units } })
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error("Failed to save unit preference", error);
    })
    .finally(() => {
      inFlight = null;
      if (queued !== null) {
        const next = queued;
        queued = null;
        persistUnitPreference(next);
      }
    });
}
