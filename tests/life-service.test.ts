import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { ProactivityEngine } from "../packages/life-context/src/index.ts";
import { PluginStore } from "../packages/life-plugins/src/index.ts";
import type { LifePlugin } from "../packages/life-plugins/src/index.ts";
import type { OwnerScope, TaskRecord, TaskRuntime } from "../packages/task-runtime/src/index.ts";
import { createLifeServer, type LifeHarnessLike } from "../apps/life/src/server.ts";
import { createLifeApplication } from "../apps/life/src/main.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ellie-life-service-"));
  await chmod(root, 0o700);
  const assets = join(root, "assets");
  await mkdir(assets, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Ellie Life</title>", {
    mode: 0o600,
  });
  let now = 1_800_000_000_000;
  const life = new LifeStore(join(root, "life.sqlite"), { now: () => now });
  const plugins = new PluginStore(join(root, "plugins.sqlite"), () => now);
  const context = new ProactivityEngine(life, () => now);
  const activeServers = new Set<ReturnType<typeof createLifeServer>>();
  const taskRows = new Map<string, TaskRecord>();
  const cancelledTasks = new Set<string>();
  const tasks = {
    get: (id: string, owner?: OwnerScope) => {
      const task = taskRows.get(id);
      return task && (!owner || task.owner === owner) ? task : undefined;
    },
    list: ({ owner }: { owner: OwnerScope }) =>
      [...taskRows.values()].filter((task) => task.owner === owner),
    pause: () => false,
    resume: () => false,
    cancel: (id: string) => {
      cancelledTasks.add(id);
      return true;
    },
    runNow: async () => {},
  } as unknown as TaskRuntime;
  const harness: LifeHarnessLike = {
    async chat(input) {
      return {
        reply: `Heard: ${input.message}`,
        conversationId: input.conversationId ?? "conversation-1",
        actions: [],
      };
    },
    async buildPlugin(input): Promise<LifePlugin> {
      return plugins.install(`${input.scope.type}:${input.scope.id}`, {
        name: "Generated",
        description: input.request,
        kind: "custom",
        capabilities: ["storage"],
        html: "<!doctype html><script>parent.postMessage('ready','*')</script>",
      });
    },
  };
  const start = async (
    token = "a".repeat(43),
    userId = "local",
    overrides: Partial<Parameters<typeof createLifeServer>[0]> = {},
  ) => {
    const server = createLifeServer({
      stateDir: root,
      assetsDir: assets,
      store: life,
      plugins,
      tasks,
      harness,
      context,
      port: 0,
      token,
      userId,
      now: () => now,
      extractor: async ({ filename }) => ({
        text: `Extracted ${filename}`,
        metadata: { pages: 1 },
      }),
      ...overrides,
    });
    activeServers.add(server);
    const listening = await server.listen();
    return { server, ...listening };
  };
  return {
    root,
    life,
    plugins,
    tasks,
    taskRows,
    cancelledTasks,
    harness,
    start,
    setNow: (value: number) => {
      now = value;
    },
    close: async () => {
      await Promise.all([...activeServers].map((server) => server.close()));
      plugins.close();
      life.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function authenticate(url: string, token: string): Promise<string> {
  const response = await fetch(`${url}/api/life/session`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(response.status, 204);
  const header = response.headers.get("set-cookie")!;
  assert.match(header, /HttpOnly/i);
  assert.match(header, /SameSite=Strict/i);
  assert.match(header, /Path=\//i);
  assert.doesNotMatch(header, /;\s*Secure/i);
  return header.split(";", 1)[0]!;
}
const jsonHeaders = (url: string, cookie?: string) => ({
  origin: url,
  "content-type": "application/json",
  ...(cookie ? { cookie } : {}),
});
async function requestWithHost(port: number, host: string, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port, path: "/api/life/bootstrap", headers: { host, cookie } },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("fragment token exchanges once for a protected strict session", async () => {
  const f = await fixture();
  try {
    const token = "t".repeat(43),
      running = await f.start(token);
    assert.equal(running.launchUrl, `${running.url}/#token=${token}`);
    assert.equal((await fetch(`${running.url}/api/life/bootstrap`)).status, 401);
    assert.equal(
      (
        await fetch(`${running.url}/api/life/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        })
      ).status,
      403,
    );
    const cookie = await authenticate(running.url, token);
    assert.match(cookie, /^ellie_life_session=/);
    assert.equal(
      (
        await fetch(`${running.url}/api/life/session`, {
          method: "POST",
          headers: jsonHeaders(running.url),
          body: JSON.stringify({ token }),
        })
      ).status,
      401,
    );
    const bootstrap = await fetch(`${running.url}/api/life/bootstrap`, { headers: { cookie } });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.headers.get("access-control-allow-origin"), null);
    assert.equal(bootstrap.headers.get("x-content-type-options"), "nosniff");
    const page = await fetch(running.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /default-src 'self'/);
    await running.server.close();
  } finally {
    await f.close();
  }
});

test("record CRUD, settings and sources persist through a server restart", async () => {
  const f = await fixture();
  try {
    let running = await f.start("1".repeat(43)),
      cookie = await authenticate(running.url, "1".repeat(43));
    const create = await fetch(`${running.url}/api/life/records`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({
        kind: "birthday",
        title: "Ada birthday",
        scope: { type: "user", id: "local" },
        data: { month: 12, day: 10 },
      }),
    });
    assert.equal(create.status, 201);
    const record = (await create.json()) as { id: string; revision: number; createdAt: string };
    assert.match(record.createdAt, /^\d{4}-/);
    const patch = await fetch(`${running.url}/api/life/records/${record.id}`, {
      method: "PATCH",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ expectedRevision: record.revision, data: { month: 12, day: 11 } }),
    });
    assert.equal(patch.status, 200);
    assert.equal(
      (
        await fetch(`${running.url}/api/life/settings`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({ scope: "user:local", values: { voice: "short" } }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${running.url}/api/life/settings`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({
            scope: "user:local",
            values: { voice: "long", "permissions.files": true },
          }),
        })
      ).status,
      403,
    );
    const source = await fetch(`${running.url}/api/life/sources`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({
        filename: "notes.md",
        mimeType: "text/markdown",
        scope: "user:local",
        content: "Orchids like indirect light.",
      }),
    });
    assert.equal(source.status, 201);
    const extracted = await fetch(`${running.url}/api/life/sources`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({
        filename: "scan.pdf",
        mimeType: "application/pdf",
        scope: "user:local",
        encoding: "base64",
        content: Buffer.from("synthetic").toString("base64"),
      }),
    });
    assert.equal(extracted.status, 201);
    await running.server.close();
    running = await f.start("2".repeat(43));
    cookie = await authenticate(running.url, "2".repeat(43));
    const bootstrap = (await (
      await fetch(`${running.url}/api/life/bootstrap`, { headers: { cookie } })
    ).json()) as {
      records: Array<{ id: string; data: Record<string, unknown> }>;
      settings: { values: Record<string, unknown> };
    };
    assert.equal(bootstrap.records.find((item) => item.id === record.id)?.data.day, 11);
    assert.equal(bootstrap.settings.values.voice, "short");
    assert.equal(
      bootstrap.records.some((item) => item.data.format === "markdown"),
      true,
    );
    f.taskRows.set("linked-task", {
      id: "linked-task",
      owner: "user:local",
      handler: "reminder.notify",
      input: { recordId: record.id },
      state: "scheduled",
      requiredCapabilities: [],
      allowedCapabilities: [],
      rootId: "linked-task",
      dependsOn: [],
      budget: {},
      attempt: 0,
      idempotencyKey: "linked-task:0",
      createdAt: 1,
      updatedAt: 1,
    });
    assert.equal(
      (
        await fetch(`${running.url}/api/life/records/${record.id}?revision=2`, {
          method: "DELETE",
          headers: { origin: running.url, cookie },
        })
      ).status,
      204,
    );
    assert.equal(f.cancelledTasks.has("linked-task"), true);
    await running.server.close();
  } finally {
    await f.close();
  }
});

test("group and plugin lookup cannot bypass authorized owners", async () => {
  const f = await fixture();
  try {
    f.life.createGroup({ userId: "other" }, { id: "secret", name: "Secret" });
    const hidden = f.plugins.install("group:secret", {
      name: "Hidden",
      description: "private",
      kind: "custom",
      capabilities: ["storage"],
      html: "<h1>hidden</h1>",
    });
    let running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43));
    assert.equal(await requestWithHost(running.port, "evil.invalid", cookie), 400);
    assert.equal(
      (await fetch(`${running.url}/api/life/bootstrap?scope=group:secret`, { headers: { cookie } }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(`${running.url}/api/life/plugins/${hidden.id}/view`, { headers: { cookie } }))
        .status,
      404,
    );
    const groupResponse = await fetch(`${running.url}/api/life/groups`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ id: "home", name: "Home" }),
    });
    assert.equal(groupResponse.status, 201);
    const build = await fetch(`${running.url}/api/life/plugins/build`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ request: "build an arcade", scope: "group:home" }),
    });
    assert.equal(build.status, 201);
    const plugin = (await build.json()) as { id: string };
    const view = await fetch(`${running.url}/api/life/plugins/${plugin.id}/view`, {
      headers: { cookie },
    });
    assert.equal(view.status, 200);
    assert.match(view.headers.get("content-security-policy")!, /sandbox allow-scripts/);
    assert.match(view.headers.get("content-security-policy")!, /connect-src 'none'/);
    const viewHtml = await view.text();
    assert.match(viewHtml, /document\.createElement\('iframe'\)/);
    assert.match(viewHtml, /frame\.sandbox='allow-scripts'/);
    assert.doesNotMatch(viewHtml, /<iframe[^>]*srcdoc=/);
    const set = await fetch(`${running.url}/api/life/plugins/${plugin.id}/action`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ action: "storage.set", payload: { key: "highScore", value: 42 } }),
    });
    assert.equal(set.status, 200);
    assert.equal(f.plugins.storageGet("group:home", plugin.id, "user:local:highScore"), 42);
    f.life.setGroupMember({ userId: "local" }, "home", { userId: "bob", role: "member" });
    await running.server.close();
    running = await f.start("b".repeat(43), "bob");
    cookie = await authenticate(running.url, "b".repeat(43));
    const bobBootstrap = (await (
      await fetch(`${running.url}/api/life/bootstrap?scope=group:home`, { headers: { cookie } })
    ).json()) as { plugins: Array<{ id: string; data: { highScore: number } }> };
    assert.equal(bobBootstrap.plugins.find((item) => item.id === plugin.id)?.data.highScore, 0);
    assert.equal(
      (
        await fetch(`${running.url}/api/life/plugins/${plugin.id}/action`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({ action: "storage.set", payload: { key: "highScore", value: 7 } }),
        })
      ).status,
      200,
    );
    await running.server.close();
    running = await f.start("c".repeat(43));
    cookie = await authenticate(running.url, "c".repeat(43));
    const localBootstrap = (await (
      await fetch(`${running.url}/api/life/bootstrap?scope=group:home`, { headers: { cookie } })
    ).json()) as { plugins: Array<{ id: string; data: { highScore: number } }> };
    assert.equal(localBootstrap.plugins.find((item) => item.id === plugin.id)?.data.highScore, 42);
    f.plugins.update("group:home", plugin.id, 1, {
      name: "Star arcade",
      description: "Version two",
      kind: "arcade",
      capabilities: ["storage"],
    });
    const rollback = await fetch(`${running.url}/api/life/plugins/${plugin.id}/rollback`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ expectedVersion: 2, targetVersion: 1 }),
    });
    assert.equal(rollback.status, 200);
    assert.equal(((await rollback.json()) as { version: string }).version, "3");
    assert.equal(
      (
        await fetch(`${running.url}/api/life/plugins/${plugin.id}/revise`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({ expectedVersion: 3, request: "change it" }),
        })
      ).status,
      503,
    );
    assert.equal(
      (
        await fetch(`${running.url}/api/life/plugins/${plugin.id}`, {
          method: "DELETE",
          headers: { origin: running.url, cookie },
        })
      ).status,
      204,
    );
    await running.server.close();
  } finally {
    await f.close();
  }
});

