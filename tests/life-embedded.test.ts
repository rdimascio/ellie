import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEmbeddedLifeApplication } from "../apps/life/src/embedded.ts";
import {
  createLifeServer,
  type LifeEmbeddedContext,
  type LifeServerOptions,
} from "../apps/life/src/server.ts";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { createLifeHarness, type LifeModel } from "../packages/life-harness/src/index.ts";
import { MLBAdapter, PluginStore } from "../packages/life-plugins/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";

const actor = { userId: "alice" };
const scope = { type: "user" as const, id: actor.userId };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release,
    async wait() {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Fixture operation did not start.")), 5_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "ellie-life-embedded-"));
  await chmod(root, 0o700);
  const assets = join(root, "ui");
  await mkdir(join(assets, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(assets, "index.html"),
    '<!doctype html><title>Ellie Life</title><script type="module" src="./assets/life.js"></script>',
    { mode: 0o600 },
  );
  await writeFile(join(assets, "assets", "life.js"), 'document.title = "Fixture Life";', {
    mode: 0o600,
  });
  return { root, assets };
}

type Application = {
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: LifeEmbeddedContext,
  ): Promise<boolean>;
};

/** Trusted context injection only. Production native authentication is tested separately. */
async function gateway(application: Application) {
  const clients = new Map(
    ["mac", "phone", "outsider"].map((id) => [
      id,
      {
        actorId: id === "outsider" ? "bob" : actor.userId,
        current: true,
        controller: new AbortController(),
      },
    ]),
  );
  const server = createServer((request, response) => {
    const clientId = String(request.headers["x-fixture-client"] ?? "mac");
    const client = clients.get(clientId);
    if (!client) {
      response.writeHead(401).end();
      return;
    }
    void application
      .handle(request, response, {
        actorId: client.actorId,
        clientId,
        origin: "https://coordinator.example:7443",
        signal: client.controller.signal,
        isCurrent: () => client.current,
      })
      .then((handled) => {
        if (!handled) response.writeHead(404).end();
      })
      .catch(() => {
        if (!response.destroyed && !response.writableEnded) response.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    clients,
    request(path: string, client = "mac", body?: unknown, method?: string) {
      return fetch(`${url}${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: { "x-fixture-client": client, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function fixture(
  options: { model?: LifeModel; extractor?: LifeServerOptions["extractor"] } = {},
) {
  const files = await workspace();
  const life = new LifeStore(join(files.root, "life.sqlite"));
  const plugins = new PluginStore(join(files.root, "plugins.sqlite"));
  const tasks = new TaskRuntime({
    directory: join(files.root, "tasks"),
    capabilityResolver: () => ["life.records.read", "life.records.write"],
  });
  const harness = createLifeHarness({
    store: life,
    plugins,
    tasks,
    mlb: new MLBAdapter(),
    model: options.model,
  });
  const server = createLifeServer({
    stateDir: files.root,
    assetsDir: files.assets,
    userId: actor.userId,
    store: life,
    plugins,
    tasks,
    harness,
    extractor: options.extractor,
  });
  await server.prepareEmbedded();
  const transport = await gateway({
    handle: (request, response, context) => server.handleEmbedded(request, response, context),
  });
  return {
    ...transport,
    ...files,
    life,
    tasks,
    plugins,
    async close() {
      await transport.close();
      await server.close();
      await tasks.close();
      plugins.close();
      life.close();
      await rm(files.root, { recursive: true, force: true });
    },
  };
}

test("embedded factory shares durable Life records, conversations and automatic memory across two devices and restart", async () => {
  const files = await workspace();
  let application: Awaited<ReturnType<typeof createEmbeddedLifeApplication>> | undefined;
  let transport: Awaited<ReturnType<typeof gateway>> | undefined;
  const seed = new LifeStore(join(files.root, "life.sqlite"));
  const other = { userId: "bob" };
  const otherGroup = seed.createGroup(other, { name: "Bob's private household" });
  const otherRecord = seed.createRecord(other, {
    kind: "memory",
    scope: { type: "user", id: "bob" },
    title: "Bob's private secret",
  });
  seed.close();
  const start = async () => {
    application = await createEmbeddedLifeApplication({
      stateDir: files.root,
      assetsDir: files.assets,
      userId: actor.userId,
      openAuthorizationUrl: async () => false,
    });
    transport = await gateway(application);
    return transport;
  };
  try {
    let api = await start();
    const created = await api.request("/api/life/records", "mac", {
      scope: "user:alice",
      kind: "memory",
      title: "The same note on my devices",
    });
    assert.equal(created.status, 201);
    const record = (await created.json()) as { id: string };
    const phoneRecord = await api.request(`/api/life/records/${record.id}`, "phone");
    assert.equal(phoneRecord.status, 200);
    assert.match(await phoneRecord.text(), /The same note on my devices/);
    assert.equal((await api.request(`/api/life/records/${record.id}`, "outsider")).status, 401);
    assert.equal((await api.request(`/api/life/records/${otherRecord.id}`, "phone")).status, 404);
    assert.equal(
      (await api.request(`/api/life/bootstrap?scope=group:${otherGroup.id}`, "phone")).status,
      403,
    );
    assert.equal(
      (
        await api.request("/api/life/records", "phone", {
          scope: "user:bob",
          kind: "memory",
          title: "Forged actor",
          actorId: "bob",
        })
      ).status,
      403,
    );
    const groupResponse = await api.request("/api/life/groups", "mac", {
      name: "Alice's existing Life space",
    });
    assert.equal(groupResponse.status, 201);
    const group = (await groupResponse.json()) as { id: string };
    assert.equal(
      (
        await api.request("/api/life/records", "phone", {
          scope: `group:${group.id}`,
          kind: "memory",
          title: "Explicit Life membership still works",
        })
      ).status,
      201,
    );
    const groupBootstrap = await api.request(
      `/api/life/bootstrap?scope=group:${group.id}`,
      "phone",
    );
    assert.equal(groupBootstrap.status, 200);
    assert.match(await groupBootstrap.text(), /Explicit Life membership still works/);

    const chat = await api.request("/api/life/chat", "mac", {
      scope: "user:alice",
      message: "Remember that I prefer chamomile tea.",
      requestId: "shared-memory",
      chatEpoch: 1,
    });
    assert.equal(chat.status, 200);
    const conversation = (await chat.json()) as { conversationId: string };
    const memory = await api.request("/api/life/memory?scope=user:alice", "phone");
    assert.equal(memory.status, 200);
    assert.match(await memory.text(), /chamomile tea/);
    await api.close();
    transport = undefined;
    await application!.close();
    application = undefined;
    api = await start();
    assert.match(
      await (await api.request(`/api/life/records/${record.id}`, "phone")).text(),
      /The same note on my devices/,
    );
    const retained = await api.request(
      `/api/life/conversations/${conversation.conversationId}`,
      "phone",
    );
    assert.equal(retained.status, 200);
    assert.match(await retained.text(), /chamomile tea/);
    assert.match(
      await (await api.request("/api/life/memory?scope=user:alice", "phone")).text(),
      /chamomile tea/,
    );
    assert.doesNotMatch(
      await (await api.request("/api/life/bootstrap", "phone")).text(),
      /Bob's private/,
    );
  } finally {
    await transport?.close();
    await application?.close();
    await rm(files.root, { recursive: true, force: true });
  }
});

test("embedded routes preserve relative assets and sandboxed plugin documents while refusing local sessions and remote OAuth", async () => {
  const f = await fixture();
  try {
    const index = await f.request("/life/", "phone");
    assert.equal(index.status, 200);
    assert.match(await index.text(), /src="\.\/assets\/life.js"/);
    assert.equal(index.headers.get("cache-control"), "no-store");
    const asset = await f.request("/life/assets/life.js", "phone");
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /Fixture Life/);
    assert.equal(
      (await f.request("/api/life/session", "phone", { token: "a".repeat(43) })).status,
      404,
    );
    assert.equal(
      (
        await f.request("/api/connections/start", "phone", {
          provider: "google-calendar",
          mode: "observe",
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.request("/api/connections/callback?code=fixture&state=fixture", "phone")).status,
      409,
    );
    assert.equal((await f.request("/api/connections", "phone")).status, 200);
    const built = await f.request("/api/life/plugins/build", "phone", {
      scope: "user:alice",
      request: "build an arcade",
    });
    assert.equal(built.status, 201);
    const plugin = (await built.json()) as { id: string };
    const view = await f.request(`/api/life/plugins/${plugin.id}/view`, "phone");
    assert.equal(view.status, 200);
    assert.match(view.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/);
    const html = await view.text();
    assert.match(html, /frame\.sandbox='allow-scripts'/);
    assert.match(html, /frame\.srcdoc=/);
    assert.doesNotMatch(html, /__Host-ellie_life|sessionToken|Authorization/);
  } finally {
    await f.close();
  }
});

test("original device authority gates progress and late model actions even when another device remains authorized", async () => {
  const entered = gate(),
    release = gate();
  const f = await fixture({
    model: {
      async plan(_request, _signal, progress) {
        progress?.({ phase: "drafting", text: "Provisional result from the original device" });
        entered.release();
        await release.promise; // Deliberately uncooperative model; host checks must still hold.
        return {
          reply: "Late result",
          actions: [
            { type: "create_memory", title: "Forbidden late memory", body: "Must never commit" },
          ],
        };
      },
    },
  });
  let pending: Promise<Response> | undefined;
  try {
    pending = f.request("/api/life/chat", "mac", {
      scope: "user:alice",
      message: "Consider a useful idea for tomorrow",
      requestId: "held-model",
      chatEpoch: 1,
    });
    await entered.wait();
    const initial = await f.request("/api/life/chat/requests/held-model", "phone");
    assert.equal(initial.status, 200);
    assert.match(await initial.text(), /Provisional result from the original device/);
    f.clients.get("mac")!.current = false; // Expiry without AbortSignal tests the captured predicate.
    const afterExpiry = await f.request("/api/life/chat/requests/held-model", "phone");
    assert.equal(afterExpiry.status, 200);
    const state = (await afterExpiry.json()) as { progress?: unknown };
    assert.equal(
      state.progress,
      undefined,
      "phone context must not lend its authority to expired Mac work",
    );
    release.release();
    assert.equal((await pending).status, 401);
    assert.equal(
      f.life
        .listRecords(actor, { scope })
        .some((record) => record.title === "Forbidden late memory"),
      false,
    );
    assert.equal((await f.request("/api/life/bootstrap", "phone")).status, 200);
  } finally {
    release.release();
    await pending?.catch(() => undefined);
    await f.close();
  }
});

test("revocation aborts source extraction and rejects a late uncooperative result", async () => {
  const entered = gate(),
    release = gate();
  let extractionSignal: AbortSignal | undefined;
  const f = await fixture({
    extractor: async (input) => {
      extractionSignal = input.signal;
      entered.release();
      await release.promise;
      return { text: "Late private extracted content" };
    },
  });
  let pending: Promise<Response> | undefined;
  try {
    pending = f.request("/api/life/sources", "mac", {
      scope: "user:alice",
      filename: "fixture.pdf",
      mimeType: "application/pdf",
      encoding: "base64",
      content: Buffer.from("Synthetic file").toString("base64"),
    });
    await entered.wait();
    f.clients.get("mac")!.controller.abort();
    assert.equal(extractionSignal?.aborted, true);
    release.release();
    assert.equal((await pending).status, 401);
    assert.equal(f.life.listRecords(actor, { scope, kinds: ["source"] }).length, 0);
  } finally {
    release.release();
    await pending?.catch(() => undefined);
    await f.close();
  }
});

test("a durably authorized personal reset completes as host work after its initiating device expires", async () => {
  const f = await fixture();
  const entered = gate(),
    release = gate();
  const drain = f.tasks.drainPersonalDeletion.bind(f.tasks);
  f.tasks.drainPersonalDeletion = async (...args) => {
    entered.release();
    await release.promise;
    return drain(...args);
  };
  let pending: Promise<Response> | undefined;
  try {
    f.life.createRecord(actor, { scope, kind: "memory", title: "Private record to reset" });
    const group = f.life.createGroup(actor, { name: "Keep authorized Life space" });
    f.life.createRecord(actor, {
      scope: { type: "group", id: group.id },
      kind: "memory",
      title: "Keep shared record",
    });
    const reviewResponse = await f.request("/api/life/personal-data/review", "mac");
    assert.equal(reviewResponse.status, 200);
    const review = (await reviewResponse.json()) as { reviewToken: string };
    pending = f.request("/api/life/personal-data/reset", "mac", {
      reviewToken: review.reviewToken,
    });
    await entered.wait();
    assert.equal(f.life.getPersonalReset(actor)?.state, "draining");
    const operationId = f.life.getPersonalReset(actor)!.operationId;
    f.clients.get("mac")!.current = false;
    release.release();
    assert.equal((await pending).status, 401);
    assert.equal(f.life.getPersonalReset(actor)?.state, "completed");
    assert.equal(f.life.listRecords(actor, { scope }).length, 0);
    assert.equal(
      f.life.listRecords(actor, { scope: { type: "group", id: group.id } })[0]?.title,
      "Keep shared record",
    );
    const status = await f.request(`/api/life/personal-data/reset/${operationId}`, "phone");
    assert.equal(status.status, 200);
    assert.match(await status.text(), /completed/);
  } finally {
    release.release();
    await pending?.catch(() => undefined);
    await f.close();
  }
});
