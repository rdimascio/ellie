import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { connect } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import test from "node:test";
import {
  BROWSER_WEBMCP_LIMITS,
  BROWSER_WEBMCP_PROTOCOL,
  browserWebMCPRequest,
  browserWebMCPResult,
} from "@ellie/protocol";
import {
  browserWebMCPFrame,
  browserWebMCPRuntimeDirectory,
  startBrowserWebMCPBridge,
} from "../apps/node/src/browser-webmcp-bridge.ts";
import {
  browserWebMCPNativeHostManifest,
  ELLIE_BROWSER_EXTENSION_ID,
  ellieBrowserWebMCPNativeHostManifest,
  runBrowserWebMCPNativeHost,
} from "../apps/node/src/browser-native-host.ts";
import { browserWebMCPHostInstallationPlan } from "../scripts/browser-webmcp-host-setup.ts";
import { BrowserWebMCPOperations } from "../apps/node/src/browser-operations.ts";

const statusRequest = (id = "request-1") => ({
  protocol: BROWSER_WEBMCP_PROTOCOL,
  id,
  type: "binding.status" as const,
});

function frameQueue(stream: PassThrough) {
  const values: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  browserWebMCPFrame.accept(stream, (value) => {
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else values.push(value);
  });
  return {
    next: () =>
      values.length
        ? Promise.resolve(values.shift())
        : new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("frame timeout")), 2_000);
            waiters.push((value) => {
              clearTimeout(timeout);
              resolve(value);
            });
          }),
  };
}

async function waitForBridge(
  bridge: { connected(): boolean; connectionContext(): unknown },
  connected: boolean,
): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (
    connected ? !bridge.connected() || !bridge.connectionContext() : bridge.connectionContext()
  ) {
    if (performance.now() >= deadline) throw new Error("bridge state timeout");
    await yieldEventLoop();
  }
}

