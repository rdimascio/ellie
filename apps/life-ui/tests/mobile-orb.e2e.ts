import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

const dist = resolve("apps/life-ui/dist");
const types: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".png": "image/png",
};
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const target = normalize(join(dist, pathname === "/" ? "index.html" : pathname.slice(1)));
  if (
    (!target.startsWith(`${dist}/`) && target !== join(dist, "index.html")) ||
    pathname.includes("..")
  ) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("content-type", types[extname(target)] ?? "application/octet-stream");
  createReadStream(target)
    .on("error", () => response.writeHead(404).end())
    .pipe(response);
});
await new Promise<void>((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;

const bootstrap = {
  profile: { id: "orb-fixture", name: "Orb Fixture", timeZone: "America/Los_Angeles" },
  groups: [],
  scope: "user:orb-fixture",
  records: [],
  tasks: [],
  plugins: [],
  settings: {},
  notifications: [],
  capabilities: {},
  chatEpoch: 1,
};
const plans = {
  plans: [
    {
      record: {
        id: "plan-one",
        kind: "memory",
        title: "Prepare the garden",
        scope: { type: "user", id: "orb-fixture" },
        data: {},
        revision: 1,
        createdAt: "2026-09-15T12:00:00Z",
        updatedAt: "2026-09-15T12:00:00Z",
      },
      steps: [{ id: "step-one", title: "Gather tools", completed: false }],
      completedSteps: 0,
      totalSteps: 1,
      completed: false,
    },
  ],
  hasMore: false,
  unavailableCount: 0,
};

async function openFixture(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/life/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const value =
      pathname === "/api/life/bootstrap" ? bootstrap : pathname === "/api/life/plans" ? plans : {};
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  });
  await page.goto(origin);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await page
    .locator(".plan-widget")
    .getByText(/Prepare the garden/)
    .waitFor();
  return errors;
}

async function overlap(page: Page) {
  return page.evaluate(() => {
    const orb = document.querySelector(".ellie-orb"),
      plan = document.querySelector(".plan-widget .widget-open");
    if (!(orb instanceof HTMLElement) || !(plan instanceof HTMLElement))
      throw new Error("targets missing");
    const orbBounds = orb.getBoundingClientRect(),
      planBounds = plan.getBoundingClientRect(),
      left = Math.max(orbBounds.left, planBounds.left),
      right = Math.min(orbBounds.right, planBounds.right),
      top = Math.max(orbBounds.top, planBounds.top),
      bottom = Math.min(orbBounds.bottom, planBounds.bottom),
      width = Math.max(0, right - left),
      height = Math.max(0, bottom - top);
    return {
      width,
      height,
      orb: { x: orbBounds.x, y: orbBounds.y, width: orbBounds.width, height: orbBounds.height },
      plan: {
        x: planBounds.x,
        y: planBounds.y,
        width: planBounds.width,
        height: planBounds.height,
      },
      topHit:
        width && height
          ? document.elementFromPoint((left + right) / 2, (top + bottom) / 2)?.closest("button")
              ?.className
          : undefined,
    };
  });
}

const browser = await chromium.launch({ headless: true });
try {
  const artifactDir = process.env.ELLIE_E2E_ARTIFACT_DIR;
  if (artifactDir) await mkdir(artifactDir, { recursive: true });
  for (const viewport of [
    { width: 390, height: 844, name: "mobile" },
    { width: 1024, height: 900, name: "large" },
  ]) {
    const context = await browser.newContext({ viewport, timezoneId: "America/Los_Angeles" });
    const page = await context.newPage();
    const errors = await openFixture(page);
    const measured = await overlap(page);
    if (artifactDir)
      await Promise.all([
        page.screenshot({
          path: join(artifactDir, `life-orb-${viewport.name}.png`),
          animations: "disabled",
        }),
        writeFile(
          join(artifactDir, `life-orb-${viewport.name}.json`),
          `${JSON.stringify(measured, null, 2)}\n`,
        ),
      ]);
    assert.deepEqual(errors, []);
    assert.equal(
      measured.width * measured.height,
      0,
      `${viewport.name} orb covers the Plans control: ${JSON.stringify(measured)}`,
    );
    if (viewport.name === "mobile") {
      const plan = page.locator(".plan-widget .widget-open");
      for (
        let presses = 0;
        presses < 20 && !(await plan.evaluate((node) => node === document.activeElement));
        presses++
      )
        await page.keyboard.press("Tab");
      assert.equal(await plan.evaluate((node) => node === document.activeElement), true);
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "Plans", exact: true }).waitFor();
    }
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
