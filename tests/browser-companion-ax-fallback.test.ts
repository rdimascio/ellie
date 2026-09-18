import assert from "node:assert/strict";
import test from "node:test";
import { browserWebMCPAction, browserWebMCPOperationResult } from "@ellie/protocol";
import type { BrowserAction, Result } from "@ellie/protocol";
import type { BrowserAccessibilityRuntime } from "../apps/node/src/browser-accessibility-runtime.ts";
import type { BrowserCompanionOperations } from "../apps/node/src/browser-companion-operations.ts";
import { BrowserOperationSelector } from "../apps/node/src/browser-operation-selector.ts";
import {
  browserBindingRevision,
  type BrowserBinding,
} from "../apps/node/src/browser-operations.ts";

const origins = [
  "https://www.netflix.com",
  "https://tv.youtube.com",
  "https://www.disneyplus.com",
] as const;

function browserResult(result: Result) {
  assert.ok("browser" in result);
  return result.browser;
}

function setup(origin: string, page: "unsupported" | "login" = "unsupported") {
  let binding: BrowserBinding = {
    availability: "companion",
    bindingId: "binding-1",
    documentId: "document-1",
    origin,
    url: `${origin}/browse`,
    expiresAt: Date.now() + 60_000,
  };
  let companionCalls = 0;
  const axCalls: string[] = [];
  let axDirections: ("up" | "down")[] = ["down"];
  let afterCompanion: (() => void) | undefined;
  let afterAX: (() => void) | undefined;
  const companion = {
    async execute(action: BrowserAction) {
      if (action.tool !== "browser.read") throw new Error("Companion action must not run.");
      companionCalls += 1;
      afterCompanion?.();
      return browserWebMCPOperationResult({
        ok: true,
        message: "Observed page.",
        browser: {
          source: "companion",
          operation: "read",
          status: "completed",
          revision: browserBindingRevision(binding),
          view: {
            items: [],
            site: {
              provider: origin.includes("netflix")
                ? "netflix"
                : origin.includes("disneyplus")
                  ? "disneyplus"
                  : "youtube_tv",
              page,
              playback: "unavailable",
            },
          },
        },
      });
    },
    invalidate() {},
  } as unknown as BrowserCompanionOperations;
  const accessibility = {
    async execute(action: BrowserAction) {
      axCalls.push(action.tool);
      afterAX?.();
      if (action.tool === "browser.read")
        return browserWebMCPOperationResult({
          ok: true,
          message: "Observed web area.",
          browser: {
            source: "accessibility",
            operation: "read",
            status: "completed",
            revision: browserBindingRevision(binding),
            view: { items: [], axScrollDirections: axDirections },
          },
        });
      return browserWebMCPOperationResult({
        ok: false,
        message: "One scroll dispatched.",
        browser: {
          source: "accessibility",
          operation: "command",
          status: "unknown",
          revision: browserBindingRevision(binding),
        },
      });
    },
  } as unknown as BrowserAccessibilityRuntime;
  const selector = new BrowserOperationSelector(
    async () => binding,
    {
      async execute() {
        throw new Error("WebMCP must not run.");
      },
    },
    accessibility,
    companion,
  );
  const revision = browserBindingRevision(binding);
  const read = (signal = new AbortController().signal) =>
    selector.execute(
      browserWebMCPAction({ tool: "browser.read", view: "summary", revision }),
      signal,
    );
  const scroll = (direction: "up" | "down" | "left", signal = new AbortController().signal) =>
    selector.execute(browserWebMCPAction({ tool: "browser.scroll", direction, revision }), signal);
  return {
    selector,
    read,
    scroll,
    revision,
    axCalls,
    get companionCalls() {
      return companionCalls;
    },
    changeBinding() {
      binding = { ...binding, documentId: "document-2" };
    },
    setDirections(value: ("up" | "down")[]) {
      axDirections = value;
    },
    afterCompanion(value: () => void) {
      afterCompanion = value;
    },
    afterAX(value: () => void) {
      afterAX = value;
    },
  };
}