test("application factory assembles isolated stores and reports readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-life-app-"));
  await chmod(root, 0o700);
  const assets = join(root, "assets");
  await mkdir(assets, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Ready</title>", {
    mode: 0o600,
  });
  const application = await createLifeApplication({
    stateDir: join(root, "state"),
    assetsDir: assets,
    port: 0,
  });
  try {
    const ready = await application.listen();
    assert.match(ready.launchUrl, /^http:\/\/127\.0\.0\.1:\d+\/#token=/);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit context signals create scoped notifications without retaining raw location", async () => {
  const f = await fixture();
  try {
    f.life.createRecord(
      { userId: "local" },
      {
        kind: "need",
        title: "Coffee filters",
        scope: { type: "user", id: "local" },
        data: { stores: ["Market"] },
      },
    );
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43)),
      response = await fetch(`${running.url}/api/life/signals`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({
          scope: "user:local",
          signal: { type: "shopping", store: "Market", at: 1_800_000_000_000 },
        }),
      });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { suggestions: unknown[] }).suggestions.length, 1);
    const bootstrap = (await (
      await fetch(`${running.url}/api/life/bootstrap`, { headers: { cookie } })
    ).json()) as { notifications: Array<{ title: string }> };
    assert.equal(
      bootstrap.notifications.some((item) => item.title === "Coffee filters"),
      true,
    );
    assert.equal(
      JSON.stringify(f.life.exportPersonal({ userId: "local" })).includes("latitude"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("calendar import previews original content and commits selected items idempotently", async () => {
  const f = await fixture();
  try {
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43)),
      content = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:one@example.test",
        "SUMMARY:Review",
        "DTSTART:20270102T170000Z",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:two@example.test",
        "SUMMARY:Dinner",
        "DTSTART:20270102T190000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
      request = { scope: "user:local", format: "ics", content, fileName: "plans.ics" },
      previewResponse = await fetch(`${running.url}/api/life/import/preview`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify(request),
      });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as { items: Array<{ key: string }> };
    assert.equal(preview.items.length, 2);
    const commit = async () =>
      fetch(`${running.url}/api/life/import/commit`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({ ...request, selectedKeys: [preview.items[0]!.key] }),
      });
    const first = await commit();
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { created: number; records: unknown[] }).created, 1);
    const second = await commit();
    assert.equal(second.status, 200);
    const repeated = (await second.json()) as { unchanged: number; records: unknown[] };
    assert.equal(repeated.unchanged, 1);
    assert.equal(repeated.records.length, 1);
  } finally {
    await f.close();
  }
});

