import assert from "node:assert/strict";
import test from "node:test";
import { analyzeLife, type ConnectorObservation } from "../packages/life-anticipation/src/index.ts";

const DAY = 86_400_000;
const now = Date.UTC(2026, 8, 14, 12);
let sequence = 0;

function observation(
  value: Omit<ConnectorObservation, "connectionId" | "sourceRevision" | "observedAt"> & {
    connectionId?: string;
    sourceRevision?: string;
    observedAt?: number;
  },
): ConnectorObservation {
  sequence++;
  return {
    connectionId: value.connectionId ?? "synthetic-connection",
    sourceRevision: value.sourceRevision ?? `revision-${sequence}`,
    observedAt: value.observedAt ?? now - DAY + sequence,
    ...value,
  } as ConnectorObservation;
}

function event(sourceKey: string, title: string, startAt: number): ConnectorObservation {
  return observation({
    kind: "event",
    sourceKey,
    title,
    data: { startAt, endAt: startAt + 30 * 60_000, status: "confirmed", organizerIsSelf: true },
  });
}

test("cross-source analysis surfaces tentative routines, follow-up, and appointment preparation", () => {
  const events = [
    event("monday-1", "Call Mum", Date.UTC(2026, 7, 24, 9)),
    event("monday-2", "Call Mum", Date.UTC(2026, 7, 31, 9)),
    event("monday-3", "Call Mum", Date.UTC(2026, 8, 7, 9)),
    event("morning-1", "Project appointment", Date.UTC(2026, 7, 25, 10)),
    event("morning-2", "Dental appointment", Date.UTC(2026, 8, 1, 10)),
    event("morning-3", "Clinic appointment", Date.UTC(2026, 8, 10, 10)),
    event("doctor", "Doctor visit", now + 5 * DAY),
  ];
  const messages = [21, 14, 7].map((daysAgo, index) =>
    observation({
      kind: "message",
      sourceKey: `mum-${index}`,
      title: "Message thread",
      data: {
        sentAt: now - daysAgo * DAY,
        from: "me@example.test",
        to: ["mum@example.test"],
        subject: "Checking in",
        direction: "outgoing",
      },
    }),
  );
  const result = analyzeLife({
    observations: [...events, ...messages],
    explicitSettings: {},
    now,
    timeZone: "UTC",
  });
  assert.match(
    result.insights.find((item) => item.key === "preference:appointments:morning")!.statement,
    /may be preferred/,
  );
  const monday = result.insights.find((item) => item.key.includes("habit:event-weekly"))!;
  assert.match(monday.statement, /Monday routine: Call Mum/);
  assert.match(monday.caveats.join(" "), /does not prove.*completed/);
  const weekly = result.proposals.find((item) => item.suggestedSchedule);
  assert.deepEqual(weekly?.suggestedSchedule, {
    kind: "weekly",
    weekday: 1,
    time: "09:00",
    timeZone: "UTC",
  });
  assert.ok((weekly?.confidence ?? 0) >= 0.88);
  const preparation = result.proposals.find((item) => item.kind === "prepare_event")!;
  assert.equal(preparation.title, "Prepare for Doctor visit");
  assert.match(preparation.steps.join(" "), /pre-visit forms/);
  assert.doesNotMatch(preparation.steps.join(" "), /diagnosis|condition|symptom/i);
  const followUp = result.proposals.find((item) => item.kind === "follow_up")!;
  assert.equal(followUp.title, "Follow up with mum@example.test");
  assert.doesNotMatch(followUp.reason, /mother|family/i);
  assert.ok(
    [...result.insights, ...result.proposals].every((item) => item.evidenceRefs.length <= 8),
  );

  const overridden = analyzeLife({
    observations: [...events, ...messages],
    explicitSettings: { preferredAppointmentTime: "afternoon" },
    dismissedKeys: [followUp.key],
    now,
    timeZone: "UTC",
  });
  assert.equal(
    overridden.insights.some((item) => item.kind === "preference"),
    false,
  );
  assert.equal(
    overridden.proposals.some((item) => item.kind === "follow_up"),
    false,
  );
});

