import {
  CalendarDate,
  CalendarDateTime,
  Time,
  parseDate,
  parseTime,
  parseDateTime,
} from "@internationalized/date";

export function parseIsoDate(v: string): CalendarDate | null {
  if (!v) return null;
  try {
    return parseDate(v);
  } catch {
    return null;
  }
}
export function parseIsoTime(v: string): Time | null {
  if (!v) return null;
  try {
    return parseTime(v);
  } catch {
    return null;
  }
}
export function parseIsoDateTime(v: string): CalendarDateTime | null {
  if (!v) return null;
  try {
    return parseDateTime(v);
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

export function isoDate(d: CalendarDate | null): string {
  return d ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : "";
}
export function isoTime(t: Time | null): string {
  return t ? `${pad(t.hour)}:${pad(t.minute)}` : "";
}
export function isoDateTime(d: CalendarDateTime | null): string {
  return d
    ? `${d.year}-${pad(d.month)}-${pad(d.day)}T${pad(d.hour)}:${pad(d.minute)}`
    : "";
}
