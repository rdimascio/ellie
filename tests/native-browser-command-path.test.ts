import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { defaults } from "@ellie/config";
import { browserWebMCPResultFor } from "@ellie/protocol";
import { generateBrowserTlsIdentity } from "../apps/cli/src/certificate.ts";
import { BrowserNodeExecutor } from "../apps/node/src/browser-executor.ts";
import { BrowserOperationSelector } from "../apps/node/src/browser-operation-selector.ts";
import { BrowserWebMCPOperations } from "../apps/node/src/browser-operations.ts";
import type { BrowserAccessibilityRuntime } from "../apps/node/src/browser-accessibility-runtime.ts";
import { runNode } from "../apps/node/src/index.ts";
import { BrowserAuth } from "../apps/server/src/browser-auth.ts";
import { createBrowserRemote } from "../apps/server/src/browser-remote.ts";
import { createBrowserServer } from "../apps/server/src/browser-server.ts";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import { fixture } from "./helpers.ts";

const target = "native-seam-mini";

async function availablePort(): Promise<number> {
  const reservation = createNetServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("native authenticated browser status reaches one terminal unavailable node job", async () => {
  const coordinator = await fixture(3_000);
  const abort = new AbortController();
  let agent: Promise<void> | undefined;
  let browser: ReturnType<typeof createBrowserServer> | undefined;
  let bridgeRequests = 0;
  let accessibilityCalls = 0;
  let desktopCalls = 0;
  const events: string[] = [];
  try {
    const node = await coordinator.pair(target);
    const webmcp = new BrowserWebMCPOperations(
      {
        request: async (request) => {
          bridgeRequests++;
          return browserWebMCPResultFor(request.id, "unavailable");
        },
      },
      { version: 1, bindings: [] },
    );
    const selector = new BrowserOperationSelector(
      (signal, refresh) => (refresh ? webmcp.bindingRefresh(signal) : webmcp.bindingStatus(signal)),
      webmcp,
      {
        execute: async () => {
          accessibilityCalls++;
          throw new Error("Accessibility must not run without a binding.");
        },
      } as unknown as BrowserAccessibilityRuntime,
    );
    let registered!: () => void;
    const ready = new Promise<void>((resolve) => (registered = resolve));
    agent = runNode({
      client: node,
      preferences: defaults,
      signal: abort.signal,
      executor: new BrowserNodeExecutor(
        {
          capabilities: async () => ["app.open"],
          execute: async () => {
            desktopCalls++;
            throw new Error("Desktop execution must not run for browser status.");
          },
        },
        selector,
      ),
      onStatus: registered,
      onEvent: (event) => events.push(event),
    });
    await ready;

    const identity = await generateBrowserTlsIdentity("ellie.local");
    const port = await availablePort();
    const nativeAuth = new NativeAuth(NativeAuth.empty(), async () => {});
    browser = createBrowserServer({
      key: identity.leafKey,
      cert: identity.leafCert,
      origin: `https://ellie.local:${port}`,
      auth: new BrowserAuth(BrowserAuth.empty(), async () => {}),
      nativeAuth,
      remote: createBrowserRemote(coordinator.controller, [{ id: target, label: "Test Mini" }]),
    });
    await new Promise<void>((resolve, reject) => {
      browser!.server.once("error", reject);
      browser!.server.listen(port, "127.0.0.1", resolve);
    });

    async function nativeRequest(path: string, body: unknown, token?: string) {
      const data = JSON.stringify(body);
      return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const request = httpsRequest(
          {
            host: "127.0.0.1",
            port,
            servername: "ellie.local",
            path,
            method: "POST",
            ca: identity.rootCert,
            rejectUnauthorized: true,
            timeout: 5_000,
            headers: {
              host: `ellie.local:${port}`,
              "x-ellie-version": "1",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(data),
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.once("error", reject);
            response.once("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
              }),
            );
          },
        );
        request.once("timeout", () => request.destroy(new Error("Native fixture timed out.")));
        request.once("error", reject);
        request.end(data);
      });
    }

    async function pair(grants: ("app.open" | "browser.read")[], token: string) {
      const invitation = await nativeAuth.invite({
        label: "Synthetic iPhone",
        grants: [{ target, capabilities: grants }],
      });
      assert.equal(
        (await nativeRequest("/native/v1/pair", { invitation: invitation.code, token })).status,
        200,
      );
    }

    const deniedToken = "1".repeat(64);
    await pair(["app.open"], deniedToken);
    const command = { nodeId: target, action: { tool: "browser.status" } };
    assert.equal((await nativeRequest("/native/v1/commands", command, deniedToken)).status, 403);
    assert.equal(coordinator.jobStore.list(target, 1).length, 0);
    assert.equal(bridgeRequests, 0);

    const grantedToken = "2".repeat(64);
    await pair(["browser.read"], grantedToken);
    const response = await nativeRequest("/native/v1/commands", command, grantedToken);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      outcome: "failed",
      result: {
        ok: false,
        message: "Browser connection is unavailable.",
        browser: { source: "webmcp", operation: "status", status: "unavailable" },
      },
    });
    assert.equal(bridgeRequests, 1);
    assert.equal(accessibilityCalls, 0);
    assert.equal(desktopCalls, 0);
    const jobs = coordinator.jobStore.list(target, 2);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.state, "failed");
    assert.deepEqual(events, ["connected"]);
  } finally {
    if (browser) {
      const closed = browser.server.listening
        ? new Promise<void>((resolve) => browser!.server.once("close", resolve))
        : Promise.resolve();
      browser.shutdown();
      await closed;
    }
    abort.abort();
    await coordinator.close();
    await agent;
  }
});