test("weekly routines require consistent historical self-organized events and no future booking", () => {
  const history = [28, 21, 14].map((daysAgo, index) =>
    event(`history-${index}`, "Monday planning", now - daysAgo * DAY - 3 * 60 * 60_000),
  );
  const consistent = analyzeLife({
    observations: history,
    explicitSettings: {},
    now,
    timeZone: "UTC",
  });
  assert.equal(consistent.proposals.filter((item) => item.suggestedSchedule).length, 1);

  const contradiction = event("contradiction", "Monday planning", now - 7 * DAY - 2 * 60 * 60_000);
  assert.equal(
    analyzeLife({
      observations: [...history, contradiction],
      explicitSettings: {},
      now,
      timeZone: "UTC",
    }).proposals.some((item) => item.suggestedSchedule),
    false,
  );

  const monthlyMondays = [84, 56, 28].map((daysAgo, index) =>
    event(`monthly-${index}`, "Monthly planning", now - daysAgo * DAY - 3 * 60 * 60_000),
  );
  assert.equal(
    analyzeLife({
      observations: monthlyMondays,
      explicitSettings: {},
      now,
      timeZone: "UTC",
    }).proposals.some((item) => item.suggestedSchedule),
    false,
  );

  const future = event("future", "Monday planning", now + 4 * DAY);
  assert.equal(
    analyzeLife({
      observations: [...history, future],
      explicitSettings: {},
      now,
      timeZone: "UTC",
    }).proposals.some((item) => item.suggestedSchedule),
    false,
  );
});

test("future history, minority mornings, and ambiguous revisions cannot establish patterns", () => {
  const appointments = [
      event("morning-a", "Self appointment A", now - 20 * DAY - 3 * 60 * 60_000),
      event("morning-b", "Self appointment B", now - 19 * DAY - 3 * 60 * 60_000),
      event("morning-c", "Self appointment C", now - 18 * DAY - 3 * 60 * 60_000),
      ...[17, 16, 15, 14].map((daysAgo, index) =>
        event(
          `afternoon-${index}`,
          `Self appointment afternoon ${index}`,
          now - daysAgo * DAY + 3 * 60 * 60_000,
        ),
      ),
    ],
    futureMessages = [3, 2, 1].map((daysAhead, index) =>
      observation({
        kind: "message",
        sourceKey: `future-message-${index}`,
        title: "Future message",
        data: {
          sentAt: now + daysAhead * DAY,
          from: "me@example.test",
          to: ["future@example.test"],
          subject: "Impossible history",
          direction: "outgoing",
        },
      }),
    ),
    ambiguousOne = observation({
      kind: "message",
      sourceKey: "ambiguous",
      sourceRevision: "opaque-A",
      observedAt: now,
      title: "Ambiguous one",
      data: {
        sentAt: now - 10 * DAY,
        from: "me@example.test",
        to: ["ambiguous@example.test"],
        subject: "One",
        direction: "outgoing",
      },
    }),
    ambiguousTwo = observation({
      kind: "message",
      sourceKey: "ambiguous",
      sourceRevision: "opaque-B",
      observedAt: now,
      title: "Ambiguous two",
      data: {
        sentAt: now - 5 * DAY,
        from: "me@example.test",
        to: ["ambiguous@example.test"],
        subject: "Two",
        direction: "outgoing",
      },
    });
  const result = analyzeLife({
    observations: [...appointments, ...futureMessages, ambiguousOne, ambiguousTwo],
    explicitSettings: {},
    now,
    timeZone: "UTC",
  });
  assert.equal(
    result.insights.some((item) => item.key === "preference:appointments:morning"),
    false,
  );
  assert.equal(
    result.proposals.some((item) => item.kind === "follow_up"),
    false,
  );
  assert.equal(result.partial, true);

  const mixedCase = observation({
    kind: "event",
    connectionId: "ConnectionCASE",
    sourceKey: "EventCASE",
    title: "Doctor appointment",
    data: { startAt: now + DAY, status: "confirmed", organizerIsSelf: true },
  });
  const keyed = analyzeLife({
    observations: [mixedCase],
    explicitSettings: {},
    now,
    timeZone: "UTC",
  }).proposals[0]!;
  assert.match(keyed.key, /ConnectionCASE:EventCASE/);
});

