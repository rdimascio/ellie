import type { TaskSchedule } from "./types.ts";

const parts = (at: number, timeZone: string) => {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(new Date(at))) {
    if (part.type !== "literal" && part.type !== "weekday") values[part.type] = Number(part.value);
    if (part.type === "weekday")
      values.weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part.value);
  }
  return values as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    weekday: number;
  };
};

function wallOccurrence(
  schedule: Extract<TaskSchedule, { kind: "daily" | "weekly" }>,
  after: number,
): number {
  new Intl.DateTimeFormat("en", { timeZone: schedule.timeZone }).format();
  const match = /^(\d\d):([0-5]\d)$/.exec(schedule.time);
  if (!match) throw new Error("Schedule time must be HH:mm.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23) throw new Error("Schedule time must be HH:mm.");
  if (
    schedule.kind === "weekly" &&
    (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6)
  )
    throw new Error("Weekly weekday must be 0 through 6.");
  const cursorLocal = parts(after, schedule.timeZone);
  const cursorPassedWallTime =
    cursorLocal.hour > hour || (cursorLocal.hour === hour && cursorLocal.minute >= minute);
  const startDate = new Date(Date.UTC(cursorLocal.year, cursorLocal.month - 1, cursorLocal.day));
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const date = new Date(startDate.getTime() + dayOffset * 86_400_000);
    const year = date.getUTCFullYear(),
      month = date.getUTCMonth() + 1,
      day = date.getUTCDate();
    const weekday = date.getUTCDay();
    if (schedule.kind === "weekly" && weekday !== schedule.weekday) continue;
    if (dayOffset === 0 && cursorPassedWallTime) continue;
    const wall = Date.UTC(year, month - 1, day, hour, minute);
    const candidates = new Set<number>();
    for (const probe of [wall - 12 * 3_600_000, wall, wall + 12 * 3_600_000]) {
      const local = parts(probe, schedule.timeZone);
      const represented = Date.UTC(
        local.year,
        local.month - 1,
        local.day,
        local.hour,
        local.minute,
      );
      candidates.add(wall - (represented - probe));
    }
    for (const at of [...candidates].sort((a, b) => a - b)) {
      const local = parts(at, schedule.timeZone);
      if (
        at > after &&
        local.year === year &&
        local.month === month &&
        local.day === day &&
        local.hour === hour &&
        local.minute === minute
      )
        return at;
    }
  }
  throw new Error("No schedule occurrence found.");
}

export function nextOccurrence(schedule: TaskSchedule, after: number): number | undefined {
  if (!Number.isFinite(after)) throw new Error("Invalid schedule cursor.");
  if (schedule.kind === "once") {
    if (!Number.isSafeInteger(schedule.at) || schedule.at < 0)
      throw new Error("One-shot time is invalid.");
    return schedule.at > after ? schedule.at : undefined;
  }
  if (schedule.kind === "interval") {
    if (
      !Number.isSafeInteger(schedule.everyMs) ||
      schedule.everyMs <= 0 ||
      schedule.everyMs > 10 * 365 * 86_400_000
    )
      throw new Error("Interval must be positive.");
    const anchor = schedule.anchor ?? 0;
    if (!Number.isSafeInteger(anchor) || anchor < 0) throw new Error("Interval anchor is invalid.");
    return anchor > after
      ? anchor
      : anchor + (Math.floor((after - anchor) / schedule.everyMs) + 1) * schedule.everyMs;
  }
  return wallOccurrence(schedule, after);
}

export function occurrenceKey(schedule: TaskSchedule, at: number): string {
  if (schedule.kind === "daily" || schedule.kind === "weekly") {
    const p = parts(at, schedule.timeZone);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}@${schedule.timeZone}`;
  }
  return String(at);
}
