import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";

const modulePath = join(
  new URL("../apps/browser-media-extension/", import.meta.url).pathname,
  "disneyplus-controller.js",
);
const current = "https://www.disneyplus.com/browse/entity-2fa6a394-c272-41ef-afaa-714116cb16f2";
const next = "https://www.disneyplus.com/browse/entity-76ff81fe-447b-4d3b-8a5e-f07db1b6be27";
const actionId = () => crypto.randomUUID();
const fixture = `<!doctype html><style>
body { margin: 0; font: 20px sans-serif; }
a { display: inline-block; width: 260px; height: 80px; margin: 24px; }
</style><main>
<a id="title" href="${next}" aria-label="Observed title">Observed title</a>
<a id="login" href="/identity/login">Sign in</a>
<a id="plan" href="/commerce/plans">Subscribe</a>
<a id="external" href="https://elsewhere.example/browse/entity-76ff81fe-447b-4d3b-8a5e-f07db1b6be27">Outside</a>
<a id="hidden" style="display:none" href="${next}">Hidden copy</a>
</main><script>
window.clicks = [];
document.addEventListener('click', event => {
  const anchor = event.target.closest('a');
  if (!anchor) return;
  event.preventDefault();
  window.clicks.push(anchor.id);
  if (anchor.id === 'title' && !window.noNavigate)
    history.pushState({}, '', window.wrongNavigate ? '/commerce/plans' : anchor.href);
});
</script>`;

async function dispatch(page: Page, command: Record<string, unknown>, expected = current) {
  return page.evaluate(
    ({ command, expected }) =>
      globalThis["__ellieMediaController"].dispatch(command, expected, Date.now() + 1_800),
    { command, expected },
  );
}

async function withPage(run: (page: Page) => Promise<void>) {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, channel: "chromium" });
    const page = await browser.newPage();
    await page.route("https://www.disneyplus.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: fixture }),
    );
    await page.goto(current);
    await page.addScriptTag({ path: modulePath });
    await run(page);
  } finally {
    await browser?.close();
  }
}

async function makeViewportScrollable(page: Page) {
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.id = "scroll-spacer";
    spacer.style.height = "2400px";
    document.body.append(spacer);
  });
}

test(
  "Disney+ one observed viewport scroll needs a fresh read and never replays",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      await makeViewportScrollable(page);
      const first = await dispatch(page, { type: "inspect", actionId: actionId() });
      assert.deepEqual(first.site.verticalScrollDirections, ["down"]);
      const down = {
        type: "scrollViewport",
        actionId: actionId(),
        direction: "down",
        snapshotId: first.snapshotId,
      };
      assert.deepEqual(await dispatch(page, down), { outcome: "scrolled" });
      const afterDown = await page.evaluate(() => scrollY);
      assert.ok(afterDown > 0);
      await assert.rejects(dispatch(page, down), /duplicate_action/);
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: first.snapshotId,
        }),
        /stale_snapshot/,
      );
      assert.equal(await page.evaluate(() => scrollY), afterDown);
      const next = await dispatch(page, { type: "inspect", actionId: actionId() });
      assert.notEqual(next.snapshotId, first.snapshotId);
      assert.deepEqual(next.site.verticalScrollDirections, ["up", "down"]);
      assert.deepEqual(
        await dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "up",
          snapshotId: next.snapshotId,
        }),
        { outcome: "scrolled" },
      );
      assert.equal(await page.evaluate(() => scrollY), 0);
      await page.evaluate(() => scrollTo(0, document.scrollingElement?.scrollHeight || 0));
      const bottom = await dispatch(page, { type: "inspect", actionId: actionId() });
      assert.deepEqual(bottom.site.verticalScrollDirections, ["up"]);
      await page.evaluate(() => scrollTo(0, 0));
      const ready = await dispatch(page, { type: "inspect", actionId: actionId() });
      assert.equal(ready.candidates[0]?.title, "Observed title");
      assert.deepEqual(await page.evaluate(() => globalThis["clicks"]), []);
    });
  },
);

