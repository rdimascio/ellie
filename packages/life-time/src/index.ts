export interface LocalDate {
  year: number;
  month: number;
  day: number;
}
export interface LocalDateTime extends LocalDate {
  hour: number;
  minute: number;
  second?: number;
}
export type CalendarTimeCode =
  | "invalid-date"
  | "invalid-time"
  | "invalid-zone"
  | "nonexistent-time"
  | "ambiguous-time";
export class CalendarTimeError extends RangeError {
  readonly code: CalendarTimeCode;
  constructor(code: CalendarTimeCode, message: string) {
    super(message);
    this.name = "CalendarTimeError";
    this.code = code;
  }
}

const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  if (typeof zone !== "string" || !zone || zone.length > 200)
    throw new CalendarTimeError("invalid-zone", "Use a valid IANA time zone.");
  const saved = formatters.get(zone);
  if (saved) return saved;
  try {
    const value = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
      weekday: "short",
      era: "short",
    });
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, value);
    return value;
  } catch {
    throw new CalendarTimeError("invalid-zone", "Use a valid IANA time zone.");
  }
}

/** Avoid Date.UTC's special interpretation of years 0–99. */
function utc(date: LocalDate, hour = 0, minute = 0, second = 0): number {
  const value = new Date(0);
  value.setUTCFullYear(date.year, date.month - 1, date.day);
  value.setUTCHours(hour, minute, second, 0);
  return value.getTime();
}
export function validateCalendarDate(date: LocalDate): LocalDate {
  if (
    !date ||
    !Number.isInteger(date.year) ||
    date.year < 1 ||
    date.year > 9999 ||
    !Number.isInteger(date.month) ||
    date.month < 1 ||
    date.month > 12 ||
    !Number.isInteger(date.day) ||
    date.day < 1 ||
    date.day > 31
  )
    throw new CalendarTimeError("invalid-date", "That calendar date is invalid.");
  const value = new Date(utc(date));
  if (value.getUTCMonth() + 1 !== date.month || value.getUTCDate() !== date.day)
    throw new CalendarTimeError("invalid-date", "That calendar date is invalid.");
  return { year: date.year, month: date.month, day: date.day };
}
export function calendarDateKey(date: LocalDate): string {
  validateCalendarDate(date);
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}
export function parseCalendarDate(value: unknown): LocalDate | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  try {
    return validateCalendarDate({ year: year!, month: month!, day: day! });
  } catch {
    return undefined;
  }
}
/** An epoch millisecond or strict offset-bearing ISO value; never normalize an invalid date. */
export function parseInstant(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return undefined;
  const date = parseCalendarDate(match[1]),
    hour = Number(match[2]),
    minute = Number(match[3]),
    second = Number(match[4] ?? 0),
    millisecond = Number((match[5] ?? "").padEnd(3, "0")),
    offsetHour = Number(match[8] ?? 0),
    offsetMinute = Number(match[9] ?? 0);
  if (!date || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59)
    return undefined;
  const offset = (offsetHour * 60 + offsetMinute) * 60_000 * (match[7] === "-" ? -1 : 1);
  return utc(date, hour, minute, second) + millisecond - offset;
}
export function localParts(
  epochMs: number,
  zone: string,
): LocalDateTime & { second: number; weekday: number } {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > 8.64e15)
    throw new CalendarTimeError("invalid-date", "That instant is invalid.");
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(epochMs)
      .map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  return {
    year: parts.era === "BC" ? 1 - year : year,
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!),
  };
}
function validatedTime(local: LocalDateTime): Required<LocalDateTime> {
  const date = validateCalendarDate(local),
    second = local.second ?? 0;
  if (
    !Number.isInteger(local.hour) ||
    local.hour < 0 ||
    local.hour > 23 ||
    !Number.isInteger(local.minute) ||
    local.minute < 0 ||
    local.minute > 59 ||
    !Number.isInteger(second) ||
    second < 0 ||
    second > 59
  )
    throw new CalendarTimeError("invalid-time", "That clock time is invalid.");
  return { ...date, hour: local.hour, minute: local.minute, second };
}

