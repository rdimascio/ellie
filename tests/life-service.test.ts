import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { ProactivityEngine } from "../packages/life-context/src/index.ts";
import { PluginStore, groupStorageKey } from "../packages/life-plugins/src/index.ts";
import type { LifePlugin } from "../packages/life-plugins/src/index.ts";
import {
  TaskRuntime,
  type OwnerScope,
  type TaskRecord,
} from "../packages/task-runtime/src/index.ts";
import { createLifeServer, type LifeHarnessLike } from "../apps/life/src/server.ts";
import { pluginChildDocument } from "../apps/life/src/plugin-bootstrap.ts";
import { PluginBuildError } from "../packages/life-harness/src/build.ts";
import { createLifeApplication } from "../apps/life/src/main.ts";

test("plugin child bootstrap installs a frozen storage SDK before custom HTML", () => {
  const marker = "<script>window.customSawEllie=window.ellie</script>",
    document = pluginChildDocument("plugin-1", marker);
  assert.ok(document.indexOf("Object.defineProperty(window,'ellie'") < document.indexOf(marker));
  assert.match(document, /Object\.freeze\(\{get:key=>send/);
  assert.match(document, /writable:false,configurable:false/);
  assert.match(document, /pending\.size>=32/);
  assert.match(document, /hasOwnProperty\.call\(item,'toJSON'\)/);
  assert.match(document, /Number\.isFinite/);
  assert.match(document, /byteLength>16384/);
  assert.match(document, /Storage request timed out\./);
  assert.match(document, /addEventListener\('pagehide',stop/);
  assert.match(document, /legacy\.port2/);
  assert.match(document, /addEventListener\('DOMContentLoaded'/);
  assert.match(document, /sendWindow\(\{type:'ellie:connect'/);
  assert.doesNotMatch(document, /\[upstream\.port2\]/);
});

test("group management is generated, revisioned and owner-only", async () => {
  const f = await fixture();
  try {
    let running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43));
    const suppliedId = await fetch(`${running.url}/api/life/groups`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ id: "chosen", name: "Family" }),
    });
    assert.equal(suppliedId.status, 400);
    const createdResponse = await fetch(`${running.url}/api/life/groups`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ name: "Family" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as {
      id: string;
      name: string;
      role: string;
      revision: number;
    };
    assert.equal(created.role, "owner");
    assert.equal(created.revision, 1);
    const renamed = await fetch(`${running.url}/api/life/groups/${created.id}`, {
      method: "PATCH",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ name: "Our family", expectedRevision: 1 }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { revision: number }).revision, 2);
    assert.equal(
      (
        await fetch(`${running.url}/api/life/groups/${created.id}`, {
          method: "PATCH",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({ name: "Stale", expectedRevision: 1 }),
        })
      ).status,
      409,
    );
    f.life.setGroupMember({ userId: "local" }, created.id, { userId: "bob", role: "member" });
    await running.server.close();
    running = await f.start("b".repeat(43), "bob");
    cookie = await authenticate(running.url, "b".repeat(43));
    const groups = (await (
      await fetch(`${running.url}/api/life/groups`, { headers: { cookie } })
    ).json()) as { groups: Array<{ name: string; role: string }> };
    assert.deepEqual(
      groups.groups.map(({ name, role }) => ({ name, role })),
      [{ name: "Our family", role: "member" }],
    );
    assert.equal(
      (
        await fetch(`${running.url}/api/life/groups/${created.id}`, {
          method: "PATCH",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({ name: "No", expectedRevision: 2 }),
        })
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("chat applies private conversation preferences once and restores them", async () => {
  const f = await fixture();
  try {
    f.harness.chat = async (input) => ({
      reply: "I’ll keep this conversation brief.",
      conversationId: input.conversationId!,
      actions: [],
      conversationPreferenceUpdate: {
        set: { verbosity: "brief" },
        expectedRevision: input.conversationPreferences!.revision,
      },
    });
    let running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43));
    const payload = {
      scope: "user:local",
      message: "In this conversation, be brief",
      requestId: "preference-once",
      chatEpoch: 1,
    };
    const response = await fetch(`${running.url}/api/life/chat`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    const saved = (await response.json()) as {
      conversationId: string;
      conversationPreferences: { preferences: { verbosity: string }; revision: number };
    };
    assert.deepEqual(saved.conversationPreferences, {
      preferences: { verbosity: "brief" },
      revision: 1,
    });
    const duplicate = await fetch(`${running.url}/api/life/chat`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify(payload),
    });
    assert.equal(
      ((await duplicate.json()) as { conversationPreferences: { revision: number } })
        .conversationPreferences.revision,
      1,
    );
    await running.server.close();
    running = await f.start("b".repeat(43));
    cookie = await authenticate(running.url, "b".repeat(43));
    const detail = (await (
      await fetch(`${running.url}/api/life/conversations/${saved.conversationId}`, {
        headers: { cookie },
      })
    ).json()) as { conversationPreferences: { preferences: { verbosity: string } } };
    assert.equal(detail.conversationPreferences.preferences.verbosity, "brief");
  } finally {
    await f.close();
  }
});

test("plugin builds expose actionable deadlines and abort during service shutdown", async () => {
  const f = await fixture();
  try {
    f.harness.buildPlugin = async () => {
      throw new PluginBuildError("timeout", "deadline");
    };
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43)),
      timedOut = await fetch(`${running.url}/api/life/plugins/build`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({ scope: "user:local", request: "make a custom journal" }),
      });
    assert.equal(timedOut.status, 504);
    assert.match(
      ((await timedOut.json()) as { error: string }).error,
      /local model took too long/i,
    );

    let aborted = false,
      enteredBuild!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredBuild = resolve;
    });
    f.harness.buildPlugin = (input) =>
      new Promise((_resolve, reject) => {
        enteredBuild();
        input.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new PluginBuildError("cancelled", "cancelled"));
          },
          { once: true },
        );
      });
    const pending = fetch(`${running.url}/api/life/plugins/build`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ scope: "user:local", request: "make another custom journal" }),
    }).catch(() => undefined);
    await entered;
    await running.server.close();
    await pending;
    assert.equal(aborted, true);
  } finally {
    await f.close();
  }
});

test("service shutdown aborts a conversational custom build without a late install", async () => {
  const f = await fixture();
  try {
    let enteredBuild!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredBuild = resolve;
    });
    f.harness.chat = (input) =>
      new Promise((_resolve, reject) => {
        enteredBuild();
        input.signal?.addEventListener(
          "abort",
          () => reject(new PluginBuildError("cancelled", "cancelled")),
          { once: true },
        );
      });
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43)),
      pending = fetch(`${running.url}/api/life/chat`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({
          scope: "user:local",
          message: "Build a custom journal",
          requestId: "chat-build-shutdown",
          chatEpoch: 1,
        }),
      }).catch(() => undefined);
    await entered;
    await running.server.close();
    await pending;
    assert.deepEqual(f.plugins.list("user:local"), []);
  } finally {
    await f.close();
  }
});

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
    list: ({ owner, parentId }: { owner: OwnerScope; parentId?: string }) =>
      [...taskRows.values()].filter(
        (task) => task.owner === owner && (parentId === undefined || task.parentId === parentId),
      ),
    deliveryOccurrences: (templateId: string, owner: OwnerScope) => {
      const children = [...taskRows.values()]
        .filter((task) => task.owner === owner && task.parentId === templateId)
        .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
      return {
        active: children.find(
          (task) =>
            !["succeeded", "failed", "cancelled", "expired", "unknown"].includes(task.state),
        ),
        latest: children[0],
      };
    },
    pause: () => false,
    resume: () => false,
    cancel: (id: string) => {
      cancelledTasks.add(id);
      return true;
    },
    runNow: async () => {},
    progress: () => [],
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
          body: JSON.stringify({
            scope: "user:local",
            values: { voice: "short", timeZone: "America/Los_Angeles" },
          }),
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
      profile: { timeZone: string };
    };
    assert.equal(bootstrap.records.find((item) => item.id === record.id)?.data.day, 11);
    assert.equal(bootstrap.settings.values.voice, "short");
    assert.equal(bootstrap.profile.timeZone, "America/Los_Angeles");
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