test("notification completion closes its linked reminder and cancels delivery work", async () => {
  const f = await fixture();
  try {
    const actor = { userId: "local" },
      scope = { type: "user" as const, id: "local" },
      reminder = f.life.createRecord(actor, {
        kind: "reminder",
        title: "Bring the form",
        scope,
        data: { completed: false },
      }),
      notification = f.life.createRecord(actor, {
        kind: "event",
        title: "Notification: Bring the form",
        scope,
        data: { type: "notification", reminderId: reminder.id, deliveredAt: 1 },
        relationships: [{ type: "reminder", targetId: reminder.id }],
      });
    f.taskRows.set("delivery", {
      id: "delivery",
      owner: "user:local",
      handler: "reminder.notify",
      input: { recordId: reminder.id },
      state: "scheduled",
      requiredCapabilities: [],
      allowedCapabilities: [],
      rootId: "delivery",
      dependsOn: [],
      budget: {},
      attempt: 0,
      idempotencyKey: "delivery:0",
      createdAt: 1,
      updatedAt: 1,
    });
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43)),
      before = (await (
        await fetch(`${running.url}/api/life/bootstrap`, { headers: { cookie } })
      ).json()) as { notifications: Array<{ id: string; revision: number }> };
    assert.equal(before.notifications.find((item) => item.id === notification.id)?.revision, 1);
    const completed = await fetch(
      `${running.url}/api/life/notifications/${notification.id}/complete`,
      {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    );
    assert.equal(completed.status, 200);
    assert.equal(f.life.getRecord(actor, reminder.id)?.data.completed, true);
    assert.equal(f.cancelledTasks.has("delivery"), true);
    const after = (await (
      await fetch(`${running.url}/api/life/bootstrap`, { headers: { cookie } })
    ).json()) as { notifications: Array<{ id: string }> };
    assert.equal(
      after.notifications.some((item) => item.id === notification.id),
      false,
    );
  } finally {
    await f.close();
  }
});

