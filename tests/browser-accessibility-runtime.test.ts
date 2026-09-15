import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserWebMCPAction, browserWebMCPResultFor, type BrowserAction } from "@ellie/protocol";
import { defaults } from "@ellie/config";
import { runNode } from "../apps/node/src/index.ts";
import { BrowserNodeExecutor } from "../apps/node/src/browser-executor.ts";
import {
  BrowserAccessibilityRuntime,
  type BrowserAccessibilityBinding,
} from "../apps/node/src/browser-accessibility-runtime.ts";
import { BrowserOperationSelector } from "../apps/node/src/browser-operation-selector.ts";
import { BrowserWebMCPOperations } from "../apps/node/src/browser-operations.ts";
import { reviewedBrowserRegistry } from "../apps/node/src/browser-operation-registry.ts";
import {
  startBrowserKernelBridge,
  type BrowserKernelBridge,
} from "../apps/node/src/browser-kernel-bridge.ts";
import { browserWebMCPFrame } from "../apps/node/src/browser-webmcp-bridge.ts";
import { fixture } from "./helpers.ts";

async function compileSession(executable: string, flags: string[] = []): Promise<void> {
  const child = spawn(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-D",
      "ELLIE_AX_TEST_BACKEND",
      ...flags.flatMap((flag) => ["-D", flag]),
      new URL("../packages/macos/native/BrowserAccessibility.swift", import.meta.url).pathname,
      new URL("../packages/macos/native/BrowserAccessibilitySession.swift", import.meta.url)
        .pathname,
      new URL("fixtures/browser-accessibility-session-backend.swift", import.meta.url).pathname,
      "-o",
      executable,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let bytes = 0;
  child.stdout.on("data", (value: Buffer) => {
    bytes += value.length;
  });
  child.stderr.on("data", (value: Buffer) => {
    bytes += value.length;
  });
  let stopping = false;
  const deadline = setTimeout(() => {
    stopping = true;
    child.kill("SIGTERM");
  }, 20_000);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  clearTimeout(deadline);
  assert.equal(stopping, false, "Swift fixture compilation exceeded its deadline");
  assert.ok(bytes <= 64 * 1024, "Swift fixture compiler output exceeded its bound");
  assert.deepEqual(result, { code: 0, signal: null });
}

async function compileSwift(
  label: string,
  executable: string,
  files: string[],
  flags: string[] = [],
) {
  const child = spawn("/usr/bin/xcrun", ["swiftc", ...flags, ...files, "-o", executable], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  let outputBytes = 0;
  const capture = (value: Buffer) => {
    outputBytes += value.length;
    if (outputBytes <= 64 * 1024) output.push(Buffer.from(value));
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    child.kill("SIGTERM");
  }, 20_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  clearTimeout(deadline);
  assert.equal(expired, false, `${label} Swift compilation exceeded its deadline`);
  assert.ok(outputBytes <= 64 * 1024, `${label} Swift compiler output exceeded its bound`);
  assert.equal(
    code,
    0,
    `${label} Swift compilation failed:\n${Buffer.concat(output).toString("utf8")}`,
  );
}

test("persistent accessibility helper binds, reads and reports mutations as unverified", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ellie-browser-ax-runtime-"));
  let completed = false;
  try {
    const helper = join(root, "helper.mjs");
    await writeFile(
      helper,
      `#!${process.execPath}
import { createInterface } from 'node:readline';
let session;
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.type === 'bind') { session = 'session-1'; console.log(JSON.stringify({id:value.id,status:'bound',sessionID:session,documentRevision:value.documentRevision})); }
  else if (value.type === 'read') console.log(JSON.stringify({id:value.id,status:'completed',sessionID:session,generation:'generation-1',documentRevision:'document-1',title:'NASA',items:[{id:'video-1',label:'Earth'}],operation:'read'}));
  else console.log(JSON.stringify({id:value.id,status:'dispatchedUnverified',sessionID:session,documentRevision:'document-1',operation:value.operation}));
}
`,
    );
    await chmod(helper, 0o700);
    let context = {
      browserProcessPid: process.pid,
      browserStartSeconds: 1,
      browserStartMicroseconds: 0,
      browserCodeHash: "00".repeat(20),
      connectionId: "connection-1",
      authenticated: true,
    };
    const runtime = new BrowserAccessibilityRuntime(helper, () => context);
    const binding = {
      availability: "accessibility" as const,
      documentId: "document-1",
      url: "https://www.youtube.com/watch?v=iTHUUjTA-LI",
      revision: "revision-1",
    };
    const signal = new AbortController().signal;
    const view = await runtime.execute(
      browserWebMCPAction({ tool: "browser.read", view: "page", revision: "revision-1" }),
      binding,
      signal,
    );
    assert.equal(view.browser.source, "accessibility");
    assert.equal(view.browser.operation, "read");
    const mutation = await runtime.execute(
      browserWebMCPAction({ tool: "browser.scroll", direction: "down", revision: "revision-1" }),
      binding,
      signal,
    );
    assert.equal(mutation.ok, false);
    assert.deepEqual(mutation.browser, {
      source: "accessibility",
      operation: "command",
      status: "unknown",
      revision: "revision-1",
    });
    context = { ...context, browserStartMicroseconds: 1 };
    await assert.rejects(
      runtime.execute(
        browserWebMCPAction({ tool: "browser.read", view: "page", revision: "revision-1" }),
        binding,
        signal,
      ),
      /page changed/,
    );
    context = { ...context, connectionId: "connection-2" };
    await assert.rejects(
      runtime.execute(
        browserWebMCPAction({ tool: "browser.read", view: "page", revision: "revision-1" }),
        binding,
        signal,
      ),
      /page changed/,
    );
    await runtime.close();
    completed = true;
  } finally {
    if (completed) await rm(root, { recursive: true });
    else t.diagnostic(`Retained browser AX runtime fixture: ${root}`);
  }
});

test("read-only accessibility failures stay distinct from dispatched action uncertainty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ellie-browser-ax-readonly-failure-"));
  let completed = false;
  try {
    const context = {
      browserProcessPid: process.pid,
      browserStartSeconds: 1,
      browserStartMicroseconds: 0,
      browserCodeHash: "00".repeat(20),
      connectionId: "connection-1",
      authenticated: true,
    };
    const binding = {
      availability: "accessibility" as const,
      documentId: "document-1",
      url: "https://www.youtube.com/watch?v=iTHUUjTA-LI",
      revision: "revision-1",
    };
    const cases = [
      {
        name: "bind-eof",
        action: browserWebMCPAction({ tool: "browser.status" }),
        response: "if (value.type === 'bind') process.exit(0);",
        expected: "Browser accessibility helper is unavailable.",
      },
      {
        name: "read-malformed",
        action: browserWebMCPAction({
          tool: "browser.read",
          view: "page",
          revision: "revision-1",
        }),
        response:
          "if (value.type === 'bind') console.log(JSON.stringify({id:value.id,status:'bound',sessionID:'session-1',documentRevision:value.documentRevision})); else console.log(JSON.stringify({id:value.id,status:'garbage'}));",
        expected: "Browser accessibility read failed.",
      },
    ];
    for (const scenario of cases) {
      const helper = join(root, `${scenario.name}.mjs`);
      await writeFile(
        helper,
        `#!${process.execPath}\nimport { createInterface } from 'node:readline';\nfor await (const line of createInterface({ input: process.stdin })) { const value = JSON.parse(line); ${scenario.response} }\n`,
      );
      await chmod(helper, 0o700);
      const runtime = new BrowserAccessibilityRuntime(helper, () => context);
      try {
        await assert.rejects(
          runtime.execute(scenario.action, binding, new AbortController().signal),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, scenario.expected);
            assert.doesNotMatch(error.message, /outcome is unknown/);
            return true;
          },
        );
      } finally {
        await runtime.close();
      }
    }
    completed = true;
  } finally {
    if (completed) await rm(root, { recursive: true });
    else t.diagnostic(`Retained browser AX read-only failure fixture: ${root}`);
  }
});

