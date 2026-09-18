import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaults } from "@ellie/config";
import { browserWebMCPResultFor, record } from "@ellie/protocol";
import { generateBrowserTlsIdentity } from "../apps/cli/src/certificate.ts";
import { BrowserNodeExecutor } from "../apps/node/src/browser-executor.ts";
import { BrowserOperationSelector } from "../apps/node/src/browser-operation-selector.ts";
import { BrowserWebMCPOperations } from "../apps/node/src/browser-operations.ts";
import { BrowserAccessibilityRuntime } from "../apps/node/src/browser-accessibility-runtime.ts";
import { BrowserCompanionOperations } from "../apps/node/src/browser-companion-operations.ts";
import { runNode } from "../apps/node/src/index.ts";
import { BrowserAuth } from "../apps/server/src/browser-auth.ts";
import { createBrowserRemote } from "../apps/server/src/browser-remote.ts";
import { createBrowserServer } from "../apps/server/src/browser-server.ts";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import { fixture } from "./helpers.ts";

const target = "native-seam-mini";

async function within<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function availablePort(): Promise<number> {
  const reservation = createNetServer();
  try {
    await within(
      new Promise<void>((resolve, reject) => {
        reservation.once("error", reject);
        reservation.listen(0, "127.0.0.1", resolve);
      }),
      5_000,
      "Port reservation did not start.",
    );
    return (reservation.address() as AddressInfo).port;
  } finally {
    if (reservation.listening)
      await within(
        new Promise<void>((resolve, reject) =>
          reservation.close((error) => (error ? reject(error) : resolve())),
        ),
        5_000,
        "Port reservation did not close.",
      );
  }
}

