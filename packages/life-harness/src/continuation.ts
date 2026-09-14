import type {
  LifeActor,
  LifeScope,
  PendingIntentField,
  PendingIntentPayload,
  PendingLifeIntent,
  PendingTemporalSpec,
} from "../../life-core/src/index.ts";
import {
  addCalendarDays,
  CalendarTimeError,
  localParts,
  nextWeekdayDate,
  parseClock,
  resolveZoned,
} from "../../life-time/src/index.ts";
export type PendingField = PendingIntentField;
export type { PendingIntentPayload, PendingLifeIntent, PendingTemporalSpec };
type TemporalSpec = PendingTemporalSpec;

export type ContinuationDirective =
  | {
      action: "create" | "replace";
      intent: PendingIntentPayload;
      missing: PendingField[];
      question: string;
      target?: PendingLifeIntent["target"];
      answer?: { when: TemporalSpec } | { start: TemporalSpec };
    }
  | {
      action: "answer";
      pendingIntentId: string;
      expectedRevision: number;
      answer: { when: TemporalSpec } | { start: TemporalSpec };
    }
  | { action: "cancel"; pendingIntentId: string; expectedRevision: number };
export type TemporalAnswer = { when: TemporalSpec } | { start: TemporalSpec };

export class PendingAnswerInputError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "PendingAnswerInputError";
  }
}

export function parseMissingReminder(message: string): PendingIntentPayload | undefined {
  const match =
    /^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:please\s+)?remind me to\s+(.+?)[.!?]?$/i.exec(
      message.trim(),
    );
  if (!match) return undefined;
  const title = match[1]!
    .trim()
    .replace(/[.!]+$/, "")
    .trim();
  if (
    !title ||
    title.length > 2_000 ||
    /\b(?:today|tomorrow|next\s+\w+|at\s+\d|in\s+\d|when\s+i(?:'m| am))\b/i.test(title)
  )
    return undefined;
  return { kind: "schedule-reminder", title };
}

export function parseTemporalAnswer(
  message: string,
  now: number,
  timeZone: string,
): TemporalSpec | undefined {
  const match =
    /^(today|tomorrow|next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday))\s+(?:at\s*)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)[.!]?$/i.exec(
      message.trim(),
    );
  if (!match) return undefined;
  const current = localParts(now, timeZone);
  let date = { year: current.year, month: current.month, day: current.day };
  if (match[1]!.toLowerCase() === "tomorrow") date = addCalendarDays(date, 1);
  else if (match[2])
    date = nextWeekdayDate(
      date,
      ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(
        match[2].toLowerCase(),
      ),
    );
  const clock = parseClock(match[3]!);
  return { type: "instant", at: resolveZoned({ ...date, ...clock }, timeZone) };
}

export function pendingDirective(
  actor: LifeActor,
  scope: LifeScope,
  pending: PendingLifeIntent,
  message: string,
  now: number,
  timeZone: string,
): ContinuationDirective | undefined {
  void actor;
  if (pending.scope.type !== scope.type || pending.scope.id !== scope.id) return undefined;
  if (pending.state !== "awaiting-fields" || pending.expiresAt <= now) return undefined;
  if (/^(?:never mind|nevermind|cancel that|forget it)[.!]?$/i.test(message.trim()))
    return { action: "cancel", pendingIntentId: pending.id, expectedRevision: pending.revision };
  if (
    pending.missing.length !== 1 ||
    (!pending.missing.includes("when") && !pending.missing.includes("start"))
  )
    return undefined;
  try {
    const when = parseTemporalAnswer(message, now, timeZone);
    if (when?.type === "instant" && when.at <= now)
      throw new PendingAnswerInputError("That time is in the past. Please choose a future time.");
    return when
      ? {
          action: "answer",
          pendingIntentId: pending.id,
          expectedRevision: pending.revision,
          answer: pending.missing[0] === "start" ? { start: when } : { when },
        }
      : undefined;
  } catch (error) {
    if (error instanceof CalendarTimeError) throw error;
    throw error;
  }
}
