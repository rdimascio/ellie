import type { EvidenceRef, ProviderObservation } from "../../life-connectors/src/provider-types.ts";

export type ConnectorObservation = ProviderObservation & { connectionId: string };
export type AnticipationHorizon = "day" | "month" | "quarter" | "year";

export interface LifeInsight {
  key: string;
  kind: "preference" | "habit" | "relationship" | "goal" | "commitment";
  statement: string;
  confidence: number;
  evidenceRefs: EvidenceRef[];
  validUntil: number;
  caveats: string[];
}

export interface AnticipatoryProposal {
  key: string;
  kind: "prepare_event" | "follow_up" | "review_recurring_expense" | "planning_horizon";
  title: string;
  reason: string;
  evidenceRefs: EvidenceRef[];
  confidence: number;
  expiresAt: number;
  steps: string[];
  suggestedReminderAt?: number;
  suggestedSchedule?: {
    kind: "weekly";
    weekday: number;
    time: string;
    timeZone: string;
  };
  horizon: AnticipationHorizon;
}

export interface LifeAnticipationResult {
  insights: LifeInsight[];
  proposals: AnticipatoryProposal[];
  partial: boolean;
}

const DAY = 86_400_000;
const HORIZON_MS: Record<AnticipationHorizon, number> = {
  day: DAY,
  month: 31 * DAY,
  quarter: 92 * DAY,
  year: 366 * DAY,
};
const appointmentWords = /\b(?:appointment|doctor|dentist|clinic|consultation|checkup|visit)\b/i;
const currencyScales: Record<string, number> = {
  AUD: 2,
  CAD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  NZD: 2,
  USD: 2,
};

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new TypeError(`${label} is invalid.`);
  return value.trim();
}

function ref(item: ConnectorObservation): EvidenceRef {
  return {
    connectionId: item.connectionId,
    sourceKey: item.sourceKey,
    sourceRevision: item.sourceRevision,
  };
}

function refs(items: ConnectorObservation[]): EvidenceRef[] {
  return items.slice(-8).map(ref);
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function key(prefix: string, values: string[]): string {
  return `${prefix}:${values.map((value) => encodeURIComponent(normalized(value))).join(":")}`;
}

function opaqueKey(prefix: string, values: string[]): string {
  return `${prefix}:${values.map((value) => encodeURIComponent(value)).join(":")}`;
}

function localParts(
  timestamp: number,
  timeZone: string,
): {
  date: string;
  weekday: string;
  weekdayNumber: number;
  hour: number;
  minute: number;
} {
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
  const part = (type: string) => fields.find((item) => item.type === type)?.value ?? "";
  const weekday = part("weekday");
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    weekday,
    weekdayNumber: [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ].indexOf(weekday),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
  };
}

function currentObservations(
  input: ConnectorObservation[],
  now: number,
): { items: ConnectorObservation[]; partial: boolean } {
  const candidates = new Map<string, ConnectorObservation[]>();
  let partial = false;
  for (const item of input) {
    text(item.connectionId, "connectionId", 200);
    text(item.sourceKey, "sourceKey", 500);
    text(item.sourceRevision, "sourceRevision", 500);
    text(item.title, "observation title", 1_000);
    if (!Number.isSafeInteger(item.observedAt) || item.observedAt < 0)
      throw new TypeError("observedAt is invalid.");
    if (item.observedAt > now + 5 * 60_000) {
      partial = true;
      continue;
    }
    const identity = `${item.connectionId}\0${item.sourceKey}`;
    candidates.set(identity, [...(candidates.get(identity) ?? []), item]);
  }
  const latest: ConnectorObservation[] = [];
  for (const versions of candidates.values()) {
    const newestAt = Math.max(...versions.map((item) => item.observedAt)),
      newest = versions.filter((item) => item.observedAt === newestAt),
      tombstone = newest.find((item) => item.kind === "deleted" || item.deleted);
    if (tombstone) {
      latest.push(tombstone);
      if (newest.length > 1) partial = true;
      continue;
    }
    if (new Set(newest.map((item) => item.sourceRevision)).size > 1) {
      partial = true;
      continue;
    }
    latest.push(newest[0]!);
  }
  return {
    items: latest
      .filter((item) => item.kind !== "deleted" && !item.deleted)
      .sort(
        (left, right) =>
          left.observedAt - right.observedAt ||
          left.connectionId.localeCompare(right.connectionId) ||
          left.sourceKey.localeCompare(right.sourceKey),
      ),
    partial,
  };
}

