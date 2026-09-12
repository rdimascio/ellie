import { test, expect } from "@playwright/test";

test("demo actions stay in-browser, identify the target, and report completion", async ({
  page,
}) => {
  const mutations: string[] = [];
  const external: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") mutations.push(request.url());
    if (new URL(request.url()).origin !== "http://127.0.0.1:4173") external.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByText("Sample home. Commands stay in this browser.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Living room Mac", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("remote.png"), fullPage: true });
  await page.getByRole("button", { name: "Tile Arc left", exact: false }).click();
  await expect(page.getByRole("status")).toContainText("Waiting");
  await expect(page.getByRole("status")).toContainText("Completed");
  await expect(page.locator(".window-preview")).toHaveClass(/left/);
  expect(mutations).toEqual([]);
  expect(external).toEqual([]);
});

test("offline, empty, and uncertain outcomes give actionable states without dispatch", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Demo scenario").selectOption("offline");
  await expect(page.getByText("This Mac is offline.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Arc", exact: false })).toBeDisabled();
  await page.getByLabel("Demo scenario").selectOption("empty");
  await expect(page.getByRole("heading", { name: "No Macs here yet." })).toBeVisible();
  await page.getByLabel("Demo scenario").selectOption("unknown");
  await expect(page.getByText("Outcome unknown", { exact: true })).toBeVisible();
  await expect(page.getByText(/Check this Mac before trying again/)).toBeVisible();
  await page.getByLabel("Demo scenario").selectOption("running");
  await page.getByRole("button", { name: "Cancel request" }).click();
  await expect(
    page.locator(".activity").getByText("Cancellation requested", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/An action already started may still finish/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel request" })).toHaveCount(0);
});

test("device selection retains the explicit target and disables unsupported controls", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "phone")
    await page.getByLabel("Control a Mac").selectOption("demo-study");
  else await page.getByRole("button", { name: /Study Mac Available/ }).click();
  await expect(page.getByRole("heading", { name: "Study Mac", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tile Arc left", exact: false })).toBeDisabled();
  await page.getByRole("button", { name: "Open Arc", exact: false }).click();
  await expect(page.locator(".activity-list li").first()).toContainText("Study Mac");
});

test("TV stays read-only and directional keys move visible focus", async ({ page }, testInfo) => {
  await page.goto("/?view=tv");
  await expect(page.getByRole("heading", { name: "Good to be home." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Arc", exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Remote", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "TV view" })).toBeFocused();
  await expect(page.getByText("Sample agenda", { exact: true })).toBeVisible();
  if (testInfo.project.name === "tv")
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
    ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("tv.png"), fullPage: true });
});

test("all scenarios fit the viewport and keyboard users can reach the controls", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  for (const scenario of [
    "ready",
    "loading",
    "offline",
    "empty",
    "running",
    "completed",
    "failed",
    "cancelled",
    "unknown",
  ]) {
    await page.getByLabel("Demo scenario").selectOption(scenario);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath("narrow.png"), fullPage: true });
});