test("bootstrap stays compact while record detail and search remain scoped", async () => {
  const f = await fixture();
  try {
    const source = f.life.ingestSource(
      { userId: "local" },
      {
        title: "Large notes",
        scope: { type: "user", id: "local" },
        format: "text",
        content: `orchid-evidence ${"x".repeat(1_200_000)} private-tail-marker`,
        metadata: { filename: "large.txt", mimeType: "text/plain", internal: "omit" },
      },
    );
    const other = f.life.createRecord(
      { userId: "other" },
      {
        kind: "memory",
        title: "Other person's record",
        scope: { type: "user", id: "other" },
        data: {},
      },
    );
    for (let index = 0; index < 101; index++)
      f.life.createRecord(
        { userId: "local" },
        {
          kind: "memory",
          title: `Paged memory ${index}`,
          scope: { type: "user", id: "local" },
          data: {},
        },
      );
    f.setNow(1_800_000_000_001);
    f.life.updateSource({ userId: "local" }, source.id, source.revision, {
      content: source.body!,
    });
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43)),
      bootstrapResponse = await fetch(`${running.url}/api/life/bootstrap`, {
        headers: { cookie },
      }),
      bootstrapText = await bootstrapResponse.text();
    assert.equal(bootstrapResponse.status, 200);
    assert.ok(Buffer.byteLength(bootstrapText) < 100_000);
    assert.doesNotMatch(bootstrapText, /private-tail-marker/);
    const bootstrap = JSON.parse(bootstrapText) as {
      records: Array<{
        id: string;
        bodyPreview?: string;
        hasMoreBody: boolean;
        data: { metadata?: Record<string, unknown> };
      }>;
      recordsPage: { hasMore: boolean; nextCursor?: string };
    };
    const summary = bootstrap.records.find((record) => record.id === source.id);
    assert.equal(summary?.bodyPreview?.length, 240);
    assert.equal(summary?.hasMoreBody, true);
    assert.deepEqual(summary?.data.metadata, {
      filename: "large.txt",
      mimeType: "text/plain",
    });
    assert.equal(bootstrap.records.length, 100);
    assert.equal(bootstrap.recordsPage.hasMore, true);
    const nextPage = (await (
      await fetch(
        `${running.url}/api/life/records?scope=user:local&limit=100&cursor=${encodeURIComponent(bootstrap.recordsPage.nextCursor!)}`,
        { headers: { cookie } },
      )
    ).json()) as { records: Array<{ id: string }>; page: { hasMore: boolean } };
    assert.equal(nextPage.records.length, 2);
    assert.equal(nextPage.page.hasMore, false);
    assert.equal(
      new Set([...bootstrap.records, ...nextPage.records].map((record) => record.id)).size,
      102,
    );
    const detail = (await (
      await fetch(`${running.url}/api/life/records/${source.id}`, { headers: { cookie } })
    ).json()) as { body: string };
    assert.match(detail.body, /private-tail-marker$/);
    const search = (await (
      await fetch(`${running.url}/api/life/search?scope=user:local&q=orchid-evidence`, {
        headers: { cookie },
      })
    ).json()) as { results: Array<{ sourceId: string; text: string }> };
    assert.equal(search.results[0]?.sourceId, source.id);
    assert.match(search.results[0]?.text ?? "", /orchid-evidence/);
    assert.equal(
      (
        await fetch(`${running.url}/api/life/search?scope=user:other&q=orchid-evidence`, {
          headers: { cookie },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${running.url}/api/life/records/${other.id}`, { headers: { cookie } })).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("source growth cannot crowd commitments or notifications out of bootstrap", async () => {
  const f = await fixture();
  try {
    const actor = { userId: "local" },
      scope = { type: "user" as const, id: "local" },
      appointment = f.life.createRecord(actor, {
        kind: "event",
        title: "Older appointment",
        scope,
        data: { startAt: 1_900_000_000_000 },
      }),
      notification = f.life.createRecord(actor, {
        kind: "feedback",
        title: "Older notification",
        scope,
        body: "Still actionable",
        data: {
          notification: true,
          relatedRecordId: appointment.id,
          dismissed: false,
        },
      });
    f.setNow(1_800_000_000_001);
    for (let index = 0; index < 101; index++)
      f.life.ingestSource(actor, {
        title: `New source ${index}`,
        scope,
        format: "text",
        content: `Source ${index}`,
      });
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43)),
      bootstrap = (await (
        await fetch(`${running.url}/api/life/bootstrap`, { headers: { cookie } })
      ).json()) as {
        records: Array<{ id: string }>;
        recordsPage: { hasMore: boolean };
        agendaRecords: Array<{ id: string }>;
        agendaPage: { hasMore: boolean; nextCursor?: string };
        notifications: Array<{ id: string }>;
      };
    assert.equal(
      bootstrap.records.some((record) => record.id === appointment.id),
      false,
    );
    assert.equal(bootstrap.recordsPage.hasMore, true);
    assert.equal(
      bootstrap.agendaRecords.some((record) => record.id === appointment.id),
      true,
    );
    assert.equal(bootstrap.agendaPage.hasMore, false);
    assert.equal(
      bootstrap.notifications.some((record) => record.id === notification.id),
      true,
    );
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
      body: JSON.stringify({ name: "Home" }),
    });
    assert.equal(groupResponse.status, 201);
    const groupId = ((await groupResponse.json()) as { id: string }).id;
    const build = await fetch(`${running.url}/api/life/plugins/build`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ request: "build an arcade", scope: `group:${groupId}` }),
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
    assert.equal(
      f.plugins.storageGet(`group:${groupId}`, plugin.id, groupStorageKey("local", "highScore")),
      42,
    );
    f.life.setGroupMember({ userId: "local" }, groupId, { userId: "bob", role: "member" });
    await running.server.close();
    running = await f.start("b".repeat(43), "bob");
    cookie = await authenticate(running.url, "b".repeat(43));
    const bobBootstrap = (await (
      await fetch(`${running.url}/api/life/bootstrap?scope=group:${groupId}`, {
        headers: { cookie },
      })
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
    f.life.setGroupSetting({ userId: "local" }, groupId, "timeZone", "America/New_York");
    f.life.setUserSetting({ userId: "local" }, "timeZone", "America/Los_Angeles");
    const localBootstrap = (await (
      await fetch(`${running.url}/api/life/bootstrap?scope=group:${groupId}`, {
        headers: { cookie },
      })
    ).json()) as {
      profile: { timeZone: string };
      plugins: Array<{ id: string; data: { highScore: number } }>;
    };
    assert.equal(localBootstrap.plugins.find((item) => item.id === plugin.id)?.data.highScore, 42);
    assert.equal(localBootstrap.profile.timeZone, "America/Los_Angeles");
    f.plugins.update(`group:${groupId}`, plugin.id, 1, {
      name: "Star arcade",
      description: "Version two",
      kind: "arcade",
      capabilities: ["storage"],
    });
    const historyResponse = await fetch(`${running.url}/api/life/plugins/${plugin.id}/history`, {
      headers: { cookie },
    });
    assert.equal(historyResponse.status, 200);
    const history = (await historyResponse.json()) as {
      revisions: Array<{ version: number; active: boolean; capabilities: string[] }>;
    };
    assert.deepEqual(
      history.revisions.map(({ version, active }) => ({ version, active })),
      [
        { version: 2, active: true },
        { version: 1, active: false },
      ],
    );
    assert.deepEqual(history.revisions[0]?.capabilities, ["storage"]);
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

test("bootstrap rechecks group membership after an awaited provider read", async () => {
  const f = await fixture();
  let markProviderStarted!: () => void;
  let finish = () => {};
  const providerStarted = new Promise<void>((resolve) => {
    markProviderStarted = resolve;
  });
  try {
    f.life.createGroup({ userId: "local" }, { id: "shared", name: "Shared" });
    f.life.setGroupMember({ userId: "local" }, "shared", { userId: "bob", role: "member" });
    f.plugins.install("group:shared", {
      name: "MLB",
      description: "Delayed scores",
      kind: "mlb",
      capabilities: ["mlb.read"],
    });
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
      }),
      running = await f.start("b".repeat(43), "bob", {
        mlb: {
          async snapshot() {
            markProviderStarted();
            await gate;
            return { games: [] };
          },
        },
      }),
      cookie = await authenticate(running.url, "b".repeat(43)),
      response = fetch(`${running.url}/api/life/bootstrap?scope=group:shared`, {
        headers: { cookie },
      });
    await providerStarted;
    f.life.setGroupMember({ userId: "local" }, "shared", { userId: "bob", remove: true });
    finish();
    assert.equal((await response).status, 403);
  } finally {
    finish();
    await f.close();
  }
});

test("group plugin storage separates colon user ids from crafted keys", async () => {
  const f = await fixture();
  try {
    const ownerActor = { userId: "local" };
    f.life.createGroup(ownerActor, { id: "arcade-room", name: "Arcade room" });
    f.life.setGroupMember(ownerActor, "arcade-room", { userId: "alice", role: "member" });
    f.life.setGroupMember(ownerActor, "arcade-room", {
      userId: "alice:bob",
      role: "member",
    });
    const plugin = f.plugins.install("group:arcade-room", {
      name: "Arcade",
      description: "Scores",
      kind: "arcade",
      capabilities: ["storage"],
    });
    let running = await f.start("a".repeat(43), "alice"),
      cookie = await authenticate(running.url, "a".repeat(43));
    const setScore = (key: string, value: number) =>
      fetch(`${running.url}/api/life/plugins/${plugin.id}/action`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({ action: "storage.set", payload: { key, value } }),
      });
    assert.equal((await setScore("bob:highScore", 99)).status, 200);
    await running.server.close();
    running = await f.start("b".repeat(43), "alice:bob");
    cookie = await authenticate(running.url, "b".repeat(43));
    assert.equal((await setScore("highScore", 7)).status, 200);
    assert.notEqual(
      groupStorageKey("alice", "bob:highScore"),
      groupStorageKey("alice:bob", "highScore"),
    );
    assert.equal(
      f.plugins.storageGet(
        "group:arcade-room",
        plugin.id,
        groupStorageKey("alice", "bob:highScore"),
      ),
      99,
    );
    assert.equal(
      f.plugins.storageGet(
        "group:arcade-room",
        plugin.id,
        groupStorageKey("alice:bob", "highScore"),
      ),
      7,
    );
  } finally {
    await f.close();
  }
});

test("successful record mutations invalidate scoped conversation context", async () => {
  const f = await fixture();
  const invalidated: string[] = [];
  try {
    const actor = { userId: "local" },
      record = f.life.createRecord(actor, {
        kind: "memory",
        title: "Mutable",
        scope: { type: "user", id: "local" },
        data: {},
      }),
      running = await f.start("a".repeat(43), "local", {
        harness: {
          ...f.harness,
          invalidateContext(_actor, scope) {
            invalidated.push(`${scope.type}:${scope.id}`);
          },
        },
      }),
      cookie = await authenticate(running.url, "a".repeat(43));
    assert.equal(
      (
        await fetch(`${running.url}/api/life/records/${record.id}`, {
          method: "PATCH",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({ expectedRevision: 1, title: "Changed" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${running.url}/api/life/records/${record.id}?revision=2`, {
          method: "DELETE",
          headers: jsonHeaders(running.url, cookie),
        })
      ).status,
      204,
    );
    for (const source of [
      { filename: "note.txt", mimeType: "text/plain", content: "hello" },
      {
        filename: "scan.pdf",
        mimeType: "application/pdf",
        encoding: "base64",
        content: Buffer.from("pdf").toString("base64"),
      },
    ])
      assert.equal(
        (
          await fetch(`${running.url}/api/life/sources`, {
            method: "POST",
            headers: jsonHeaders(running.url, cookie),
            body: JSON.stringify({ scope: "user:local", ...source }),
          })
        ).status,
        201,
      );
    assert.deepEqual(invalidated, ["user:local", "user:local", "user:local", "user:local"]);
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
  const state = join(root, "state");
  await mkdir(state, { mode: 0o700 });
  const seed = new LifeStore(join(state, "life.sqlite"));
  seed.createRecord(
    { userId: "local" },
    {
      kind: "event",
      title: "Flight",
      scope: { type: "user", id: "local" },
      data: { startAt: Date.now() + 60 * 60_000 },
    },
  );
  seed.close();
  const application = await createLifeApplication({
    stateDir: state,
    assetsDir: assets,
    port: 0,
  });
  try {
    const ready = await application.listen();
    assert.match(ready.launchUrl, /^http:\/\/127\.0\.0\.1:\d+\/#token=/);
    const cookie = await authenticate(
      ready.url,
      decodeURIComponent(ready.launchUrl.split("#token=")[1]!),
    );
    const bootstrap = (await (
      await fetch(`${ready.url}/api/life/bootstrap`, { headers: { cookie } })
    ).json()) as { notifications: Array<{ title: string }> };
    assert.equal(
      bootstrap.notifications.some((item) => item.title === "Flight"),
      true,
    );
    await Promise.all([application.close(), application.close(), application.close()]);
    await application.close();
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

test("bootstrap hides a preparation notice after its event moves outside the preparation window", async () => {
  const f = await fixture();
  try {
    const event = f.life.createRecord(
        { userId: "local" },
        {
          kind: "event",
          title: "Appointment",
          scope: { type: "user", id: "local" },
          data: { startAt: 1_800_000_000_000 + 60 * 60_000 },
        },
      ),
      running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43));
    const signal = await fetch(`${running.url}/api/life/signals`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({
        scope: "user:local",
        signal: { type: "check", at: 1_800_000_000_000 },
      }),
    });
    assert.equal(signal.status, 200);
    const before = (await (
      await fetch(`${running.url}/api/life/bootstrap?scope=user:local`, { headers: { cookie } })
    ).json()) as { notifications: Array<{ title: string }> };
    assert.equal(
      before.notifications.some((item) => item.title === "Appointment"),
      true,
    );
    const current = f.life.getRecord({ userId: "local" }, event.id)!;
    f.life.updateRecord({ userId: "local" }, event.id, current.revision, {
      data: { ...current.data, startAt: 1_800_000_000_000 + 7 * 24 * 60 * 60_000 },
    });
    const after = (await (
      await fetch(`${running.url}/api/life/bootstrap?scope=user:local`, { headers: { cookie } })
    ).json()) as { notifications: Array<{ title: string }> };
    assert.equal(
      after.notifications.some((item) => item.title === "Appointment"),
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

test("conversation response feedback is bound to an owned turn and stored privately", async () => {
  const f = await fixture();
  try {
    const actor = { userId: "local" },
      group = f.life.createGroup(actor, { id: "feedback-room", name: "Feedback room" }),
      begun = f.life.beginConversationTurn(actor, {
        scope: { type: "group", id: group.id },
        requestId: "rated-turn",
        chatEpoch: 1,
        message: "What should I bring?",
      });
    f.life.completeConversationTurn(actor, {
      conversationId: begun.conversation.id,
      turnId: begun.turn.id,
      requestId: "rated-turn",
      result: {
        reply: "Bring water.",
        actions: [],
        recordIds: [],
        taskIds: [],
        evidence: [],
      },
    });
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43)),
      response = await fetch(`${running.url}/api/life/learning`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({
          scope: `group:${group.id}`,
          conversationId: begun.conversation.id,
          turnId: begun.turn.id,
          message: "Helpful",
          rating: 1,
          example: { prompt: "malicious replacement", response: "leak this" },
          trainingEligible: false,
        }),
      });
    assert.equal(response.status, 201);
    const feedback = (await response.json()) as {
      scope: { type: string; id: string };
      data: { example: { prompt: string; response: string } };
    };
    assert.deepEqual(feedback.scope, { type: "user", id: "local" });
    assert.deepEqual(feedback.data.example, {
      prompt: "What should I bring?",
      response: "Bring water.",
    });
    const personalPreference = await fetch(`${running.url}/api/life/feedback`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({
        scope: `group:${group.id}`,
        text: "Keep my answers brief",
        explicitPreference: { key: "verbosity", value: "brief" },
      }),
    });
    assert.equal(personalPreference.status, 201);
    assert.deepEqual(
      ((await personalPreference.json()) as { scope: { type: string; id: string } }).scope,
      { type: "user", id: "local" },
    );
    assert.equal(f.life.resolveSettings(actor).values.verbosity, "brief");
    assert.equal(f.life.resolveSettings(actor, { groupId: group.id }).origins.verbosity, "user");
    assert.equal(
      (
        await fetch(`${running.url}/api/life/learning`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({
            conversationId: begun.conversation.id,
            turnId: "missing-turn",
            message: "No",
            rating: -1,
          }),
        })
      ).status,
      403,
    );
    f.life.setGroupMember(actor, group.id, { userId: "other-owner", role: "owner" });
    f.life.setGroupMember(actor, group.id, { userId: "local", remove: true });
    assert.equal(
      (
        await fetch(`${running.url}/api/life/learning`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({
            conversationId: begun.conversation.id,
            turnId: begun.turn.id,
            message: "Again",
            rating: 1,
          }),
        })
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("private improvement routes reject forged scope and abort without late persistence", async () => {
  const f = await fixture();
  try {
    const actor = { userId: "local" },
      feedback = f.life.createRecord(actor, {
        kind: "feedback",
        title: "Response to improve",
        scope: { type: "user", id: "local" },
        data: {
          type: "learning-feedback-v1",
          example: { prompt: "Hello", response: "Hi", preferredResponse: "Hello there" },
        },
      }),
      proposalRecord = f.life.createRecord(actor, {
        kind: "routine",
        title: "Warmer greetings",
        scope: { type: "user", id: "local" },
        data: {
          type: "learning-improvement-v1",
          status: "ready",
          previews: [{ candidateResponse: "hidden direct replay" }],
          improvementAudit: { previews: [{ candidateResponse: "hidden audit replay" }] },
        },
      }),
      proposal = {
        record: proposalRecord,
        status: "ready" as const,
        instructions: "Use a warmer greeting.",
        rationale: "The selected example asked for warmth.",
        feedback: [{ id: feedback.id, revision: feedback.revision }],
        previews: [
          {
            feedbackId: feedback.id,
            prompt: "Hello",
            recordedResponse: "Hi",
            preferredResponse: "Hello there",
            candidateResponse: "Hello there!",
          },
        ],
      };
    let entered!: () => void,
      settleCalls = 0;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.harness.improvements = {
      modelAvailable: true,
      list: () => [proposal],
      get: () => ({ ...proposal, status: "stale", previews: proposal.previews }),
      propose: (_trustedActor, input) => {
        if (["capacity", "invalid_candidate", "model_transport", "busy"].includes(input.goal!))
          return Promise.reject({ code: input.goal });
        return new Promise((_resolve, reject) => {
          entered();
          input.signal?.addEventListener("abort", () => reject({ code: "cancelled" }), {
            once: true,
          });
        });
      },
      adopt: () => proposal,
      dismiss: () => ({ ...proposal, status: "dismissed" }),
      settleActive: async () => {
        settleCalls++;
        return true;
      },
    };
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43));
    const list = (await (
      await fetch(`${running.url}/api/life/improvements`, { headers: { cookie } })
    ).json()) as { modelAvailable: boolean; proposals: unknown[] };
    assert.equal(list.modelAvailable, true);
    assert.equal(list.proposals.length, 1);
    const stale = (await (
      await fetch(`${running.url}/api/life/improvements/${proposalRecord.id}`, {
        headers: { cookie },
      })
    ).json()) as {
      status: string;
      previews: unknown[];
      record: { data: { previews?: unknown; improvementAudit?: { previews?: unknown } } };
    };
    assert.equal(stale.status, "stale");
    assert.deepEqual(stale.previews, []);
    assert.equal(stale.record.data.previews, undefined);
    assert.equal(stale.record.data.improvementAudit?.previews, undefined);
    assert.equal(
      (
        await fetch(`${running.url}/api/life/improvements`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({
            scope: "group:forged",
            feedback: [{ id: feedback.id, revision: feedback.revision }],
          }),
        })
      ).status,
      400,
    );
    for (const invalidBody of [
      { feedback: [{ id: feedback.id, revision: [feedback.revision] }] },
      { feedback: [{ id: feedback.id, revision: feedback.revision }], extra: true },
    ])
      assert.equal(
        (
          await fetch(`${running.url}/api/life/improvements`, {
            method: "POST",
            headers: jsonHeaders(running.url, cookie),
            body: JSON.stringify(invalidBody),
          })
        ).status,
        400,
      );
    assert.equal(
      (
        await fetch(`${running.url}/api/life/improvements/${proposalRecord.id}/adopt`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({ expectedRevision: [proposalRecord.revision] }),
        })
      ).status,
      400,
    );
    for (const [goal, status, message] of [
      ["capacity", 429, "Delete an old improvement proposal before creating another."],
      ["busy", 429, "Two improvement reviews are already running. Try again shortly."],
      ["invalid_candidate", 502, "The local model returned an invalid improvement proposal."],
      [
        "model_transport",
        503,
        "The local model runner is unavailable. Try again when it is ready.",
      ],
    ] as const) {
      const result = await fetch(`${running.url}/api/life/improvements`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({
          feedback: [{ id: feedback.id, revision: feedback.revision }],
          goal,
        }),
      });
      assert.equal(result.status, status);
      assert.equal(((await result.json()) as { error: string }).error, message);
    }
    const pending = fetch(`${running.url}/api/life/improvements`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ feedback: [{ id: feedback.id, revision: feedback.revision }] }),
    }).catch(() => undefined);
    await started;
    await running.server.close();
    assert.equal(settleCalls, 1);
    await pending;
    assert.equal(
      f.life.listRecords(actor, { scope: { type: "user", id: "local" }, kinds: ["routine"] })
        .length,
      1,
      "the aborted engine cannot persist another proposal",
    );
  } finally {
    await f.close();
  }
});