test(
  "large Unicode AX summaries cross the Swift session and Node result contract",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ellie-browser-ax-summary-"));
    let runtime: BrowserAccessibilityRuntime | undefined;
    let completed = false;
    try {
      const executable = join(root, "ellie-browser-accessibility");
      await compileSession(executable, ["ELLIE_AX_LARGE_SUMMARY"]);
      runtime = new BrowserAccessibilityRuntime(executable, () => ({
        browserProcessPid: process.pid,
        browserStartSeconds: 1,
        browserStartMicroseconds: 0,
        browserCodeHash: "00".repeat(20),
        connectionId: "summary-connection",
        authenticated: true,
      }));
      const result = await runtime.execute(
        browserWebMCPAction({ tool: "browser.read", view: "page", revision: "revision-1" }),
        {
          availability: "accessibility",
          documentId: "document-1",
          url: "https://www.youtube.com/watch?v=iTHUUjTA-LI",
          revision: "revision-1",
        },
        new AbortController().signal,
      );
      assert.equal(result.browser.source, "accessibility");
      if (result.browser.operation !== "read" || result.browser.status !== "completed")
        throw new Error("Expected a completed read.");
      const summary = result.browser.view.summary;
      assert.equal(summary, Array(2).fill("🌙".repeat(200)).join(" "));
      assert.ok(Buffer.byteLength(summary) <= 2_000);
      assert.deepEqual(
        result.browser.view.items.map((item) => item.label),
        ["Earth from space"],
      );
      completed = true;
    } finally {
      await runtime?.close();
      if (completed) await rm(root, { recursive: true });
      else t.diagnostic(`Retained browser AX summary fixture: ${root}`);
    }
  },
);