test("native browser route reaches unavailable status and a preselected synthetic AX session", async (t) => {
  const coordinator = await fixture(3_000);
  const agentAbort = new AbortController();
  let agent: Promise<void> | undefined;
  let browser: ReturnType<typeof createBrowserServer> | undefined;
  let accessibility: BrowserAccessibilityRuntime | undefined;
  let helperRoot: string | undefined;
  let bridgeRequests = 0;
  const bridgeTypes: string[] = [];
  const companionCommands: string[] = [];
  const submittedSearches: { controlId: string; query: string }[] = [];
  const selectedCandidates: string[] = [];
  const searchControlId = randomUUID();
  const resultId = randomUUID();
  let watchInspections = 0;
  let webActionCalls = 0;
  let desktopCalls = 0;
  let binding: "unavailable" | { bindingId: string; documentId: string; url: string } =
    "unavailable";
  const events: string[] = [];
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  let cleanupFailures: unknown[] = [];
  try {
    const node = await coordinator.pair(target);
    helperRoot = await mkdtemp(join(tmpdir(), "ellie-native-browser-ax-seam-"));
    const helper = join(helperRoot, "synthetic-accessibility.mjs");
    const helperLog = join(helperRoot, "helper-requests.jsonl");
    await writeFile(
      helper,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
let session, documentRevision;
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  appendFileSync(${JSON.stringify(helperLog)}, JSON.stringify({type:value.type,operation:value.operation,query:value.query,itemID:value.itemID,action:value.action}) + '\\n');
  if (value.type === 'bind') {
    session = 'session-1'; documentRevision = value.documentRevision;
    console.log(JSON.stringify({id:value.id,status:'bound',sessionID:session,documentRevision}));
  } else if (value.type === 'read') {
    console.log(JSON.stringify({id:value.id,status:'completed',sessionID:session,generation:'generation-1',documentRevision,title:'Synthetic public video page',items:[],operation:'read'}));
  } else {
    console.log(JSON.stringify({id:value.id,status:'dispatchedUnverified',sessionID:session,documentRevision,operation:value.operation}));
  }
}
`,
    );
    await chmod(helper, 0o700);
    accessibility = new BrowserAccessibilityRuntime(helper, () => ({
      browserProcessPid: process.pid,
      browserStartSeconds: 1,
      browserStartMicroseconds: 0,
      browserCodeHash: "00".repeat(20),
      connectionId: "synthetic-connection-1",
      authenticated: true,
    }));
    const webmcp = new BrowserWebMCPOperations(
      {
        request: async (request) => {
          bridgeRequests++;
          bridgeTypes.push(request.type);
          if (request.type !== "binding.status") {
            webActionCalls++;
            throw new Error("WebMCP must not execute a site action after AX selection.");
          }
          return binding === "unavailable"
            ? browserWebMCPResultFor(request.id, "unavailable")
            : browserWebMCPResultFor(request.id, "ok", {
                ...binding,
                origin: "https://www.youtube.com",
                expiresAt: Date.now() + 60_000,
                availability: "accessibility",
              });
        },
      },
      { version: 1, bindings: [] },
    );
    const selector = new BrowserOperationSelector(
      (signal, refresh) => (refresh ? webmcp.bindingRefresh(signal) : webmcp.bindingStatus(signal)),
      webmcp,
      accessibility,
      new BrowserCompanionOperations({
        async request(request) {
          assert.equal(request.type, "media.execute");
          if (binding === "unavailable") throw new Error("No selected page.");
          companionCommands.push(request.command.type);
          if (request.command.type === "searchObserved") {
            submittedSearches.push({
              controlId: request.command.controlId,
              query: request.command.query,
            });
            return browserWebMCPResultFor(request.id, "unknown");
          }
          if (request.command.type === "open") {
            selectedCandidates.push(request.command.candidateId);
            return browserWebMCPResultFor(request.id, "unknown");
          }
          assert.equal(request.command.type, "inspect");
          const page =
            binding.documentId === "watch-document"
              ? "watch"
              : binding.documentId === "results-document"
                ? "results"
                : "home";
          if (page === "watch") watchInspections++;
          const site = {
            provider: "youtube",
            page,
            playback:
              page === "watch" ? (watchInspections === 1 ? "paused" : "playing") : "unavailable",
            ...(page === "watch"
              ? {}
              : { searchControl: { id: searchControlId, label: "Search" } }),
          };
          return browserWebMCPResultFor(request.id, "ok", {
            bindingId: binding.bindingId,
            documentId: binding.documentId,
            url: binding.url,
            value: {
              snapshotId: randomUUID(),
              candidates:
                page === "results" ? [{ id: resultId, title: "Synthetic public video" }] : [],
              playback: { available: false },
              ...(page === "watch" ? {} : { searchControl: site.searchControl }),
              site,
            },
          });
        },
      }),
    );
    let registered!: () => void;
    const ready = new Promise<void>((resolve) => (registered = resolve));
    agent = runNode({
      client: node,
      preferences: defaults,
      signal: agentAbort.signal,
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
    await within(ready, 5_000, "Synthetic browser node did not register.");

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
    await within(
      new Promise<void>((resolve, reject) => {
        browser!.server.once("error", reject);
        browser!.server.listen(port, "127.0.0.1", resolve);
      }),
      5_000,
      "Owned native listener did not start.",
    );

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

    async function pair(
      grants: ("app.open" | "browser.read" | "browser.control")[],
      token: string,
    ) {
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
    await assert.rejects(readFile(helperLog), { code: "ENOENT" });
    assert.equal(desktopCalls, 0);
    const jobs = coordinator.jobStore.list(target, 2);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.state, "failed");

    const forbiddenSelect = {
      nodeId: target,
      action: {
        tool: "browser.select",
        itemId: "observed-video-1",
        revision: "a".repeat(64),
      },
    };
    assert.equal(
      (await nativeRequest("/native/v1/commands", forbiddenSelect, grantedToken)).status,
      403,
    );
    assert.equal(coordinator.jobStore.list(target, 2).length, 1);
    assert.equal(bridgeRequests, 1);

    const controlToken = "3".repeat(64);
    await pair(["browser.read", "browser.control"], controlToken);
    binding = {
      bindingId: "initial-binding",
      documentId: "initial-document",
      url: "https://www.youtube.com/",
    };
    const initialStatus = await nativeRequest("/native/v1/commands", command, controlToken);
    assert.equal(initialStatus.status, 200);
    assert.equal(record(initialStatus.body).outcome, "completed");
    const initialStatusBrowser = record(record(record(initialStatus.body).result).browser);
    assert.deepEqual(
      [initialStatusBrowser.source, initialStatusBrowser.operation, initialStatusBrowser.status],
      ["accessibility", "status", "connected"],
    );
    const initialRevision = initialStatusBrowser.revision;
    assert.equal(typeof initialRevision, "string");
    const initialRead = await nativeRequest(
      "/native/v1/commands",
      {
        nodeId: target,
        action: { tool: "browser.read", view: "summary", revision: initialRevision },
      },
      controlToken,
    );
    assert.equal(initialRead.status, 200);
    assert.equal(record(initialRead.body).outcome, "completed");
    const initialReadBrowser = record(record(record(initialRead.body).result).browser);
    assert.deepEqual(
      [
        initialReadBrowser.source,
        initialReadBrowser.operation,
        initialReadBrowser.status,
        initialReadBrowser.revision,
      ],
      ["companion", "read", "completed", initialRevision],
    );
    assert.deepEqual(record(record(initialReadBrowser.view).site), {
      provider: "youtube",
      page: "home",
      playback: "unavailable",
      searchControl: { id: searchControlId, label: "Search" },
    });
    const query = "Blender official Big Buck Bunny";
    const search = await nativeRequest(
      "/native/v1/commands",
      { nodeId: target, action: { tool: "browser.search", query, revision: initialRevision } },
      controlToken,
    );
    assert.equal(search.status, 200);
    assert.equal(record(search.body).outcome, "unknown");
    assert.equal(record(record(record(search.body).result).browser).status, "unknown");
    assert.equal(coordinator.jobStore.list(target, 1)[0]!.state, "unknown");
    assert.equal(bridgeRequests, 4, "search cannot trigger a second binding or adapter attempt");

    // Results are separately supplied and read after unknown; search has no automatic recovery.
    binding = {
      bindingId: "results-binding",
      documentId: "results-document",
      url: "https://www.youtube.com/results?search_query=Blender+official+Big+Buck+Bunny",
    };
    const connected = await nativeRequest("/native/v1/commands", command, controlToken);
    assert.equal(connected.status, 200);
    assert.equal(record(connected.body).outcome, "completed");
    const resultsStatus = record(record(record(connected.body).result).browser);
    assert.equal(resultsStatus.source, "accessibility");
    assert.equal(resultsStatus.status, "connected");
    const resultsRevision = resultsStatus.revision;
    assert.equal(typeof resultsRevision, "string");
    assert.notEqual(resultsRevision, initialRevision);

    const resultsRead = await nativeRequest(
      "/native/v1/commands",
      {
        nodeId: target,
        action: { tool: "browser.read", view: "summary", revision: resultsRevision },
      },
      controlToken,
    );
    assert.equal(resultsRead.status, 200);
    assert.equal(record(resultsRead.body).outcome, "completed");
    const resultsReadBrowser = record(record(record(resultsRead.body).result).browser);
    assert.deepEqual(
      [
        resultsReadBrowser.source,
        resultsReadBrowser.operation,
        resultsReadBrowser.status,
        resultsReadBrowser.revision,
      ],
      ["companion", "read", "completed", resultsRevision],
    );
    const resultsView = resultsReadBrowser.view;
    assert.deepEqual(record(record(resultsView).site), {
      provider: "youtube",
      page: "results",
      playback: "unavailable",
      searchControl: { id: searchControlId, label: "Search" },
    });
    const resultsItems = record(resultsView).items;
    assert.ok(Array.isArray(resultsItems));
    assert.deepEqual(resultsItems, [{ id: resultId, label: "Synthetic public video" }]);
    const observedItemId = record(resultsItems[0]).id;
    assert.equal(typeof observedItemId, "string");
    const selection = await nativeRequest(
      "/native/v1/commands",
      {
        nodeId: target,
        action: { tool: "browser.select", itemId: observedItemId, revision: resultsRevision },
      },
      controlToken,
    );
    assert.equal(selection.status, 200);
    assert.equal(record(selection.body).outcome, "unknown");
    assert.equal(record(record(record(selection.body).result).browser).status, "unknown");
    assert.equal(coordinator.jobStore.list(target, 1)[0]!.state, "unknown");
    assert.equal(bridgeRequests, 7, "selection cannot cause a second binding or adapter attempt");

    // A new watch binding and explicit read are separate test observations, not an AX fallback.
    binding = {
      bindingId: "watch-binding",
      documentId: "watch-document",
      url: "https://www.youtube.com/watch?v=iTHUUjTA-LI",
    };
    const watchStatus = await nativeRequest("/native/v1/commands", command, controlToken);
    assert.equal(watchStatus.status, 200);
    const watchRevision = record(record(record(watchStatus.body).result).browser).revision;
    assert.equal(typeof watchRevision, "string");
    assert.notEqual(watchRevision, resultsRevision);
    const watchReadAction = {
      nodeId: target,
      action: { tool: "browser.read", view: "summary", revision: watchRevision },
    };
    const firstWatchRead = await nativeRequest(
      "/native/v1/commands",
      watchReadAction,
      controlToken,
    );
    assert.equal(firstWatchRead.status, 200);
    assert.equal(record(firstWatchRead.body).outcome, "completed");
    const watchReadBrowser = record(record(record(firstWatchRead.body).result).browser);
    assert.deepEqual(
      [
        watchReadBrowser.source,
        watchReadBrowser.operation,
        watchReadBrowser.status,
        watchReadBrowser.revision,
      ],
      ["companion", "read", "completed", watchRevision],
    );
    assert.deepEqual(record(record(watchReadBrowser.view).site), {
      provider: "youtube",
      page: "watch",
      playback: "paused",
    });
    const play = await nativeRequest(
      "/native/v1/commands",
      {
        nodeId: target,
        action: { tool: "browser.playback", action: "play", revision: watchRevision },
      },
      controlToken,
    );
    assert.equal(play.status, 200);
    assert.equal(record(play.body).outcome, "unknown");
    assert.equal(bridgeRequests, 10, "play cannot trigger a second binding or adapter attempt");
    const secondWatchRead = await nativeRequest(
      "/native/v1/commands",
      watchReadAction,
      controlToken,
    );
    assert.equal(secondWatchRead.status, 200);
    assert.equal(record(secondWatchRead.body).outcome, "completed");
    const secondWatchReadBrowser = record(record(record(secondWatchRead.body).result).browser);
    assert.deepEqual(
      [
        secondWatchReadBrowser.source,
        secondWatchReadBrowser.operation,
        secondWatchReadBrowser.status,
        secondWatchReadBrowser.revision,
      ],
      ["companion", "read", "completed", watchRevision],
    );
    assert.deepEqual(record(record(secondWatchReadBrowser.view).site), {
      provider: "youtube",
      page: "watch",
      playback: "playing",
    });
    const pause = await nativeRequest(
      "/native/v1/commands",
      {
        nodeId: target,
        action: { tool: "browser.playback", action: "pause", revision: watchRevision },
      },
      controlToken,
    );
    assert.equal(pause.status, 200);
    assert.equal(record(pause.body).outcome, "unknown");

    const helperRequests = (await readFile(helperLog, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            operation?: string;
            query?: string;
            itemID?: string;
            action?: string;
          },
      );
    assert.deepEqual(helperRequests, [
      { type: "bind" },
      { type: "read" },
      { type: "bind" },
      { type: "read" },
      { type: "bind" },
      { type: "read" },
      { type: "perform", operation: "playback", action: "play" },
      { type: "read" },
      { type: "perform", operation: "playback", action: "pause" },
    ]);
    assert.equal(bridgeRequests, 12, "each explicit operation requires one fresh binding check");
    assert.deepEqual(bridgeTypes, Array(12).fill("binding.status"));
    assert.deepEqual(companionCommands, [
      "inspect",
      "searchObserved",
      "inspect",
      "open",
      "inspect",
      "inspect",
    ]);
    assert.deepEqual(submittedSearches, [
      { controlId: searchControlId, query: "Blender official Big Buck Bunny" },
    ]);
    assert.deepEqual(selectedCandidates, [resultId]);
    assert.equal(webActionCalls, 0, "AX and companion dispatch must never switch to WebMCP");
    assert.equal(desktopCalls, 0);
    const allJobs = coordinator.jobStore.list(target, 20);
    assert.equal(allJobs.length, 12, "unknown operations must not generate replay jobs");
    assert.deepEqual(
      allJobs.map((job) => job.state).sort(),
      ["failed", ...Array(7).fill("completed"), ...Array(4).fill("unknown")].sort(),
    );
    assert.deepEqual(events, ["connected"]);
  } catch (error) {
    primaryFailure = error;
    hasPrimaryFailure = true;
  } finally {
    agentAbort.abort();
    const cleanup: Promise<unknown>[] = [];
    if (browser) {
      const closed = browser.server.listening
        ? new Promise<void>((resolve) => browser!.server.once("close", resolve))
        : Promise.resolve();
      try {
        browser.shutdown();
      } catch (error) {
        cleanupFailures.push(error);
      }
      cleanup.push(within(closed, 5_000, "Owned native listener did not close."));
    }
    cleanup.push(within(coordinator.close(), 5_000, "Owned coordinator did not close."));
    if (agent) cleanup.push(within(agent, 5_000, "Owned browser node did not stop."));
    if (accessibility)
      cleanup.push(within(accessibility.close(), 5_000, "Owned AX helper did not stop."));
    const results = await Promise.allSettled(cleanup);
    cleanupFailures.push(
      ...results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      ),
    );
    if (helperRoot && !hasPrimaryFailure && cleanupFailures.length === 0)
      try {
        await within(rm(helperRoot, { recursive: true }), 5_000, "Owned AX fixture did not clean.");
      } catch (error) {
        cleanupFailures.push(error);
      }
    if (helperRoot && (hasPrimaryFailure || cleanupFailures.length > 0))
      t.diagnostic(`Retained synthetic AX fixture: ${helperRoot}`);
  }
  if (cleanupFailures.length)
    throw new AggregateError(
      hasPrimaryFailure ? [primaryFailure, ...cleanupFailures] : cleanupFailures,
      "Synthetic browser cleanup failed.",
    );
  if (hasPrimaryFailure) throw primaryFailure;
});