test("record DTO reports the authoritative bound delivery state", async () => {
  const f = await fixture();
  try {
    const actor = { userId: "local" },
      draft = f.life.createRecord(actor, {
        kind: "reminder",
        title: "Call Mum",
        scope: { type: "user", id: "local" },
        data: { dueAt: 50_000, completed: false },
      }),
      reminder = f.life.updateRecord(actor, draft.id, draft.revision, {
        data: { ...draft.data, taskId: "call-delivery" },
      }),
      running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43));
    f.taskRows.set("call-delivery", {
      id: "call-delivery",
      owner: "user:local",
      handler: "reminder.notify",
      input: { recordId: reminder.id, scope: reminder.scope },
      state: "scheduled",
      requiredCapabilities: [],
      allowedCapabilities: [],
      rootId: "call-delivery",
      dependsOn: [],
      budget: {},
      attempt: 0,
      idempotencyKey: "call-delivery:0",
      createdAt: 1,
      updatedAt: 1,
    });
    const detail = (await (
      await fetch(`${running.url}/api/life/records/${reminder.id}`, { headers: { cookie } })
    ).json()) as { delivery: { taskId: string; status: string; actions: string[] } };
    assert.deepEqual(detail.delivery, {
      taskId: "call-delivery",
      status: "scheduled",
      scheduleStatus: "scheduled",
      actions: ["pause", "cancel", "run"],
    });
    f.taskRows.get("call-delivery")!.state = "paused";
    const refreshed = (await (
      await fetch(`${running.url}/api/life/records/${reminder.id}`, { headers: { cookie } })
    ).json()) as { delivery: { status: string; actions: string[] } };
    assert.equal(refreshed.delivery.status, "paused");
    assert.deepEqual(refreshed.delivery.actions, ["resume", "cancel", "run"]);
  } finally {
    await f.close();
  }
});