test(
  "large AX result collections fit the persistent Swift session frame",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ellie-browser-ax-items-"));
    let runtime: BrowserAccessibilityRuntime | undefined;
    let completed = false;
    try {
      const executable = join(root, "ellie-browser-accessibility");
      await compileSession(executable, ["ELLIE_AX_LARGE_ITEMS"]);
      runtime = new BrowserAccessibilityRuntime(executable, () => ({
        browserProcessPid: process.pid,
        browserStartSeconds: 1,
        browserStartMicroseconds: 0,
        browserCodeHash: "00".repeat(20),
        connectionId: "items-connection",
        authenticated: true,
      }));
      const result = await runtime.execute(
        browserWebMCPAction({ tool: "browser.read", view: "page", revision: "revision-1" }),
        {
          availability: "accessibility",
          documentId: "document-1",
          url: "https://www.youtube.com/watch?v=iTHUUjTA-LI",
          revision: "revision-1",
        },
        new AbortController().signal,
      );
      if (result.browser.operation !== "read" || result.browser.status !== "completed")
        throw new Error("Expected a completed read.");
      const items = result.browser.view.items;
      assert.equal(items[0]?.label, "Earth from space");
      assert.ok(items.length > 1 && items.length < 64);
      assert.equal(new Set(items.map((item) => item.id)).size, items.length);
      for (const item of items.slice(1)) {
        assert.match(item.label, /^Video [0-9]{2} /);
        assert.equal(item.label.slice(9), '"\\'.repeat(120) + "x");
        assert.equal(item.label.length, 250);
      }
      completed = true;
    } finally {
      await runtime?.close();
      if (completed) await rm(root, { recursive: true });
      else t.diagnostic(`Retained browser AX items fixture: ${root}`);
    }
  },
);

test("adapter selection happens once before dispatch and never falls through", async () => {
  let webCalls = 0;
  let axCalls = 0;
  const accessibility = {
    async execute() {
      axCalls += 1;
      throw new Error("unexpected");
    },
  } as unknown as BrowserAccessibilityRuntime;
  const selector = new BrowserOperationSelector(
    async () => ({
      availability: "webmcp",
      bindingId: "binding-1",
      documentId: "document-1",
      origin: "https://www.youtube.com",
      url: "https://www.youtube.com/watch?v=iTHUUjTA-LI",
      expiresAt: Date.now() + 60_000,
    }),
    {
      async execute() {
        webCalls += 1;
        throw new Error("unknown after dispatch");
      },
    },
    accessibility,
  );
  await assert.rejects(
    selector.execute(
      browserWebMCPAction({ tool: "browser.scroll", direction: "right", revision: "revision-1" }),
      new AbortController().signal,
    ),
    /unknown after dispatch/,
  );
  assert.equal(webCalls, 1);
  assert.equal(axCalls, 0);
});