test(
  "Disney+ scroll is bound to the exact inspect snapshot and an unverified effect never rearms",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      await makeViewportScrollable(page);
      const first = await dispatch(page, { type: "inspect", actionId: actionId() });
      const replacement = await dispatch(page, { type: "inspect", actionId: actionId() });
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: first.snapshotId,
        }),
        /stale_snapshot/,
      );
      assert.equal(await page.evaluate(() => scrollY), 0);
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: replacement.snapshotId,
        }),
        /stale_snapshot/,
      );

      const fresh = await dispatch(page, { type: "inspect", actionId: actionId() });
      await page.evaluate(() => {
        const root = document.scrollingElement;
        if (!root) throw new Error("missing root");
        globalThis["savedDisneyScrollBy"] = root.scrollBy;
        root.scrollBy = () => {};
      });
      assert.deepEqual(
        await dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: fresh.snapshotId,
        }),
        { outcome: "scroll_unverified" },
      );
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: fresh.snapshotId,
        }),
        /stale_snapshot/,
      );
      assert.equal(await page.evaluate(() => scrollY), 0);
    });
  },
);

test(
  "Disney+ invalid viewport geometry exposes no scroll direction",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      await makeViewportScrollable(page);
      await page.evaluate(() => {
        const root = document.scrollingElement;
        if (!root) throw new Error("missing root");
        Object.defineProperty(root, "clientHeight", { configurable: true, value: 0 });
      });
      assert.deepEqual(
        (await dispatch(page, { type: "inspect", actionId: actionId() })).site
          .verticalScrollDirections,
        [],
      );
      await page.evaluate(() => {
        const root = document.scrollingElement;
        if (!root) throw new Error("missing root");
        delete root.clientHeight;
        Object.defineProperty(root, "scrollTop", {
          configurable: true,
          value: root.scrollHeight + 100,
          writable: true,
        });
      });
      assert.deepEqual(
        (await dispatch(page, { type: "inspect", actionId: actionId() })).site
          .verticalScrollDirections,
        [],
      );
    });
  },
);

test(
  "Disney+ stale, cancelled, blocked, absent and ambiguous viewport scrolls have no effect",
  { timeout: 20_000 },
  async () => {
    await withPage(async (page) => {
      const missing = await dispatch(page, { type: "inspect", actionId: actionId() });
      assert.ok(missing.snapshotId);
      assert.deepEqual(missing.site.verticalScrollDirections, []);
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: missing.snapshotId,
        }),
        /scroll_unavailable/,
      );
      await makeViewportScrollable(page);
      let read = await dispatch(page, { type: "inspect", actionId: actionId() });
      await page.evaluate(() => history.pushState({}, "", "/commerce/plans"));
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: read.snapshotId,
        }),
        /page_changed/,
      );
      await page.evaluate((url) => history.pushState({}, "", url), current);
      assert.equal(await page.evaluate(() => scrollY), 0);

      read = await dispatch(page, { type: "inspect", actionId: actionId() });
      await page.evaluate(() => scrollTo(0, 30));
      const movedExternally = await page.evaluate(() => scrollY);
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: read.snapshotId,
        }),
        /stale_snapshot/,
      );
      assert.equal(await page.evaluate(() => scrollY), movedExternally);
      await page.evaluate(() => scrollTo(0, 0));

      read = await dispatch(page, { type: "inspect", actionId: actionId() });
      await page.evaluate(() => {
        const extra = document.createElement("div");
        extra.id = "changed-height";
        extra.style.height = "300px";
        document.body.append(extra);
      });
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: read.snapshotId,
        }),
        /stale_snapshot/,
      );
      assert.equal(await page.evaluate(() => scrollY), 0);

      read = await dispatch(page, { type: "inspect", actionId: actionId() });
      const cancelled = actionId();
      await dispatch(page, { type: "cancel", actionId: actionId(), targetActionId: cancelled });
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: cancelled,
          direction: "down",
          snapshotId: read.snapshotId,
        }),
        /cancelled/,
      );
      assert.equal(await page.evaluate(() => scrollY), 0);
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: read.snapshotId,
        }),
        /stale_snapshot/,
      );

      read = await dispatch(page, { type: "inspect", actionId: actionId() });
      await page.locator("main").evaluate((node) => node.setAttribute("role", "dialog"));
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: read.snapshotId,
        }),
        /unsupported_page/,
      );
      assert.equal(await page.evaluate(() => scrollY), 0);
      await page.locator("main").evaluate((node) => node.removeAttribute("role"));

      await page.evaluate(() => {
        document.body.style.overflowY = "hidden";
      });
      read = await dispatch(page, { type: "inspect", actionId: actionId() });
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: read.snapshotId,
        }),
        /scroll_unavailable/,
      );
      await page.evaluate(() => {
        document.body.style.overflowY = "";
      });
      assert.equal(await page.evaluate(() => scrollY), 0);

      await page.evaluate(() => {
        const competing = document.createElement("div");
        competing.id = "competing-scroller";
        competing.style.cssText =
          "position:fixed;left:25vw;top:25vh;width:50vw;height:50vh;overflow-y:auto;z-index:10;background:white";
        competing.innerHTML = '<div style="height:150vh">Competing page region</div>';
        document.body.append(competing);
      });
      read = await dispatch(page, { type: "inspect", actionId: actionId() });
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: read.snapshotId,
        }),
        /scroll_ambiguous/,
      );
      assert.equal(await page.evaluate(() => scrollY), 0);
      await page.locator("#competing-scroller").evaluate((node) => node.remove());
      await page.evaluate(() => {
        const cover = document.createElement("div");
        cover.id = "fixed-scroll-cover";
        cover.style.cssText =
          "position:fixed;inset:0;z-index:20;background:white;pointer-events:auto";
        document.body.append(cover);
      });
      read = await dispatch(page, { type: "inspect", actionId: actionId() });
      assert.deepEqual(read.site.verticalScrollDirections, []);
      await assert.rejects(
        dispatch(page, {
          type: "scrollViewport",
          actionId: actionId(),
          direction: "down",
          snapshotId: read.snapshotId,
        }),
        /scroll_unavailable/,
      );
      assert.deepEqual(await page.evaluate(() => globalThis["clicks"]), []);
    });
  },
);

