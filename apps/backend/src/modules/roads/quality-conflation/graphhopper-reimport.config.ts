import { registerAs } from '@nestjs/config';

/**
 * Config for the GraphHopper re-import trigger (#779) — the orchestration hook
 * fired after a successful quality conflation so GraphHopper re-imports the
 * freshly-tagged extract and quality-aware routing stops lagging.
 *
 * GraphHopper has no re-import API and reuses its `graph-cache` on restart, so
 * the actual "clear cache + restart" lives outside the backend. This is
 * deliberately a **generic authenticated webhook** rather than anything
 * GraphHopper- or host-specific: the backend just POSTs (or GETs) a URL, and the
 * receiver decides how to re-import. That keeps GraphHopper's location a config
 * detail — a same-host sibling container today (point the URL at a local sidecar
 * or the Coolify deploy webhook for the GraphHopper service), a separate VPS
 * tomorrow (the same webhook on the other host) — with no code change.
 *
 * Unset `webhookUrl` → the trigger is a no-op (the artifact is still written;
 * routing just reflects it on the next manual re-import). `token`, when set, is
 * sent as `Authorization: Bearer …` (Coolify deploy webhooks + most CI hooks
 * accept this). `method` defaults to POST; set GET for hooks that require it
 * (e.g. Coolify's `/api/v1/deploy`).
 *
 * The receiver contract (documented in the module README): make the derived
 * extract GraphHopper's input, delete the `graph-cache`, and restart.
 */
export interface GraphHopperReimportConfig {
  webhookUrl: string | null;
  token: string | null;
  method: 'POST' | 'GET';
}

export const graphhopperReimportConfig = registerAs(
  'graphhopperReimport',
  (): GraphHopperReimportConfig => {
    const webhookUrl =
      process.env.TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_URL?.trim();
    const token =
      process.env.TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_TOKEN?.trim();
    const rawMethod =
      process.env.TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_METHOD?.trim().toUpperCase();
    if (rawMethod && rawMethod !== 'POST' && rawMethod !== 'GET') {
      throw new Error(
        `TARMOTO_GRAPHHOPPER_REIMPORT_WEBHOOK_METHOD must be POST or GET, got "${rawMethod}"`,
      );
    }
    return {
      webhookUrl: webhookUrl ? webhookUrl : null,
      token: token ? token : null,
      method: rawMethod === 'GET' ? 'GET' : 'POST',
    };
  },
);
