import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "@playwright/test";

const controller = join(
  new URL("../apps/browser-media-extension/", import.meta.url).pathname,
  "media-controller.js",
);
const home = "https://www.youtube.com/";
const query = "NASA Artemis official launch";
const results = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
const watch = "https://www.youtube.com/watch?v=abcdefghijk";
const fixture = `<!doctype html><style>
body { margin: 0; font: 18px sans-serif }
.ytSearchboxComponentInputContainer { display: flex; gap: 8px; margin: 16px }
input,button { width: 280px; height: 42px }
a { display: block; width: 360px; height: 42px; margin: 16px }
</style><div class="ytSearchboxComponentInputContainer">
<div><form action="/results"><input name="search_query" role="combobox" type="text"
  placeholder="Search"></form></div>
<button id="submit" aria-label="Search">Search</button></div>
<button id="narrow" aria-label="Search" style="display:none">Search</button>
<main><a id="title" href="/watch?v=abcdefghijk" title="Observed public title">Observed public title</a></main>
<script>
window.effects = { searches: 0, opens: 0 };
document.querySelector('#submit').addEventListener('click', event => {
  event.preventDefault();
  window.effects.searches++;
  const value = document.querySelector('input').value;
  history.pushState({}, '', '/results?search_query=' + encodeURIComponent(value));
});
document.querySelector('#title').addEventListener('click', event => {
  event.preventDefault();
  window.effects.opens++;
  history.pushState({}, '', event.currentTarget.href);
});
</script>`;

const id = () => crypto.randomUUID();
const dispatch = (page: Page, command: Record<string, unknown>, expected = page.url()) =>
  page.evaluate(
    ({ command, expected }) =>
      globalThis["__ellieMediaController"].dispatch(command, expected, Date.now() + 1_800),
    { command, expected },
  );

async function withPage(run: (page: Page) => Promise<void>) {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, channel: "chromium" });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route("https://www.youtube.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: fixture }),
    );
    await page.goto(home);
    await page.addScriptTag({ path: controller });
    await run(page);
  } finally {
    await browser?.close();
  }
}

test(
  "YouTube observed search selects the one visible control, then one observed title",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      const read = await dispatch(page, { type: "inspect", actionId: id() });
      assert.deepEqual(read.site, { provider: "youtube", page: "home", playback: "unavailable" });
      assert.equal(read.searchControl.label, "Search");
      const command = {
        type: "searchObserved",
        actionId: id(),
        snapshotId: read.snapshotId,
        controlId: read.searchControl.id,
        query,
      };
      assert.deepEqual(await dispatch(page, command, home), { outcome: "navigation_observed" });
      assert.equal(page.url(), results);
      assert.deepEqual(await page.evaluate(() => globalThis["effects"]), { searches: 1, opens: 0 });
      await assert.rejects(
        dispatch(page, { ...command, actionId: id() }, results),
        /stale_snapshot/,
      );
      const found = await dispatch(page, { type: "inspect", actionId: id() }, results);
      assert.equal(found.site.page, "results");
      const selected = found.candidates.find(
        (entry: { title: string }) => entry.title === "Observed public title",
      );
      assert.ok(selected);
      assert.deepEqual(
        await dispatch(
          page,
          {
            type: "open",
            actionId: id(),
            snapshotId: found.snapshotId,
            candidateId: selected.id,
          },
          results,
        ),
        { outcome: "navigation_observed" },
      );
      assert.equal(page.url(), watch);
      assert.deepEqual(await page.evaluate(() => globalThis["effects"]), { searches: 1, opens: 1 });
    });
  },
);

test(
  "a full search navigation permits one explicit fresh results inspection without replay",
  { timeout: 15_000 },
  async () => {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true, channel: "chromium" });
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.route("https://www.youtube.com/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: route.request().url().includes("/results?")
            ? `<a href="/watch?v=abcdefghijk" title="Observed public title">Observed public title</a>`
            : fixture
                .replace(
                  /window\.effects\.searches\+\+;/,
                  "sessionStorage.setItem('searchClicks', String(Number(sessionStorage.getItem('searchClicks') || 0) + 1));",
                )
                .replace(
                  /history\.pushState\(\{\}, '', '\/results\?search_query=' \+ encodeURIComponent\(value\)\);/,
                  "location.href = '/results?search_query=' + encodeURIComponent(value);",
                ),
        }),
      );
      await page.goto(home);
      await page.addScriptTag({ path: controller });
      const first = await dispatch(page, { type: "inspect", actionId: id() }, home);
      const search = dispatch(
        page,
        {
          type: "searchObserved",
          actionId: id(),
          snapshotId: first.snapshotId,
          controlId: first.searchControl.id,
          query,
        },
        home,
      ).catch(() => undefined);
      await page.waitForURL(results, { waitUntil: "domcontentloaded" });
      await search;
      assert.equal(await page.evaluate(() => sessionStorage.getItem("searchClicks")), "1");
      await page.addScriptTag({ path: controller });
      const observed = await dispatch(page, { type: "inspect", actionId: id() }, results);
      assert.equal(observed.site.page, "results");
      assert.equal(
        observed.candidates.filter(
          (entry: { title: string }) => entry.title === "Observed public title",
        ).length,
        1,
      );
      assert.equal(await page.evaluate(() => sessionStorage.getItem("searchClicks")), "1");
    } finally {
      await browser?.close();
    }
  },
);

test(
  "YouTube changed, covered or ambiguous search controls do not dispatch",
  { timeout: 15_000 },
  async () => {
    await withPage(async (page) => {
      let read = await dispatch(page, { type: "inspect", actionId: id() });
      await page.locator("input[name=search_query]").evaluate((input) => {
        input.setAttribute("placeholder", "Search profiles");
      });
      const command = () => ({
        type: "searchObserved",
        actionId: id(),
        snapshotId: read.snapshotId,
        controlId: read.searchControl.id,
        query,
      });
      await assert.rejects(dispatch(page, command()), /search_unavailable/);
      await page.locator("input[name=search_query]").evaluate((input) => {
        input.setAttribute("placeholder", "Search");
      });
      read = await dispatch(page, { type: "inspect", actionId: id() });
      await page
        .locator("#submit")
        .evaluate((button) => button.setAttribute("aria-label", "Subscribe"));
      await assert.rejects(dispatch(page, command()), /search_unavailable/);
      await page
        .locator("#submit")
        .evaluate((button) => button.setAttribute("aria-label", "Search"));
      read = await dispatch(page, { type: "inspect", actionId: id() });
      await page.evaluate(() => {
        const cover = document.createElement("div");
        cover.id = "cover";
        cover.style.cssText = "position:fixed;inset:0;z-index:10;background:#fff";
        document.body.append(cover);
      });
      await assert.rejects(dispatch(page, command()), /search_unavailable/);
      await page.locator("#cover").evaluate((cover) => cover.remove());
      read = await dispatch(page, { type: "inspect", actionId: id() });
      await page.evaluate(() => {
        const duplicate = document.querySelector("input[name=search_query]")!.cloneNode(true);
        document.querySelector("form")!.append(duplicate);
      });
      await assert.rejects(dispatch(page, command()), /search_unavailable/);
      assert.deepEqual(await page.evaluate(() => globalThis["effects"]), { searches: 0, opens: 0 });
    });
  },
);