test("recurring expenses exclude duplicates, refunds, pending charges, and unsupported precision", () => {
  const payment = (sourceKey: string, postedAt: number, amountDecimal = "12.34") =>
    observation({
      kind: "transaction",
      sourceKey,
      title: "StreamCo transaction",
      data: {
        postedAt,
        amountDecimal,
        currency: "USD",
        merchant: "StreamCo",
        pending: false,
      },
    });
  const valid = [
    payment("pay-1", now - 90 * DAY),
    payment("pay-2", now - 60 * DAY),
    payment("pay-3", now - 30 * DAY),
  ];
  const noise = [
    payment("duplicate-provider-key", now - 30 * DAY),
    payment("refund", now - 20 * DAY, "-12.34"),
    payment("unsupported-precision", now - 10 * DAY, "12.345"),
    observation({
      kind: "transaction",
      sourceKey: "pending",
      title: "StreamCo pending",
      data: {
        postedAt: now,
        amountDecimal: "12.34",
        currency: "USD",
        merchant: "StreamCo",
        pending: true,
      },
    }),
  ];
  const result = analyzeLife({
    observations: [...valid, ...noise],
    explicitSettings: {},
    now,
    timeZone: "UTC",
  });
  const recurring = result.proposals.find((item) => item.kind === "review_recurring_expense")!;
  assert.ok(recurring);
  assert.equal(recurring.evidenceRefs.length, 3);
  assert.match(
    recurring.reason,
    /refunds, pending charges, and duplicate transactions were excluded/,
  );
  assert.doesNotMatch(recurring.reason, /integer-amount/);
  const commitment = result.insights.find((item) => item.kind === "commitment")!;
  assert.match(commitment.caveats.join(" "), /balances, income, reserves.*coverage/);
  assert.doesNotMatch(commitment.statement, /subscription/);

  const deletion = observation({
    kind: "deleted",
    sourceKey: "pay-3",
    sourceRevision: "revision-deleted",
    observedAt: now + 1,
    title: "Deleted transaction",
    data: { previousKind: "transaction" },
  });
  const insufficient = analyzeLife({
    observations: [...valid, deletion],
    explicitSettings: {},
    now,
    timeZone: "UTC",
  });
  assert.equal(
    insufficient.proposals.some((item) => item.kind === "review_recurring_expense"),
    false,
  );
});

test("cancelled, past, and out-of-horizon events do not create preparation or completion claims", () => {
  const cancelled = observation({
      kind: "event",
      sourceKey: "cancelled",
      title: "Dentist appointment",
      data: { startAt: now + DAY, status: "cancelled" },
    }),
    past = event("past", "Doctor visit", now - DAY),
    distant = event("distant", "Clinic appointment", now + 40 * DAY),
    allegedReceipt = observation({
      kind: "message",
      sourceKey: "message-receipt",
      title: "Form receipt message",
      data: {
        sentAt: now,
        from: "clinic@example.test",
        to: ["me@example.test"],
        subject: "Your form was submitted",
        snippet: "All forms complete",
        direction: "incoming",
      },
    });
  const monthOnly = analyzeLife({
    observations: [cancelled, past, distant, allegedReceipt],
    explicitSettings: {},
    now,
    timeZone: "UTC",
    horizons: ["month"],
  });
  assert.equal(
    monthOnly.proposals.some((item) => item.kind === "prepare_event"),
    false,
  );
  assert.equal(
    monthOnly.insights.some((item) => /complete|submitted/i.test(item.statement)),
    false,
  );

  const quarter = analyzeLife({
    observations: [distant, allegedReceipt],
    explicitSettings: {},
    now,
    timeZone: "UTC",
    horizons: ["quarter"],
  });
  const proposal = quarter.proposals.find((item) => item.kind === "prepare_event")!;
  assert.ok(proposal);
  assert.match(proposal.steps.join(" "), /Check whether any pre-visit forms need attention/);
  assert.equal(
    proposal.evidenceRefs.some((item) => item.sourceKey === "message-receipt"),
    false,
  );
});