test("validated extension availability reaches the accessibility selector", async () => {
  let accessibilityCalls = 0;
  const webmcp = new BrowserWebMCPOperations(
    {
      async request(request) {
        assert.equal(request.type, "binding.status");
        return browserWebMCPResultFor(request.id, "ok", {
          bindingId: "binding-1",
          documentId: "document-1",
          origin: "https://www.youtube.com",
          url: "https://www.youtube.com/watch?v=iTHUUjTA-LI",
          expiresAt: Date.now() + 60_000,
          availability: "accessibility",
        });
      },
    },
    reviewedBrowserRegistry({ version: 1, bindings: [] }),
  );
  const selector = new BrowserOperationSelector((signal) => webmcp.bindingStatus(signal), webmcp, {
    async execute(_action: BrowserAction, binding: BrowserAccessibilityBinding) {
      accessibilityCalls += 1;
      assert.equal(binding.availability, "accessibility");
      return {
        ok: true,
        message: "Browser tab connected.",
        browser: {
          source: "accessibility",
          operation: "status",
          status: "connected",
          revision: binding.revision,
          origin: "https://www.youtube.com",
        },
      };
    },
  } as unknown as BrowserAccessibilityRuntime);

  const result = await selector.execute(
    browserWebMCPAction({ tool: "browser.status" }),
    AbortSignal.timeout(1_000),
  );
  assert.ok("browser" in result);
  assert.equal(result.browser.source, "accessibility");
  assert.equal(accessibilityCalls, 1);
});

test("reported native-host PID cannot authorize accessibility", async () => {
  const runtime = new BrowserAccessibilityRuntime("/bin/false", () => ({
    browserProcessPid: process.pid,
    browserStartSeconds: 1,
    browserStartMicroseconds: 0,
    browserCodeHash: "00".repeat(20),
    connectionId: "reported-only",
    authenticated: false,
  }));
  await assert.rejects(
    runtime.execute(
      browserWebMCPAction({ tool: "browser.read", view: "page", revision: "revision-1" }),
      {
        availability: "accessibility",
        documentId: "document-1",
        url: "https://www.youtube.com/watch?v=iTHUUjTA-LI",
        revision: "revision-1",
      },
      new AbortController().signal,
    ),
    /page changed/,
  );
});

test(
  "coordinator and runNode traverse the persistent Swift helper framing path",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ellie-browser-ax-node-"));
    const f = await fixture();
    const abort = new AbortController();
    let agent: Promise<void> | undefined;
    let runtime: BrowserAccessibilityRuntime | undefined;
    let completed = false;
    try {
      const executable = join(root, "ellie-browser-accessibility");
      await compileSession(executable);
      const context = {
        browserProcessPid: process.pid,
        browserStartSeconds: 1,
        browserStartMicroseconds: 0,
        browserCodeHash: "00".repeat(20),
        connectionId: "connection-1",
        authenticated: true,
      };
      runtime = new BrowserAccessibilityRuntime(executable, () => context);
      const selector = new BrowserOperationSelector(
        async () => ({
          availability: "accessibility",
          bindingId: "binding-1",
          documentId: "document-1",
          origin: "https://www.youtube.com",
          url: "https://www.youtube.com/watch?v=iTHUUjTA-LI",
          expiresAt: Date.now() + 60_000,
        }),
        {
          async execute() {
            throw new Error("WebMCP must not dispatch.");
          },
        },
        runtime,
      );
      const paired = await f.pair("ax-node");
      let ready!: () => void;
      const registered = new Promise<void>((resolve) => {
        ready = resolve;
      });
      agent = runNode({
        client: paired,
        preferences: defaults,
        signal: abort.signal,
        executor: new BrowserNodeExecutor(
          {
            capabilities: async () => [],
            execute: async () => ({ ok: false, message: "Unavailable." }),
          },
          selector,
        ),
        onStatus: ready,
      });
      await registered;
      const status = await f.controller.call("POST", "/v1/commands", {
        nodeId: "ax-node",
        action: { tool: "browser.status" },
      });
      assert.equal((status as { browser?: { source?: string } }).browser?.source, "accessibility");
      completed = true;
    } finally {
      abort.abort();
      await f.close();
      await agent;
      await runtime?.close();
      if (completed) await rm(root, { recursive: true });
      else t.diagnostic(`Retained browser AX node fixture: ${root}`);
    }
  },
);