test("WebMCP wire grammar is exact and bounded", () => {
  assert.deepEqual(browserWebMCPRequest(statusRequest()), statusRequest());
  assert.deepEqual(
    browserWebMCPRequest({ ...statusRequest("refresh-1"), type: "binding.refresh" }),
    { ...statusRequest("refresh-1"), type: "binding.refresh" },
  );
  assert.throws(() => browserWebMCPRequest({ ...statusRequest(), extra: true }), /Invalid/);
  assert.throws(
    () =>
      browserWebMCPRequest({
        protocol: BROWSER_WEBMCP_PROTOCOL,
        id: "execute",
        type: "tool.execute",
        bindingId: "binding",
        documentId: "document",
        toolHandle: "tool",
        args: { value: "x".repeat(BROWSER_WEBMCP_LIMITS.maximumArgumentsBytes) },
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      browserWebMCPResult({
        protocol: BROWSER_WEBMCP_PROTOCOL,
        id: "request",
        type: "result",
        status: "unknown",
        value: {},
      }),
    /Invalid/,
  );
});

test("native host manifest fixes one extension and executable", () => {
  const manifest = browserWebMCPNativeHostManifest(
    "a".repeat(32),
    "/Applications/Ellie.app/Contents/MacOS/bridge",
  );
  assert.equal(manifest.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(manifest), {
    name: "org.ellie.browser_webmcp",
    description: "Ellie WebMCP bridge",
    path: "/Applications/Ellie.app/Contents/MacOS/bridge",
    type: "stdio",
    allowed_origins: [`chrome-extension://${"a".repeat(32)}/`],
  });
  assert.throws(() => browserWebMCPNativeHostManifest("extension", "/tmp/host"), /Invalid/);
  assert.throws(() => browserWebMCPNativeHostManifest("a".repeat(32), "relative"), /Invalid/);
  const fixed = JSON.parse(ellieBrowserWebMCPNativeHostManifest("/release/payload/bin/host"));
  assert.deepEqual(fixed.allowed_origins, [`chrome-extension://${ELLIE_BROWSER_EXTENSION_ID}/`]);
  const plan = browserWebMCPHostInstallationPlan("/captured/release-id");
  assert.equal(plan.executablePath, "/captured/release-id/payload/bin/ellie-browser-webmcp-host");
  assert.equal(JSON.parse(plan.manifest).path, plan.executablePath);
  assert.throws(() => browserWebMCPHostInstallationPlan("relative"), /Invalid/);
  assert.throws(() => browserWebMCPHostInstallationPlan("/captured/../other"), /Invalid/);
});

test("extension manifest public key has the fixed reviewed extension identity", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../apps/browser-media-extension/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const alphabet = "abcdefghijklmnop";
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex");
  const extensionId = Array.from(digest.slice(0, 32))
    .map((value) => alphabet[Number.parseInt(value, 16)])
    .join("");
  assert.equal(extensionId, ELLIE_BROWSER_EXTENSION_ID);
});

test(
  "private bridge and native host relay bounded requests and cancellation",
  { timeout: 10_000 },
  async () => {
    const home = await mkdtemp("/tmp/ellie-webmcp-");
    await mkdir(join(home, "Library", "Application Support", "Ellie"), { recursive: true });
    await chmod(join(home, "Library", "Application Support", "Ellie"), 0o700);
    const bridge = await startBrowserWebMCPBridge({ home });
    const input = new PassThrough();
    const output = new PassThrough();
    const replies = frameQueue(output);
    const host = runBrowserWebMCPNativeHost({ home, input, output });
    try {
      await waitForBridge(bridge, true);
      assert.equal(bridge.connected(), true);
      const connection = bridge.connectionContext();
      assert.equal(connection?.reportedNativeHostParentPid, process.ppid);
      assert.equal(connection?.authenticated, false);
      assert.match(connection?.connectionId ?? "", /^[0-9a-f-]{36}$/);
      assert.equal(Number((await lstat(bridge.socketPath, { bigint: true })).mode & 0o777n), 0o600);
      const status = bridge.request(statusRequest(), new AbortController().signal);
      assert.deepEqual(await replies.next(), statusRequest());
      input.write(
        browserWebMCPFrame.encode({
          protocol: BROWSER_WEBMCP_PROTOCOL,
          id: "request-1",
          type: "result",
          status: "ok",
          value: {
            bindingId: "binding",
            documentId: "document",
            origin: "https://demo.invalid",
            url: "https://demo.invalid/",
            expiresAt: 1,
          },
        }),
      );
      assert.equal((await status).status, "ok");

      const operations = new BrowserWebMCPOperations(bridge, { version: 1, bindings: [] });
      const operationStatus = operations.execute(
        { tool: "browser.status" },
        AbortSignal.timeout(2_000),
      );
      const operationRequest = browserWebMCPRequest(await replies.next());
      input.write(
        browserWebMCPFrame.encode({
          protocol: BROWSER_WEBMCP_PROTOCOL,
          id: operationRequest.id,
          type: "result",
          status: "ok",
          value: {
            bindingId: "binding",
            documentId: "document",
            origin: "https://www.youtube.com",
            url: "https://www.youtube.com/watch?v=abcdefghijk",
            expiresAt: Date.now() + 60_000,
            availability: "accessibility",
          },
        }),
      );
      assert.deepEqual((await operationStatus).browser, {
        source: "webmcp",
        operation: "status",
        status: "unsupported",
      });

      const malformedStatus = operations.execute(
        { tool: "browser.status" },
        AbortSignal.timeout(2_000),
      );
      const malformedRequest = browserWebMCPRequest(await replies.next());
      input.write(
        browserWebMCPFrame.encode({
          protocol: BROWSER_WEBMCP_PROTOCOL,
          id: malformedRequest.id,
          type: "result",
          status: "ok",
          value: {
            bindingId: "binding",
            documentId: "document",
            origin: "https://www.youtube.com",
            url: "https://www.youtube.com/",
            expiresAt: Date.now() + 60_000,
            availability: "dom",
          },
        }),
      );
      assert.equal((await malformedStatus).browser.status, "unavailable");

      const controller = new AbortController();
      const executionId = "e".repeat(BROWSER_WEBMCP_LIMITS.maximumIdentifierLength);
      const executing = bridge.request(
        {
          protocol: BROWSER_WEBMCP_PROTOCOL,
          id: executionId,
          type: "tool.execute",
          bindingId: "binding",
          documentId: "document",
          toolHandle: "tool",
          args: {},
        },
        controller.signal,
      );
      assert.equal(((await replies.next()) as any).id, executionId);
      assert.equal(
        (await bridge.request(statusRequest("request-2"), new AbortController().signal)).status,
        "busy",
      );
      controller.abort();
      assert.equal((await executing).status, "unknown");
      const cancellation = browserWebMCPRequest(await replies.next());
      assert.match(cancellation.id, /^cancel:[0-9a-f-]{36}$/);
      assert.deepEqual(cancellation, {
        protocol: BROWSER_WEBMCP_PROTOCOL,
        id: cancellation.id,
        type: "cancel",
        targetId: executionId,
      });
      input.write(
        browserWebMCPFrame.encode({
          protocol: BROWSER_WEBMCP_PROTOCOL,
          id: cancellation.id,
          type: "result",
          status: "ok",
          value: { cancelled: true },
        }),
      );
      input.write(
        browserWebMCPFrame.encode({
          protocol: BROWSER_WEBMCP_PROTOCOL,
          id: executionId,
          type: "result",
          status: "cancelled",
        }),
      );
      input.end();
      await host;
      await waitForBridge(bridge, false);
      assert.equal(bridge.connectionContext(), undefined);
    } finally {
      input.destroy();
      output.destroy();
      await bridge.close();
      await rm(home, { recursive: true, force: true });
    }
    await assert.rejects(readFile(browserWebMCPRuntimeDirectory(home)), /ENOENT/);
  },
);

test(
  "malformed frames and a post-dispatch disconnect fail closed without crashing",
  { timeout: 10_000 },
  async () => {
    const home = await mkdtemp("/tmp/e-wm-");
    await mkdir(join(home, "Library", "Application Support", "Ellie"), { recursive: true });
    await chmod(join(home, "Library", "Application Support", "Ellie"), 0o700);
    const bridge = await startBrowserWebMCPBridge({ home });
    try {
      const sameUser = connect(bridge.socketPath);
      sameUser.on("error", () => {});
      await once(sameUser, "connect");
      sameUser.write(
        browserWebMCPFrame.encode({ type: "native-host.hello", version: 1, parentPid: 1 }),
      );
      await waitForBridge(bridge, true);
      assert.deepEqual(
        { ...bridge.connectionContext(), connectionId: "redacted" },
        { reportedNativeHostParentPid: 1, connectionId: "redacted", authenticated: false },
      );
      sameUser.end();
      await once(sameUser, "close");
      await waitForBridge(bridge, false);
      assert.equal(bridge.connectionContext(), undefined);

      const malformed = connect(bridge.socketPath);
      malformed.on("error", () => {});
      await once(malformed, "connect");
      const oversized = Buffer.alloc(4);
      oversized.writeUInt32LE(BROWSER_WEBMCP_LIMITS.maximumMessageBytes + 1);
      malformed.write(oversized);
      await once(malformed, "close");

      const badInput = new PassThrough();
      badInput.on("error", () => {});
      const badOutput = new PassThrough();
      const malformedHost = runBrowserWebMCPNativeHost({
        home,
        input: badInput,
        output: badOutput,
      });
      await waitForBridge(bridge, true);
      badInput.write(oversized);
      await malformedHost;
      badOutput.destroy();
      await waitForBridge(bridge, false);

      const input = new PassThrough();
      const output = new PassThrough();
      const requests = frameQueue(output);
      const host = runBrowserWebMCPNativeHost({ home, input, output });
      await waitForBridge(bridge, true);
      const result = bridge.request(statusRequest("disconnect-1"), new AbortController().signal);
      assert.equal(((await requests.next()) as any).id, "disconnect-1");
      input.end();
      assert.equal((await result).status, "unknown");
      await host;
      output.destroy();
    } finally {
      await bridge.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
