import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeLife, type ConnectorObservation } from "../packages/life-anticipation/src/index.ts";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { ProactivityEngine, recordProactiveDismissal } from "../packages/life-context/src/index.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

test("a refreshed appointment stays current across inference, scoped notification dedupe, backoff, and cancellation", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-quality-proactivity-"));
  const actor = { userId: "alice" };
  const personal = { type: "user" as const, id: actor.userId };
  const family = { type: "group" as const, id: "family" };
  let now = Date.parse("2026-09-14T16:00:00Z");
  const observed = now - HOUR;
  const historyStarts = [
    "2026-08-25T09:00:00-07:00",
    "2026-09-01T09:00:00-07:00",
    "2026-09-08T09:00:00-07:00",
  ];
  const history = historyStarts.map((start, index): ConnectorObservation => ({
    connectionId: "calendar-primary",
    kind: "event",
    sourceKey: `past-appointment-${index}`,
    sourceRevision: "v1",
    observedAt: observed - index,
    title: "Clinic appointment",
    data: {
      startAt: Date.parse(start),
      endAt: Date.parse(start) + HOUR,
      status: "confirmed",
      organizerIsSelf: true,
    },
  }));
  const original: ConnectorObservation = {
    connectionId: "calendar-primary",
    kind: "event",
    sourceKey: "doctor-visit",
    sourceRevision: "v1",
    observedAt: observed,
    title: "Doctor visit",
    data: {
      startAt: now + 20 * HOUR,
      endAt: now + 21 * HOUR,
      status: "confirmed",
      organizerIsSelf: false,
    },
  };
  const rescheduledStart = now + 30 * HOUR;
  const rescheduled: ConnectorObservation = {
    ...original,
    sourceRevision: "v2",
    observedAt: observed + 1,
    data: { ...original.data, startAt: rescheduledStart, endAt: rescheduledStart + HOUR },
  };
  const refreshedDuplicate: ConnectorObservation = {
    ...rescheduled,
    data: { ...rescheduled.data },
  };

  const inferred = analyzeLife({
    observations: [...history, original, rescheduled, refreshedDuplicate],
    explicitSettings: {},
    now,
    timeZone: "America/Los_Angeles",
  });
  assert.ok(
    inferred.insights.some((item) => item.key === "preference:appointments:morning"),
    "three 09:00 local appointments establish the tentative baseline",
  );

  const analyzed = analyzeLife({
    observations: [...history, original, rescheduled, refreshedDuplicate],
    explicitSettings: { preferredAppointmentTime: "afternoon" },
    now,
    timeZone: "America/Los_Angeles",
  });
  assert.equal(analyzed.partial, false);
  assert.equal(
    analyzed.insights.some((item) => item.key === "preference:appointments:morning"),
    false,
    "an explicit scheduling preference wins over repeated morning history",
  );
  const preparations = analyzed.proposals.filter((item) => item.kind === "prepare_event");
  assert.equal(preparations.length, 1, "duplicate refreshes do not duplicate preparation");
  const preparation = preparations[0];
  assert.ok(preparation);
  assert.deepEqual(preparation.evidenceRefs, [
    {
      connectionId: "calendar-primary",
      sourceKey: "doctor-visit",
      sourceRevision: "v2",
    },
  ]);
  assert.equal(preparation.expiresAt, rescheduledStart);
  assert.equal(preparation.suggestedReminderAt, rescheduledStart - DAY);

  const store = new LifeStore(join(directory, "life.sqlite"), { now: () => now });
  try {
    store.createGroup(actor, { id: family.id, name: "Family" });
    // This focused test isolates anticipation from context; ConnectorBroker.publish
    // integration is covered separately by the connector suite.
    const personalEvent = store.createRecord(actor, {
      kind: "event",
      scope: personal,
      title: "Doctor visit",
      data: { startAt: rescheduled.data.startAt },
    });
    const familyEvent = store.createRecord(actor, {
      kind: "event",
      scope: family,
      title: "Doctor visit",
      data: { startAt: rescheduled.data.startAt },
    });
    const engine = new ProactivityEngine(store, () => now);

    const first = engine.evaluate(actor, personal, { type: "check", at: now });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.recordId, personalEvent.id);
    assert.equal(engine.evaluate(actor, personal, { type: "check", at: now }).length, 0);

    const notice = store.getRecord(actor, first[0]!.id)!;
    const dismissed = store.updateNotification(
      actor,
      notice.id,
      notice.revision,
      "dismiss",
      now,
    ).notification;
    assert.equal(recordProactiveDismissal(store, actor, dismissed, now), true);

    now += 13 * HOUR;
    assert.equal(
      engine.evaluate(actor, personal, { type: "check", at: now }).length,
      0,
      "dismissal backoff outlasts the ordinary notification cooldown",
    );
    const groupNotice = engine.evaluate(actor, family, { type: "check", at: now });
    assert.equal(groupNotice.length, 1, "personal backoff does not suppress another scope");
    assert.equal(groupNotice[0]?.recordId, familyEvent.id);

    for (const event of [personalEvent, familyEvent]) {
      const current = store.getRecord(actor, event.id)!;
      store.updateRecord(actor, current.id, current.revision, {
        data: { ...current.data, cancelled: true },
      });
    }
    now += 13 * HOUR;
    assert.equal(engine.evaluate(actor, personal, { type: "check", at: now }).length, 0);
    assert.equal(engine.evaluate(actor, family, { type: "check", at: now }).length, 0);

    const cancellation: ConnectorObservation = {
      connectionId: rescheduled.connectionId,
      kind: "deleted",
      sourceKey: rescheduled.sourceKey,
      sourceRevision: "v3",
      observedAt: observed + 2,
      title: "Doctor visit removed",
      data: { previousKind: "event" },
    };
    const afterCancellation = analyzeLife({
      observations: [...history, original, rescheduled, refreshedDuplicate, cancellation],
      explicitSettings: { preferredAppointmentTime: "afternoon" },
      now,
      timeZone: "America/Los_Angeles",
    });
    assert.equal(
      afterCancellation.proposals.some((item) => item.kind === "prepare_event"),
      false,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
