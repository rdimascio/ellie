import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import {
  LocalModelReadiness,
  validateLocalModelConfiguration,
} from "../apps/life/src/model-status.ts";

const configuration = { endpoint: "http://127.0.0.1:8080/v1", model: "installed-model" };

test("model readiness is optional and rejects nonlocal or credential-bearing setup", async () => {
  const readiness = new LocalModelReadiness(undefined, {
    fetcher: async () => {
      throw new Error("An unconfigured model must not make a request.");
    },
    now: () => 42,
  });
  assert.deepEqual(await readiness.status(), {
    mode: "deterministic",
    configured: false,
    available: false,
    checkedAt: 42,
    capabilities: { chat: false, customApps: false },
    reason: "not-configured",
  });
  for (const endpoint of [
    "https://example.com/v1",
    "http://localhost:8080/v1",
    "http://127.0.0.1.example.com/v1",
    "http://name:password@127.0.0.1/v1",
    "http://127.0.0.1/v1?token=secret",
    "http://127.0.0.1/v1#fragment",
  ])
    assert.throws(() => new LocalModelReadiness({ ...configuration, endpoint }), /loopback/);
  assert.equal(
    validateLocalModelConfiguration({ ...configuration, endpoint: "http://[::1]:8080/v1" }).href,
    "http://[::1]:8080/v1/models",
  );
  assert.throws(() => new LocalModelReadiness({ ...configuration, model: " wrong " }), /model ID/);
});

test("inventory probes coalesce, cache, and return only the configured model", async () => {
  let now = 1_000;
  let requests = 0;
  let resolve!: (value: Response) => void;
  const readiness = new LocalModelReadiness(configuration, {
    now: () => now,
    fetcher: async (url, init) => {
      requests++;
      assert.equal(String(url), "http://127.0.0.1:8080/v1/models");
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.body, undefined);
      return new Promise<Response>((done) => {
        resolve = done;
      });
    },
  });
  const first = readiness.status();
  const second = readiness.status();
  assert.equal(requests, 1);
  resolve(Response.json({ data: [{ id: "installed-model" }, { id: "private-other-model" }] }));
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.available, true);
  assert.equal(one.reason, "ready");
  assert.doesNotMatch(JSON.stringify(one), /private-other|127\.0\.0\.1/);
  one.capabilities.chat = false;
  assert.equal(two.capabilities.chat, true);
  now += 14_999;
  assert.equal((await readiness.status()).capabilities.chat, true);
  assert.equal(requests, 1);
  now += 1;
  const refreshed = readiness.status();
  resolve(Response.json({ data: [{ id: "a-different-model" }] }));
  assert.equal((await refreshed).reason, "model-not-installed");
  assert.equal(requests, 2);
  readiness.close();
});

test("unsupported, malformed and oversized inventories do not look ready", async () => {
  let cancelled = false;
  for (const response of [
    new Response("Unsupported", { status: 404 }),
    Response.json({ data: [{ id: 7 }] }),
    Response.json({ data: Array.from({ length: 257 }, () => ({ id: "installed-model" })) }),
    new Response("not json"),
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(128 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
  ]) {
    const readiness = new LocalModelReadiness(configuration, { fetcher: async () => response });
    const status = await readiness.status();
    assert.equal(status.reason, "probe-unsupported");
    assert.equal(status.available, false);
    assert.equal(status.configured, true);
    readiness.close();
  }
  assert.equal(cancelled, true);
  const failed = new LocalModelReadiness(configuration, {
    fetcher: async () => {
      throw new Error("Connection failed with private diagnostic text");
    },
  });
  assert.equal((await failed.status()).reason, "runner-unreachable");
  failed.close();
  const interrupted = new LocalModelReadiness(configuration, {
    fetcher: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("Connection closed during inventory"));
          },
        }),
      ),
  });
  assert.equal((await interrupted.status()).reason, "runner-unreachable");
  interrupted.close();
});

test("deadline bounds noncooperative probes and prevents overlapping late transports", async () => {
  let now = 1_000;
  let requests = 0;
  let resolve!: (value: Response) => void;
  let signal: AbortSignal | null | undefined;
  const readiness = new LocalModelReadiness(configuration, {
    timeoutMs: 20,
    now: () => now,
    fetcher: async (_url, init) => {
      requests++;
      signal = init?.signal;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    },
  });
  assert.equal((await readiness.status()).reason, "runner-unreachable");
  assert.equal(signal?.aborted, true);
  now += 20_000;
  assert.equal((await readiness.status()).available, false);
  assert.equal(requests, 1);
  resolve(Response.json({ data: [{ id: "installed-model" }] }));
  await new Promise<void>((done) => setImmediate(done));
  readiness.close();
  assert.equal((await readiness.status()).reason, "runner-unreachable");
  assert.equal(requests, 1);
});

test("real local inventory probe makes no inference request and rejects redirects", async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url!);
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "installed-model" }] }));
    } else {
      response.writeHead(302, { location: "/v1/models" });
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const readiness = new LocalModelReadiness({ ...configuration, endpoint: `${endpoint}/v1` });
  const redirected = new LocalModelReadiness({ ...configuration, endpoint: `${endpoint}/other` });
  try {
    assert.equal((await readiness.status()).reason, "ready");
    assert.equal((await redirected.status()).reason, "runner-unreachable");
    assert.deepEqual(paths, ["/v1/models", "/other/models"]);
  } finally {
    readiness.close();
    redirected.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