test("completing a need notification cancels tasks for related reminders", async () => {
  const f = await fixture();
  try {
    const actor = { userId: "local" },
      scope = { type: "user" as const, id: "local" },
      need = f.life.createRecord(actor, {
        kind: "need",
        title: "Coffee filters",
        scope,
        data: { completed: false },
      }),
      reminder = f.life.createRecord(actor, {
        kind: "reminder",
        title: "Buy coffee filters",
        scope,
        data: { completed: false },
        relationships: [{ type: "for-need", targetId: need.id }],
      }),
      notification = f.life.createRecord(actor, {
        kind: "feedback",
        title: need.title,
        scope,
        data: { notification: true, relatedRecordId: need.id, dismissed: false },
        relationships: [{ type: "suggestion-for", targetId: need.id }],
      });
    f.taskRows.set("need-delivery", {
      id: "need-delivery",
      owner: "user:local",
      handler: "reminder.notify",
      input: { recordId: reminder.id },
      state: "scheduled",
      requiredCapabilities: [],
      allowedCapabilities: [],
      rootId: "need-delivery",
      dependsOn: [],
      budget: {},
      attempt: 0,
      idempotencyKey: "need-delivery:0",
      createdAt: 1,
      updatedAt: 1,
    });
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43)),
      response = await fetch(`${running.url}/api/life/notifications/${notification.id}/complete`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({ expectedRevision: notification.revision }),
      });
    assert.equal(response.status, 200);
    assert.equal(f.cancelledTasks.has("need-delivery"), true);
  } finally {
    await f.close();
  }
});

