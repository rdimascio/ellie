import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const code = "ab".repeat(32);
const client = {
  id: "synthetic-phone",
  label: "Kitchen phone",
  role: "phone_controller",
  expiresAt: Date.now() + 86400000,
};

async function connection(
  page: Page,
  options: {
    paired?: boolean;
    role?: string;
    losePair?: boolean;
    logout?: "lost" | "malformed";
  } = {},
) {
  const state = {
    paired: options.paired ?? false,
    offline: false,
    mutations: [] as string[],
    sessionReads: 0,
  };
  const identity = { ...client, role: options.role ?? client.role };
  await page.route("**/browser/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const operation = path.split("/").at(-1)!;
    if (route.request().method() === "POST") state.mutations.push(operation);
    if (state.offline) {
      await route.abort("connectionrefused");
      return;
    }
    if (operation === "session") {
      state.sessionReads += 1;
      await route.fulfill({
        status: state.paired ? 200 : 401,
        json: state.paired ? { client: identity } : { error: "Not paired" },
      });
    } else if (operation === "pair") {
      expect(route.request().postDataJSON()).toEqual({ code });
      state.paired = true;
      if (options.losePair) await route.abort("connectionreset");
      else await route.fulfill({ json: { client: identity } });
    } else if (operation === "logout") {
      if (options.logout === "lost") await route.abort("connectionreset");
      else if (options.logout === "malformed") await route.fulfill({ json: {} });
      else {
        state.paired = false;
        await route.fulfill({ json: { ok: true } });
      }
    } else throw new Error(`Unexpected synthetic browser route: ${operation}`);
  });
  return state;
}

test("pairing sends a code once without placing it in URLs or browser storage", async ({
  page,
}) => {
  const state = await connection(page);
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  await page.goto("/pair/");
  await expect(page.getByRole("heading", { name: "Connect this device" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("pairing.png"), fullPage: true });
  await page.getByLabel("Pairing code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Connect to Ellie", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connected to Ellie" })).toBeVisible();
  await expect(page.getByText("Kitchen phone", { exact: true })).toBeVisible();
  await expect(page.getByText(/Household controls aren’t available/)).toBeVisible();
  expect(state.mutations).toEqual(["pair"]);
  expect(
    urls.every((url) => !url.includes(code) && new URL(url).origin === "http://127.0.0.1:4173"),
  ).toBe(true);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(await page.content()).not.toContain(code);
  await page.screenshot({ path: test.info().outputPath("paired.png"), fullPage: true });
  await page.getByRole("button", { name: "Disconnect this device" }).click();
  await expect(page.getByRole("status")).toHaveText("This device is disconnected.");
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveValue("");
  expect(state.mutations).toEqual(["pair", "logout"]);
});

test("a lost pairing response verifies the session without resubmitting the code", async ({
  page,
}) => {
  const state = await connection(page, { losePair: true });
  await page.goto("/pair/");
  await page.getByLabel("Pairing code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Connect to Ellie", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connected to Ellie" })).toBeVisible();
  expect(state.sessionReads).toBe(2);
  expect(state.mutations).toEqual(["pair"]);
});

for (const logout of ["lost", "malformed"] as const) {
  test(`${logout} logout confirmation checks the session and offers explicit recovery`, async ({
    page,
  }) => {
    const state = await connection(page, { paired: true, logout });
    await page.goto("/pair/");
    await page.getByRole("button", { name: "Disconnect this device" }).click();
    await expect(page.getByRole("status")).toContainText("This device is still connected.");
    await expect(page.getByRole("button", { name: "Disconnect this device" })).toBeEnabled();
    expect(state.mutations).toEqual(["logout"]);
  });
}

test("revocation and outages change the page using bounded read-only retries", async ({ page }) => {
  await page.clock.install();
  const state = await connection(page, { paired: true });
  await page.goto("/pair/");
  await expect(page.getByRole("heading", { name: "Connected to Ellie" })).toBeVisible();
  state.offline = true;
  await page.clock.runFor(10_100);
  await expect(page.getByRole("heading", { name: "Let’s reconnect" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("same home network");
  state.offline = false;
  state.paired = false;
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByRole("status")).toContainText("Your connection has ended.");
  expect(state.mutations).toEqual([]);
});

test("read-only shared display identity and narrow phone layouts remain usable", async ({
  page,
  browserName,
}) => {
  await connection(page, { paired: true, role: "tv_viewer" });
  await page.goto("/pair/");
  await expect(page.getByText("Shared display · read only", { exact: true })).toBeVisible();
  expect(await page.getByRole("button").allTextContents()).toEqual(["Disconnect this device"]);
  await page.keyboard.press(
    browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab",
  );
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("paired-tv.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Disconnect this device" }).click();
  await expect(page.getByLabel("Pairing code", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath("pairing-narrow.png"), fullPage: true });
});
