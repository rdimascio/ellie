import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaults } from "@ellie/config";
import { record } from "@ellie/protocol";
import { Client } from "@ellie/transport";
import { generateBrowserTlsIdentity, generateCertificate } from "../apps/cli/src/certificate.ts";
import { initializeBrowser, BROWSER_CA_CERT } from "../apps/cli/src/browser-setup.ts";
import { createBrowserRuntime } from "../apps/cli/src/browser-runtime.ts";
import { parseHouseholdCommand, runHouseholdCommand } from "../apps/cli/src/household-commands.ts";
import { Auth, newToken } from "../apps/server/src/auth.ts";
import { createBrowserServer } from "../apps/server/src/browser-server.ts";
import type { BrowserServer } from "../apps/server/src/browser-server.ts";
import { createEllieServer } from "../apps/server/src/index.ts";
import { JobStore } from "../apps/server/src/jobs.ts";

test(
  "production runtime, controller CLI and two native HTTPS clients persist conditional state without actions",
  { timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "ellie-household-integration-"));
    const values = new Map<string, string>();
    const setup = {
      stateDir: directory,
      secrets: {
        async get(key: string) {
          const value = values.get(key);
          if (!value) throw new Error("Missing synthetic secret.");
          return value;
        },
        async set(key: string, value: string) {
          values.set(key, value);
        },
        async has(key: string) {
          return values.has(key);
        },
        async add(key: string, value: string) {
          assert.equal(values.has(key), false);
          values.set(key, value);
        },
        async delete(key: string) {
          values.delete(key);
        },
      },
      localHostname: async () => "household-test.local",
      generate: generateBrowserTlsIdentity,
      now: Date.now,
    };
    let runtime: ReturnType<typeof createBrowserRuntime> | undefined;
    let listener: BrowserServer | undefined;
    let coordinator: ReturnType<typeof createEllieServer> | undefined;
    let controller: Client | undefined;
    let dispatched = 0;
    let writes = 0;
    let discardNextWriteResponse = false;
    const stopRuntime = async () => {
      const closed = listener?.server.listening ? once(listener.server, "close") : undefined;
      await runtime?.shutdown();
      await closed;
    };
    t.after(async () => {
      controller?.close();
      if (coordinator) {
        const closed = coordinator.server.listening ? once(coordinator.server, "close") : undefined;
        coordinator.shutdown();
        await closed;
      }
      await stopRuntime();
      await rm(directory, { recursive: true, force: true });
    });
    const config = await initializeBrowser(setup);
    const ca = await readFile(join(directory, BROWSER_CA_CERT), "utf8");
    const startRuntime = async () => {
      runtime = createBrowserRuntime({
        setup,
        bindHost: "127.0.0.1",
        loadAssets: async () =>
          new Map([["/", { contentType: "text/html", body: Buffer.from("Synthetic fixture") }]]),
        createRemote: async () => ({
          remote: {
            nodes: async () => [
              { id: "qa-mac", label: "QA Mac", online: true, capabilities: ["app.open"] },
            ],
            openApp: async () => {
              dispatched++;
              return { ok: true, message: "Synthetic action." };
            },
          },
          close() {},
        }),
        createServer: (options) => {
          listener = createBrowserServer(options);
          // Bind a kernel-selected loopback port while retaining the production configured Host check.
          const listen = listener.server.listen.bind(listener.server);
          listener.server.listen = (() => listen(0, "127.0.0.1")) as typeof listener.server.listen;
          listener.server.prependListener("request", (incoming, response) => {
            if (incoming.method !== "PUT") return;
            writes++;
            if (!discardNextWriteResponse) return;
            discardNextWriteResponse = false;
            // Simulate a connection lost after commit, before any success body reaches the client.
            response.end = (() => {
              incoming.socket.destroy();
              return response;
            }) as typeof response.end;
          });
          return listener;
        },
      });
      await runtime.start();
      assert.equal(runtime.current().status, "ready");
    };
    await startRuntime();
    const identity = await generateCertificate();
    const controllerToken = newToken();
    await Auth.initialize(controllerToken, directory);
    const jobs = new JobStore(join(directory, "jobs.sqlite"));
    coordinator = createEllieServer({
      ...identity,
      auth: await Auth.open(directory),
      preferences: defaults,
      jobStore: jobs,
      browser: { current: () => runtime!.current() },
    });
    coordinator.server.listen(0, "127.0.0.1");
    await once(coordinator.server, "listening");
    controller = new Client(
      `https://127.0.0.1:${(coordinator.server.address() as AddressInfo).port}`,
      identity.cert,
      controllerToken,
    );
    const cli = (args: string[]) => runHouseholdCommand(controller!, parseHouseholdCommand(args));
    const native = (
      token: string | undefined,
      method: string,
      path: string,
      body?: unknown,
      revision?: string,
    ) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      return new Promise<{ status: number; body: unknown; etag?: string }>((resolve, reject) => {
        const outgoing = request(
          {
            hostname: "127.0.0.1",
            port: (listener!.server.address() as AddressInfo).port,
            servername: config.hostname,
            ca,
            rejectUnauthorized: true,
            method,
            path,
            signal: AbortSignal.timeout(5_000),
            headers: {
              host: `${config.hostname}:${config.port}`,
              "x-ellie-version": "1",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              ...(revision === undefined ? {} : { "if-match": revision }),
              ...(data === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(data),
                  }),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 300_000) {
                outgoing.destroy(new Error("Synthetic response exceeded limit."));
                return;
              }
              chunks.push(chunk);
            });
            response.once("error", reject);
            response.once("end", () => {
              try {
                assert.equal(response.headers["cache-control"], "no-store");
                resolve({
                  status: response.statusCode!,
                  body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                  etag: response.headers.etag,
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        outgoing.once("error", reject);
        outgoing.end(data);
      });
    };
    const enroll = async (label: string) => {
      const invitation = record(
        await controller!.call("POST", "/v1/native/invitations", {
          label,
          grants: [{ target: "qa-mac", capabilities: ["app.open"] }],
        }),
      );
      const token = randomBytes(32).toString("hex");
      const paired = await native(undefined, "POST", "/native/v1/pair", {
        invitation: invitation.invitation,
        token,
      });
      assert.equal(paired.status, 200);
      const client = record(record(paired.body).client);
      assert.equal(typeof client.id, "string");
      return { token, id: client.id as string };
    };
    const a = await enroll("Phone A");
    const b = await enroll("Phone B");
    const shared = "/native/v1/household/shared/dashboards";
    const privatePath = "/native/v1/household/private/dashboards";
    const document = (name: string) => ({
      version: 1,
      dashboards: [{ id: "home", name, widgets: [] }],
    });
    assert.deepEqual(JSON.parse(await cli(["grants"])), []);
    assert.equal((await native(a.token, "GET", shared)).status, 403);
    for (const client of [a, b])
      for (const profile of ["shared", "private"]) {
        assert.equal(
          await cli(["grant", client.id, profile, "dashboards", "write"]),
          "Household data grant saved.",
        );
      }
    assert.equal(JSON.parse(await cli(["grants"])).length, 4);
    assert.equal((await native(a.token, "GET", shared)).etag, '"ellie-revision-0"');
    assert.equal(
      (await native(a.token, "PUT", shared, { value: document("One") }, '"ellie-revision-0"'))
        .status,
      200,
    );
    assert.equal((await native(b.token, "GET", shared)).etag, '"ellie-revision-1"');
    discardNextWriteResponse = true;
    await assert.rejects(
      native(a.token, "PUT", shared, { value: document("Two") }, '"ellie-revision-1"'),
    );
    const recovered = await native(a.token, "GET", shared);
    assert.equal(recovered.etag, '"ellie-revision-2"');
    assert.deepEqual(record(recovered.body).value, document("Two"));
    assert.equal(writes, 2, "Recovery must not repeat the PUT.");
    const conflict = await native(
      b.token,
      "PUT",
      shared,
      { value: document("Stale draft") },
      '"ellie-revision-1"',
    );
    assert.equal(conflict.status, 412);
    assert.deepEqual(conflict.body, { profile: "shared", kind: "dashboards", revision: 2 });
    await native(
      a.token,
      "PUT",
      privatePath,
      { value: document("Private A") },
      '"ellie-revision-0"',
    );
    assert.deepEqual(record((await native(b.token, "GET", privatePath)).body).value, {
      version: 1,
      dashboards: [],
    });
    await stopRuntime();
    await startRuntime();
    assert.deepEqual(record((await native(b.token, "GET", shared)).body).value, document("Two"));
    assert.deepEqual(
      record((await native(a.token, "GET", privatePath)).body).value,
      document("Private A"),
    );
    assert.equal(
      await cli(["revoke", a.id, "shared", "dashboards"]),
      "Household data grant revoked.",
    );
    assert.equal((await native(a.token, "GET", shared)).status, 403);
    assert.equal((await native(a.token, "GET", "/native/v1/session")).status, 200);
    await controller.call("POST", "/v1/native/revoke", { id: a.id });
    assert.equal((await native(a.token, "GET", privatePath)).status, 401);
    assert.equal(dispatched, 0);
    assert.deepEqual(jobs.list(), []);
    assert.equal(writes, 4, "Only the explicitly issued document writes reached the listener.");
  },
);
