import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLifeServer } from "../apps/life/src/server.ts";
import { LifeStore } from "../packages/life-core/src/index.ts";
import {
  createLifeHarness,
  type LifeModel,
  type LifeModelPlan,
  type LifeModelProgress,
} from "../packages/life-harness/src/index.ts";
import { MLBAdapter, PluginStore } from "../packages/life-plugins/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("request progress is bounded, provisional, ownership checked and invalidated before final authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-chat-progress-"));
  await chmod(root, 0o700);
  const assets = join(root, "assets");
  await mkdir(assets, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Fixture</title>");
  const actor = { userId: "progress-fixture" },
    scope = { type: "user" as const, id: actor.userId };
  const store = new LifeStore(join(root, "life.sqlite"));
  const plugins = new PluginStore(join(root, "plugins.sqlite"));
  const tasks = new TaskRuntime({
    directory: join(root, "tasks"),
    capabilityResolver: () => ["life.records.read", "life.records.write"],
  });
  let started = deferred<void>();
  let completion = deferred<LifeModelPlan>();
  let emit: ((value: LifeModelProgress) => void) | undefined;
  let signal: AbortSignal | undefined;
  let calls = 0;
  const model: LifeModel = {
    async plan(_request, incomingSignal, onProgress) {
      calls++;
      signal = incomingSignal;
      emit = onProgress;
      started.resolve();
      return completion.promise;
    },
  };
  const harness = createLifeHarness({ store, plugins, tasks, model, mlb: new MLBAdapter() });
  const token = randomUUID().replaceAll("-", "") + randomUUID();
  const server = createLifeServer({
    stateDir: root,
    assetsDir: assets,
    store,
    plugins,
    tasks,
    harness,
    userId: actor.userId,
    port: 0,
    token,
  });
  try {
    const { url } = await server.listen();
    const login = await fetch(`${url}/api/life/session`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(login.status, 204);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const post = (requestId: string, targetScope = `user:${actor.userId}`) =>
      fetch(`${url}/api/life/chat`, {
        method: "POST",
        headers: { cookie, origin: url, "content-type": "application/json" },
        body: JSON.stringify({
          message: "Suggest a simple weekend idea",
          requestId,
          chatEpoch: store.chatEpoch(actor),
          scope: targetScope,
          progress: { text: "client-forged-preview" },
        }),
      });
    const status = async (requestId: string) => {
      const response = await fetch(`${url}/api/life/chat/requests/${requestId}`, {
        headers: { cookie },
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const id = randomUUID();
    const pending = post(id);
    await started.promise;
    assert.ok(signal, "service abort signal reaches the model through the harness");
    assert.ok(emit);
    assert.equal((await fetch(`${url}/api/life/chat/requests/${id}`)).status, 401);
    assert.equal((await status(randomUUID())).status, 404);
    assert.equal((await status(id)).body.progress.text, undefined);
    emit({ phase: "drafting", text: "only-provisional: pretend completed" });
    let snapshot = (await status(id)).body;
    assert.equal(snapshot.status, "pending");
    assert.equal(snapshot.progress.text, "only-provisional: pretend completed");
    assert.equal(snapshot.reply, undefined);
    assert.equal(store.listRecords(actor, { scope }).length, 0);
    const duplicate = await post(id);
    assert.equal(duplicate.status, 200);
    assert.equal(calls, 1, "status and repeated request do not rerun inference");
    emit({ phase: "drafting", text: "🌿".repeat(8000) });
    snapshot = (await status(id)).body;
    assert.ok(Buffer.byteLength(snapshot.progress.text) <= 8192);
    assert.equal(snapshot.progress.text.includes("\uFFFD"), false);
    const previousRevision = snapshot.progress.revision;
    emit({ phase: "drafting" });
    snapshot = (await status(id)).body;
    assert.ok(snapshot.progress.revision > previousRevision);
    assert.equal(
      snapshot.progress.text,
      undefined,
      "a repair replaces and clears the previous draft",
    );
    emit({ phase: "validating", text: "only-provisional final draft" });
    completion.resolve({ reply: "A short walk could be nice.", actions: [] });
    const finalResponse = await pending;
    assert.equal(finalResponse.status, 200);
    const final = (await finalResponse.json()) as { reply: string; conversationId: string };
    assert.equal(final.reply, "A short walk could be nice.");
    emit({ phase: "drafting", text: "late callback" });
    assert.equal((await status(id)).body.progress, undefined);
    assert.equal(
      JSON.stringify(store.getConversation(actor, final.conversationId)).includes(
        "only-provisional",
      ),
      false,
    );

    started = deferred<void>();
    completion = deferred<LifeModelPlan>();
    const staleId = randomUUID(),
      stale = post(staleId);
    await started.promise;
    emit!({ phase: "drafting", text: "private stale preview" });
    store.createRecord(actor, {
      scope,
      kind: "memory",
      title: "Newer preference",
      data: { body: "A changed context" },
    });
    assert.equal((await status(staleId)).body.progress, undefined);
    emit!({ phase: "drafting", text: "must remain hidden" });
    assert.equal((await status(staleId)).body.progress, undefined);
    completion.resolve({
      reply: "Stale suggestion",
      actions: [{ type: "create_memory", title: "must not save", body: "stale" }],
    });
    assert.equal((await stale).status, 200);
    assert.equal(
      store.listRecords(actor, { scope }).some((r) => r.title === "must not save"),
      false,
    );

    const owner = { userId: "group-owner" };
    const group = store.createGroup(owner, { name: "Fixture group" });
    store.setGroupMember(owner, group.id, { userId: actor.userId, role: "member" });
    started = deferred<void>();
    completion = deferred<LifeModelPlan>();
    const groupId = randomUUID(),
      groupPending = post(groupId, `group:${group.id}`);
    await started.promise;
    emit!({ phase: "drafting", text: "private group draft" });
    store.setGroupMember(owner, group.id, { userId: actor.userId, remove: true });
    assert.equal((await status(groupId)).status, 403);
    completion.resolve({ reply: "Group reply", actions: [] });
    assert.equal((await groupPending).status, 403);
  } finally {
    completion.resolve({ reply: "Cleanup", actions: [] });
    await server.close();
    await tasks.close();
    plugins.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
