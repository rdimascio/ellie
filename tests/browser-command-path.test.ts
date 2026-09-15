import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaults } from "@ellie/config";
import { nativeCommand, record, type Action } from "@ellie/protocol";
import { createBrowserRemote } from "../apps/server/src/browser-remote.ts";
import { runNode } from "../apps/node/src/index.ts";
import { BrowserNodeExecutor } from "../apps/node/src/browser-executor.ts";
import type { BrowserWebMCPOperations } from "../apps/node/src/browser-operations.ts";
import { fixture } from "./helpers.ts";
import { browserWebMCPHostWrapper } from "../scripts/browser-webmcp-host-wrapper.ts";

const revision = "a".repeat(64);

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
