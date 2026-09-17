import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLifeApplication } from "../apps/life/src/main.ts";
import { ConnectorStore } from "../packages/life-connectors/src/store.ts";

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
        label: "Selected fixture calendar",
        selectedCalendarId: "fixture-calendar",
        grantedScopes: ["calendar.readonly"],
      },
      true,
    );
    const url = `${ready.url}/api/connections/${created.id}/agenda`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { cookie, origin: ready.url };
    const incomplete = (await (await fetch(url, { headers })).json()) as {
      complete: boolean;
      events: unknown[];
    };
    assert.equal(incomplete.complete, false);
    assert.deepEqual(incomplete.events, []);

    const now = Date.now();
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
            title: "Soon",
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
        ],
      },
      now,
    );
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    const agenda = (await response.json()) as {
      connectionId: string;
      selectedCalendarId: string;
      complete: boolean;
      lastSyncAt: number;
      events: { title: string; status: string; startAt?: number; startDate?: string }[];
    };
    assert.equal(agenda.connectionId, created.id);
    assert.equal(agenda.selectedCalendarId, "fixture-calendar");
    assert.equal(agenda.complete, true);
    assert.equal(agenda.lastSyncAt, now);
    assert.deepEqual(
      agenda.events.filter((item) => item.startAt !== undefined).map((item) => item.title),
      ["Soon", "Later"],
    );
    assert.deepEqual(
      agenda.events.filter((item) => item.startAt !== undefined).map((item) => item.status),
      ["tentative", "confirmed"],
    );
    assert.ok(
      agenda.events.some((item) => item.title === "All day" && item.startDate === allDayStart),
    );
    assert.ok(!agenda.events.some((item) => item.title === "Invalid date"));
    assert.equal(agenda.events.find((item) => item.title === "Soon")?.startAt, now + 3_600_000);

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