test(
  "Disney+ public entity inspection exposes only one observed title and no playback",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      const observation = await dispatch(page, { type: "observe", actionId: actionId() });
      assert.deepEqual(observation, {
        provider: "disneyplus",
        page: "browse",
        playback: "unavailable",
      });
      const read = await dispatch(page, { type: "inspect", actionId: actionId() });
      assert.deepEqual(read.site, { ...observation, verticalScrollDirections: [] });
      assert.deepEqual(read.playback, { available: false });
      assert.equal(read.candidates.length, 1);
      assert.equal(read.candidates[0].title, "Observed title");
      await assert.rejects(
        dispatch(page, { type: "play", actionId: actionId() }),
        /invalid_command/,
      );
      await assert.rejects(
        dispatch(page, { type: "searchObserved", actionId: actionId() }),
        /invalid_command/,
      );
      assert.deepEqual(await page.evaluate(() => globalThis["clicks"]), []);
    });
  },
);

test(
  "Disney+ selection revalidates handle, navigates once and cannot replay",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      const read = await dispatch(page, { type: "inspect", actionId: actionId() });
      const open = {
        type: "open",
        actionId: actionId(),
        snapshotId: read.snapshotId,
        candidateId: read.candidates[0].id,
      };
      assert.deepEqual(await dispatch(page, open), { outcome: "navigation_observed" });
      assert.deepEqual(await page.evaluate(() => globalThis["clicks"]), ["title"]);
      await assert.rejects(dispatch(page, open, next), /duplicate_action/);
      await assert.rejects(
        dispatch(page, { ...open, actionId: actionId() }, next),
        /unsupported_page|stale_snapshot/,
      );
      assert.deepEqual(await page.evaluate(() => globalThis["clicks"]), ["title"]);
    });
  },
);

test(
  "Disney+ changed, duplicate and cancelled handles never click",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      let read = await dispatch(page, { type: "inspect", actionId: actionId() });
      await page.locator("#title").evaluate((node) => node.setAttribute("aria-label", "Changed"));
      await assert.rejects(
        dispatch(page, {
          type: "open",
          actionId: actionId(),
          snapshotId: read.snapshotId,
          candidateId: read.candidates[0].id,
        }),
        /stale_candidate/,
      );
      await page
        .locator("#title")
        .evaluate((node) => node.setAttribute("aria-label", "Observed title"));
      read = await dispatch(page, { type: "inspect", actionId: actionId() });
      await page.locator("#hidden").evaluate((node) => node.removeAttribute("style"));
      await assert.rejects(
        dispatch(page, {
          type: "open",
          actionId: actionId(),
          snapshotId: read.snapshotId,
          candidateId: read.candidates[0].id,
        }),
        /stale_candidate/,
      );
      await page.locator("#hidden").evaluate((node) => node.setAttribute("style", "display:none"));
      read = await dispatch(page, { type: "inspect", actionId: actionId() });
      const cancelledAction = actionId();
      await dispatch(page, {
        type: "cancel",
        actionId: actionId(),
        targetActionId: cancelledAction,
      });
      await assert.rejects(
        dispatch(page, {
          type: "open",
          actionId: cancelledAction,
          snapshotId: read.snapshotId,
          candidateId: read.candidates[0].id,
        }),
        /cancelled/,
      );
      assert.deepEqual(await page.evaluate(() => globalThis["clicks"]), []);
    });
  },
);