test("plan routes create scoped checklists and update steps with record CAS", async () => {
  const f = await fixture();
  try {
    let running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43));
    const createdResponse = await fetch(`${running.url}/api/life/plans`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({
        scope: "user:local",
        title: "Prepare launch",
        steps: ["Check weather", "Pack bag"],
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as {
      record: { id: string; revision: number; data: { completed: boolean } };
      steps: Array<{ id: string; completed: boolean }>;
      completedSteps: number;
      totalSteps: number;
      completed: boolean;
    };
    assert.equal(created.totalSteps, 2);
    assert.equal(created.completedSteps, 0);
    const updatedResponse = await fetch(
      `${running.url}/api/life/plans/${created.record.id}/steps/${created.steps[0]!.id}`,
      {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({ completed: true, expectedRevision: 1 }),
      },
    );
    assert.equal(updatedResponse.status, 200);
    const updated = (await updatedResponse.json()) as {
      record: { revision: number };
      completedSteps: number;
    };
    assert.equal(updated.record.revision, 2);
    assert.equal(updated.completedSteps, 1);
    assert.equal(
      (
        await fetch(
          `${running.url}/api/life/plans/${created.record.id}/steps/${created.steps[1]!.id}`,
          {
            method: "POST",
            headers: jsonHeaders(running.url, cookie),
            body: JSON.stringify({ completed: true, expectedRevision: 1 }),
          },
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await fetch(
          `${running.url}/api/life/plans/${created.record.id}/steps/${created.steps[1]!.id}`,
          {
            method: "POST",
            headers: jsonHeaders(running.url, cookie),
            body: JSON.stringify({ completed: true, expectedRevision: [2] }),
          },
        )
      ).status,
      400,
    );
    const list = (await (
      await fetch(`${running.url}/api/life/plans?scope=user:local`, { headers: { cookie } })
    ).json()) as { plans: unknown[]; hasMore: boolean };
    assert.equal(list.plans.length, 1);
    assert.equal(list.hasMore, false);
    await running.server.close();
    running = await f.start("b".repeat(43), "bob");
    cookie = await authenticate(running.url, "b".repeat(43));
    assert.equal(
      (
        await fetch(`${running.url}/api/life/plans/${created.record.id}`, {
          headers: { cookie },
        })
      ).status,
      404,
    );
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
        body: JSON.stringify({
          scope: "user:local",
          message: "wait",
          requestId: "slow-chat",
          chatEpoch: 1,
        }),
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

test("task detail suppresses an aggregate result after a cited source changes", async () => {
  const f = await fixture();
  try {
    const actor = { userId: "local" },
      scope = { type: "user" as const, id: "local" },
      source = f.life.ingestSource(actor, {
        title: "Reference",
        scope,
        format: "text",
        content: "Original evidence",
      });
    f.taskRows.set("summary-root", {
      id: "summary-root",
      owner: "user:local",
      handler: "knowledge.aggregate",
      input: {
        query: "garden evidence",
        sourceIds: [source.id],
        rawPrompt: "must never be returned",
      },
      state: "succeeded",
      requiredCapabilities: [],
      allowedCapabilities: [],
      rootId: "summary-root",
      dependsOn: [],
      budget: {},
      attempt: 1,
      idempotencyKey: "summary-root:0",
      result: {
        status: "complete",
        summary: "Verified aggregate",
        citations: [
          {
            sourceId: source.id,
            sourceRevision: source.revision,
            title: source.title,
            references: ["chunk 1"],
          },
        ],
        omitted: 0,
      },
      createdAt: 1,
      updatedAt: 1,
    });
    const running = await f.start("a".repeat(43), "local", {
        harness: {
          ...f.harness,
          rerunBackgroundSummary({ taskId }) {
            assert.equal(taskId, "summary-root");
            const rerun: TaskRecord = {
              ...f.taskRows.get(taskId)!,
              id: "summary-rerun",
              rootId: "summary-rerun",
              state: "queued",
              result: undefined,
              idempotencyKey: "summary-rerun:0",
              createdAt: 2,
              updatedAt: 2,
            };
            f.taskRows.set(rerun.id, rerun);
            return rerun;
          },
        },
      }),
      cookie = await authenticate(running.url, "a".repeat(43)),
      detail = async () =>
        (await (
          await fetch(`${running.url}/api/life/tasks/summary-root/detail`, {
            headers: { cookie },
          })
        ).json()) as {
          task?: { title: string; actions: string[] };
          result?: { summary: string };
          stale?: boolean;
          staleReason?: string;
        };
    const current = await detail();
    assert.equal(current.result?.summary, "Verified aggregate");
    assert.equal(current.task?.title, "Summarize garden evidence");
    assert.deepEqual(current.task?.actions, ["rerun"]);
    assert.doesNotMatch(JSON.stringify(current), /must never be returned|knowledge\.aggregate/);
    f.life.updateSource(actor, source.id, source.revision, { content: "Changed evidence" });
    const stale = await detail();
    assert.equal(stale.stale, true);
    assert.equal(stale.result, undefined);
    assert.match(stale.staleReason ?? "", /Run this task again/);
    assert.doesNotMatch(JSON.stringify(stale), /must never be returned/);
    const rerun = await fetch(`${running.url}/api/life/tasks/summary-root/run`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: "{}",
    });
    assert.equal(rerun.status, 200);
    const rerunTask = (await rerun.json()) as { id: string; status: string; actions: string[] };
    assert.equal(rerunTask.id, "summary-rerun");
    assert.equal(rerunTask.status, "queued");
    assert.deepEqual(rerunTask.actions, ["pause", "cancel", "run"]);
    assert.equal(f.taskRows.get("summary-root")?.state, "succeeded");
    f.taskRows.get("summary-root")!.result = {
      status: "complete",
      summary: "No current source passages remain for this summary.",
      citations: [],
      omitted: 1,
      reason: "no_current_sources",
    };
    const empty = await detail();
    assert.equal(empty.stale, false);
    assert.equal(empty.result?.summary, "No current source passages remain for this summary.");
  } finally {
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

test("raw binary upload accepts documents above the JSON limit without base64 expansion", async () => {
  const f = await fixture();
  try {
    let received = 0;
    const running = await f.start("b".repeat(43), "local", {
        extractor: async ({ bytes, filename, mimeType }) => {
          received = bytes.length;
          assert.equal(filename, "large.pdf");
          assert.equal(mimeType, "application/pdf");
          return { text: "Extracted large document", metadata: { pages: 12 } };
        },
      }),
      cookie = await authenticate(running.url, "b".repeat(43)),
      bytes = Buffer.alloc(3_000_000, 7),
      query = new URLSearchParams({
        scope: "user:local",
        filename: "large.pdf",
        mimeType: "application/pdf",
        title: "Large PDF",
      });
    const response = await fetch(`${running.url}/api/life/sources/binary?${query}`, {
      method: "POST",
      headers: {
        origin: running.url,
        cookie,
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
      },
      body: bytes,
    });
    assert.equal(response.status, 201);
    assert.equal(received, bytes.length);
    const record = (await response.json()) as {
      title: string;
      data: { metadata: { pages: number } };
    };
    assert.equal(record.title, "Large PDF");
    assert.equal(record.data.metadata.pages, 12);
    assert.equal(
      (
        await fetch(`${running.url}/api/life/sources/binary?${query}`, {
          method: "POST",
          headers: { origin: running.url, cookie, "content-type": "application/pdf" },
          body: Buffer.from("pdf"),
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await fetch(`${running.url}/api/life/sources/binary?${query}`, {
          method: "POST",
          headers: { origin: running.url, cookie, "content-type": "application/octet-stream" },
        })
      ).status,
      411,
    );
  } finally {
    await f.close();
  }
});

test("reviewed reset aborts active extraction and improvement review before deleting stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-binary-reset-"));
  await chmod(root, 0o700);
  const assets = join(root, "assets");
  await mkdir(assets, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "ok", { mode: 0o600 });
  const life = new LifeStore(join(root, "life.sqlite")),
    plugins = new PluginStore(join(root, "plugins.sqlite")),
    tasks = new TaskRuntime({ directory: join(root, "tasks") });
  const feedback = life.createRecord(
    { userId: "local" },
    {
      kind: "feedback",
      title: "Improve",
      scope: { type: "user", id: "local" },
      data: { type: "learning-feedback-v1", example: { prompt: "a", response: "b" } },
    },
  );
  let extractionStarted!: () => void,
    improvementStarted!: () => void,
    settleCalls = 0;
  const started = new Promise<void>((resolve) => {
      extractionStarted = resolve;
    }),
    improvementEntered = new Promise<void>((resolve) => {
      improvementStarted = resolve;
    });
  const server = createLifeServer({
    stateDir: root,
    assetsDir: assets,
    store: life,
    plugins,
    tasks,
    harness: {
      chat: async () => ({ reply: "", conversationId: "c" }),
      invalidateActorContext() {},
      improvements: {
        modelAvailable: true,
        list: () => [],
        get: () => {
          throw new Error("unused");
        },
        propose: (_actor, input) =>
          new Promise((_resolve, reject) => {
            improvementStarted();
            input.signal?.addEventListener("abort", () => reject({ code: "cancelled" }), {
              once: true,
            });
          }),
        adopt: () => {
          throw new Error("unused");
        },
        dismiss: () => {
          throw new Error("unused");
        },
        settleActive: async () => {
          settleCalls++;
          return true;
        },
      },
    },
    extractor: async ({ signal }) => {
      extractionStarted();
      return await new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    },
    port: 0,
    token: "x".repeat(43),
  });
  try {
    const running = await server.listen(),
      cookie = await authenticate(running.url, "x".repeat(43)),
      review = (await (
        await fetch(`${running.url}/api/life/personal-data/review`, { headers: { cookie } })
      ).json()) as { reviewToken: string },
      query = new URLSearchParams({
        scope: "user:local",
        filename: "scan.pdf",
        mimeType: "application/pdf",
      });
    const upload = fetch(`${running.url}/api/life/sources/binary?${query}`, {
      method: "POST",
      headers: {
        origin: running.url,
        cookie,
        "content-type": "application/octet-stream",
        "content-length": "4",
      },
      body: Buffer.from("scan"),
    });
    const improvement = fetch(`${running.url}/api/life/improvements`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ feedback: [{ id: feedback.id, revision: feedback.revision }] }),
    });
    await started;
    await improvementEntered;
    const reset = await fetch(`${running.url}/api/life/personal-data/reset`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ reviewToken: review.reviewToken }),
    });
    assert.equal(reset.status, 200);
    assert.equal((await upload).status, 408);
    assert.equal((await improvement).status, 408);
    assert.equal(settleCalls > 0, true);
    assert.equal(life.personalSummary({ userId: "local" }).sources, 0);
    assert.equal(life.personalSummary({ userId: "local" }).records, 0);
  } finally {
    await server.close();
    await tasks.close();
    plugins.close();
    life.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("binary extraction rechecks group membership before persisting", async () => {
  const f = await fixture();
  try {
    f.life.createGroup({ userId: "local" }, { id: "shared", name: "Shared" });
    f.life.setGroupMember({ userId: "local" }, "shared", { userId: "bob", role: "member" });
    let begin!: () => void, finish!: (value: { text: string }) => void;
    const started = new Promise<void>((resolve) => {
        begin = resolve;
      }),
      extraction = new Promise<{ text: string }>((resolve) => {
        finish = resolve;
      });
    const running = await f.start("y".repeat(43), "bob", {
        extractor: async () => {
          begin();
          return extraction;
        },
      }),
      cookie = await authenticate(running.url, "y".repeat(43)),
      query = new URLSearchParams({
        scope: "group:shared",
        filename: "photo.png",
        mimeType: "image/png",
      });
    const upload = fetch(`${running.url}/api/life/sources/binary?${query}`, {
      method: "POST",
      headers: {
        origin: running.url,
        cookie,
        "content-type": "application/octet-stream",
        "content-length": "3",
      },
      body: Buffer.from("png"),
    });
    await started;
    f.life.setGroupMember({ userId: "local" }, "shared", { userId: "bob", remove: true });
    finish({ text: "private OCR" });
    assert.equal((await upload).status, 403);
    assert.equal(
      f.life.listRecords(
        { userId: "local" },
        { scope: { type: "group", id: "shared" }, kinds: ["source"] },
      ).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("binary uploads enforce the two-extraction concurrency quota", async () => {
  const f = await fixture();
  try {
    let active = 0,
      both!: () => void,
      release!: () => void;
    const started = new Promise<void>((resolve) => {
        both = resolve;
      }),
      held = new Promise<{ text: string }>((resolve) => {
        release = () => resolve({ text: "done" });
      });
    const running = await f.start("z".repeat(43), "local", {
        extractor: async () => {
          active++;
          if (active === 2) both();
          return held;
        },
      }),
      cookie = await authenticate(running.url, "z".repeat(43));
    const upload = (name: string) =>
      fetch(
        `${running.url}/api/life/sources/binary?${new URLSearchParams({ scope: "user:local", filename: name, mimeType: "application/pdf" })}`,
        {
          method: "POST",
          headers: {
            origin: running.url,
            cookie,
            "content-type": "application/octet-stream",
            "content-length": "1",
          },
          body: Buffer.from("x"),
        },
      );
    const first = upload("one.pdf"),
      second = upload("two.pdf");
    await started;
    assert.equal((await upload("three.pdf")).status, 429);
    release();
    assert.deepEqual(
      await Promise.all([first.then((r) => r.status), second.then((r) => r.status)]),
      [201, 201],
    );
  } finally {
    await f.close();
  }
});

test("a noncooperative extractor cannot persist after shutdown aborts its signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-binary-late-resolve-"));
  await chmod(root, 0o700);
  const assets = join(root, "assets");
  await mkdir(assets, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "ok", { mode: 0o600 });
  const life = new LifeStore(join(root, "life.sqlite")),
    plugins = new PluginStore(join(root, "plugins.sqlite")),
    tasks = new TaskRuntime({ directory: join(root, "tasks") });
  let start!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
      start = resolve;
    }),
    held = new Promise<{ text: string }>((resolve) => {
      release = () => resolve({ text: "late text" });
    });
  const server = createLifeServer({
    stateDir: root,
    assetsDir: assets,
    store: life,
    plugins,
    tasks,
    harness: {
      chat: async () => ({ reply: "", conversationId: "c" }),
      invalidateActorContext() {},
    },
    extractor: async () => {
      start();
      return held;
    },
    port: 0,
    token: "n".repeat(43),
  });
  try {
    const running = await server.listen(),
      cookie = await authenticate(running.url, "n".repeat(43)),
      query = new URLSearchParams({
        scope: "user:local",
        filename: "late.pdf",
        mimeType: "application/pdf",
      });
    const upload = fetch(`${running.url}/api/life/sources/binary?${query}`, {
      method: "POST",
      headers: {
        origin: running.url,
        cookie,
        "content-type": "application/octet-stream",
        "content-length": "1",
      },
      body: Buffer.from("x"),
    })
      .then((response) => response.status)
      .catch(() => 408);
    await started;
    let closeSettled = false;
    const closing = server.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false);
    release();
    assert.equal(await upload, 408);
    await closing;
    assert.equal(life.personalSummary({ userId: "local" }).sources, 0);
  } finally {
    release();
    await server.close();
    await tasks.close();
    plugins.close();
    life.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("client disconnect after upload aborts extraction and prevents persistence", async () => {
  const f = await fixture();
  try {
    let start!: () => void, aborted!: () => void;
    const started = new Promise<void>((resolve) => {
        start = resolve;
      }),
      sawAbort = new Promise<void>((resolve) => {
        aborted = resolve;
      });
    const running = await f.start("d".repeat(43), "local", {
        extractor: async ({ signal }) => {
          start();
          return await new Promise((_resolve, reject) =>
            signal?.addEventListener(
              "abort",
              () => {
                aborted();
                reject(new Error("disconnected"));
              },
              { once: true },
            ),
          );
        },
      }),
      cookie = await authenticate(running.url, "d".repeat(43)),
      query = new URLSearchParams({
        scope: "user:local",
        filename: "gone.png",
        mimeType: "image/png",
      });
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: running.port,
      path: `/api/life/sources/binary?${query}`,
      method: "POST",
      headers: {
        host: `127.0.0.1:${running.port}`,
        origin: running.url,
        cookie,
        "content-type": "application/octet-stream",
        "content-length": "3",
      },
    });
    request.on("error", () => {});
    request.end("png");
    await started;
    request.destroy();
    await sawAbort;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      f.life.listRecords(
        { userId: "local" },
        { scope: { type: "user", id: "local" }, kinds: ["source"] },
      ).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("legacy base64 extraction cannot write after a noncooperative shutdown abort", async () => {
  const f = await fixture();
  try {
    let start!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
        start = resolve;
      }),
      held = new Promise<{ text: string }>((resolve) => {
        release = () => resolve({ text: "late legacy text" });
      });
    const running = await f.start("q".repeat(43), "local", {
        extractor: async () => {
          start();
          return held;
        },
      }),
      cookie = await authenticate(running.url, "q".repeat(43));
    const upload = fetch(`${running.url}/api/life/sources`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({
        scope: "user:local",
        filename: "legacy.pdf",
        mimeType: "application/pdf",
        encoding: "base64",
        content: Buffer.from("pdf").toString("base64"),
      }),
    })
      .then((response) => response.status)
      .catch(() => 408);
    await started;
    let closed = false;
    const closing = running.server.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    release();
    assert.equal(await upload, 408);
    await closing;
    assert.equal(
      f.life.listRecords(
        { userId: "local" },
        { scope: { type: "user", id: "local" }, kinds: ["source"] },
      ).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("teaching routes require revisions and expose retained history", async () => {
  const f = await fixture();
  try {
    const running = await f.start(),
      cookie = await authenticate(running.url, "a".repeat(43));
    const created = await fetch(`${running.url}/api/life/teaching`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({
        scope: "user:local",
        title: "Writing",
        instructions: "Use short sentences.",
        enabled: true,
      }),
    });
    assert.equal(created.status, 201);
    const guide = (await created.json()) as {
      record: { id: string; revision: number };
      version: number;
    };
    const revised = await fetch(`${running.url}/api/life/teaching/${guide.record.id}/revise`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({
        expectedRevision: guide.record.revision,
        instructions: "Use clear short sentences.",
      }),
    });
    assert.equal(revised.status, 200);
    const list = (await (
      await fetch(`${running.url}/api/life/teaching?scope=user:local`, { headers: { cookie } })
    ).json()) as { guides: Array<{ version: number; versions: unknown[] }> };
    assert.equal(list.guides[0]?.version, 2);
    assert.equal(list.guides[0]?.versions.length, 2);
  } finally {
    await f.close();
  }
});

test("chat requests persist once, recover by request id, page privately, and expose model status", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const source = f.life.ingestSource(
        { userId: "local" },
        {
          title: "S".repeat(2_000),
          scope: { type: "user", id: "local" },
          format: "text",
          content: "bounded evidence",
        },
      ),
      token = "c".repeat(43),
      running = await f.start(token, "local", {
        harness: {
          ...f.harness,
          async chat(input) {
            calls += 1;
            return {
              reply: "R".repeat(9_000),
              conversationId: input.conversationId!,
              actions: [{ label: "L".repeat(2_000), status: "completed" }],
              evidence: [{ sourceId: source.id, title: source.title }],
            };
          },
        },
        modelStatus: async () => ({
          mode: "local",
          configured: true,
          available: true,
          model: "local-test",
          checkedAt: 1_800_000_000_000,
          capabilities: { chat: true, customApps: true },
          reason: "ready",
        }),
      }),
      cookie = await authenticate(running.url, token),
      bootstrap = (await (
        await fetch(`${running.url}/api/life/bootstrap`, { headers: { cookie } })
      ).json()) as { chatEpoch: number };
    assert.equal(bootstrap.chatEpoch, 1);
    const payload = {
      scope: "user:local",
      message: "remember once",
      requestId: "durable-request",
      chatEpoch: bootstrap.chatEpoch,
    };
    const first = await fetch(`${running.url}/api/life/chat`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify(payload),
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { conversationId: string; status: string };
    assert.equal(firstBody.status, "completed");
    const duplicate = await fetch(`${running.url}/api/life/chat`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify(payload),
    });
    assert.equal(duplicate.status, 200);
    assert.equal(calls, 1);
    const recovered = await fetch(`${running.url}/api/life/chat/requests/durable-request`, {
      headers: { cookie },
    });
    assert.equal(recovered.status, 200);
    assert.equal(((await recovered.json()) as { status: string }).status, "completed");
    const list = (await (
      await fetch(`${running.url}/api/life/conversations?scope=user:local`, {
        headers: { cookie },
      })
    ).json()) as { chatEpoch: number; conversations: Array<{ id: string }> };
    assert.equal(list.chatEpoch, 1);
    assert.equal(list.conversations[0]?.id, firstBody.conversationId);
    const detail = (await (
      await fetch(`${running.url}/api/life/conversations/${firstBody.conversationId}`, {
        headers: { cookie },
      })
    ).json()) as {
      turns: Array<{
        requestId: string;
        assistant?: string;
        actions: Array<{ label: string }>;
        evidence: Array<{ title: string }>;
      }>;
    };
    assert.equal(detail.turns[0]?.requestId, "durable-request");
    assert.equal(detail.turns[0]?.assistant?.length, 8_000);
    assert.equal(detail.turns[0]?.actions[0]?.label.length, 500);
    assert.equal(detail.turns[0]?.evidence[0]?.title.length, 500);
    assert.equal((await fetch(`${running.url}/api/life/model/status`)).status, 401);
    const status = (await (
      await fetch(`${running.url}/api/life/model/status`, { headers: { cookie } })
    ).json()) as { model: string; reason: string; checkedAt: string };
    assert.equal(status.model, "local-test");
    assert.equal(status.reason, "ready");
    assert.match(status.checkedAt, /^2027-/);
    const revision = list.conversations[0] as unknown as { revision: number };
    assert.equal(
      (
        await fetch(
          `${running.url}/api/life/conversations/${firstBody.conversationId}?revision=${revision.revision}`,
          { method: "DELETE", headers: jsonHeaders(running.url, cookie) },
        )
      ).status,
      204,
    );
    assert.equal(
      (
        await fetch(`${running.url}/api/life/chat`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify(payload),
        })
      ).status,
      409,
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("a reminder clarification survives restart, executes once, and reschedules its exact receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-life-continuation-"));
  await chmod(root, 0o700);
  const assets = join(root, "assets"),
    state = join(root, "state");
  await mkdir(assets, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Continuation</title>", {
    mode: 0o600,
  });
  let application = await createLifeApplication({ stateDir: state, assetsDir: assets, port: 0 });
  try {
    let ready = await application.listen(),
      cookie = await authenticate(
        ready.url,
        decodeURIComponent(ready.launchUrl.split("#token=")[1]!),
      );
    const first = await fetch(`${ready.url}/api/life/chat`, {
      method: "POST",
      headers: jsonHeaders(ready.url, cookie),
      body: JSON.stringify({
        scope: "user:local",
        message: "Remind me to call Mum",
        requestId: "clarification-origin",
        chatEpoch: 1,
      }),
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      conversationId: string;
      pendingIntent: { kind: string; title: string; missing: string[]; revision: number };
    };
    assert.equal(firstBody.pendingIntent.kind, "reminder");
    assert.equal(firstBody.pendingIntent.title, "call Mum");
    assert.deepEqual(firstBody.pendingIntent.missing, ["when"]);
    await application.close();

    application = await createLifeApplication({ stateDir: state, assetsDir: assets, port: 0 });
    ready = await application.listen();
    cookie = await authenticate(
      ready.url,
      decodeURIComponent(ready.launchUrl.split("#token=")[1]!),
    );
    const restored = (await (
      await fetch(
        `${ready.url}/api/life/conversations/${firstBody.conversationId}/pending-intent`,
        { headers: { cookie } },
      )
    ).json()) as { pendingIntent: { state: string } };
    assert.equal(restored.pendingIntent.state, "awaiting-fields");
    const pastAnswer = await fetch(`${ready.url}/api/life/chat`, {
      method: "POST",
      headers: jsonHeaders(ready.url, cookie),
      body: JSON.stringify({
        scope: "user:local",
        conversationId: firstBody.conversationId,
        message: "Yesterday at 10",
        requestId: "clarification-past-answer",
        chatEpoch: 1,
      }),
    });
    assert.equal(pastAnswer.status, 200);
    const pastBody = (await pastAnswer.json()) as {
      pendingIntent: { state: string; missing: string[] };
      actions: Array<{ status: string }>;
      records: unknown[];
      taskIds: string[];
    };
    assert.equal(pastBody.pendingIntent.state, "awaiting-fields");
    assert.deepEqual(pastBody.pendingIntent.missing, ["when"]);
    assert.equal(
      pastBody.actions.some((action) => action.status === "completed"),
      false,
    );
    assert.deepEqual(pastBody.records, []);
    assert.deepEqual(pastBody.taskIds, []);
    const answerPayload = {
      scope: "user:local",
      conversationId: firstBody.conversationId,
      message: "Tomorrow at 10",
      requestId: "clarification-answer",
      chatEpoch: 1,
    };
    const answer = await fetch(`${ready.url}/api/life/chat`, {
      method: "POST",
      headers: jsonHeaders(ready.url, cookie),
      body: JSON.stringify(answerPayload),
    });
    assert.equal(answer.status, 200);
    const answerBody = (await answer.json()) as {
      pendingIntent: null;
      records: Array<{ id: string; revision: number; data: { dueAt: number; taskId: string } }>;
    };
    assert.equal(answerBody.pendingIntent, null);
    const reminder = answerBody.records.at(-1)!;
    assert.ok(reminder.data.taskId);
    const duplicate = await fetch(`${ready.url}/api/life/chat`, {
      method: "POST",
      headers: jsonHeaders(ready.url, cookie),
      body: JSON.stringify(answerPayload),
    });
    assert.equal(duplicate.status, 200);
    const listed = (await (
      await fetch(`${ready.url}/api/life/records?scope=user:local&kinds=reminder`, {
        headers: { cookie },
      })
    ).json()) as { records: Array<{ id: string }> };
    assert.deepEqual(
      listed.records.map((record) => record.id),
      [reminder.id],
    );

    const correction = await fetch(`${ready.url}/api/life/chat`, {
      method: "POST",
      headers: jsonHeaders(ready.url, cookie),
      body: JSON.stringify({
        scope: "user:local",
        conversationId: firstBody.conversationId,
        message: "Actually make it 11",
        requestId: "clarification-correction",
        chatEpoch: 1,
      }),
    });
    assert.equal(correction.status, 200);
    const corrected = (await correction.json()) as {
      pendingIntent: null;
      actions: Array<{ label: string; status: string }>;
      records: Array<{ id: string; revision: number; data: { dueAt: number; taskId: string } }>;
    };
    assert.equal(corrected.pendingIntent, null);
    assert.equal(corrected.records.at(-1)?.id, reminder.id);
    assert.ok((corrected.records.at(-1)?.revision ?? 0) > reminder.revision);
    assert.notEqual(corrected.records.at(-1)?.data.taskId, reminder.data.taskId);
    assert.equal(corrected.actions[0]?.status, "scheduled");
    assert.match(corrected.actions[0]?.label ?? "", /call Mum/i);

    const internals = application.server as unknown as {
        options: { store: LifeStore; tasks: TaskRuntime };
      },
      originalMark = internals.options.store.markReminderRescheduleRecordUpdated.bind(
        internals.options.store,
      );
    let failMarkOnce = true;
    internals.options.store.markReminderRescheduleRecordUpdated = (...args) => {
      if (failMarkOnce) {
        failMarkOnce = false;
        throw new Error("injected callback failure before journal transition");
      }
      return originalMark(...args);
    };
    const beforeFault = corrected.records.at(-1)!;
    const faulted = await fetch(`${ready.url}/api/life/chat`, {
      method: "POST",
      headers: jsonHeaders(ready.url, cookie),
      body: JSON.stringify({
        scope: "user:local",
        conversationId: firstBody.conversationId,
        message: "Actually make it 12",
        requestId: "clarification-faulted-correction",
        chatEpoch: 1,
      }),
    });
    assert.equal(faulted.status, 500);
    internals.options.store.markReminderRescheduleRecordUpdated = originalMark;
    const afterFault = internals.options.store.getRecord({ userId: "local" }, reminder.id)!;
    assert.notEqual(afterFault.data.taskId, beforeFault.data.taskId);
    assert.equal(
      internals.options.tasks.get(String(beforeFault.data.taskId), "user:local")?.state,
      "cancelled",
    );
    assert.equal(
      internals.options.tasks.get(String(afterFault.data.taskId), "user:local")?.state,
      "scheduled",
    );
    assert.equal(
      internals.options.store
        .listReminderReschedules({ userId: "local" })
        .find((journal) => journal.replacementTaskId === afterFault.data.taskId)?.state,
      "completed",
    );
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup activates a prepared reminder replacement only after the record pointer is durable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-life-replacement-recovery-"));
  await chmod(root, 0o700);
  const assets = join(root, "assets");
  await mkdir(assets, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Recovery</title>", {
    mode: 0o600,
  });
  const actor = { userId: "local" },
    lifePath = join(root, "life.sqlite"),
    pluginPath = join(root, "plugins.sqlite"),
    taskPath = join(root, "tasks");
  let life = new LifeStore(lifePath, { now: 1_800_000_000_000 }),
    plugins = new PluginStore(pluginPath, () => 1_800_000_000_000),
    tasks = new TaskRuntime({ directory: taskPath, now: () => 1_800_000_000_000 });
  tasks.registerHandler({ name: "reminder.notify", async run() {} });
  const initial = life.createRecord(actor, {
      kind: "reminder",
      title: "Call Mum",
      scope: { type: "user", id: "local" },
      data: { dueAt: 1_800_100_000_000, completed: false, timeZone: "UTC" },
    }),
    oldTask = tasks.schedule({
      owner: "user:local",
      handler: "reminder.notify",
      input: { recordId: initial.id },
      schedule: { kind: "once", at: 1_800_100_000_000 },
    }),
    reminder = life.updateRecord(actor, initial.id, initial.revision, {
      data: { ...initial.data, taskId: oldTask.id },
    }),
    operationId = "replacement-recovery";
  life.beginReminderReschedule(actor, {
    operationId,
    scope: reminder.scope,
    recordId: reminder.id,
    expectedRevision: reminder.revision,
    replacesTaskId: oldTask.id,
  });
  const replacement = tasks.prepareReplacement({
    operationId,
    owner: "user:local",
    replacesTaskId: oldTask.id,
    task: {
      owner: "user:local",
      handler: "reminder.notify",
      input: { recordId: reminder.id },
      schedule: { kind: "once", at: 1_800_200_000_000 },
    },
  });
  life.markReminderReschedulePrepared(actor, operationId, {
    replacementTaskId: replacement.replacementTaskId,
    dueAt: 1_800_200_000_000,
  });
  life.updateRecord(actor, reminder.id, reminder.revision, {
    data: {
      ...reminder.data,
      dueAt: 1_800_200_000_000,
      taskId: replacement.replacementTaskId,
      rescheduleOperationId: operationId,
    },
  });
  assert.equal(life.getReminderReschedule(actor, operationId)?.state, "prepared");

  const heldRecord = life.createRecord(actor, {
      kind: "reminder",
      title: "Held cleanup",
      scope: { type: "user", id: "local" },
      data: { dueAt: 1_800_300_000_000, completed: false, timeZone: "UTC" },
    }),
    heldOldTask = tasks.schedule({
      owner: "user:local",
      handler: "reminder.notify",
      input: { recordId: heldRecord.id },
      schedule: { kind: "once", at: 1_800_300_000_000 },
    }),
    held = life.updateRecord(actor, heldRecord.id, heldRecord.revision, {
      data: { ...heldRecord.data, taskId: heldOldTask.id },
    }),
    heldOperationId = "replacement-discard-failure";
  life.beginReminderReschedule(actor, {
    operationId: heldOperationId,
    scope: held.scope,
    recordId: held.id,
    expectedRevision: held.revision,
    replacesTaskId: heldOldTask.id,
  });
  const heldReplacement = tasks.prepareReplacement({
    operationId: heldOperationId,
    owner: "user:local",
    replacesTaskId: heldOldTask.id,
    task: {
      owner: "user:local",
      handler: "reminder.notify",
      input: { recordId: held.id },
      schedule: { kind: "once", at: 1_800_400_000_000 },
    },
  });
  life.markReminderReschedulePrepared(actor, heldOperationId, {
    replacementTaskId: heldReplacement.replacementTaskId,
    dueAt: 1_800_400_000_000,
  });
  await tasks.close();
  plugins.close();
  life.close();

  life = new LifeStore(lifePath, { now: 1_800_000_000_001 });
  plugins = new PluginStore(pluginPath, () => 1_800_000_000_001);
  tasks = new TaskRuntime({ directory: taskPath, now: () => 1_800_000_000_001 });
  const discardReplacement = tasks.discardReplacement.bind(tasks);
  tasks.discardReplacement = (id, taskOwner) => {
    if (id === heldOperationId) throw new Error("injected discard failure");
    return discardReplacement(id, taskOwner);
  };
  const server = createLifeServer({
    stateDir: root,
    assetsDir: assets,
    store: life,
    plugins,
    tasks,
    harness: {
      async chat() {
        throw new Error("unused");
      },
    },
    port: 0,
    token: "r".repeat(43),
    now: () => 1_800_000_000_001,
  });
  try {
    assert.equal(life.getReminderReschedule(actor, operationId)?.state, "completed");
    assert.equal(tasks.get(oldTask.id, "user:local")?.state, "cancelled");
    assert.equal(tasks.get(replacement.replacementTaskId, "user:local")?.state, "scheduled");
    assert.equal(life.getReminderReschedule(actor, heldOperationId)?.state, "prepared");
    assert.equal(tasks.get(heldOldTask.id, "user:local")?.state, "paused");
    assert.equal(tasks.get(heldReplacement.replacementTaskId, "user:local")?.state, "paused");
    assert.throws(
      () => life.deletePersonal(actor, { preserveMemberships: true }),
      /reschedules must be recovered/,
    );
  } finally {
    await server.close();
    await tasks.close();
    plugins.close();
    life.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewed personal export and reset preserve shared data and memberships", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-personal-reset-"));
  await chmod(root, 0o700);
  const assets = join(root, "assets");
  await mkdir(assets, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "ok", { mode: 0o600 });
  const life = new LifeStore(join(root, "life.sqlite")),
    plugins = new PluginStore(join(root, "plugins.sqlite")),
    tasks = new TaskRuntime({ directory: join(root, "tasks") });
  const actor = { userId: "local" },
    group = life.createGroup(actor, { id: "home", name: "Home" });
  life.createRecord(actor, {
    kind: "source",
    title: "Private",
    body: "export this",
    scope: { type: "user", id: "local" },
    data: {},
  });
  life.createRecord(actor, {
    kind: "event",
    title: "Shared",
    scope: { type: "group", id: group.id },
    data: { startAt: Date.now() },
  });
  plugins.install("user:local", {
    name: "Mine",
    description: "Private app",
    kind: "custom",
    capabilities: [],
    html: "<!doctype html>",
  });
  const server = createLifeServer({
    stateDir: root,
    assetsDir: assets,
    store: life,
    plugins,
    tasks,
    harness: {
      chat: async () => ({ reply: "", conversationId: "c" }),
      invalidateActorContext() {},
    },
    port: 0,
    token: "r".repeat(43),
  });
  try {
    const running = await server.listen(),
      cookie = await authenticate(running.url, "r".repeat(43));
    const review = (await (
      await fetch(`${running.url}/api/life/personal-data/review`, { headers: { cookie } })
    ).json()) as { reviewToken: string; counts: { privateRecords: number; plugins: number } };
    assert.equal(review.counts.privateRecords, 1);
    assert.equal(review.counts.plugins, 1);
    const exported = (await (
      await fetch(
        `${running.url}/api/life/personal-data/export?store=life&limit=1&reviewToken=${encodeURIComponent(review.reviewToken)}`,
        { headers: { cookie } },
      )
    ).json()) as { items: unknown[] };
    assert.equal(exported.items.length, 1);
    const reset = await fetch(`${running.url}/api/life/personal-data/reset`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ reviewToken: review.reviewToken }),
    });
    assert.equal(reset.status, 200);
    assert.equal(life.personalSummary(actor).records, 0);
    assert.equal(life.listGroups(actor)[0]?.id, "home");
    assert.equal(
      life.listRecords(actor, { scope: { type: "group", id: "home" } })[0]?.title,
      "Shared",
    );
    assert.equal(plugins.personalSummary("local").plugins, 0);
    const operationId = ((await reset.json()) as { operationId: string }).operationId;
    assert.equal(
      (
        await fetch(`${running.url}/api/life/personal-data/reset/${operationId}/retry`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${running.url}/api/life/records`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({
            kind: "memory",
            title: "Fresh start",
            scope: "user:local",
            data: {},
          }),
        })
      ).status,
      201,
    );
  } finally {
    await server.close();
    await tasks.close();
    plugins.close();
    life.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted reviewed reset remains frozen and resumes after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-reset-restart-"));
  await chmod(root, 0o700);
  const assets = join(root, "assets");
  await mkdir(assets, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "ok", { mode: 0o600 });
  const life = new LifeStore(join(root, "life.sqlite")),
    plugins = new PluginStore(join(root, "plugins.sqlite"));
  life.createRecord(
    { userId: "local" },
    { kind: "memory", title: "Private", scope: { type: "user", id: "local" }, data: {} },
  );
  const originalDelete = plugins.deletePersonal.bind(plugins);
  let failOnce = true;
  (
    plugins as unknown as { deletePersonal(userId: string, expected?: number): unknown }
  ).deletePersonal = (userId, expected) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("synthetic interruption");
    }
    return originalDelete(userId, expected);
  };
  let tasks = new TaskRuntime({ directory: join(root, "tasks") });
  const makeServer = (token: string) =>
    createLifeServer({
      stateDir: root,
      assetsDir: assets,
      store: life,
      plugins,
      tasks,
      harness: {
        chat: async () => ({ reply: "", conversationId: "c" }),
        invalidateActorContext() {},
      },
      port: 0,
      token,
    });
  let server = makeServer("s".repeat(43));
  try {
    let running = await server.listen(),
      cookie = await authenticate(running.url, "s".repeat(43));
    const review = (await (
      await fetch(`${running.url}/api/life/personal-data/review`, { headers: { cookie } })
    ).json()) as { reviewToken: string };
    const failed = await fetch(`${running.url}/api/life/personal-data/reset`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ reviewToken: review.reviewToken }),
    });
    assert.equal(failed.status, 500);
    const operationId = life.getPersonalReset({ userId: "local" })!.operationId;
    assert.equal(life.getPersonalReset({ userId: "local" })!.state, "tasks-deleted");
    await server.close();
    await tasks.close();
    tasks = new TaskRuntime({ directory: join(root, "tasks") });
    server = makeServer("u".repeat(43));
    running = await server.listen();
    cookie = await authenticate(running.url, "u".repeat(43));
    const blocked = await fetch(`${running.url}/api/life/records`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ kind: "memory", title: "Too late", scope: "user:local", data: {} }),
    });
    assert.equal(blocked.status, 423);
    const retried = await fetch(
      `${running.url}/api/life/personal-data/reset/${operationId}/retry`,
      { method: "POST", headers: jsonHeaders(running.url, cookie), body: "{}" },
    );
    assert.equal(retried.status, 200);
    assert.equal(life.getPersonalReset({ userId: "local" })?.state, "completed");
    assert.equal(life.personalSummary({ userId: "local" }).records, 0);
  } finally {
    await server.close();
    await tasks.close();
    plugins.close();
    life.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a persisted life reset journal freezes runtime admission before scheduler restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-reset-crash-window-"));
  await chmod(root, 0o700);
  const assets = join(root, "assets");
  await mkdir(assets, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "ok", { mode: 0o600 });
  const actor = { userId: "local" },
    life = new LifeStore(join(root, "life.sqlite")),
    plugins = new PluginStore(join(root, "plugins.sqlite"));
  let tasks = new TaskRuntime({ directory: join(root, "tasks") });
  tasks.registerHandler({
    name: "synthetic",
    run: async (_context, input) => input,
    checkOutcome: () => true,
  });
  tasks.enqueue({ owner: "user:local", handler: "synthetic", input: { private: true } });
  const taskGeneration = tasks.personalSummary("user:local").generation,
    pluginGeneration = plugins.personalSummary("local").generation,
    lifeGeneration = life.personalSummary(actor).generation;
  life.beginPersonalReset(actor, {
    operationId: "crash-window",
    reviewTokenHash: "b".repeat(64),
    lifeGeneration,
    taskGeneration,
    pluginGeneration,
  });
  await tasks.close();
  tasks = new TaskRuntime({ directory: join(root, "tasks") });
  const server = createLifeServer({
    stateDir: root,
    assetsDir: assets,
    store: life,
    plugins,
    tasks,
    harness: {
      chat: async () => ({ reply: "", conversationId: "c" }),
      invalidateActorContext() {},
    },
    port: 0,
    token: "v".repeat(43),
  });
  try {
    assert.equal(tasks.getPersonalDeletion("user:local")?.operationId, "crash-window");
    assert.throws(
      () => tasks.enqueue({ owner: "user:local", handler: "synthetic", input: {} }),
      /frozen/,
    );
    const running = await server.listen(),
      cookie = await authenticate(running.url, "v".repeat(43));
    const current = (await (
      await fetch(`${running.url}/api/life/personal-data/reset`, { headers: { cookie } })
    ).json()) as { reset: { operationId: string } | null };
    assert.equal(current.reset?.operationId, "crash-window");
    const retry = await fetch(`${running.url}/api/life/personal-data/reset/crash-window/retry`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: "{}",
    });
    assert.equal(retry.status, 200);
  } finally {
    await server.close();
    await tasks.close();
    plugins.close();
    life.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent reset starts and completed retries cannot release a newer preflight freeze", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-reset-concurrent-"));
  await chmod(root, 0o700);
  const assets = join(root, "assets");
  await mkdir(assets, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "ok", { mode: 0o600 });
  const life = new LifeStore(join(root, "life.sqlite")),
    plugins = new PluginStore(join(root, "plugins.sqlite")),
    tasks = new TaskRuntime({ directory: join(root, "tasks") });
  let release!: () => void, chatStarted!: () => void;
  const started = new Promise<void>((resolve) => {
      chatStarted = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  const server = createLifeServer({
    stateDir: root,
    assetsDir: assets,
    store: life,
    plugins,
    tasks,
    harness: {
      async chat() {
        chatStarted();
        await blocked;
        return { reply: "done", conversationId: "c" };
      },
      invalidateActorContext() {},
    },
    port: 0,
    token: "w".repeat(43),
  });
  try {
    const running = await server.listen(),
      cookie = await authenticate(running.url, "w".repeat(43));
    const getReview = async () =>
      (await (
        await fetch(`${running.url}/api/life/personal-data/review`, { headers: { cookie } })
      ).json()) as { reviewToken: string };
    const firstReview = await getReview(),
      firstResponse = await fetch(`${running.url}/api/life/personal-data/reset`, {
        method: "POST",
        headers: jsonHeaders(running.url, cookie),
        body: JSON.stringify({ reviewToken: firstReview.reviewToken }),
      }),
      firstOperation = ((await firstResponse.json()) as { operationId: string }).operationId;
    life.createRecord(
      { userId: "local" },
      { kind: "memory", title: "New private data", scope: { type: "user", id: "local" }, data: {} },
    );
    const chat = fetch(`${running.url}/api/life/chat`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({
        scope: "user:local",
        message: "wait",
        requestId: "reset-chat",
        chatEpoch: 2,
      }),
    });
    await started;
    const secondReview = await getReview();
    const secondReset = fetch(`${running.url}/api/life/personal-data/reset`, {
      method: "POST",
      headers: jsonHeaders(running.url, cookie),
      body: JSON.stringify({ reviewToken: secondReview.reviewToken }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      (
        await fetch(`${running.url}/api/life/personal-data/reset/${firstOperation}/retry`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${running.url}/api/life/personal-data/reset`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({ reviewToken: secondReview.reviewToken }),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await fetch(`${running.url}/api/life/records`, {
          method: "POST",
          headers: jsonHeaders(running.url, cookie),
          body: JSON.stringify({
            kind: "memory",
            title: "Must stay blocked",
            scope: "user:local",
            data: {},
          }),
        })
      ).status,
      423,
    );
    release();
    await chat;
    assert.equal((await secondReset).status, 409);
  } finally {
    release();
    await server.close();
    await tasks.close();
    plugins.close();
    life.close();
    await rm(root, { recursive: true, force: true });
  }
});
