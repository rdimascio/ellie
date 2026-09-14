import type { LifeRecord } from "./types";

export type AgendaWhen = { value: string | number; allDay: boolean };
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function calendarDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return;
  const match = datePattern.exec(value);
  if (!match) return;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]),
    date = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return;
  return date;
}

export function instantDate(value: unknown): Date | undefined {
  if (typeof value !== "number" && typeof value !== "string") return;
  if (typeof value === "number" && !Number.isFinite(value)) return;
  if (typeof value === "string" && (!value.trim() || datePattern.test(value))) return;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

export function calendarKey(date: Date, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: zone,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nextBirthday(month: number, day: number, zone: string, now: Date): string | undefined {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return;
  const today = calendarKey(now, zone),
    year = Number(today.slice(0, 4));
  for (let offset = 0; offset <= 8; offset++) {
    const candidate = `${year + offset}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (calendarDate(candidate) && candidate >= today) return candidate;
  }
}

export function agendaDate(
  record: LifeRecord,
  timeZone: string,
  now = new Date(),
): AgendaWhen | undefined {
  if (record.kind === "birthday") {
    const recurring = nextBirthday(
      Number(record.data.month),
      Number(record.data.day),
      timeZone,
      now,
    );
    if (recurring) return { value: recurring, allDay: true };
    if (calendarDate(record.data.nextDate)) {
      const nextDate = String(record.data.nextDate);
      if (nextDate >= calendarKey(now, timeZone)) return { value: nextDate, allDay: true };
    }
    return;
  }
  const direct =
    record.kind === "reminder" || record.kind === "timer"
      ? record.data.dueAt
      : (record.data.startAt ?? record.data.startDate ?? record.data.date);
  if (calendarDate(direct)) return { value: String(direct), allDay: true };
  if (instantDate(direct)) return { value: direct as string | number, allDay: false };
}

export function dateValue(value: string | number): Date {
  return calendarDate(value) ?? instantDate(value) ?? new Date(Number.NaN);
}

export function dayKey(value: string | number, zone: string): string {
  return calendarDate(value) ? String(value) : calendarKey(dateValue(value), zone);
}

export function friendlyDay(value: string | number, zone?: string): string {
  const allDay = Boolean(calendarDate(value));
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: allDay ? "UTC" : zone,
  }).format(dateValue(value));
}

export function dayHeading(value: string | number, zone: string, today = new Date()): string {
  const allDay = Boolean(calendarDate(value)),
    key = dayKey(value, zone),
    parts = Object.fromEntries(
      new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "long",
        ...(key.slice(0, 4) === calendarKey(today, zone).slice(0, 4) ? {} : { year: "numeric" }),
        timeZone: allDay ? "UTC" : zone,
      })
        .formatToParts(dateValue(value))
        .map((part) => [part.type, part.value]),
    );
  return `${parts.weekday}, ${parts.month}${parts.year ? ` ${parts.year}` : ""}`;
}

export function compareAgenda(
  left: { when: AgendaWhen },
  right: { when: AgendaWhen },
  zone: string,
): number {
  const day = dayKey(left.when.value, zone).localeCompare(dayKey(right.when.value, zone));
  if (day) return day;
  if (left.when.allDay !== right.when.allDay) return left.when.allDay ? -1 : 1;
  return dateValue(left.when.value).valueOf() - dateValue(right.when.value).valueOf();
}