test(
  "Disney+ login and unsupported paths do not expose title handles",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      await page.evaluate(() => history.pushState({}, "", "/identity/login"));
      const login = await dispatch(
        page,
        { type: "inspect", actionId: actionId() },
        `${new URL(current).origin}/identity/login`,
      );
      assert.equal(login.site.page, "login");
      assert.deepEqual(login.candidates, []);
      await page.evaluate(() => history.pushState({}, "", "/commerce/plans"));
      const unsupported = await dispatch(
        page,
        { type: "inspect", actionId: actionId() },
        `${new URL(current).origin}/commerce/plans`,
      );
      assert.equal(unsupported.site.page, "unsupported");
      assert.deepEqual(unsupported.candidates, []);
      assert.deepEqual(await page.evaluate(() => globalThis["clicks"]), []);
    });
  },
);

test(
  "Disney+ a clipped or covered title link is not an observed choice",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      await page.locator("main").evaluate((node) => {
        node.style.width = "0px";
        node.style.overflow = "hidden";
      });
      assert.deepEqual(
        (await dispatch(page, { type: "inspect", actionId: actionId() })).candidates,
        [],
      );
      await page.locator("main").evaluate((node) => {
        node.style.width = "";
        node.style.overflow = "";
      });
      await page.evaluate(() => {
        const overlay = document.createElement("div");
        overlay.id = "cover";
        overlay.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:99";
        document.body.append(overlay);
      });
      assert.deepEqual(
        (await dispatch(page, { type: "inspect", actionId: actionId() })).candidates,
        [],
      );
    });
  },
);

test(
  "Disney+ disabled or inert entity links never become clickable handles",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      await page.locator("#title").evaluate((node) => node.setAttribute("aria-disabled", "true"));
      assert.deepEqual(
        (await dispatch(page, { type: "inspect", actionId: actionId() })).candidates,
        [],
      );
      await page.locator("#title").evaluate((node) => {
        node.removeAttribute("aria-disabled");
        node.setAttribute("disabled", "");
      });
      assert.deepEqual(
        (await dispatch(page, { type: "inspect", actionId: actionId() })).candidates,
        [],
      );
      await page.locator("#title").evaluate((node) => node.removeAttribute("disabled"));
      await page.locator("main").evaluate((node) => node.setAttribute("inert", ""));
      assert.deepEqual(
        (await dispatch(page, { type: "inspect", actionId: actionId() })).candidates,
        [],
      );
      await page.locator("main").evaluate((node) => node.removeAttribute("inert"));
      const read = await dispatch(page, { type: "inspect", actionId: actionId() });
      assert.equal(read.candidates.length, 1);
      await page.locator("main").evaluate((node) => node.setAttribute("aria-disabled", "true"));
      await assert.rejects(
        dispatch(page, {
          type: "open",
          actionId: actionId(),
          snapshotId: read.snapshotId,
          candidateId: read.candidates[0].id,
        }),
        /stale_candidate/,
      );
      assert.deepEqual(await page.evaluate(() => globalThis["clicks"]), []);
    });
  },
);

test(
  "Disney+ unobserved navigation is an unknown outcome with no replay",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        globalThis["noNavigate"] = true;
      });
      const read = await dispatch(page, { type: "inspect", actionId: actionId() });
      const open = {
        type: "open",
        actionId: actionId(),
        snapshotId: read.snapshotId,
        candidateId: read.candidates[0].id,
      };
      await assert.rejects(dispatch(page, open), /navigation_not_observed/);
      await assert.rejects(dispatch(page, open), /duplicate_action/);
      assert.deepEqual(await page.evaluate(() => globalThis["clicks"]), ["title"]);
    });
  },
);

test(
  "Disney+ a click that lands away from the observed entity is never a verified selection",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        globalThis["wrongNavigate"] = true;
      });
      const read = await dispatch(page, { type: "inspect", actionId: actionId() });
      const open = {
        type: "open",
        actionId: actionId(),
        snapshotId: read.snapshotId,
        candidateId: read.candidates[0].id,
      };
      await assert.rejects(dispatch(page, open), /page_changed/);
      assert.deepEqual(await page.evaluate(() => globalThis["clicks"]), ["title"]);
      await assert.rejects(
        dispatch(page, open, "https://www.disneyplus.com/commerce/plans"),
        /duplicate_action/,
      );
    });
  },
);
