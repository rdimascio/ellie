import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { defaults } from "@ellie/config";
import { browserWebMCPResultFor, nativeCommand, record, type Action } from "@ellie/protocol";
import { createBrowserRemote } from "../apps/server/src/browser-remote.ts";
import { runNode } from "../apps/node/src/index.ts";
import { BrowserNodeExecutor } from "../apps/node/src/browser-executor.ts";
import { BrowserWebMCPOperations } from "../apps/node/src/browser-operations.ts";
import { BrowserOperationSelector } from "../apps/node/src/browser-operation-selector.ts";
import type { BrowserAccessibilityRuntime } from "../apps/node/src/browser-accessibility-runtime.ts";
import { fixture } from "./helpers.ts";
import { browserWebMCPHostWrapper } from "../scripts/browser-webmcp-host-wrapper.ts";
import { packagedBrowserHelpers } from "../apps/cli/src/browser-runtime-paths.ts";

const revision = "a".repeat(64);

test("browser helpers resolve from the running executable in both supported layouts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ellie-browser-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const physicalRoot = await realpath(root);

  const helper = (directory: string, name: string) => {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${name}'\n`, { mode: 0o755 });
    chmodSync(path, 0o755);
    return path;
  };

  // A staged payload keeps helpers beside bin/, one level up from the runtime.
  const payloadRuntime = join(physicalRoot, "payload/bin/node");
  mkdirSync(dirname(payloadRuntime), { recursive: true });
  writeFileSync(payloadRuntime, "#!/bin/sh\n", { mode: 0o755 });
  for (const name of ["ellie-browser-runtime-broker", "ellie-browser-accessibility"])
    helper(join(physicalRoot, "payload/helpers"), name);
  assert.deepEqual(packagedBrowserHelpers(payloadRuntime), {
    broker: join(physicalRoot, "payload/helpers/ellie-browser-runtime-broker"),
    accessibility: join(physicalRoot, "payload/helpers/ellie-browser-accessibility"),
  });

  // An application bundle keeps them beside the runtime in Contents/MacOS.
  const bundleRuntime = join(physicalRoot, "Ellie.app/Contents/MacOS/node");
  mkdirSync(dirname(bundleRuntime), { recursive: true });
  writeFileSync(bundleRuntime, "#!/bin/sh\n", { mode: 0o755 });
  const executables = ["ellie-browser-runtime-broker", "ellie-browser-accessibility"].map((name) =>
    helper(dirname(bundleRuntime), name),
  );
  assert.deepEqual(packagedBrowserHelpers(bundleRuntime), {
    broker: executables[0],
    accessibility: executables[1],
  });

  // Resolved helpers are the executables that run, not merely paths that exist.
  for (const [kind, executable] of Object.entries(packagedBrowserHelpers(bundleRuntime)))
    assert.equal(
      execFileSync(executable, [], { encoding: "utf8", timeout: 2_000, maxBuffer: 1_024 }).trim(),
      kind === "broker" ? "ellie-browser-runtime-broker" : "ellie-browser-accessibility",
    );
});

test("a runtime without helpers beside it reports a missing installation, not a layout rule", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ellie-browser-bare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "bin/node");
  mkdirSync(dirname(runtime), { recursive: true });
  writeFileSync(runtime, "#!/bin/sh\n", { mode: 0o755 });
  assert.throws(() => packagedBrowserHelpers(runtime), /helpers are missing/);
});

test("packaged native-host wrapper invokes only the immutable CLI entrypoint in a clean environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ellie-browser-host-wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "lib/ellie/apps/cli/src"), { recursive: true });
  const wrapper = join(root, "bin/ellie-browser-webmcp-host");
  const node = join(root, "bin/node");
  writeFileSync(wrapper, browserWebMCPHostWrapper(), { mode: 0o755 });
  writeFileSync(
    node,
    '#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "HOME=%s\\n" "$HOME"\nprintf "NODE_OPTIONS=%s\\n" "${NODE_OPTIONS-}"\n',
    { mode: 0o755 },
  );
  chmodSync(wrapper, 0o755);
  chmodSync(node, 0o755);
  const output = execFileSync(wrapper, [], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 8_192,
    env: { HOME: root, TMPDIR: root, NODE_OPTIONS: "--inspect" },
  });
  const physicalRoot = execFileSync("/bin/pwd", [], { cwd: root, encoding: "utf8" }).trim();
  assert.deepEqual(output.trim().split("\n"), [
    join(physicalRoot, "lib/ellie/apps/cli/src/main.ts"),
    "browser-webmcp",
    "native-host",
    `HOME=${root}`,
    "NODE_OPTIONS=",
  ]);
});

