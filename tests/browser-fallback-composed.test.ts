import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserWebMCPResultFor, type BrowserWebMCPRequest } from "@ellie/protocol";
import { BrowserAccessibilityRuntime } from "../apps/node/src/browser-accessibility-runtime.ts";
import { BrowserCompanionOperations } from "../apps/node/src/browser-companion-operations.ts";
import { BrowserOperationSelector } from "../apps/node/src/browser-operation-selector.ts";
import {
  browserBindingRevision,
  type BrowserBinding,
  BrowserWebMCPOperations,
} from "../apps/node/src/browser-operations.ts";

test(
  "unsupported companion read falls back to the exact selected AX document without replay",
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ellie-browser-fallback-composed-"));
    const helper = join(root, "synthetic-accessibility.mjs");
    const helperLog = join(root, "helper.jsonl");
    let runtime: BrowserAccessibilityRuntime | undefined;
    let completed = false;
    try {
      await writeFile(
        helper,
        `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
let session;
let documentRevision;
for await (const line of createInterface({ input: process.stdin })) {
  const value = JSON.parse(line);
  appendFileSync(${JSON.stringify(helperLog)}, JSON.stringify({type:value.type,documentRevision:value.documentRevision,operation:value.operation,direction:value.direction}) + "\\n");
  if (value.type === "bind") {
    session = "session-" + value.documentRevision;
    documentRevision = value.documentRevision;
    console.log(JSON.stringify({id:value.id,status:"bound",sessionID:session,documentRevision}));
  } else if (value.type === "read") {
    console.log(JSON.stringify({id:value.id,status:"completed",sessionID:session,generation:"generation-1",documentRevision,items:[],scrollDirections:["down"],operation:"read"}));
  } else {
    console.log(JSON.stringify({id:value.id,status:"dispatchedUnverified",sessionID:session,documentRevision,operation:value.operation}));
  }
}
`,
      );
      await chmod(helper, 0o700);

      const origin = "https://www.netflix.com";
      let binding: BrowserBinding = {
        availability: "companion",
        bindingId: "binding-a",
        documentId: "document-a",
        origin,
        url: `${origin}/browse`,
        expiresAt: Date.now() + 60_000,
      };
      const bindingRequests: string[] = [];
      const companionDocuments: string[] = [];
      const webmcp = new BrowserWebMCPOperations(
        {
          async request(request: BrowserWebMCPRequest) {
            bindingRequests.push(request.type);
            assert.equal(request.type, "binding.status");
            return browserWebMCPResultFor(request.id, "ok", binding);
          },
        },
        { version: 1, bindings: [] },
      );
      const companion = new BrowserCompanionOperations({
        async request(request) {
          assert.equal(request.type, "media.execute");
          assert.equal(request.command.type, "inspect");
          companionDocuments.push(request.documentId);
          assert.equal(request.bindingId, binding.bindingId);
          assert.equal(request.documentId, binding.documentId);
          return browserWebMCPResultFor(request.id, "ok", {
            bindingId: request.bindingId,
            documentId: request.documentId,
            url: binding.url,
            value: {
              snapshotId: "00000000-0000-4000-8000-000000000001",
              candidates: [],
              playback: { available: false },
              site: { provider: "netflix", page: "unsupported", playback: "unavailable" },
            },
          });
        },
      });
      runtime = new BrowserAccessibilityRuntime(helper, () => ({
        browserProcessPid: process.pid,
        browserStartSeconds: 1,
        browserStartMicroseconds: 0,
        browserCodeHash: "00".repeat(20),
        connectionId: "synthetic-composed-fallback",
        authenticated: true,
      }));
      const selector = new BrowserOperationSelector(
        (signal) => webmcp.bindingStatus(signal),
        webmcp,
        runtime,
        companion,
      );
      const status = await selector.execute({ tool: "browser.status" }, AbortSignal.timeout(1_000));
      assert.ok("browser" in status);
      assert.equal(status.browser.source, "companion");
      const revisionA = status.browser.revision!;
      const read = (revision: string) =>
        selector.execute(
          { tool: "browser.read", view: "summary", revision },
          AbortSignal.timeout(2_000),
        );
      const scroll = (revision: string) =>
        selector.execute(
          { tool: "browser.scroll", direction: "down", revision },
          AbortSignal.timeout(2_000),
        );

      const readA = await read(revisionA);
      assert.ok("browser" in readA);
      assert.equal(readA.browser.source, "accessibility");
      assert.equal(readA.browser.operation, "read");
      if (readA.browser.operation !== "read") throw new Error("Expected a read result.");
      assert.deepEqual(readA.browser.view.axScrollDirections, ["down"]);

      binding = {
        ...binding,
        bindingId: "binding-b",
        documentId: "document-b",
        url: `${origin}/browse/genre/83`,
      };
      await assert.rejects(scroll(revisionA), /page changed|Read the Netflix page/);
      let helperRows = (await readFile(helperLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(helperRows.filter((row) => row.type === "perform").length, 0);

      const revisionB = browserBindingRevision(binding);
      const readB = await read(revisionB);
      assert.ok("browser" in readB);
      assert.equal(readB.browser.source, "accessibility");
      const unknown = await scroll(revisionB);
      assert.ok("browser" in unknown);
      assert.equal(unknown.browser.operation, "command");
      assert.equal(unknown.browser.status, "unknown");
      await assert.rejects(scroll(revisionB), /observed browser control/);

      helperRows = (await readFile(helperLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(
        helperRows.map((row) => [row.type, row.documentRevision, row.operation, row.direction]),
        [
          ["bind", "document-a", undefined, undefined],
          ["read", undefined, undefined, undefined],
          ["bind", "document-b", undefined, undefined],
          ["read", undefined, undefined, undefined],
          ["perform", "document-b", "scroll", "down"],
        ],
      );
      assert.deepEqual(companionDocuments, ["document-a", "document-b"]);
      assert.deepEqual(bindingRequests, Array(12).fill("binding.status"));
      completed = true;
    } finally {
      await runtime?.close();
      if (completed) await rm(root, { recursive: true });
      else t.diagnostic(`Retained composed browser fallback fixture: ${root}`);
    }
  },
);
