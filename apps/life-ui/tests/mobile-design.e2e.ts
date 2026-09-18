import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit, expect } from "@playwright/test";
import { designConnections, startDesignPreview } from "./design-preview.ts";

const { server, origin } = await startDesignPreview();
const artifacts = "test-results/mobile-redesign";
await mkdir(artifacts, { recursive: true });
const browserType = process.env.ELLIE_DESIGN_BROWSER === "webkit" ? webkit : chromium;
const browser = await browserType.launch({ headless: true });
try {
  for (const width of [320, 390, 430, 1024]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      reducedMotion: "reduce",
      timezoneId: "America/Los_Angeles",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const writes: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.method() !== "GET") writes.push(request.url());
    });
    await page.clock.setFixedTime(new Date("2026-09-16T22:41:00Z"));
    await page.goto(origin);
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expect(page.locator(".plan-widget")).toContainText("A weekend away");
    const assertFits = async () =>
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        `Horizontal overflow at ${width}px`,
      );
    await assertFits();
    await page.screenshot({ path: `${artifacts}/home-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Ask Ellie", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Ellie conversation" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Ellie" })).toBeFocused();
    await page
      .getByRole("textbox", { name: "Message Ellie" })
      .fill("Help me make room for a quiet morning.");
    await page.screenshot({ path: `${artifacts}/conversation-${width}.png` });
    await assertFits();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Talk to Ellie" })).toBeFocused();
    await page.getByRole("button", { name: "Talk to Ellie" }).click();
    await expect(page.getByRole("textbox", { name: "Message Ellie" })).toHaveValue(
      "Help me make room for a quiet morning.",
    );
    await page.getByRole("button", { name: "Close conversation" }).click();
    if (width <= 760) {
      for (const name of ["Today", "Finances", "Integrations"]) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        const nav = page.locator(".bottom").getByRole("button", { name, exact: true });
        await nav.click();
        await expect(nav).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        if (name === "Finances") {
          await expect(page.locator(".finance-accounts")).toContainText("Everyday account");
          await expect(page.locator(".finance-insights")).toContainText("monthly rhythm");
        }
        if (name === "Integrations") {
          await expect(page.locator(".connections-page")).toContainText("Personal Gmail");
          await expect(page.locator(".connections-page")).toContainText("Google Calendar");
          const modeBounds = await page.locator(".connections-page select").first().boundingBox();
          assert(
            modeBounds && modeBounds.height >= 44,
            "Connection modes need a 44px touch target",
          );
        }
        await assertFits();
        const bounds = await nav.boundingBox();
        assert(
          bounds && bounds.width >= 44 && bounds.height >= 44,
          `${name} needs a 44px touch target`,
        );
        await page.screenshot({ path: `${artifacts}/${name.toLowerCase()}-${width}.png` });
        if (name === "Finances") {
          await page
            .locator(".finance-insights")
            .getByRole("button", { name: "Ask Ellie" })
            .click();
          await expect(page.getByRole("textbox", { name: "Message Ellie" })).toHaveValue(
            "Help me understand this financial insight: Your streaming charges follow a monthly rhythm.",
          );
          await page.getByRole("button", { name: "Close conversation" }).click();
          await page.getByRole("button", { name: "Manage accounts" }).click();
          await expect(
            page.getByRole("heading", { name: "Integrations", exact: true }),
          ).toBeVisible();
          await page
            .locator(".bottom")
            .getByRole("button", { name: "Finances", exact: true })
            .click();
        }
      }
      for (const name of ["Activity", "Settings"]) {
        await page.locator(".mobile-head").getByRole("button", { name, exact: true }).click();
        await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
        await assertFits();
        await page.screenshot({ path: `${artifacts}/${name.toLowerCase()}-${width}.png` });
      }
    }
    if (width > 760) {
      const clock = page.locator(".clock-widget");
      const compact = await clock.boundingBox();
      await page.getByRole("button", { name: "Customize", exact: true }).click();
      await clock.getByRole("button", { name: "Resize widget" }).click();
      const wide = await clock.boundingBox();
      assert(
        compact && wide && wide.width > compact.width,
        "Resizing a desktop widget changes its visible width",
      );
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.reload();
      await expect(clock).toHaveClass(/wide/);
    }
    assert.deepEqual(errors, [], `Runtime errors at ${width}px`);
    assert.deepEqual(writes, [], "Opening screens or drafting a message must not send a request");
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  let unavailable = true;
  await page.route("**/api/connections", (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: { message: "Accounts temporarily unavailable" } })
      : route.fulfill({ json: { ...designConnections, connections: [] } }),
  );
  await page.goto(origin);
  await page.locator(".bottom").getByRole("button", { name: "Finances", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Accounts temporarily unavailable");
  await expect(page.locator(".finance-insights")).toHaveCount(0);
  unavailable = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "No financial accounts yet" })).toBeVisible();
  await page.getByRole("button", { name: "View integrations" }).click();
  await expect(page.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible();
  const plaid = page.locator(".provider-list article").filter({ hasText: "Plaid" });
  await expect(plaid).toContainText("Bank linking isn’t available yet");
  await expect(plaid.getByRole("button")).toBeDisabled();
  await context.close();
  console.log(
    `Mobile design acceptance passed in ${browserType.name()}: 320, 390, 430, and 1024px; navigation, draft retention, focus return, touch targets, no overflow, no accidental actions.`,
  );
} finally {
  await browser.close();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}