test("composed node advertises browser grants only with an initialized browser executor", async () => {
  const desktopCalls: Action[] = [];
  const browserCalls: Action[] = [];
  const executor = new BrowserNodeExecutor(
    {
      capabilities: async () => ["app.open"],
      execute: async (action) => {
        desktopCalls.push(action);
        return { ok: true, message: "Done." };
      },
    },
    {
      execute: async (action: Action) => {
        browserCalls.push(action);
        return {
          ok: false,
          message: "No reviewed browser tab is connected.",
          browser: { source: "webmcp", operation: "status", status: "unbound" },
        };
      },
    } as unknown as BrowserWebMCPOperations,
  );
  assert.deepEqual(await executor.capabilities(), ["app.open", "browser.read", "browser.control"]);
  await executor.execute({ tool: "app.open", app: "Arc" });
  await executor.execute({ tool: "browser.status" });
  assert.deepEqual(desktopCalls, [{ tool: "app.open", app: "Arc" }]);
  assert.deepEqual(browserCalls, [{ tool: "browser.status" }]);
});

test("disconnected browser jobs finish through coordinator without reconnect or replay", async () => {
  const f = await fixture(3_000);
  const abort = new AbortController();
  let agent: Promise<void> | undefined;
  let bridgeRequests = 0;
  let accessibilityCalls = 0;
  const events: string[] = [];
  try {
    const node = await f.pair("disconnected-browser-node");
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
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => (ready = resolve));
    agent = runNode({
      client: node,
      preferences: defaults,
      signal: abort.signal,
      executor: new BrowserNodeExecutor(
        {
          capabilities: async () => ["app.open"],
          execute: async () => {
            throw new Error("Desktop helper must not run for browser.status.");
          },
        },
        selector,
      ),
      onStatus: ready,
      onEvent: (event) => events.push(event),
    });
    await registered;
    for (const [index, action] of [
      { tool: "browser.status" },
      { tool: "browser.refresh" },
      { tool: "browser.read", view: "summary", revision },
    ].entries()) {
      const response = record(
        await f.controller.call(
          "POST",
          "/v1/commands",
          { nodeId: "disconnected-browser-node", action },
          { timeoutMs: 2_500 },
        ),
      );
      assert.equal(response.ok, false);
      if (index < 2)
        assert.deepEqual(response.browser, {
          source: "webmcp",
          operation: "status",
          status: "unavailable",
        });
      else {
        assert.equal(response.message, "Browser connection is unavailable.");
        assert.equal(Object.hasOwn(response, "browser"), false);
      }
      assert.equal(bridgeRequests, index + 1);
      const stored = f.jobStore.list("disconnected-browser-node", 1)[0]!;
      assert.equal(stored.state, "failed");
    }
    assert.equal(accessibilityCalls, 0);
    assert.deepEqual(events, ["connected"]);
  } finally {
    abort.abort();
    await f.close();
    await agent;
  }
});

test("pre-dispatch refresh failure is unavailable; cancellation and read never enter an adapter", async () => {
  let bindingCalls = 0;
  let adapterCalls = 0;
  const selector = new BrowserOperationSelector(
    async () => {
      bindingCalls++;
      throw new Error();
    },
    {
      execute: async () => {
        adapterCalls++;
        throw new Error("WebMCP adapter must not run.");
      },
    },
    {
      execute: async () => {
        adapterCalls++;
        throw new Error("Accessibility adapter must not run.");
      },
    } as unknown as BrowserAccessibilityRuntime,
  );
  const refreshed = record(
    await selector.execute({ tool: "browser.refresh" }, AbortSignal.timeout(1_000)),
  );
  assert.deepEqual(refreshed.browser, {
    source: "webmcp",
    operation: "status",
    status: "unavailable",
  });
  const cancelled = AbortSignal.abort();
  await assert.rejects(selector.execute({ tool: "browser.status" }, cancelled), /cancelled/);
  await assert.rejects(
    selector.execute(
      { tool: "browser.read", view: "summary", revision },
      AbortSignal.timeout(1_000),
    ),
    /connection is unavailable/,
  );
  assert.equal(bindingCalls, 2);
  assert.equal(adapterCalls, 0);
});

