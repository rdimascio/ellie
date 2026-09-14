import type { TaskSchedule } from "./types.ts";
import {
  addCalendarDays,
  localParts,
  validateCalendarDate,
  zonedCandidates,
} from "../../life-time/src/index.ts";

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
  const cursorLocal = localParts(after, schedule.timeZone);
  const cursorPassedWallTime =
    cursorLocal.hour > hour || (cursorLocal.hour === hour && cursorLocal.minute >= minute);
  const startDate = validateCalendarDate(cursorLocal);
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const date = addCalendarDays(startDate, dayOffset);
    const { year, month, day } = date;
    const weekdayDate = new Date(0);
    weekdayDate.setUTCFullYear(year, month - 1, day);
    weekdayDate.setUTCHours(0, 0, 0, 0);
    const weekday = weekdayDate.getUTCDay();
    if (schedule.kind === "weekly" && weekday !== schedule.weekday) continue;
    if (dayOffset === 0 && cursorPassedWallTime) continue;
    const at = zonedCandidates({ year, month, day, hour, minute }, schedule.timeZone)[0];
    if (at !== undefined && at > after) return at;
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
    const p = localParts(at, schedule.timeZone);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}@${schedule.timeZone}`;
  }
  return String(at);
}
