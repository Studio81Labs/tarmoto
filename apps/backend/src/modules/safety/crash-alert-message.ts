import type { CrashAlertContext } from './crash-alert-notifier.interface.js';

/** Locales we ship templates for. Anything else falls back to English. */
const SUPPORTED_LOCALES = ['en', 'cs', 'de', 'es', 'fr', 'pl'] as const;

type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

interface MessageTemplate {
  /** Render the SMS body. Voice TTS uses the same string. */
  render(ctx: Omit<CrashAlertContext, 'message'>): string;
}

const TEMPLATES: Record<SupportedLocale, MessageTemplate> = {
  en: {
    render: (ctx) =>
      `Tarmoto crash alert: ${ctx.rider_name} may have crashed at ${ctx.lat.toFixed(5)},${ctx.lng.toFixed(5)} ` +
      `(${ctx.timestamp}). Map: ${ctx.maps_link}` +
      (ctx.speed_kmh != null
        ? ` Speed: ${Math.round(ctx.speed_kmh)} km/h.`
        : '') +
      (ctx.ride_id ? ` Ride: ${ctx.ride_id}.` : '') +
      ` Alert ID: ${ctx.alert_id}.`,
  },
  cs: {
    render: (ctx) =>
      `Tarmoto nouzový alert: ${ctx.rider_name} mohl havarovat na ${ctx.lat.toFixed(5)},${ctx.lng.toFixed(5)} ` +
      `(${ctx.timestamp}). Mapa: ${ctx.maps_link}` +
      (ctx.speed_kmh != null
        ? ` Rychlost: ${Math.round(ctx.speed_kmh)} km/h.`
        : '') +
      (ctx.ride_id ? ` Jízda: ${ctx.ride_id}.` : '') +
      ` ID: ${ctx.alert_id}.`,
  },
  de: {
    render: (ctx) =>
      `Tarmoto Unfallalarm: ${ctx.rider_name} hatte möglicherweise einen Unfall bei ${ctx.lat.toFixed(5)},${ctx.lng.toFixed(5)} ` +
      `(${ctx.timestamp}). Karte: ${ctx.maps_link}` +
      (ctx.speed_kmh != null
        ? ` Geschwindigkeit: ${Math.round(ctx.speed_kmh)} km/h.`
        : '') +
      (ctx.ride_id ? ` Fahrt: ${ctx.ride_id}.` : '') +
      ` Alarm-ID: ${ctx.alert_id}.`,
  },
  es: {
    render: (ctx) =>
      `Alerta Tarmoto: ${ctx.rider_name} puede haber tenido un accidente en ${ctx.lat.toFixed(5)},${ctx.lng.toFixed(5)} ` +
      `(${ctx.timestamp}). Mapa: ${ctx.maps_link}` +
      (ctx.speed_kmh != null
        ? ` Velocidad: ${Math.round(ctx.speed_kmh)} km/h.`
        : '') +
      (ctx.ride_id ? ` Viaje: ${ctx.ride_id}.` : '') +
      ` ID: ${ctx.alert_id}.`,
  },
  fr: {
    render: (ctx) =>
      `Alerte Tarmoto: ${ctx.rider_name} a peut-être eu un accident à ${ctx.lat.toFixed(5)},${ctx.lng.toFixed(5)} ` +
      `(${ctx.timestamp}). Carte: ${ctx.maps_link}` +
      (ctx.speed_kmh != null
        ? ` Vitesse: ${Math.round(ctx.speed_kmh)} km/h.`
        : '') +
      (ctx.ride_id ? ` Trajet: ${ctx.ride_id}.` : '') +
      ` ID: ${ctx.alert_id}.`,
  },
  pl: {
    render: (ctx) =>
      `Tarmoto alarm awaryjny: ${ctx.rider_name} mógł mieć wypadek pod ${ctx.lat.toFixed(5)},${ctx.lng.toFixed(5)} ` +
      `(${ctx.timestamp}). Mapa: ${ctx.maps_link}` +
      (ctx.speed_kmh != null
        ? ` Prędkość: ${Math.round(ctx.speed_kmh)} km/h.`
        : '') +
      (ctx.ride_id ? ` Trasa: ${ctx.ride_id}.` : '') +
      ` ID: ${ctx.alert_id}.`,
  },
};

function normalize(locale: string | null | undefined): SupportedLocale {
  if (!locale) return 'en';
  // Accept "cs", "cs-CZ", "cs_cz", "CS-cz" — match on the language subtag.
  const lang = locale.toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(lang)
    ? (lang as SupportedLocale)
    : 'en';
}

/**
 * Canonical locale string safe to persist in `crash_alerts.locale`
 * (always ≤ 5 chars). The `crash_alerts` column is `VARCHAR(16)`;
 * normalizing at intake guarantees we never trip a "value too long"
 * insert error from a 30-char BCP-47 extension tag like
 * `ar-SA-u-ca-islamic`.
 */
export function normalizeCrashAlertLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalize(locale);
}

/**
 * Render the crash-alert message body for the given locale, falling
 * back to English when the locale is unset, malformed, or unsupported.
 */
export function renderCrashAlertMessage(
  ctx: Omit<CrashAlertContext, 'message'>,
  locale: string | null | undefined,
): string {
  return TEMPLATES[normalize(locale)].render(ctx);
}
