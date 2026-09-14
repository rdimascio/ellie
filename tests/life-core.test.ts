import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  LifeAccessError,
  LifeConflictError,
  LifeStore,
  inferTone,
} from "../packages/life-core/src/index.ts";

const alice = { userId: "alice" },
  bob = { userId: "bob" };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ellie-life-"));
  await chmod(dir, 0o700);
  const path = join(dir, "life.sqlite");
  let n = 0;
  return { dir, path, open: (now = 100) => new LifeStore(path, { now, id: () => `id-${++n}` }) };
}

test("records survive restart, enforce private/group scopes, revisions and deletion", async () => {
  const f = await fixture();
  try {
    let store = f.open();
    const group = store.createGroup(alice, { id: "home", name: "Home" });
    assert.deepEqual(group, {
      id: "home",
      name: "Home",
      role: "owner",
      revision: 1,
      createdAt: 100,
      updatedAt: 100,
    });
    store.setGroupMember(alice, "home", { userId: "bob", role: "member" });
    const privateRecord = store.createRecord(alice, {
      kind: "memory",
      title: "Private",
      scope: { type: "user", id: "alice" },
      data: { valid: true },
    });
    const shared = store.createRecord(alice, {
      kind: "reminder",
      title: "Bins",
      scope: { type: "group", id: "home" },
      data: { dueAt: 123, timeZone: "UTC", completed: false },
    });
    assert.equal(store.getRecord(bob, privateRecord.id), undefined);
    assert.equal(store.getRecord(bob, shared.id)?.title, "Bins");
    assert.throws(
      () =>
        store.createRecord(bob, {
          kind: "memory",
          title: "Trespass",
          scope: { type: "user", id: "alice" },
          data: {},
        }),
      LifeAccessError,
    );
    const revision2 = store.updateRecord(alice, privateRecord.id, 1, { data: { valid: false } });
    assert.equal(revision2.revision, 2);
    assert.throws(
      () => store.updateRecord(alice, privateRecord.id, 1, { title: "stale" }),
      LifeConflictError,
    );
    store.close();
    store = f.open(200);
    assert.equal(store.getRecord(alice, privateRecord.id)?.data.valid, false);
    store.deleteRecord(alice, privateRecord.id, 2);
    assert.equal(store.getRecord(alice, privateRecord.id), undefined);
    store.close();
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("improvement selector filters before its cap and stays actor-private", async () => {
  const f = await fixture();
  const store = f.open();
  try {
    const proposal = store.createRecord(alice, {
      kind: "routine",
      title: "Older proposal",
      scope: { type: "user", id: "alice" },
      data: { type: "learning-improvement-v1", status: "ready" },
    });
    for (let index = 0; index < 501; index++)
      store.createRecord(alice, {
        kind: "routine",
        title: `Unrelated ${index}`,
        scope: { type: "user", id: "alice" },
        data: { type: "ordinary-routine" },
      });
    store.createRecord(bob, {
      kind: "routine",
      title: "Bob proposal",
      scope: { type: "user", id: "bob" },
      data: { type: "learning-improvement-v1", status: "ready" },
    });
    assert.deepEqual(
      store.listImprovementRecords(alice).map(({ id }) => id),
      [proposal.id],
    );
    assert.throws(() => store.listImprovementRecords(alice, 22), /limit is invalid/);
  } finally {
    store.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("settings resolve precedence and cannot override permissions", async () => {
  const f = await fixture();
  try {
    const store = f.open();
    store.createGroup(alice, { id: "home", name: "Home" });
    store.setDefaultSetting("voice", "calm");
    store.setDefaultSetting("units", "metric");
    store.setGroupSetting(alice, "home", "voice", "bright");
    store.setUserSetting(alice, "voice", "quiet");
    const resolved = store.resolveSettings(alice, { groupId: "home", task: { voice: "brief" } });
    assert.deepEqual(resolved.values, { units: "metric", voice: "brief" });
    assert.deepEqual(resolved.origins, { units: "default", voice: "task" });
    assert.throws(() => store.setUserSetting(alice, "permissions.calendar", true), LifeAccessError);
    assert.throws(
      () => store.resolveSettings(alice, { task: { authority: "owner" } }),
      LifeAccessError,
    );
    const completed = store.createRecord(alice, {
        kind: "need",
        title: "Completed need",
        scope: { type: "user", id: "alice" },
        data: { completed: true },
      }),
      linked = store.createRecord(alice, {
        kind: "reminder",
        title: "Preparation reminder",
        scope: { type: "user", id: "alice" },
        data: {},
        relationships: [{ type: "need", targetId: completed.id }],
      }),
      linkedSummary = store
        .listRecordSummaries(alice, {
          scope: { type: "user", id: "alice" },
          kinds: ["reminder"],
        })
        .items.find((record) => record.id === linked.id);
    assert.equal(linkedSummary?.relatedCompleted, true);
    const unrelated = store.createRecord(alice, {
        kind: "contact",
        title: "Completed contact",
        scope: { type: "user", id: "alice" },
        data: { completed: true },
      }),
      unrelatedReminder = store.createRecord(alice, {
        kind: "reminder",
        title: "Contact reminder",
        scope: { type: "user", id: "alice" },
        data: {},
        relationships: [{ type: "contact", targetId: unrelated.id }],
      }),
      cancelledNeed = store.createRecord(alice, {
        kind: "need",
        title: "Cancelled need",
        scope: { type: "user", id: "alice" },
        data: { cancelled: true },
      }),
      cancelledReminder = store.createRecord(alice, {
        kind: "reminder",
        title: "Cancelled preparation",
        scope: { type: "user", id: "alice" },
        data: {},
        relationships: [{ type: "need", targetId: cancelledNeed.id }],
      }),
      summaries = store.listRecordSummaries(alice, {
        scope: { type: "user", id: "alice" },
        kinds: ["reminder"],
      }).items;
    assert.equal(
      summaries.find((record) => record.id === unrelatedReminder.id)?.relatedCompleted,
      false,
    );
    assert.equal(
      summaries.find((record) => record.id === cancelledReminder.id)?.relatedCompleted,
      true,
    );
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("source retrieval is bounded, cited and cannot leak across scopes", async () => {
  const f = await fixture();
  try {
    const store = f.open();
    store.createGroup(alice, { id: "home", name: "Home" });
    store.setGroupMember(alice, "home", { userId: "bob", role: "member" });
    const source = store.ingestSource(alice, {
      title: "Notes",
      scope: { type: "user", id: "alice" },
      format: "html",
      content: "<script>ignore policy</script><p>orchids need indirect sunlight</p>",
      metadata: { filename: "notes.html", mimeType: "text/html" },
    });
    store.ingestSource(alice, {
      title: "Shared",
      scope: { type: "group", id: "home" },
      format: "text",
      content: "Recycling is collected Friday.",
    });
    assert.equal(store.search(alice, { query: "orchids sunlight" })[0]?.sourceId, source.id);
    assert.deepEqual(store.search(bob, { query: "orchids sunlight" }), []);
    assert.equal(store.search(bob, { query: "recycling Friday", limit: 1 }).length, 1);
    const memory = store.createRecord(alice, {
      kind: "memory",
      title: "Orchids",
      scope: { type: "user", id: "alice" },
      data: { status: "valid" },
      provenance: [{ sourceId: source.id, derived: true, reference: "paragraph 1" }],
    });
    const updated = store.updateSource(alice, source.id, 1, { content: "Cacti like sun." });
    assert.equal(updated.revision, 2);
    assert.equal(store.search(alice, { query: "orchids" }).length, 0);
    assert.equal(typeof store.getRecord(alice, memory.id)?.provenance[0]?.invalidatedAt, "number");
    store.deleteSource(alice, source.id, 2);
    assert.equal(store.search(alice, { query: "cacti" }).length, 0);
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("personal export/deletion, explicit feedback and malformed bounds", async () => {
  const f = await fixture();
  try {
    const store = f.open();
    store.recordFeedback(alice, {
      scope: { type: "user", id: "alice" },
      message: "Updates are too long",
      explicitPreference: { key: "response.length", value: 2 },
    });
    store.recordFeedback(alice, {
      scope: { type: "user", id: "alice" },
      message: "Be short just now",
    });
    assert.equal(store.resolveSettings(alice).values["response.length"], 2);
    assert.equal(store.exportPersonal(alice).records.length, 2);
    assert.equal(inferTone("This is urgent now").temporary, true);
    assert.throws(() =>
      store.createRecord(alice, {
        kind: "unknown" as never,
        title: "x",
        scope: { type: "user", id: "alice" },
        data: {},
      }),
    );
    assert.throws(() =>
      store.createRecord(alice, {
        kind: "memory",
        title: "x".repeat(2001),
        scope: { type: "user", id: "alice" },
        data: {},
      }),
    );
    assert.throws(() => store.setUserSetting(alice, "bad", undefined));
    store.deletePersonal(alice);
    assert.equal(store.exportPersonal(alice).records.length, 0);
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("unsafe files and newer schemas are rejected without replacing data", async () => {
  const f = await fixture();
  try {
    const newer = new DatabaseSync(f.path);
    newer.exec("PRAGMA user_version=99");
    newer.close();
    await chmod(f.path, 0o600);
    assert.throws(() => f.open(), /preserve/);
    const target = join(f.dir, "target");
    await writeFile(target, "keep", { mode: 0o600 });
    const linked = join(f.dir, "linked.sqlite");
    await symlink(target, linked);
    assert.throws(() => new LifeStore(linked), /preserve/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("kind filtering happens before the result limit", async () => {
  const f = await fixture();
  try {
    const store = f.open();
    store.createRecord(alice, {
      kind: "reminder",
      title: "Older reminder",
      scope: { type: "user", id: "alice" },
      data: {},
    });
    for (let index = 0; index < 8; index++)
      store.createRecord(alice, {
        kind: "memory",
        title: `Recent ${index}`,
        scope: { type: "user", id: "alice" },
        data: {},
      });
    assert.equal(
      store.listRecords(alice, { kinds: ["reminder"], limit: 1 })[0]?.title,
      "Older reminder",
    );
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("settings reject prototype pollution and failed group feedback is atomic", async () => {
  const f = await fixture();
  try {
    const store = f.open();
    store.createGroup(alice, { id: "home", name: "Home" });
    store.setGroupMember(alice, "home", { userId: "bob", role: "member" });
    assert.throws(() => store.setUserSetting(alice, "__proto__", { polluted: true }), /unsafe/);
    assert.throws(
      () => store.setUserSetting(alice, "safe", JSON.parse('{"constructor":{"polluted":true}}')),
      /unsafe/,
    );
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    assert.throws(
      () =>
        store.setSettings(alice, {
          level: "user",
          values: { tone: "brief", "permissions.calendar": true },
        }),
      LifeAccessError,
    );
    assert.equal(store.resolveSettings(alice).values.tone, undefined);
    assert.throws(
      () =>
        store.setSettings(alice, {
          level: "user",
          values: { tone: "warm", timeZone: "Mars/Olympus" },
        }),
      /IANA/,
    );
    assert.equal(store.resolveSettings(alice).values.tone, undefined);
    assert.throws(() => store.setUserSetting(alice, "proactiveSuggestions", "yes"), /boolean/);
    assert.throws(
      () => store.setUserSetting(alice, "quietHours", { enabled: true, start: -1, end: 8 }),
      /0 through 24/,
    );
    store.setUserSetting(alice, "timeZone", "America/Los_Angeles");
    store.setUserSetting(alice, "proactiveSuggestions", true);
    store.setUserSetting(alice, "quietHours", { enabled: true, start: 22, end: 7 });
    store.setSettings(alice, { level: "user", values: { tone: "brief", units: "metric" } });
    assert.equal(store.resolveSettings(alice).values.tone, "brief");
    const before = store.listRecords(bob, { kinds: ["feedback"] }).length;
    assert.throws(
      () =>
        store.recordFeedback(bob, {
          scope: { type: "group", id: "home" },
          message: "Change it",
          explicitPreference: { key: "tone", value: "brief" },
        }),
      LifeAccessError,
    );
    assert.equal(store.listRecords(bob, { kinds: ["feedback"] }).length, before);
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("relationships and provenance require strict values and same-scope readable targets", async () => {
  const f = await fixture();
  try {
    const store = f.open();
    store.createGroup(alice, { id: "home", name: "Home" });
    const privateSource = store.ingestSource(alice, {
      title: "Private source",
      scope: { type: "user", id: "alice" },
      format: "text",
      content: "private evidence",
    });
    const sharedTarget = store.createRecord(alice, {
      kind: "goal",
      title: "Shared",
      scope: { type: "group", id: "home" },
      data: {},
    });
    assert.throws(
      () =>
        store.createRecord(alice, {
          kind: "memory",
          title: "Leak",
          scope: { type: "group", id: "home" },
          data: {},
          provenance: [{ sourceId: privateSource.id, derived: true }],
        }),
      LifeAccessError,
    );
    assert.throws(
      () =>
        store.createRecord(alice, {
          kind: "memory",
          title: "Bad boolean",
          scope: { type: "user", id: "alice" },
          data: {},
          provenance: [{ sourceId: privateSource.id, derived: "yes" as never }],
        }),
      /derived/,
    );
    assert.throws(
      () =>
        store.createRecord(alice, {
          kind: "memory",
          title: "Bad time",
          scope: { type: "user", id: "alice" },
          data: {},
          provenance: [{ sourceId: privateSource.id, invalidatedAt: Number.NaN }],
        }),
      /invalidatedAt/,
    );
    assert.throws(
      () =>
        store.createRecord(alice, {
          kind: "goal",
          title: "Cross scope",
          scope: { type: "user", id: "alice" },
          data: {},
          relationships: [{ type: "depends-on", targetId: sharedTarget.id }],
        }),
      LifeAccessError,
    );
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("proactive notification and source cooldown marker commit atomically", async () => {
  const f = await fixture();
  try {
    const store = f.open(),
      need = store.createRecord(alice, {
        kind: "need",
        title: "Coffee filters",
        scope: { type: "user", id: "alice" },
        data: { completed: false },
      }),
      first = store.createProactiveNotification(alice, {
        scope: need.scope,
        recordId: need.id,
        expectedRevision: need.revision,
        reason: "You are at the market.",
        category: "shopping",
        expiresAt: 200,
        at: 100,
      });
    assert.equal(first?.kind, "feedback");
    assert.equal(store.getRecord(alice, need.id)?.data.lastSuggestionAt, 100);
    assert.equal(
      store.createProactiveNotification(alice, {
        scope: need.scope,
        recordId: need.id,
        expectedRevision: need.revision,
        reason: "Duplicate",
        category: "shopping",
        expiresAt: 201,
        at: 101,
      }),
      undefined,
    );
    assert.equal(store.listRecords(alice, { kinds: ["feedback"] }).length, 1);
    const event = store.createRecord(alice, {
      kind: "event",
      title: "Trip",
      scope: need.scope,
      data: {},
    });
    assert.ok(
      store.createProactiveNotification(alice, {
        scope: event.scope,
        recordId: event.id,
        expectedRevision: event.revision,
        reason: "Pack now",
        category: "preparation",
        expiresAt: 1_000,
        at: 100,
        cooldownMs: 0,
      }),
    );
    const marked = store.getRecord(alice, event.id)!;
    assert.equal(
      store.createProactiveNotification(alice, {
        scope: event.scope,
        recordId: event.id,
        expectedRevision: marked.revision,
        reason: "Pack again",
        category: "preparation",
        expiresAt: 1_100,
        at: 200,
        cooldownMs: 0,
      }),
      undefined,
    );
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("imports are atomic, stable, related and preserve edited records", async () => {
  const f = await fixture();
  try {
    const store = f.open(),
      content = "BEGIN:VCALENDAR\nsynthetic\nEND:VCALENDAR",
      contentHash = createHash("sha256").update(content).digest("hex"),
      input = {
        scope: { type: "user" as const, id: "alice" },
        format: "ics" as const,
        content,
        sourceTitle: "calendar.ics",
        contentHash,
        items: [
          {
            key: "event:a",
            kind: "event" as const,
            title: "Dinner",
            data: { startAt: 500 },
            relatedKeys: [{ type: "precedes", targetKey: "event:b" }],
            warnings: [],
          },
          {
            key: "event:b",
            kind: "event" as const,
            title: "Dessert",
            data: { startAt: 600 },
            relatedKeys: [],
            warnings: ["Synthetic warning"],
          },
        ],
      },
      first = store.commitImport(alice, input);
    assert.deepEqual(
      { created: first.created, updated: first.updated, unchanged: first.unchanged },
      { created: 2, updated: 0, unchanged: 0 },
    );
    assert.equal(first.records[0]?.relationships[0]?.targetId, first.records[1]?.id);
    assert.equal(first.records[0]?.provenance[0]?.sourceId, first.source.id);
    const second = store.commitImport(alice, input);
    assert.equal(second.source.id, first.source.id);
    assert.equal(second.unchanged, 2);
    const edited = store.updateRecord(alice, first.records[0]!.id, 1, { title: "My dinner" }),
      changedContent = `${content}\nupdated`,
      changed = store.commitImport(alice, {
        ...input,
        content: changedContent,
        contentHash: createHash("sha256").update(changedContent).digest("hex"),
        sourceId: first.source.id,
        items: input.items.map((item) =>
          item.key === "event:a" ? { ...item, title: "Imported dinner" } : item,
        ),
      });
    assert.equal(changed.conflicts[0]?.recordId, edited.id);
    assert.equal(store.getRecord(alice, edited.id)?.title, "My dinner");
    assert.equal(changed.updated, 0);
    assert.equal(changed.unchanged, 1);
    const before = store.listRecords(alice).length;
    assert.throws(
      () =>
        store.commitImport(alice, {
          ...input,
          items: [{ ...input.items[0]!, relatedKeys: [{ type: "bad", targetKey: "missing" }] }],
        }),
      /selected items/,
    );
    assert.equal(store.listRecords(alice).length, before);
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("compact record summaries page stably across equal timestamps and restart", async () => {
  const f = await fixture();
  try {
    let store = f.open(500);
    for (let index = 0; index < 501; index++)
      store.createRecord(alice, {
        kind: "memory",
        title: `Memory ${index}`,
        body: `Preview ${index} ${"x".repeat(300)}`,
        scope: { type: "user", id: "alice" },
        data: {
          privateBulk: "x".repeat(10_000),
          date: { nested: "x".repeat(10_000) },
          status: "x".repeat(1_000),
          completed: index % 2 === 0,
        },
      });
    const first = store.listRecordSummaries(alice, {
      scope: { type: "user", id: "alice" },
      limit: 500,
    });
    assert.equal(first.items.length, 500);
    assert.equal(first.hasMore, true);
    assert.equal(first.items[0]?.bodyPreview?.length, 240);
    assert.equal(first.items[0]?.hasMoreBody, true);
    assert.equal(first.items[0]?.data.privateBulk, undefined);
    assert.equal(first.items[0]?.data.date, undefined);
    assert.equal(first.items[0]?.data.status, undefined);
    store.close();
    store = f.open(500);
    const second = store.listRecordSummaries(alice, {
      scope: { type: "user", id: "alice" },
      limit: 500,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 1);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.items, ...second.items].map((record) => record.id)).size, 501);
    assert.throws(
      () =>
        store.listRecordSummaries(alice, {
          scope: { type: "user", id: "alice" },
          cursor: "forged",
        }),
      /cursor/,
    );
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("personal export is generation-bound and reset preserves shared membership", async () => {
  const f = await fixture();
  try {
    let store = f.open(700);
    store.createGroup(alice, { id: "family", name: "Family" });
    store.setGroupMember(alice, "family", { userId: "bob", role: "member" });
    store.createRecord(alice, {
      kind: "source",
      title: "Private source",
      body: "full private text",
      scope: { type: "user", id: "alice" },
      data: {},
    });
    store.createRecord(alice, {
      kind: "event",
      title: "Shared dinner",
      scope: { type: "group", id: "family" },
      data: { startAt: 900 },
    });
    store.setSettings(alice, { level: "user", values: { tone: "brief" } });
    const review = store.personalSummary(alice),
      first = store.exportPersonalPage(alice, { limit: 1, expectedGeneration: review.generation });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    store.createRecord(alice, {
      kind: "memory",
      title: "Changed",
      scope: { type: "user", id: "alice" },
      data: {},
    });
    assert.throws(
      () =>
        store.exportPersonalPage(alice, {
          cursor: first.nextCursor,
          expectedGeneration: review.generation,
        }),
      LifeConflictError,
    );
    const current = store.personalSummary(alice),
      journal = store.beginPersonalReset(alice, {
        operationId: "reset-1",
        reviewTokenHash: "a".repeat(64),
        lifeGeneration: current.generation,
        taskGeneration: 3,
        pluginGeneration: 4,
      });
    assert.equal(journal.state, "draining");
    store.close();
    store = f.open(701);
    assert.equal(store.getPersonalReset(alice)?.operationId, "reset-1");
    const after = store.deletePersonal(alice, { preserveMemberships: true });
    assert.equal(after.records, 0);
    assert.equal(store.listGroups(bob)[0]?.id, "family");
    assert.equal(
      store.listRecords(bob, { scope: { type: "group", id: "family" } })[0]?.title,
      "Shared dinner",
    );
    for (const state of ["tasks-deleted", "plugins-deleted", "life-deleted", "completed"] as const)
      store.advancePersonalReset(alice, "reset-1", state);
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("personal export pages bound large source payloads without losing the next item", async () => {
  const f = await fixture();
  try {
    const store = f.open(900),
      body = "x".repeat(3_100_000);
    store.createRecord(alice, {
      kind: "source",
      title: "One",
      body,
      scope: { type: "user", id: "alice" },
      data: {},
    });
    store.createRecord(alice, {
      kind: "source",
      title: "Two",
      body,
      scope: { type: "user", id: "alice" },
      data: {},
    });
    const generation = store.personalSummary(alice).generation,
      first = store.exportPersonalPage(alice, { limit: 100, expectedGeneration: generation });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = store.exportPersonalPage(alice, {
      cursor: first.nextCursor,
      limit: 100,
      expectedGeneration: generation,
    });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, undefined);
    store.createRecord(bob, {
      kind: "memory",
      title: "Bob",
      scope: { type: "user", id: "bob" },
      data: {},
    });
    assert.throws(() => store.exportPersonalPage(bob, { cursor: first.nextCursor }), /cursor/);
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("durable conversations are private, idempotent, context-safe, and restart pending as interrupted", async () => {
  const f = await fixture();
  try {
    let store = f.open(1_000);
    const source = store.ingestSource(alice, {
      title: "Notes",
      scope: { type: "user", id: "alice" },
      format: "text",
      content: "Garden plans",
    });
    const begun = store.beginConversationTurn(alice, {
      scope: { type: "user", id: "alice" },
      requestId: "request-1",
      chatEpoch: 1,
      message: "What are the plans?",
    });
    const completed = store.completeConversationTurn(alice, {
      conversationId: begun.conversation.id,
      turnId: begun.turn.id,
      requestId: "request-1",
      result: {
        reply: "Garden plans",
        actions: [],
        recordIds: [],
        taskIds: [],
        evidence: [{ sourceId: source.id, sourceRevision: source.revision, title: source.title }],
      },
    });
    const duplicate = store.beginConversationTurn(alice, {
      scope: { type: "user", id: "alice" },
      conversationId: begun.conversation.id,
      requestId: "request-1",
      chatEpoch: 1,
      message: "What are the plans?",
    });
    assert.equal(duplicate.status, "completed");
    assert.equal(duplicate.result?.reply, "Garden plans");
    assert.throws(
      () =>
        store.beginConversationTurn(alice, {
          scope: { type: "user", id: "alice" },
          requestId: "request-1",
          chatEpoch: 1,
          message: "Different",
        }),
      LifeConflictError,
    );
    assert.equal(store.conversationHistory(alice, begun.conversation.id).length, 2);
    store.updateRecord(alice, source.id, source.revision, { body: "Changed plans" });
    assert.equal(store.conversationHistory(alice, begun.conversation.id).length, 0);
    assert.equal(
      store.getConversation(alice, begun.conversation.id).turns.items[0]?.outdated,
      true,
    );
    const beforeSetting = store.conversationContextFingerprint(alice, begun.conversation.id);
    store.setSettings(alice, { level: "user", values: { tone: "concise" } });
    assert.notEqual(
      store.conversationContextFingerprint(alice, begun.conversation.id),
      beforeSetting,
      "same-clock setting changes must invalidate restored model context",
    );
    assert.throws(() => store.getConversation(bob, begun.conversation.id), LifeAccessError);
    const pending = store.beginConversationTurn(alice, {
      scope: { type: "user", id: "alice" },
      conversationId: begun.conversation.id,
      requestId: "request-2",
      chatEpoch: 1,
      message: "Pending",
    });
    store.close();
    store = f.open(1_001);
    assert.equal(store.getConversationRequest(alice, "request-2")?.turn.status, "interrupted");
    assert.throws(
      () =>
        store.completeConversationTurn(alice, {
          conversationId: begun.conversation.id,
          turnId: pending.turn.id,
          requestId: "request-2",
          result: { reply: "late", actions: [], recordIds: [], taskIds: [], evidence: [] },
        }),
      /cannot be replayed/,
    );
    const summary = store.personalSummary(alice);
    assert.equal(summary.conversations, 1);
    assert.equal(summary.conversationTurns, 2);
    assert.ok(
      store
        .exportPersonalPage(alice, { expectedGeneration: summary.generation, limit: 100 })
        .items.some((item) => item.type === "conversation-turn"),
    );
    for (let index = 3; index <= 200; index += 1) {
      const added = store.beginConversationTurn(alice, {
        scope: { type: "user", id: "alice" },
        conversationId: begun.conversation.id,
        requestId: `request-${index}`,
        chatEpoch: 1,
        message: "retained",
      });
      store.interruptConversationTurn(alice, {
        conversationId: begun.conversation.id,
        turnId: added.turn.id,
        requestId: `request-${index}`,
      });
    }
    assert.throws(
      () =>
        store.beginConversationTurn(alice, {
          scope: { type: "user", id: "alice" },
          conversationId: begun.conversation.id,
          requestId: "request-201",
          chatEpoch: 1,
          message: "must not prune replay protection",
        }),
      /retained turn limit/,
    );
    assert.equal(
      store.beginConversationTurn(alice, {
        scope: { type: "user", id: "alice" },
        conversationId: begun.conversation.id,
        requestId: "request-1",
        chatEpoch: 1,
        message: "What are the plans?",
      }).status,
      "completed",
    );
    const current = store.getConversation(alice, begun.conversation.id).conversation;
    store.deleteConversation(alice, begun.conversation.id, current.revision);
    assert.equal(store.personalSummary(alice).conversations, 0);
    assert.throws(
      () =>
        store.beginConversationTurn(alice, {
          scope: { type: "user", id: "alice" },
          requestId: "request-1",
          chatEpoch: 1,
          message: "What are the plans?",
        }),
      /cannot be replayed/,
    );
    store.deletePersonal(alice, { preserveMemberships: true });
    assert.equal(store.chatEpoch(alice), 2);
    assert.throws(
      () =>
        store.beginConversationTurn(alice, {
          scope: { type: "user", id: "alice" },
          requestId: "request-after-reset",
          chatEpoch: 1,
          message: "old page",
        }),
      /refresh/,
    );
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("revoked group conversation contexts stay private and reset still deletes them", async () => {
  const f = await fixture();
  try {
    const store = f.open();
    store.createGroup(alice, { id: "chat-group", name: "Chat group" });
    store.setGroupMember(alice, "chat-group", { userId: "bob", role: "member" });
    const begun = store.beginConversationTurn(bob, {
      scope: { type: "group", id: "chat-group" },
      requestId: "group-request",
      chatEpoch: 1,
      message: "private transcript in shared context",
    });
    store.interruptConversationTurn(bob, {
      conversationId: begun.conversation.id,
      turnId: begun.turn.id,
      requestId: "group-request",
    });
    const reminder = store.createRecord(bob, {
      kind: "reminder",
      title: "Shared reminder",
      scope: { type: "group", id: "chat-group" },
      data: { dueAt: 90_000_000, completed: false, taskId: "old-task" },
    });
    store.beginReminderReschedule(bob, {
      operationId: "shared-reschedule",
      scope: reminder.scope,
      recordId: reminder.id,
      expectedRevision: reminder.revision,
      replacesTaskId: "old-task",
    });
    store.markReminderReschedulePrepared(bob, "shared-reschedule", {
      replacementTaskId: "new-task",
      dueAt: 91_000_000,
    });
    assert.throws(() => store.getConversation(alice, begun.conversation.id), LifeAccessError);
    store.setGroupMember(alice, "chat-group", { userId: "bob", remove: true });
    assert.throws(() => store.getConversation(bob, begun.conversation.id), LifeAccessError);
    assert.equal(store.exportPersonalPage(bob).items.length, 0);
    assert.equal(store.personalSummary(bob).conversations, 1);
    assert.throws(
      () => store.deletePersonal(bob, { preserveMemberships: true }),
      /reschedules must be recovered/,
    );
    store.interruptReminderReschedule(bob, "shared-reschedule");
    store.deletePersonal(bob, { preserveMemberships: true });
    assert.equal(store.personalSummary(bob).conversations, 0);
    assert.equal(store.chatEpoch(bob), 2);
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("pending intents bind direct turns, fill only missing fields, persist and never replay executing work", async () => {
  const f = await fixture();
  try {
    let store = f.open(1_000);
    const origin = store.beginConversationTurn(alice, {
      scope: { type: "user", id: "alice" },
      requestId: "clarify-origin",
      chatEpoch: 1,
      message: "Remind me to call Mum",
    });
    store.completeConversationTurn(alice, {
      conversationId: origin.conversation.id,
      turnId: origin.turn.id,
      requestId: "clarify-origin",
      result: {
        reply: "When should I remind you?",
        actions: [],
        recordIds: [],
        taskIds: [],
        evidence: [],
      },
    });
    const pending = store.createPendingIntent(alice, {
      conversationId: origin.conversation.id,
      scope: { type: "user", id: "alice" },
      chatEpoch: 1,
      originTurnId: origin.turn.id,
      originRequestId: "clarify-origin",
      intent: { kind: "schedule-reminder", title: "Call Mum" },
      missing: ["when"],
      question: "When should I remind you?",
      contextFingerprint: origin.contextFingerprint,
    });
    assert.equal(pending.expiresAt, 1_000 + 24 * 60 * 60_000);
    store.close();
    store = f.open(2_000);
    assert.equal(store.getPendingIntent(alice, origin.conversation.id)?.state, "awaiting-fields");
    const answerTurn = store.beginConversationTurn(alice, {
      scope: { type: "user", id: "alice" },
      conversationId: origin.conversation.id,
      requestId: "clarify-answer",
      chatEpoch: 1,
      message: "Tomorrow at 10",
    });
    assert.throws(
      () =>
        store.answerPendingIntent(alice, {
          id: pending.id,
          expectedRevision: pending.revision,
          answerTurnId: answerTurn.turn.id,
          answerRequestId: "clarify-answer",
          answer: { budget: 5 } as never,
        }),
      /undeclared/,
    );
    const answered = store.answerPendingIntent(alice, {
      id: pending.id,
      expectedRevision: pending.revision,
      answerTurnId: answerTurn.turn.id,
      answerRequestId: "clarify-answer",
      answer: { when: { type: "instant", at: 90_000_000 } },
    });
    assert.deepEqual(answered.missing, []);
    const executing = store.claimPendingIntent(alice, answered.id, answered.revision);
    assert.equal(executing.state, "executing");
    store.close();
    store = f.open(3_000);
    assert.equal(store.getPendingIntent(alice, origin.conversation.id)?.state, "interrupted");
    assert.throws(
      () => store.claimPendingIntent(alice, executing.id, executing.revision),
      /not ready/,
    );
    const newerOrigin = store.beginConversationTurn(alice, {
      scope: { type: "user", id: "alice" },
      conversationId: origin.conversation.id,
      requestId: "newer-origin",
      chatEpoch: 1,
      message: "Remind me to check the door",
    });
    store.completeConversationTurn(alice, {
      conversationId: origin.conversation.id,
      turnId: newerOrigin.turn.id,
      requestId: "newer-origin",
      result: {
        reply: "When?",
        actions: [],
        recordIds: [],
        taskIds: [],
        evidence: [],
      },
    });
    const newerInput = {
      conversationId: origin.conversation.id,
      scope: { type: "user" as const, id: "alice" },
      chatEpoch: 1,
      originTurnId: newerOrigin.turn.id,
      originRequestId: "newer-origin",
      intent: { kind: "schedule-reminder" as const, title: "Check the door" },
      missing: ["when" as const],
      question: "When?",
      contextFingerprint: newerOrigin.contextFingerprint,
    };
    const newer = store.createPendingIntent(alice, newerInput);
    assert.equal(store.createPendingIntent(alice, newerInput).id, newer.id);
    store.cancelPendingIntent(alice, newer.id, newer.revision);
    assert.equal(
      store.getPendingIntent(alice, origin.conversation.id)?.state,
      "cancelled",
      "an older interrupted draft must not resurface",
    );
    assert.ok(
      store
        .exportPersonalPage(alice, { limit: 100 })
        .items.some((item) => item.type === "pending-intent"),
    );
    store.deletePersonal(alice, { preserveMemberships: true });
    assert.equal(store.personalSummary(alice).pendingIntents, 0);
    store.close();
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("groups are revisioned and conversation preferences remain actor-private", async () => {
  const f = await fixture();
  let store = f.open(10_000);
  try {
    const group = store.createGroup(alice, { id: "family", name: "Family" });
    assert.equal(group.revision, 1);
    store.setGroupMember(alice, group.id, { userId: "bob", role: "member" });
    assert.throws(() => store.renameGroup(bob, group.id, 1, "Other"), LifeAccessError);
    store.recordFeedback(bob, {
      scope: { type: "group", id: group.id },
      message: "Please be brief",
      explicitPreference: { key: "verbosity", value: "brief" },
      preferenceLevel: "user",
    });
    assert.equal(store.resolveSettings(bob).values.verbosity, "brief");
    assert.equal(store.resolveSettings(alice, { groupId: group.id }).values.verbosity, undefined);
    const renamed = store.renameGroup(alice, group.id, 1, "Our family");
    assert.equal(renamed.revision, 2);
    assert.throws(() => store.renameGroup(alice, group.id, 1, "Stale"), LifeConflictError);
    for (let index = 1; index < 32; index++)
      store.createGroup(alice, { id: `group-${index}`, name: `Group ${index}` });
    assert.throws(
      () => store.createGroup(alice, { id: "group-33", name: "Too many" }),
      /at most 32/,
    );

    const begun = store.beginConversationTurn(alice, {
      scope: { type: "group", id: group.id },
      requestId: "style-1",
      chatEpoch: 1,
      message: "In this conversation, be brief",
    });
    assert.throws(
      () =>
        store.updateConversationPreferences(alice, {
          conversationId: begun.conversation.id,
          expectedRevision: 0,
          set: { tone: ["warm"] } as never,
          chatEpoch: 1,
          contextFingerprint: begun.contextFingerprint,
          originTurnId: begun.turn.id,
          originRequestId: "style-1",
        }),
      /tone is invalid/,
    );
    const completed = store.completeConversationTurn(alice, {
      conversationId: begun.conversation.id,
      turnId: begun.turn.id,
      requestId: "style-1",
      result: { reply: "Okay.", actions: [], recordIds: [], taskIds: [], evidence: [] },
      preferenceUpdate: {
        expectedRevision: 0,
        set: { verbosity: "brief" },
        chatEpoch: 1,
        contextFingerprint: begun.contextFingerprint,
      },
    });
    assert.deepEqual(store.getConversationPreferences(alice, begun.conversation.id), {
      preferences: { verbosity: "brief" },
      revision: 1,
    });
    assert.throws(
      () => store.getConversationPreferences(bob, begun.conversation.id),
      LifeAccessError,
    );
    assert.equal(
      store.completeConversationTurn(alice, {
        conversationId: begun.conversation.id,
        turnId: begun.turn.id,
        requestId: "style-1",
        result: completed.result,
      }).turn.id,
      begun.turn.id,
      "a duplicate receipt must not apply the preference twice",
    );
    store.close();
    store = f.open(11_000);
    assert.equal(store.listGroups(alice).find((item) => item.id === group.id)?.name, "Our family");
    assert.equal(
      store.getConversationPreferences(alice, begun.conversation.id).preferences.verbosity,
      "brief",
    );
    assert.ok(
      store
        .exportPersonalPage(alice, { limit: 100 })
        .items.some((item) => item.type === "conversation-preferences"),
    );
    store.deleteConversation(alice, begun.conversation.id, completed.conversation.revision);
    assert.throws(() => store.getConversationPreferences(alice, begun.conversation.id));
  } finally {
    try {
      store.close();
    } catch {}
    await rm(f.dir, { recursive: true, force: true });
  }
});