for (const origin of origins) {
  test(`${origin}: unsupported companion read admits one observed AX vertical scroll`, async () => {
    const f = setup(origin);
    const read = await f.read();
    const observed = browserResult(read);
    assert.equal(observed.source, "accessibility");
    assert.equal(observed.operation, "read");
    assert.deepEqual(observed.view.axScrollDirections, ["down"]);
    await assert.rejects(f.scroll("up"), /observed browser control/);
    await assert.rejects(f.scroll("left"), /observed browser control/);
    await assert.rejects(
      f.selector.execute(
        { tool: "browser.playback", action: "play", revision: f.revision },
        AbortSignal.timeout(1000),
      ),
      /observed browser control/,
    );
    assert.deepEqual(f.axCalls, ["browser.read"]);
    assert.equal(browserResult(await f.scroll("down")).status, "unknown");
    await assert.rejects(f.scroll("down"), /observed browser control/);
    assert.deepEqual(f.axCalls, ["browser.read", "browser.scroll"]);
    assert.equal(f.companionCalls, 1);
  });
}

test("supported companion page stays on companion and a read failure never switches adapter", async () => {
  const supported = setup(origins[0], "login");
  assert.equal(browserResult(await supported.read()).source, "companion");
  assert.deepEqual(supported.axCalls, []);
  for (const reason of ["page_changed", "cancelled", "unavailable", "unknown"]) {
    const f = setup(origins[0]);
    f.afterCompanion(() => {
      throw new Error(reason);
    });
    await assert.rejects(f.read(), new RegExp(reason));
    assert.deepEqual(f.axCalls, []);
  }
});

test("binding, cancellation and an ambiguous AX observation prevent scroll admission", async () => {
  const stale = setup(origins[1]);
  stale.afterCompanion(() => stale.changeBinding());
  await assert.rejects(stale.read(), /page changed/);
  assert.deepEqual(stale.axCalls, []);

  const cancelled = setup(origins[1]);
  const controller = new AbortController();
  cancelled.afterCompanion(() => controller.abort());
  await assert.rejects(cancelled.read(controller.signal), /cancelled/);
  assert.deepEqual(cancelled.axCalls, []);

  const duringAX = setup(origins[1]);
  duringAX.afterAX(() => duringAX.changeBinding());
  await assert.rejects(duringAX.read(), /page changed/);
  assert.deepEqual(duringAX.axCalls, ["browser.read"]);
  await assert.rejects(duringAX.scroll("down"), /Companion action must not run/);

  const noScroll = setup(origins[1]);
  noScroll.setDirections([]);
  assert.equal(browserResult(await noScroll.read()).source, "accessibility");
  await assert.rejects(noScroll.scroll("down"), /observed browser control/);
  assert.deepEqual(noScroll.axCalls, ["browser.read"]);
});

test("an unknown AX scroll consumes observation without replay", async () => {
  const f = setup(origins[2]);
  await f.read();
  assert.equal(browserResult(await f.scroll("down")).status, "unknown");
  await assert.rejects(f.scroll("down"), /observed browser control/);
  assert.deepEqual(f.axCalls, ["browser.read", "browser.scroll"]);
});

test("AX scroll capability is a bounded read-only protocol field", () => {
  const read = (source: "accessibility" | "companion", directions: unknown) => ({
    ok: true,
    message: "Observed.",
    browser: {
      source,
      operation: "read",
      status: "completed",
      revision: "revision-1",
      view: { items: [], axScrollDirections: directions },
    },
  });
  assert.deepEqual(
    browserWebMCPOperationResult(read("accessibility", ["up", "down"])).browser,
    read("accessibility", ["up", "down"]).browser,
  );
  for (const directions of [["down", "down"], ["left"], ["up", "down", "up"], "down"])
    assert.throws(() => browserWebMCPOperationResult(read("accessibility", directions)));
  assert.throws(() => browserWebMCPOperationResult(read("companion", ["down"])));
});