function explicitAppointmentPreference(settings: Record<string, unknown>): boolean {
  return Object.entries(settings).some(([rawKey, value]) => {
    const setting = normalized(rawKey).replace(/[^a-z0-9]/g, "");
    return (
      value !== undefined &&
      value !== null &&
      (setting.includes("appointment") || setting.includes("scheduling")) &&
      (setting.includes("preference") || setting.includes("preferred") || setting.includes("time"))
    );
  });
}

function horizonFor(timestamp: number, now: number): AnticipationHorizon {
  const distance = timestamp - now;
  if (distance <= DAY) return "day";
  if (distance <= HORIZON_MS.month) return "month";
  if (distance <= HORIZON_MS.quarter) return "quarter";
  return "year";
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]!
    : Math.round((ordered[middle - 1]! + ordered[middle]!) / 2);
}

function minorAmount(value: string, currency: string): bigint | undefined {
  const scale = currencyScales[currency];
  if (scale === undefined || typeof value !== "string") return;
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2]?.length ?? 0) > scale) return;
  const fraction = (match[2] ?? "").padEnd(scale, "0");
  try {
    return BigInt(match[1]!) * 10n ** BigInt(scale) + BigInt(fraction || "0");
  } catch {
    return;
  }
}

export function analyzeLife(input: {
  observations: ConnectorObservation[];
  explicitSettings: Record<string, unknown>;
  dismissedKeys?: string[];
  now: number;
  timeZone: string;
  horizons?: AnticipationHorizon[];
  maxProposals?: number;
}): LifeAnticipationResult {
  if (!Array.isArray(input.observations) || input.observations.length > 5_000)
    throw new TypeError("observations are invalid.");
  if (!input.explicitSettings || typeof input.explicitSettings !== "object")
    throw new TypeError("explicitSettings are invalid.");
  if (Object.keys(input.explicitSettings).length > 128)
    throw new TypeError("explicitSettings are too large.");
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new TypeError("now is invalid.");
  text(input.timeZone, "timeZone", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format(input.now);
  } catch {
    throw new TypeError("timeZone is invalid.");
  }
  const maxProposals = input.maxProposals ?? 12;
  if (!Number.isSafeInteger(maxProposals) || maxProposals < 1 || maxProposals > 12)
    throw new TypeError("maxProposals is invalid.");
  const horizons = input.horizons ?? ["day", "month", "quarter", "year"];
  if (
    !Array.isArray(horizons) ||
    !horizons.length ||
    horizons.some((item) => !["day", "month", "quarter", "year"].includes(item))
  )
    throw new TypeError("horizons are invalid.");
  const dismissed = new Set(
    (input.dismissedKeys ?? []).map((item) => text(item, "dismissed key", 500)),
  );
  if (dismissed.size > 100) throw new TypeError("dismissedKeys are too large.");

  const current = currentObservations(input.observations, input.now),
    observations = current.items,
    events = observations.filter((item) => item.kind === "event"),
    allMessages = observations.filter((item) => item.kind === "message"),
    messages = allMessages.filter(
      (item) => item.kind === "message" && item.data.sentAt <= input.now + 5 * 60_000,
    ),
    allTransactions = observations.filter((item) => item.kind === "transaction"),
    transactions = allTransactions.filter(
      (item) => item.kind === "transaction" && item.data.postedAt <= input.now + 5 * 60_000,
    ),
    futureHistoryDiscarded =
      messages.length !== allMessages.length || transactions.length !== allTransactions.length,
    insights: LifeInsight[] = [],
    proposals: AnticipatoryProposal[] = [];

  const confirmedTimedEvents = events.filter(
    (item) =>
      item.kind === "event" &&
      item.data.status === "confirmed" &&
      Number.isSafeInteger(item.data.startAt),
  );
  const selfAppointments = confirmedTimedEvents.filter(
      (item) =>
        item.kind === "event" &&
        item.data.organizerIsSelf === true &&
        appointmentWords.test(item.title),
    ),
    appointmentDates = new Set<string>(),
    morningByDate = new Map<string, ConnectorObservation>();
  for (const item of selfAppointments) {
    if (item.kind !== "event" || item.data.startAt === undefined) continue;
    const local = localParts(item.data.startAt, item.data.timeZone ?? input.timeZone);
    appointmentDates.add(local.date);
    if (local.hour >= 6 && local.hour < 12) morningByDate.set(local.date, item);
  }
  if (
    morningByDate.size >= 3 &&
    morningByDate.size / appointmentDates.size >= 0.6 &&
    !explicitAppointmentPreference(input.explicitSettings)
  ) {
    const evidence = [...morningByDate.values()];
    insights.push({
      key: "preference:appointments:morning",
      kind: "preference",
      statement: "Repeated confirmed bookings suggest that morning appointments may be preferred.",
      confidence: Math.min(0.9, 0.6 + evidence.length * 0.07),
      evidenceRefs: refs(evidence),
      validUntil: input.now + HORIZON_MS.quarter,
      caveats: [
        "This is a tentative scheduling pattern, not an explicit preference.",
        "Organizer status does not establish attendance, and calendar coverage may be incomplete.",
      ],
    });
  }

  const weeklyEvents = new Map<string, ConnectorObservation[]>();
  for (const item of confirmedTimedEvents) {
    if (
      item.kind !== "event" ||
      item.data.startAt === undefined ||
      item.data.startAt >= input.now ||
      item.data.organizerIsSelf !== true
    )
      continue;
    const identity = normalized(item.title);
    weeklyEvents.set(identity, [...(weeklyEvents.get(identity) ?? []), item]);
  }
  let routineProposalCount = 0;
  for (const [identity, items] of weeklyEvents) {
    const dates = new Set(
      items.map((item) =>
        item.kind === "event" && item.data.startAt !== undefined
          ? localParts(item.data.startAt, input.timeZone).date
          : "",
      ),
    );
    if (dates.size < 3) continue;
    const localDays = [...dates]
      .map((value) => Date.parse(`${value}T00:00:00Z`) / DAY)
      .sort((left, right) => left - right);
    let consecutive = 1,
      longestConsecutive = 1;
    for (let index = 1; index < localDays.length; index++) {
      consecutive = localDays[index]! - localDays[index - 1]! === 7 ? consecutive + 1 : 1;
      longestConsecutive = Math.max(longestConsecutive, consecutive);
    }
    if (longestConsecutive < 3) continue;
    const slots = new Set(
      items.map((item) => {
        const local = localParts(
          (item as ConnectorObservation & { kind: "event" }).data.startAt!,
          input.timeZone,
        );
        return `${local.weekdayNumber}:${local.hour}:${local.minute}`;
      }),
    );
    if (slots.size !== 1) continue;
    const local = localParts(
        (items.at(-1)! as ConnectorObservation & { kind: "event" }).data.startAt!,
        input.timeZone,
      ),
      hasFutureBooking = confirmedTimedEvents.some(
        (item) =>
          item.kind === "event" &&
          item.data.startAt !== undefined &&
          item.data.startAt >= input.now &&
          normalized(item.title) === identity,
      ),
      proposalKey = key("weekly-routine", [
        identity,
        String(local.weekdayNumber),
        `${local.hour}:${local.minute}`,
      ]),
      routineExpiresAt =
        Math.max(
          ...items.map(
            (item) => (item as ConnectorObservation & { kind: "event" }).data.startAt ?? 0,
          ),
        ) +
        90 * DAY;
    insights.push({
      key: key("habit:event-weekly", [identity, local.weekday]),
      kind: "habit",
      statement: `Confirmed events suggest a recurring ${local.weekday} routine: ${items.at(-1)!.title}.`,
      confidence: Math.min(0.9, 0.62 + dates.size * 0.06),
      evidenceRefs: refs(items),
      validUntil: input.now + HORIZON_MS.quarter,
      caveats: ["A recurring booking does not prove the activity was completed."],
    });
    if (
      !hasFutureBooking &&
      !dismissed.has(proposalKey) &&
      routineProposalCount < 8 &&
      routineExpiresAt > input.now &&
      horizons.includes("quarter")
    ) {
      proposals.push({
        key: proposalKey,
        kind: "planning_horizon",
        title: items.at(-1)!.title,
        reason: `${dates.size} past self-organized events occurred at the same weekly local time.`,
        evidenceRefs: refs(items),
        confidence: Math.min(0.94, 0.76 + dates.size * 0.04),
        expiresAt: routineExpiresAt,
        steps: ["Review this inferred weekly routine and adjust or cancel it whenever needed."],
        suggestedSchedule: {
          kind: "weekly",
          weekday: local.weekdayNumber,
          time: `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`,
          timeZone: input.timeZone,
        },
        horizon: "quarter",
      });
      routineProposalCount++;
    }
  }

  for (const item of confirmedTimedEvents) {
    if (
      item.kind !== "event" ||
      item.data.startAt === undefined ||
      item.data.startAt <= input.now ||
      item.data.startAt > input.now + HORIZON_MS.year ||
      !appointmentWords.test(item.title)
    )
      continue;
    const horizon = horizonFor(item.data.startAt, input.now);
    if (!horizons.includes(horizon)) continue;
    const proposalKey = opaqueKey("prepare-event", [item.connectionId, item.sourceKey]);
    if (dismissed.has(proposalKey)) continue;
    proposals.push({
      key: proposalKey,
      kind: "prepare_event",
      title: `Prepare for ${item.title}`,
      reason: `A confirmed appointment is scheduled for ${new Intl.DateTimeFormat("en-US", {
        timeZone: input.timeZone,
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(item.data.startAt)}.`,
      evidenceRefs: refs([item]),
      confidence: 0.82,
      expiresAt: item.data.startAt,
      steps: [
        "Review the confirmed time, location, and check-in instructions.",
        "Check whether any pre-visit forms need attention.",
        "Gather questions and documents.",
        "Plan travel and arrival time.",
      ],
      ...(item.data.startAt - DAY > input.now
        ? { suggestedReminderAt: item.data.startAt - DAY }
        : {}),
      horizon,
    });
  }

  const outgoing = new Map<string, ConnectorObservation[]>();
  for (const item of messages) {
    if (item.kind !== "message" || item.data.direction !== "outgoing") continue;
    for (const recipient of new Set(item.data.to.map(normalized)))
      outgoing.set(recipient, [...(outgoing.get(recipient) ?? []), item]);
  }
  for (const [recipient, raw] of outgoing) {
    const items = raw
        .filter(
          (item): item is ConnectorObservation & { kind: "message" } => item.kind === "message",
        )
        .sort((left, right) => left.data.sentAt - right.data.sentAt),
      distinct = items.filter(
        (item, index) => !index || item.data.sentAt !== items[index - 1]!.data.sentAt,
      );
    if (distinct.length < 3) continue;
    const intervals = distinct
        .slice(1)
        .map((item, index) => item.data.sentAt - distinct[index]!.data.sentAt),
      cadence = median(intervals),
      last = distinct.at(-1)!;
    if (cadence < 3 * DAY || cadence > 120 * DAY || input.now - last.data.sentAt < cadence)
      continue;
    const proposalKey = key("follow-up", [recipient]);
    if (dismissed.has(proposalKey)) continue;
    proposals.push({
      key: proposalKey,
      kind: "follow_up",
      title: `Follow up with ${recipient}`,
      reason: `Outgoing messages to this address followed an approximately ${Math.round(cadence / DAY)}-day cadence, and that interval has passed.`,
      evidenceRefs: refs(distinct),
      confidence: Math.min(0.86, 0.58 + distinct.length * 0.07),
      expiresAt: input.now + 7 * DAY,
      steps: ["Review the latest conversation before deciding whether and how to follow up."],
      suggestedReminderAt: input.now,
      horizon: "day",
    });
  }

  const payments = new Map<string, (ConnectorObservation & { kind: "transaction" })[]>();
  const semanticPayments = new Set<string>();
  for (const item of transactions) {
    if (item.kind !== "transaction" || item.data.pending || !item.data.merchant) continue;
    const amount = minorAmount(item.data.amountDecimal, item.data.currency);
    if (amount === undefined || amount <= 0n) continue;
    const semantic = `${normalized(item.data.merchant)}\0${item.data.currency}\0${item.data.postedAt}\0${amount}`;
    if (semanticPayments.has(semantic)) continue;
    semanticPayments.add(semantic);
    const identity = `${normalized(item.data.merchant)}\0${item.data.currency}`;
    payments.set(identity, [...(payments.get(identity) ?? []), item]);
  }
  for (const [identity, items] of payments) {
    items.sort((left, right) => left.data.postedAt - right.data.postedAt);
    if (items.length < 3) continue;
    const intervals = items
        .slice(1)
        .map((item, index) => item.data.postedAt - items[index]!.data.postedAt),
      cadence = median(intervals),
      recurring =
        (cadence >= 5 * DAY && cadence <= 9 * DAY) ||
        (cadence >= 20 * DAY && cadence <= 40 * DAY) ||
        (cadence >= 330 * DAY && cadence <= 400 * DAY);
    if (!recurring) continue;
    const [merchant, currency] = identity.split("\0"),
      proposalKey = key("review-recurring-expense", [merchant!, currency!]);
    insights.push({
      key: key("commitment:recurring-expense", [merchant!, currency!]),
      kind: "commitment",
      statement: `${items.at(-1)!.data.merchant} has repeated settled ${currency} charges on an approximately ${Math.round(cadence / DAY)}-day cadence.`,
      confidence: Math.min(0.92, 0.64 + items.length * 0.06),
      evidenceRefs: refs(items),
      validUntil: input.now + Math.max(cadence * 2, 30 * DAY),
      caveats: [
        "This pattern does not prove a subscription or predict a guaranteed future charge.",
        "Cash-flow impact requires current balances, income, reserves, and complete account coverage.",
      ],
    });
    if (dismissed.has(proposalKey)) continue;
    proposals.push({
      key: proposalKey,
      kind: "review_recurring_expense",
      title: `Review recurring charges from ${items.at(-1)!.data.merchant}`,
      reason: `${items.length} settled charges in ${currency} show a recurring cadence; refunds, pending charges, and duplicate transactions were excluded.`,
      evidenceRefs: refs(items),
      confidence: Math.min(0.9, 0.62 + items.length * 0.06),
      expiresAt: input.now + Math.min(cadence, 31 * DAY),
      steps: [
        "Confirm whether the charges are expected and still useful.",
        "Check the next billing date and amount with the provider.",
        "Estimate cash flow only after confirming balances, income, reserve, and account coverage.",
      ],
      horizon: cadence <= 9 * DAY ? "day" : cadence <= 40 * DAY ? "month" : "year",
    });
  }

  const eligibleProposals = proposals
      .filter((proposal) => horizons.includes(proposal.horizon))
      .sort(
        (left, right) =>
          right.confidence - left.confidence ||
          left.expiresAt - right.expiresAt ||
          left.key.localeCompare(right.key),
      ),
    orderedInsights = insights
      .sort(
        (left, right) => right.confidence - left.confidence || left.key.localeCompare(right.key),
      )
      .slice(0, 32);
  return {
    insights: orderedInsights,
    proposals: eligibleProposals.slice(0, maxProposals),
    partial:
      input.observations.length >= 5_000 ||
      current.partial ||
      futureHistoryDiscarded ||
      insights.length > 32 ||
      eligibleProposals.length > maxProposals,
  };
}