test("invalid desktop error messages produce one bounded terminal result without reconnect", async () => {
  const f = await fixture(3_000);
  const abort = new AbortController();
  let agent: Promise<void> | undefined;
  let executions = 0;
  const events: string[] = [];
  try {
    const node = await f.pair("invalid-browser-error-node");
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => (ready = resolve));
    agent = runNode({
      client: node,
      preferences: defaults,
      signal: abort.signal,
      executor: {
        capabilities: async () => ["browser.read"],
        execute: async () => {
          executions++;
          throw new Error(executions === 1 ? "" : "x".repeat(4_001));
        },
      },
      onStatus: ready,
      onEvent: (event) => events.push(event),
    });
    await registered;
    for (let index = 1; index <= 2; index++) {
      const response = record(
        await f.controller.call(
          "POST",
          "/v1/commands",
          { nodeId: "invalid-browser-error-node", action: { tool: "browser.status" } },
          { timeoutMs: 2_500 },
        ),
      );
      assert.equal(response.ok, false);
      assert.equal(response.message, "Native action failed.");
      assert.equal(executions, index);
    }
    assert.deepEqual(events, ["connected"]);
    assert.equal(f.jobStore.list("invalid-browser-error-node", 2).length, 2);
    assert.ok(
      f.jobStore.list("invalid-browser-error-node", 2).every((row) => row.state === "failed"),
    );
  } finally {
    abort.abort();
    await f.close();
    await agent;
  }
});

test("native browser command grammar is canonical and never accepts page authority", () => {
  assert.deepEqual(
    nativeCommand({
      nodeId: "mini",
      action: { tool: "browser.scroll", direction: "right", revision },
    }),
    { nodeId: "mini", action: { tool: "browser.scroll", direction: "right", revision } },
  );
  for (const value of [
    { nodeId: "mini", text: "scroll right" },
    { nodeId: "mini", action: { tool: "browser.scroll", direction: "right", revision, pid: 1 } },
    { nodeId: "mini", action: { tool: "url.open", app: "Safari", url: "https://x.test" } },
    { nodeId: "mini", action: { tool: "browser.select", itemId: "label text", revision } },
  ])
    assert.throws(() => nativeCommand(value));
});

test("browser remote forwards typed actions and preserves structured unknown results", async () => {
  const calls: unknown[] = [];
  const remote = createBrowserRemote({
    async call(method, path, body) {
      calls.push({ method, path, body });
      return {
        ok: false,
        message: "Browser action did not confirm completion.",
        browser: { source: "webmcp", operation: "command", status: "unknown", revision },
      };
    },
  });
  const result = await remote.execute!("mini", {
    tool: "browser.playback",
    action: "play",
    revision,
  });
  assert.equal("browser" in result ? result.browser.status : undefined, "unknown");
  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/v1/commands",
      body: {
        nodeId: "mini",
        action: { tool: "browser.playback", action: "play", revision },
      },
    },
  ]);
  const mismatched = createBrowserRemote({
    async call() {
      return {
        ok: false,
        message: "Unknown.",
        browser: {
          source: "webmcp",
          operation: "command",
          status: "unknown",
          revision: "b".repeat(64),
        },
      };
    },
  });
  await assert.rejects(
    mismatched.execute!("mini", { tool: "browser.playback", action: "play", revision }),
    /outcome unknown/,
  );
});

test("coordinator and runNode deliver canonical browser jobs and persist unknown outcomes", async () => {
  const f = await fixture();
  const abort = new AbortController();
  let agent: Promise<void> | undefined;
  const executed: Action[] = [];
  try {
    const node = await f.pair("browser-node");
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => (ready = resolve));
    agent = runNode({
      client: node,
      preferences: defaults,
      signal: abort.signal,
      executor: {
        capabilities: async () => ["app.open", "browser.read", "browser.control"],
        execute: async (action) => {
          executed.push(action);
          return action.tool.startsWith("browser.")
            ? {
                ok: false,
                message: "Browser action did not confirm completion.",
                browser: {
                  source: "webmcp" as const,
                  operation: "command" as const,
                  status: "unknown" as const,
                  revision,
                },
              }
            : { ok: true, message: "Done." };
        },
      },
      onStatus: ready,
    });
    await registered;
    for (const action of [
      { tool: "app.open", app: "Arc" },
      { tool: "url.open", app: "Safari", url: "https://example.com/" },
      { tool: "window.place", app: "Arc", layout: "left", monitor: "current" },
      { tool: "window.adjacent", app: "Arc", anchor: "Safari" },
    ])
      await assert.rejects(
        f.controller.call("POST", "/v1/commands", { nodeId: "browser-node", action }),
        /Command request rejected/,
      );
    assert.equal(executed.length, 0);
    const response = record(
      await f.controller.call("POST", "/v1/commands", {
        nodeId: "browser-node",
        action: { tool: "browser.scroll", direction: "right", revision },
      }),
    );
    assert.equal(record(response.browser).status, "unknown");
    assert.deepEqual(executed, [{ tool: "browser.scroll", direction: "right", revision }]);
    const stored = f.jobStore.list("browser-node", 1)[0]!;
    assert.equal(stored.state, "unknown");
    assert.equal(stored.outcomeOk, false);
  } finally {
    abort.abort();
    await f.close();
    await agent;
  }
});