test("learning feedback remains scoped and exports only explicitly selected personal examples", async () => {
  const f = await fixture();
  try {
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43)),
      created = await fetch(`${running.url}/api/life/learning`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({
          scope: "user:local",
          message: "Use the corrected answer.",
          rating: -1,
          example: {
            prompt: "When is dinner?",
            response: "At six.",
            preferredResponse: "At seven.",
          },
          trainingEligible: false,
        }),
      });
    assert.equal(created.status, 201);
    const feedback = (await created.json()) as { id: string; revision: number };
    const beforeSelection = await fetch(`${running.url}/api/life/learning/export`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ ids: [feedback.id] }),
    });
    assert.equal(beforeSelection.status, 403);
    const selected = await fetch(`${running.url}/api/life/learning/${feedback.id}/selection`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ expectedRevision: feedback.revision, selected: true }),
    });
    assert.equal(selected.status, 200);
    const listed = (await (
      await fetch(`${running.url}/api/life/learning?scope=user:local`, { headers: { cookie } })
    ).json()) as { records: Array<{ id: string; updatedAt: string }> };
    assert.equal(listed.records[0]?.id, feedback.id);
    assert.match(listed.records[0]?.updatedAt ?? "", /^\d{4}-/);
    const exported = await fetch(`${running.url}/api/life/learning/export`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ ids: [feedback.id] }),
    });
    assert.equal(exported.status, 200);
    const payload = (await exported.json()) as { format: string; count: number; jsonl: string };
    assert.equal(payload.format, "ellie-feedback-v1");
    assert.equal(payload.count, 1);
    assert.match(payload.jsonl, /"preferredOutput":"At seven\."/);
  } finally {
    await f.close();
  }
});

