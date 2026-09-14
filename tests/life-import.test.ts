import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { commitLifeImport, previewLifeImport } from "../packages/life-import/src/index.ts";

async function storeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ellie-life-import-"));
  await chmod(directory, 0o700);
  const store = new LifeStore(join(directory, "life.sqlite"), { now: 100 });
  return {
    directory,
    store,
    close: async () => {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("ICS preview preserves all-day events and UTC timestamps", () => {
  const preview = previewLifeImport({
    format: "ics",
    fileName: "calendar.ics",
    content: [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:all-day-1",
      "SUMMARY:Company picnic",
      "DTSTART;VALUE=DATE:20260920",
      "DTEND;VALUE=DATE:20260921",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:utc-1",
      "SUMMARY:Flight",
      "DTSTART:20260922T153000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  });
  assert.equal(preview.source.title, "calendar.ics");
  assert.equal(preview.items[0]?.data.startDate, "2026-09-20");
  assert.equal(preview.items[0]?.data.allDay, true);
  assert.equal(preview.items[1]?.data.startAt, Date.UTC(2026, 8, 22, 15, 30));
  assert.equal(preview.items[1]?.data.timeZone, "UTC");
});

test("ICS preview resolves valid DST instants and refuses nonexistent or unknown zones", () => {
  const preview = previewLifeImport({
    format: "ics",
    content: [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:valid",
      "SUMMARY:Before DST",
      "DTSTART;TZID=America/Los_Angeles:20260308T013000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:missing",
      "SUMMARY:Missing hour",
      "DTSTART;TZID=America/Los_Angeles:20260308T023000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:unknown",
      "SUMMARY:Unknown zone",
      "DTSTART;TZID=Mars/Olympus:20260308T103000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ambiguous",
      "SUMMARY:Repeated hour",
      "DTSTART;TZID=America/Los_Angeles:20261101T013000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n"),
  });
  assert.equal(preview.items[0]?.data.startAt, Date.UTC(2026, 2, 8, 9, 30));
  assert.match(preview.items[1]?.warnings.join(" ") ?? "", /nonexistent/);
  assert.equal(preview.items[1]?.data.startAt, undefined);
  assert.match(preview.items[2]?.warnings.join(" ") ?? "", /unknown time zone/);
  assert.match(preview.items[3]?.warnings.join(" ") ?? "", /ambiguous/);
  assert.equal(preview.items[3]?.data.startAt, undefined);
});

test("unsupported recurrence is visible and never expanded into actions", () => {
  const preview = previewLifeImport({
    format: "ics",
    content: [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:repeat",
      "SUMMARY:Pay rent",
      "DTSTART;VALUE=DATE:20261001",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
      "EXDATE;VALUE=DATE:20270101",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n"),
  });
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0]?.data.recurrence, "FREQ=MONTHLY;BYMONTHDAY=1");
  assert.match(preview.items[0]?.warnings.join(" ") ?? "", /not expanded/);
});

test("vCard preview links contacts and leap-day birthdays with stable keys", () => {
  const content = [
    "BEGIN:VCARD",
    "VERSION:4.0",
    "UID:maya",
    "FN:Maya Rivera",
    "EMAIL:maya@example.test",
    "BDAY:2000-02-29",
    "END:VCARD",
  ].join("\r\n");
  const first = previewLifeImport({ format: "vcard", content }),
    second = previewLifeImport({ format: "vcard", content });
  assert.deepEqual(first, second);
  assert.equal(first.items[0]?.kind, "contact");
  assert.equal(first.items[1]?.kind, "birthday");
  assert.equal(first.items[1]?.data.month, 2);
  assert.equal(first.items[1]?.data.day, 29);
  assert.equal(first.items[1]?.data.birthYear, 2000);
  assert.equal(first.items[1]?.relatedKeys[0]?.targetKey, first.items[0]?.key);
});

test("malformed, oversized, invalid-date and unbalanced input fails or warns without guessing", () => {
  assert.throws(
    () =>
      previewLifeImport({
        format: "ics",
        content: `BEGIN:VCALENDAR\n${"x".repeat(2_000_001)}\nEND:VCALENDAR`,
      }),
    /invalid|too large/,
  );
  assert.throws(
    () => previewLifeImport({ format: "vcard", content: "BEGIN:VCARD\nFN:No end" }),
    /Unclosed/,
  );
  const invalid = previewLifeImport({
    format: "ics",
    content:
      "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Impossible\nDTSTART;VALUE=DATE:20260230\nEND:VEVENT\nEND:VCALENDAR",
  });
  assert.match(invalid.items[0]?.warnings.join(" ") ?? "", /invalid/);
  assert.equal(invalid.items[0]?.data.startDate, undefined);
});

test("calendar preview handles optional seconds, cancellation, and invalid ranges", () => {
  const preview = previewLifeImport({
    format: "ics",
    content: [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:cancelled",
      "SUMMARY:Cancelled appointment",
      "STATUS:CANCELLED",
      "DTSTART:20261001T1700Z",
      "DTEND:20261001T1600Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:no-start",
      "SUMMARY:Undated",
      "DURATION:PT1H",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n"),
  });
  assert.equal(preview.items[0]?.data.startAt, Date.UTC(2026, 9, 1, 17));
  assert.equal(preview.items[0]?.data.cancelled, true);
  assert.match(preview.items[0]?.warnings.join(" ") ?? "", /end must be after/i);
  assert.match(preview.items[1]?.warnings.join(" ") ?? "", /no start time.*DURATION/is);
});

test("commit reparses content and repeated UID import is idempotent", async () => {
  const f = await storeFixture(),
    actor = { userId: "alice" },
    scope = { type: "user", id: "alice" } as const;
  const content =
    "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:stable-event\nSUMMARY:Planning\nDTSTART:20261001T170000Z\nEND:VEVENT\nEND:VCALENDAR";
  try {
    const first = commitLifeImport({
      store: f.store,
      actor,
      scope,
      format: "ics",
      content,
    });
    const second = commitLifeImport({
      store: f.store,
      actor,
      scope,
      format: "ics",
      content,
    });
    assert.equal(first.created, 1);
    assert.equal(second.unchanged, 1);
    assert.equal(second.source.id, first.source.id);
    assert.equal(second.records[0]?.id, first.records[0]?.id);
    assert.deepEqual(second.records[0]?.provenance, [
      {
        sourceId: first.source.id,
        reference: previewLifeImport({ format: "ics", content }).items[0]!.key,
        derived: true,
      },
    ]);
  } finally {
    await f.close();
  }
});

test("commit uses the same normalized content as preview", async () => {
  const f = await storeFixture();
  try {
    const result = commitLifeImport({
      store: f.store,
      actor: { userId: "alice" },
      scope: { type: "user", id: "alice" },
      format: "ics",
      content:
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:line-endings\r\nSUMMARY:Planning\r\nDTSTART:20261001T170000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    });
    assert.equal(result.created, 1);
  } finally {
    await f.close();
  }
});

test("source update refreshes managed records, preserves user edits, and delete invalidates provenance", async () => {
  const f = await storeFixture(),
    actor = { userId: "alice" },
    scope = { type: "user", id: "alice" } as const;
  const original =
    "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:event\nSUMMARY:Original\nDTSTART:20261001T170000Z\nEND:VEVENT\nEND:VCALENDAR";
  try {
    const first = commitLifeImport({
      store: f.store,
      actor,
      scope,
      format: "ics",
      content: original,
    });
    const sourceId = first.source.id;
    const changed = original.replace("SUMMARY:Original", "SUMMARY:Changed");
    const update = commitLifeImport({
      store: f.store,
      actor,
      scope,
      format: "ics",
      content: changed,
      sourceId,
    });
    assert.equal(update.updated, 1);
    assert.equal(update.records[0]?.title, "Changed");
    const edited = f.store.updateRecord(actor, update.records[0]!.id, update.records[0]!.revision, {
      title: "My own title",
    });
    const conflict = commitLifeImport({
      store: f.store,
      actor,
      scope,
      format: "ics",
      content: changed.replace("Changed", "Again"),
      sourceId,
    });
    assert.equal(conflict.conflicts[0]?.recordId, edited.id);
    assert.equal(f.store.getRecord(actor, edited.id)?.title, "My own title");
    f.store.deleteSource(actor, conflict.source.id, conflict.source.revision);
    assert.equal(f.store.getRecord(actor, edited.id)?.provenance[0]?.invalidatedAt, 100);
  } finally {
    await f.close();
  }
});

test("selection rejects unknown and duplicate keys before atomic commit", async () => {
  const f = await storeFixture(),
    actor = { userId: "alice" },
    scope = { type: "user", id: "alice" } as const;
  const content =
    "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:same\nSUMMARY:One\nDTSTART;VALUE=DATE:20261001\nEND:VEVENT\nBEGIN:VEVENT\nUID:same\nSUMMARY:Two\nDTSTART;VALUE=DATE:20261002\nEND:VEVENT\nEND:VCALENDAR";
  try {
    assert.throws(
      () =>
        commitLifeImport({
          store: f.store,
          actor,
          scope,
          format: "ics",
          content,
          selectedKeys: ["missing"],
        }),
      /not present/,
    );
    const key = previewLifeImport({ format: "ics", content }).items[0]!.key;
    assert.throws(
      () =>
        commitLifeImport({
          store: f.store,
          actor,
          scope,
          format: "ics",
          content,
          selectedKeys: [key],
        }),
      /ambiguous/,
    );
    assert.equal(f.store.listRecords(actor).length, 0);
  } finally {
    await f.close();
  }
});
