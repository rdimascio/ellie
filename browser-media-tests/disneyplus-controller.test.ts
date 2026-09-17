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
  if (anchor.id === 'title' && !window.noNavigate) history.pushState({}, '', anchor.href);
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
      assert.deepEqual(read.site, observation);
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