test("server close refuses to release stores while an HTTP handler remains active", async () => {
  const f = await fixture();
  let release!: () => void;
  let markEntered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    }),
    slowHarness: LifeHarnessLike = {
      async chat(input) {
        markEntered();
        await gate;
        f.life.createRecord(input.actor, {
          kind: "memory",
          title: "Slow request completed",
          scope: input.scope,
          data: {},
        });
        return { reply: "done", conversationId: "slow", actions: [] };
      },
    };
  try {
    const running = await f.start("a".repeat(43), "local", {
        harness: slowHarness,
        closeDrainMs: 20,
      }),
      cookie = await authenticate(running.url, "a".repeat(43)),
      request = fetch(`${running.url}/api/life/chat`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({ scope: "user:local", message: "wait" }),
      }).catch(() => undefined);
    await entered;
    await assert.rejects(running.server.close(), /requests are still active/);
    assert.equal(f.life.listRecords({ userId: "local" }, { limit: 10 }).length, 0);
    release();
    await request;
    assert.equal(
      f.life.listRecords({ userId: "local" }, { limit: 10 })[0]?.title,
      "Slow request completed",
    );
    await running.server.close();
  } finally {
    release();
    await f.close();
  }
});

test("MLB actions use the profile time zone when no setting exists", async () => {
  const f = await fixture();
  let requestedDate = "";
  try {
    f.setNow(Date.parse("2026-09-14T06:00:00Z"));
    const plugin = f.plugins.install("user:local", {
        name: "MLB",
        description: "Scores",
        kind: "mlb",
        capabilities: ["mlb.read"],
      }),
      running = await f.start("a".repeat(43), "local", {
        timeZone: "America/Los_Angeles",
        mlb: {
          async snapshot(date?: string) {
            requestedDate = date ?? "";
            return {};
          },
        },
      }),
      cookie = await authenticate(running.url, "a".repeat(43)),
      response = await fetch(`${running.url}/api/life/plugins/${plugin.id}/action`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({ action: "mlb.snapshot", payload: {} }),
      });
    assert.equal(response.status, 200);
    assert.equal(requestedDate, "2026-09-13");
  } finally {
    await f.close();
  }
});

test("malformed, cross-origin, oversized and hostile paths are rejected", async () => {
  const f = await fixture();
  try {
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43));
    assert.equal(
      (
        await fetch(`${running.url}/api/life/records`, {
          method: "POST",
          headers: {
            ...jsonHeaders("http://evil.invalid", cookie),
            host: `127.0.0.1:${running.port}`,
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${running.url}/api/life/records`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: "{",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${running.url}/api/life/records`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({ padding: "x".repeat(150_000) }),
        })
      ).status,
      413,
    );
    assert.equal((await fetch(`${running.url}/..%2f..%2fetc%2fpasswd`)).status, 404);
    const outside = join(f.root, "private.txt");
    await writeFile(outside, "must not escape", { mode: 0o600 });
    await symlink(outside, join(f.root, "assets/leak.txt"));
    assert.equal((await fetch(`${running.url}/leak.txt`)).status, 404);
    assert.equal(
      (
        await fetch(`${running.url}/api/life/sources`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({
            filename: "scan.pdf",
            mimeType: "application/pdf",
            scope: "user:local",
            content: "not-a-pdf",
          }),
        })
      ).status,
      415,
    );
    await running.server.close();
  } finally {
    await f.close();
  }
});
