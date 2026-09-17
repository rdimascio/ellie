import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLifeApplication } from "../apps/life/src/main.ts";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { ConnectorBroker } from "../packages/life-connectors/src/broker.ts";
import { ConnectorStore } from "../packages/life-connectors/src/store.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";

test("actor-scoped upcoming agenda reads only completed selected-calendar imports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-agenda-route-"));
  const application = await createLifeApplication({
    stateDir: directory,
    port: 0,
    userId: "owner",
  });
  let fixture: ConnectorStore | undefined;
  try {
    const ready = await application.listen();
    const login = await fetch(`${ready.url}/api/life/session`, {
      method: "POST",
      headers: { origin: ready.url, "content-type": "application/json" },
      body: JSON.stringify({ token: decodeURIComponent(ready.launchUrl.split("#token=")[1]!) }),
    });
    assert.equal(login.status, 204);
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
    fixture = new ConnectorStore(join(directory, "connectors.sqlite"));
    const created = fixture.create("owner", "google-calendar", "observe");
    const connected = fixture.update(
      "owner",
      created.id,
      created.generation,
      {
        state: "connected",
        accountId: "synthetic-account",
        label: "家族 🗓️ calendar",
        selectedCalendarId: "fixture-calendar",
        grantedScopes: ["calendar.readonly"],
      },
      true,
    );
    const url = `${ready.url}/api/connections/${created.id}/agenda?timeZone=America%2FLos_Angeles`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { cookie, origin: ready.url };
    assert.equal(
      (await fetch(`${ready.url}/api/connections/${created.id}/agenda`, { headers })).status,
      400,
    );
    assert.equal((await fetch(`${url}&timeZone=UTC`, { headers })).status, 400);
    const incomplete = (await (await fetch(url, { headers })).json()) as {
      complete: boolean;
      events: unknown[];
    };
    assert.equal(incomplete.complete, false);
    assert.deepEqual(incomplete.events, []);

    const now = Date.now();
    const civilDate = (instant: number) => {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          calendar: "gregory",
          numberingSystem: "latn",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .formatToParts(new Date(instant))
          .map((part) => [part.type, part.value]),
      );
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const today = civilDate(now);
    const yesterday = civilDate(now - 86_400_000);
    const allDayStart = new Date(now + 86_400_000).toISOString().slice(0, 10);
    const allDayEnd = new Date(now + 2 * 86_400_000).toISOString().slice(0, 10);
    fixture.ingest(
      "owner",
      created.id,
      connected.generation,
      {
        accountId: "synthetic-account",
        complete: true,
        cursor: "fixture-cursor",
        items: [
          {
            kind: "event",
            sourceKey: "later",
            sourceRevision: "1",
            observedAt: now,
            title: "Later",
            data: { status: "confirmed", startAt: now + 86_400_000, endAt: now + 90_000_000 },
          },
          {
            kind: "event",
            sourceKey: "soon",
            sourceRevision: "1",
            observedAt: now,
            title: "日程 🗓️ Soon",
            data: { status: "tentative", startAt: now + 3_600_000, endAt: now + 7_200_000 },
          },
          {
            kind: "event",
            sourceKey: "past",
            sourceRevision: "1",
            observedAt: now,
            title: "Past",
            data: { status: "confirmed", startAt: now - 86_400_000, endAt: now - 82_800_000 },
          },
          {
            kind: "event",
            sourceKey: "all-day",
            sourceRevision: "1",
            observedAt: now,
            title: "All day",
            data: { status: "confirmed", startDate: allDayStart, endDate: allDayEnd },
          },
          {
            kind: "event",
            sourceKey: "invalid-date",
            sourceRevision: "1",
            observedAt: now,
            title: "Invalid date",
            data: { status: "confirmed", startDate: "2026-13-40", endDate: "2026-13-41" },
          },
          {
            kind: "event",
            sourceKey: "cancelled",
            sourceRevision: "1",
            observedAt: now,
            title: "Cancelled",
            data: { status: "cancelled", startAt: now + 1_000, endAt: now + 2_000 },
          },
          ...Array.from({ length: 25 }, (_, index) => ({
            kind: "event" as const,
            sourceKey: `ended-${index}`,
            sourceRevision: "1",
            observedAt: now,
            title: `Ended ${index}`,
            data: { status: "confirmed" as const, startDate: yesterday, endDate: today },
          })),
        ],
      },
      now,
    );
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    const agenda = (await response.json()) as {
      connectionId: string;
      selectedCalendarId: string;
      displayTimeZone: string;
      label: string;
      complete: boolean;
      lastSyncAt: number;
      events: { title: string; status: string; startAt?: number; startDate?: string }[];
    };
    assert.equal(agenda.connectionId, created.id);
    assert.equal(agenda.selectedCalendarId, "fixture-calendar");
    assert.equal(agenda.displayTimeZone, "America/Los_Angeles");
    assert.equal(agenda.label, "家族 🗓️ calendar");
    assert.equal(agenda.complete, true);
    assert.equal(agenda.lastSyncAt, now);
    assert.deepEqual(
      agenda.events.filter((item) => item.startAt !== undefined).map((item) => item.title),
      ["日程 🗓️ Soon", "Later"],
    );
    assert.deepEqual(
      agenda.events.filter((item) => item.startAt !== undefined).map((item) => item.status),
      ["tentative", "confirmed"],
    );
    assert.ok(
      agenda.events.some((item) => item.title === "All day" && item.startDate === allDayStart),
    );
    assert.ok(!agenda.events.some((item) => item.title === "Invalid date"));
    assert.ok(
      !agenda.events.some((item) => item.title.startsWith("Ended")),
      "events whose exclusive all-day end is today cannot consume the result cap",
    );
    assert.equal(
      agenda.events.find((item) => item.title === "日程 🗓️ Soon")?.startAt,
      now + 3_600_000,
    );

    const outsider = fixture.create("other", "google-calendar", "observe");
    assert.equal(
      (await fetch(`${ready.url}/api/connections/${outsider.id}/agenda`, { headers })).status,
      404,
    );
    fixture.selectCalendar("owner", created.id, connected.generation, "new-calendar");
    const changed = (await (await fetch(url, { headers })).json()) as {
      complete: boolean;
      events: unknown[];
      selectedCalendarId: string;
    };
    assert.equal(changed.selectedCalendarId, "new-calendar");
    assert.equal(changed.complete, false);
    assert.deepEqual(changed.events, []);
    fixture.revoke("owner", created.id);
    assert.equal((await fetch(url, { headers })).status, 404);
  } finally {
    fixture?.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("all-day agenda uses the requested civil time zone at midnight and exclusive end", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-agenda-midnight-"));
  const store = new ConnectorStore(join(directory, "connectors.sqlite"));
  const life = new LifeStore(join(directory, "life.sqlite"));
  const tasks = new TaskRuntime({
    directory: join(directory, "tasks"),
    capabilityResolver: () => [],
  });
  const now = Date.UTC(2026, 8, 17, 6, 30); // September 16, 23:30 in Los Angeles.
  const broker = new ConnectorBroker({
    store,
    life,
    tasks,
    providers: [],
    now: () => now,
    vault: {
      put() {},
      get() {
        return undefined;
      },
      delete() {},
    },
  });
  try {
    const created = store.create("owner", "google-calendar", "observe");
    const connected = store.update(
      "owner",
      created.id,
      created.generation,
      {
        state: "connected",
        accountId: "synthetic",
        label: "Calendar",
        selectedCalendarId: "selected",
        grantedScopes: ["calendar.readonly"],
      },
      true,
    );
    store.ingest(
      "owner",
      created.id,
      connected.generation,
      {
        accountId: "synthetic",
        complete: true,
        cursor: "complete",
        items: [
          {
            kind: "event",
            sourceKey: "boundary",
            sourceRevision: "1",
            observedAt: now,
            title: "Ends at local midnight",
            data: { status: "confirmed", startDate: "2026-09-16", endDate: "2026-09-17" },
          },
          {
            kind: "event",
            sourceKey: "ongoing",
            sourceRevision: "1",
            observedAt: now,
            title: "Ongoing multi-day",
            data: { status: "confirmed", startDate: "2026-09-15", endDate: "2026-09-18" },
          },
        ],
      },
      now,
    );
    const beforeMidnight = broker.agenda("owner", created.id, "America/Los_Angeles");
    assert.deepEqual(
      beforeMidnight.events.map((event) => event.title),
      ["Ongoing multi-day", "Ends at local midnight"],
    );
    const afterMidnightUTC = broker.agenda("owner", created.id, "UTC");
    assert.deepEqual(
      afterMidnightUTC.events.map((event) => event.title),
      ["Ongoing multi-day"],
    );
    assert.throws(() => broker.agenda("owner", created.id, "Invalid/Zone"));
  } finally {
    await broker.close();
    await tasks.close();
    store.close();
    life.close();
    await rm(directory, { recursive: true, force: true });
  }
});