/** Find offsets around the requested date, then verify every local field exactly. */
export function zonedCandidates(local: LocalDateTime, zone: string): number[] {
  const wanted = validatedTime(local),
    wall = utc(wanted, wanted.hour, wanted.minute, wanted.second),
    offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 12) {
    const probe = wall + hours * 3_600_000,
      p = localParts(probe, zone);
    offsets.add(utc(p, p.hour, p.minute, p.second) - probe);
  }
  const candidates: number[] = [];
  for (const offset of offsets) {
    const candidate = wall - offset,
      actual = localParts(candidate, zone);
    if (
      actual.year === wanted.year &&
      actual.month === wanted.month &&
      actual.day === wanted.day &&
      actual.hour === wanted.hour &&
      actual.minute === wanted.minute &&
      actual.second === wanted.second
    )
      candidates.push(candidate);
  }
  return [...new Set(candidates)].sort((a, b) => a - b);
}
export function resolveZoned(
  local: LocalDateTime,
  zone: string,
  options: { ambiguous?: "reject" | "earlier" | "later" } = {},
): number {
  const policy = options.ambiguous ?? "reject";
  if (!["reject", "earlier", "later"].includes(policy))
    throw new TypeError("Invalid repeated-time policy.");
  const candidates = zonedCandidates(local, zone);
  if (!candidates.length)
    throw new CalendarTimeError(
      "nonexistent-time",
      "That local time does not exist because the clocks change. Choose another time.",
    );
  if (candidates.length > 1 && policy === "reject")
    throw new CalendarTimeError(
      "ambiguous-time",
      "That local time occurs twice because the clocks change. Choose an unambiguous time.",
    );
  return policy === "later" ? candidates.at(-1)! : candidates[0]!;
}
export function addCalendarDays(date: LocalDate, days: number): LocalDate {
  validateCalendarDate(date);
  if (!Number.isSafeInteger(days) || Math.abs(days) > 3_660_000)
    throw new CalendarTimeError("invalid-date", "Calendar day offset is invalid.");
  const value = new Date(utc(date) + days * DAY);
  return validateCalendarDate({
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  });
}
export function nextWeekdayDate(date: LocalDate, weekday: number, includeToday = false): LocalDate {
  validateCalendarDate(date);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
    throw new CalendarTimeError("invalid-date", "Weekday must be from Sunday through Saturday.");
  const delta = (weekday - new Date(utc(date)).getUTCDay() + 7) % 7;
  return addCalendarDays(date, delta === 0 && !includeToday ? 7 : delta);
}
/** Calendar occurrence on or after the user's current local day; the caller chooses an alert time. */
export function nextAnnualDate(
  date: { month: number; day: number },
  after: number,
  zone: string,
): LocalDate {
  validateCalendarDate({ year: 2000, month: date.month, day: date.day });
  const current = localParts(after, zone),
    today = calendarDateKey(current);
  for (let year = current.year; year <= Math.min(9999, current.year + 8); year++) {
    let candidate: LocalDate;
    try {
      candidate = validateCalendarDate({ year, month: date.month, day: date.day });
    } catch {
      continue;
    }
    if (calendarDateKey(candidate) >= today) return candidate;
  }
  throw new CalendarTimeError(
    "invalid-date",
    "No annual occurrence is available in the supported calendar range.",
  );
}
export function parseClock(value: string): { hour: number; minute: number } {
  const match =
    typeof value === "string" && value.length <= 40
      ? /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.trim())
      : null;
  if (!match)
    throw new CalendarTimeError("invalid-time", "Use a clock time such as 9:30 am or 14:30.");
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0),
    meridiem = match[3]?.toLowerCase();
  if (minute > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23))
    throw new CalendarTimeError("invalid-time", "That clock time is invalid.");
  if (meridiem) hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  return { hour, minute };
}

/** Earliest instant in a local calendar day, including days whose midnight is skipped. */
export function startOfLocalDay(date: LocalDate, zone: string): number | undefined {
  const target = utc(validateCalendarDate(date));
  // Compare Gregorian day ordinals, never the viewer's system time zone.
  const ordinal = (at: number) => utc(localParts(at, zone));
  let lo = target - 36 * 3_600_000,
    hi = target + 36 * 3_600_000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ordinal(mid) < target) lo = mid;
    else hi = mid;
  }
  return ordinal(hi) === target ? hi : undefined;
}
