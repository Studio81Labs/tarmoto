import { parseIsoDate, parseIsoTime, parseIsoDateTime } from "./isoDate";

/**
 * Display-formatting knobs shared by DatePicker/TimePicker/DateTimePicker. The
 * component value stays an ISO string in every case — these only affect the
 * text shown in the trigger.
 *
 * - `locale` + `formatOptions` drive an `Intl.DateTimeFormat` pass (the common
 *   case; omit `locale` to use the runtime default).
 * - `formatValue` is a full escape hatch: given the ISO value, return the
 *   display string yourself. It wins over locale/formatOptions.
 */
export interface DisplayFormatProps {
  // `| undefined` (not just `?`) so callers can forward already-destructured
  // optional props under exactOptionalPropertyTypes without narrowing first.
  locale?: string | undefined;
  formatOptions?: Intl.DateTimeFormatOptions | undefined;
  formatValue?: ((value: string) => string) | undefined;
}

const DATE_DEFAULTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
};

const TIME_DEFAULTS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

const DATETIME_DEFAULTS: Intl.DateTimeFormatOptions = {
  ...DATE_DEFAULTS,
  ...TIME_DEFAULTS,
};

/**
 * The picker values are zoneless wall-clock parts. Anchor them in UTC and
 * format in UTC so no timezone offset shifts the day or hour. Callers can still
 * override any option (including `timeZone`) via `formatOptions`.
 */
function run(
  date: Date,
  defaults: Intl.DateTimeFormatOptions,
  locale?: string,
  formatOptions?: Intl.DateTimeFormatOptions,
): string {
  // `dateStyle`/`timeStyle` are mutually exclusive with individual component
  // options (year/month/day/hour/minute): merging them throws. When the caller
  // opts into a style, drop the component defaults and let the style win.
  const usesStyle = Boolean(
    formatOptions?.dateStyle || formatOptions?.timeStyle,
  );
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    ...(usesStyle ? {} : defaults),
    ...formatOptions,
  }).format(date);
}

export function displayIsoDate(
  value: string,
  { locale, formatOptions, formatValue }: DisplayFormatProps = {},
): string {
  if (!value) return "";
  if (formatValue) return formatValue(value);
  const d = parseIsoDate(value);
  if (!d) return value; // invalid but non-empty: show it rather than hide it
  return run(
    new Date(Date.UTC(d.year, d.month - 1, d.day)),
    DATE_DEFAULTS,
    locale,
    formatOptions,
  );
}

export function displayIsoTime(
  value: string,
  { locale, formatOptions, formatValue }: DisplayFormatProps = {},
): string {
  if (!value) return "";
  if (formatValue) return formatValue(value);
  const t = parseIsoTime(value);
  if (!t) return value;
  return run(
    new Date(Date.UTC(2000, 0, 1, t.hour, t.minute)),
    TIME_DEFAULTS,
    locale,
    formatOptions,
  );
}

export function displayIsoDateTime(
  value: string,
  { locale, formatOptions, formatValue }: DisplayFormatProps = {},
): string {
  if (!value) return "";
  if (formatValue) return formatValue(value);
  const dt = parseIsoDateTime(value);
  if (!dt) return value;
  return run(
    new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute)),
    DATETIME_DEFAULTS,
    locale,
    formatOptions,
  );
}