test("runNode persists malformed post-dispatch accessibility outcome as unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ellie-browser-ax-unknown-"));
  const f = await fixture();
  const abort = new AbortController();
  let agent: Promise<void> | undefined;
  let runtime: BrowserAccessibilityRuntime | undefined;
  let completed = false;
  try {
    const executable = join(root, "helper.mjs");
    const performed = join(root, "performed");
    await writeFile(
      executable,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
let session, documentRevision;
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  if (value.type === 'bind') { session = 'session-1'; documentRevision = value.documentRevision; console.log(JSON.stringify({id:value.id,status:'bound',sessionID:session,documentRevision})); }
  else if (value.type === 'read') console.log(JSON.stringify({id:value.id,status:'completed',sessionID:session,generation:'generation-1',documentRevision,items:[],operation:'read'}));
  else { appendFileSync(${JSON.stringify(performed)}, value.id + '\\n'); console.log(JSON.stringify({id:value.id,status:'garbage',sessionID:session,documentRevision,operation:value.operation})); }
}
`,
    );
    await chmod(executable, 0o700);
    const context = {
      browserProcessPid: process.pid,
      browserStartSeconds: 1,
      browserStartMicroseconds: 0,
      browserCodeHash: "00".repeat(20),
      connectionId: "connection-1",
      authenticated: true,
    };
    runtime = new BrowserAccessibilityRuntime(executable, () => context);
    const selector = new BrowserOperationSelector(
      async () => ({
        availability: "accessibility",
        bindingId: "binding-1",
        documentId: "document-1",
        origin: "https://www.youtube.com",
        url: "https://www.youtube.com/watch?v=iTHUUjTA-LI",
        expiresAt: Date.now() + 60_000,
      }),
      {
        async execute() {
          throw new Error("WebMCP must not dispatch.");
        },
      },
      runtime,
    );
    const paired = await f.pair("ax-unknown-node");
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    agent = runNode({
      client: paired,
      preferences: defaults,
      signal: abort.signal,
      executor: new BrowserNodeExecutor(
        {
          capabilities: async () => [],
          execute: async () => ({ ok: false, message: "Unavailable." }),
        },
        selector,
      ),
      onStatus: ready,
    });
    await registered;
    const status = (await f.controller.call("POST", "/v1/commands", {
      nodeId: "ax-unknown-node",
      action: { tool: "browser.status" },
    })) as { browser: { revision: string } };
    const revision = status.browser.revision;
    await f.controller.call("POST", "/v1/commands", {
      nodeId: "ax-unknown-node",
      action: { tool: "browser.read", view: "summary", revision },
    });
    const response = (await f.controller.call("POST", "/v1/commands", {
      nodeId: "ax-unknown-node",
      action: { tool: "browser.scroll", direction: "down", revision },
    })) as { message: string; browser: { status: string } };
    assert.equal(
      response.message,
      "Browser action outcome is unknown. Check the page before retrying.",
    );
    assert.equal(response.browser.status, "unknown");
    assert.equal((await readFile(performed, "utf8")).trim().split("\n").length, 1);
    const stored = f.jobStore.list("ax-unknown-node", 1)[0]!;
    assert.equal(stored.state, "unknown");
    completed = true;
  } finally {
    abort.abort();
    await f.close();
    await agent;
    await runtime?.close();
    if (completed) await rm(root, { recursive: true });
    else t.diagnostic(`Retained browser AX unknown fixture: ${root}`);
  }
});

test(
  "kernel broker rejects a direct same-user peer and admits its exact browser-child fixture",
  { skip: process.platform !== "darwin", timeout: 45_000 },
  async (t) => {
    const root = await mkdtemp("/tmp/e-bk-");
    let completed = false;
    const bridges = new Set<BrowserKernelBridge>();
    const children = new Set<ChildProcess>();
    const trackBridge = (bridge: BrowserKernelBridge) => {
      bridges.add(bridge);
      return bridge;
    };
    const closeBridge = async (bridge: BrowserKernelBridge) => {
      await bridge.close();
      bridges.delete(bridge);
    };
    const trackChild = <T extends ChildProcess>(child: T): T => {
      children.add(child);
      return child;
    };
    const stopChild = async (child: ChildProcess): Promise<boolean> => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      const closed = new Promise<boolean>((resolve) => child.once("close", () => resolve(true)));
      if (!child.kill("SIGTERM")) return false;
      if (
        await Promise.race([
          closed,
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
        ])
      )
        return true;
      if (child.exitCode === null && child.signalCode === null && !child.kill("SIGKILL"))
        return false;
      return Promise.race([
        closed,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
    };
    try {
      const payload = join(root, "payload");
      const helpers = join(payload, "helpers");
      const bin = join(payload, "bin");
      const home = join(root, "home");
      await mkdir(join(home, "Library/Application Support/Ellie"), {
        recursive: true,
        mode: 0o700,
      });
      for (const directory of [
        home,
        join(home, "Library"),
        join(home, "Library/Application Support"),
        join(home, "Library/Application Support/Ellie"),
      ])
        await chmod(directory, 0o700);
      await mkdir(helpers, { recursive: true });
      await mkdir(bin);
      const broker = join(helpers, "ellie-browser-runtime-broker");
      const productionBroker = join(helpers, "production-browser-runtime-broker");
      const peer = join(bin, "node");
      await compileSwift(
        "test broker",
        broker,
        [
          new URL("../packages/macos/native/BrowserAccessibility.swift", import.meta.url).pathname,
          new URL("../packages/macos/native/BrowserRuntimeBroker.swift", import.meta.url).pathname,
        ],
        ["-D", "ELLIE_AX_BROKER_TEST", "-lbsm"],
      );
      await compileSwift(
        "production broker",
        productionBroker,
        [
          new URL("../packages/macos/native/BrowserAccessibility.swift", import.meta.url).pathname,
          new URL("../packages/macos/native/BrowserRuntimeBroker.swift", import.meta.url).pathname,
        ],
        ["-lbsm"],
      );
      await compileSwift(
        "peer",
        peer,
        [new URL("fixtures/browser-kernel-peer.swift", import.meta.url).pathname],
        ["-parse-as-library"],
      );
      const socket = join(
        home,
        "Library/Application Support/Ellie/BrowserBridge/browser-webmcp-v1.sock",
      );
      const lock = join(home, "Library/Application Support/Ellie/BrowserBridge/broker.lock");
      const waitForPublishedSocket = async () => {
        for (let count = 0; count < 100; count += 1) {
          const current = await lstat(socket).catch(() => undefined);
          if (
            current?.isSocket() &&
            (current.mode & 0o777) === 0o600 &&
            current.uid === process.getuid!() &&
            (await readFile(lock, "utf8").catch(() => undefined)) ===
              `v1 ${current.dev} ${current.ino}\n`
          )
            return current;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.fail("broker socket and ownership record were not published together");
      };
      const waitForNoSocket = async () => {
        for (let count = 0; count < 100; count += 1) {
          if (
            !(await access(socket).then(
              () => true,
              () => false,
            ))
          )
            return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.fail("broker socket was not removed");
      };

      const crashed = trackChild(
        spawn(broker, [], {
          env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
          stdio: ["pipe", "ignore", "ignore"],
        }),
      );
      const crashedExit = new Promise((resolve) => crashed.once("close", resolve));
      const publishedSocket = await waitForPublishedSocket();
      assert.equal(crashed.kill("SIGKILL"), true);
      assert.equal(await crashedExit, null);
      assert.equal(
        await access(socket).then(
          () => true,
          () => false,
        ),
        true,
      );
      const staleSocket = await lstat(socket);
      assert.equal(staleSocket.isSocket(), true);
      assert.equal(staleSocket.mode & 0o777, 0o600);
      assert.equal(staleSocket.dev, publishedSocket.dev);
      assert.equal(staleSocket.ino, publishedSocket.ino);
      assert.equal(await readFile(lock, "utf8"), `v1 ${staleSocket.dev} ${staleSocket.ino}\n`);
      const retainedLock = await lstat(lock);
      assert.equal(retainedLock.mode & 0o777, 0o600);

      const first = trackBridge(await startBrowserKernelBridge({ home, executable: broker }));
      const connectToOwnedPublishedSocket = async () => {
        for (let count = 0; count < 100; count += 1) {
          const [current, currentLock, record] = await Promise.all([
            lstat(socket).catch(() => undefined),
            lstat(lock).catch(() => undefined),
            readFile(lock, "utf8").catch(() => undefined),
          ]);
          if (
            current?.isSocket() &&
            (current.mode & 0o777) === 0o600 &&
            current.uid === process.getuid!() &&
            currentLock?.isFile() &&
            currentLock.dev === retainedLock.dev &&
            currentLock.ino === retainedLock.ino &&
            currentLock.uid === retainedLock.uid &&
            currentLock.mode === retainedLock.mode &&
            record === `v1 ${current.dev} ${current.ino}\n`
          ) {
            const candidate = connect(socket);
            const connected = await new Promise<boolean>((resolve) => {
              let settled = false;
              const finish = (value: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                candidate.off("connect", onConnect);
                candidate.off("error", onError);
                resolve(value);
              };
              const onConnect = () => finish(true);
              const onError = () => finish(false);
              const timer = setTimeout(() => {
                candidate.destroy();
                finish(false);
              }, 100);
              candidate.once("connect", onConnect);
              candidate.once("error", onError);
            });
            if (connected) {
              candidate.on("error", () => {});
              return { connection: candidate, socketInfo: current };
            }
            candidate.destroy();
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.fail("owned replacement broker socket did not accept a connection");
      };
      const { connection: hostile, socketInfo: replacementSocketInfo } =
        await connectToOwnedPublishedSocket();
      const hostileClosed = hostile.closed
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              hostile.destroy();
              resolve(false);
            }, 1_000);
            hostile.once("close", () => {
              clearTimeout(timer);
              resolve(true);
            });
          });
      assert.equal(replacementSocketInfo.isSocket(), true);
      assert.equal(replacementSocketInfo.mode & 0o777, 0o600);
      assert.equal(replacementSocketInfo.uid, process.getuid!());
      assert.equal((await lstat(lock)).ino, retainedLock.ino);
      hostile.write(
        browserWebMCPFrame.encode({ type: "native-host.hello", version: 1, parentPid: 1 }),
      );
      assert.equal(await hostileClosed, true, "replacement broker did not reject the hostile peer");
      assert.equal(first.connectionContext(), undefined);
      await closeBridge(first);
      await waitForNoSocket();

      const production = trackBridge(
        await startBrowserKernelBridge({ home, executable: productionBroker }),
      );
      await waitForPublishedSocket();
      const untrustedExactPeer = trackChild(
        spawn(peer, [], { env: { HOME: home }, stdio: "ignore" }),
      );
      const untrustedExactExit = new Promise((resolve) =>
        untrustedExactPeer.once("close", resolve),
      );
      assert.equal(await untrustedExactExit, 3);
      assert.equal(production.connectionContext(), undefined);
      await closeBridge(production);
      await waitForNoSocket();

      const bridge = trackBridge(await startBrowserKernelBridge({ home, executable: broker }));
      await waitForPublishedSocket();
      const child = trackChild(
        spawn(peer, ["--disconnect"], { env: { HOME: home }, stdio: "ignore" }),
      );
      const childExit = new Promise((resolve) => child.once("close", resolve));
      for (let count = 0; !bridge.connected() && count < 100; count += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(bridge.connectionContext()?.authenticated, true);
      const response = await bridge.request(
        {
          protocol: "ellie.browser-webmcp.v1",
          id: "status-1",
          type: "binding.status",
        },
        new AbortController().signal,
      );
      assert.equal(response.status, "ok");
      const firstConnection = bridge.connectionContext()?.connectionId;
      assert.ok(firstConnection);
      assert.equal(await childExit, 0);
      for (let count = 0; bridge.connected() && count < 100; count += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(bridge.connectionContext(), undefined);

      const replacement = trackChild(spawn(peer, [], { env: { HOME: home }, stdio: "ignore" }));
      const replacementExit = new Promise((resolve) => replacement.once("close", resolve));
      for (let count = 0; !bridge.connected() && count < 100; count += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(bridge.connectionContext()?.authenticated, true);
      assert.notEqual(bridge.connectionContext()?.connectionId, firstConnection);
      const replacementResponse = await bridge.request(
        {
          protocol: "ellie.browser-webmcp.v1",
          id: "status-2",
          type: "binding.status",
        },
        new AbortController().signal,
      );
      assert.equal(replacementResponse.status, "ok");
      await closeBridge(bridge);
      assert.equal(await replacementExit, 0);
      completed = true;
    } finally {
      let cleanupCertain = true;
      for (const bridge of bridges) {
        try {
          await closeBridge(bridge);
        } catch (error) {
          cleanupCertain = false;
          t.diagnostic(`Browser kernel bridge cleanup uncertain: ${String(error)}`);
        }
      }
      for (const child of children) {
        if (!(await stopChild(child))) {
          cleanupCertain = false;
          t.diagnostic(`Browser kernel fixture child cleanup uncertain: ${child.pid ?? "unknown"}`);
        }
      }
      if (completed && cleanupCertain) await rm(root, { recursive: true });
      else t.diagnostic(`Retained browser kernel fixture: ${root}`);
      assert.equal(cleanupCertain, true, "browser kernel fixture cleanup was uncertain");
    }
  },
);
