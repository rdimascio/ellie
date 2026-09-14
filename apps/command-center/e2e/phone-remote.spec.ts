import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

const phone = {
  id: "phone-controller",
  label: "Ryan’s phone",
  role: "phone_controller",
  expiresAt: Date.now() + 86_400_000,
};

const nodes = [
  { id: "living-room", label: "Living room Mac", online: true, capabilities: ["app.open"] },
  { id: "study", label: "Study Mac", online: true, capabilities: ["app.open"] },
  { id: "guest", label: "Guest Mac", online: false, capabilities: ["app.open"] },
];

async function remoteApi(
  page: Page,
  options: {
    role?: "phone_controller" | "tv_viewer";
    command?: "success" | "lost" | "upstream-unknown";
  } = {},
) {
  const posts: Array<{ nodeId: string; text: string }> = [];
  await page.route("**/browser/v1/**", async (route: Route) => {
    const operation = new URL(route.request().url()).pathname.split("/").at(-1);
    if (operation === "session") {
      await route.fulfill({ json: { client: { ...phone, role: options.role ?? phone.role } } });
      return;
    }
    if (operation === "nodes") {
      await route.fulfill({ json: { nodes } });
      return;
    }
    if (operation === "commands") {
      posts.push(route.request().postDataJSON() as { nodeId: string; text: string });
      if (options.command === "lost") await route.abort("connectionreset");
      else if (options.command === "upstream-unknown")
        await route.fulfill({
          status: 502,
          json: { error: "Command outcome is unknown. Check the Mac before sending again." },
        });
      else await route.fulfill({ json: { ok: true, message: "Safari opened." } });
      return;
    }
    throw new Error(`Unexpected browser API operation: ${operation}`);
  });
  return posts;
}

test("targets the selected Mac and sends each command exactly once", async ({ page }) => {
  const posts = await remoteApi(page);
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  await page.goto("/pair/");
  await expect(page.getByRole("heading", { name: "Control a Mac" })).toBeVisible();
  await page.getByLabel("Send to").selectOption("study");
  await page.getByRole("button", { name: "Open Safari" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Safari opened." })).toBeVisible();
  expect(posts).toEqual([{ nodeId: "study", text: "Open Safari" }]);

  await page.getByLabel("Command").fill("open Messages");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual({ nodeId: "study", text: "open Messages" });
  expect(urls.every((url) => !url.includes("study") && !url.includes("Messages"))).toBe(true);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("a lost command reply stays a single POST and identifies the uncertain target", async ({
  page,
}) => {
  const posts = await remoteApi(page, { command: "lost" });
  await page.goto("/pair/");
  await page.getByLabel("Send to").selectOption("study");
  await page.getByRole("button", { name: "Open Arc" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Outcome unknown" })).toContainText(
    "Check Study Mac before sending it again.",
  );
  expect(posts).toEqual([{ nodeId: "study", text: "Open Arc" }]);
});

test("an upstream unknown response also tells the user to check the selected Mac", async ({
  page,
}) => {
  const posts = await remoteApi(page, { command: "upstream-unknown" });
  await page.goto("/pair/");
  await page.getByRole("button", { name: "Open Messages" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Outcome unknown" })).toContainText(
    "Check Living room Mac before sending it again.",
  );
  expect(posts).toEqual([{ nodeId: "living-room", text: "Open Messages" }]);
});

test("offline targets disable every command control", async ({ page }) => {
  const posts = await remoteApi(page);
  await page.goto("/pair/");
  await page.getByLabel("Send to").selectOption("guest");
  await expect(page.getByText("Guest Mac is offline.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Arc" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open Safari" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open Messages" })).toBeDisabled();
  await expect(page.getByLabel("Command")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  expect(posts).toEqual([]);
});

test("TV viewer remains read only and never requests remote-control APIs", async ({ page }) => {
  const requested: string[] = [];
  await page.route("**/browser/v1/**", async (route) => {
    const operation = new URL(route.request().url()).pathname.split("/").at(-1)!;
    requested.push(operation);
    if (operation !== "session") throw new Error(`TV requested ${operation}`);
    await route.fulfill({ json: { client: { ...phone, role: "tv_viewer" } } });
  });
  await page.goto("/pair/");
  await expect(page.getByText("Shared display · read only", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Control a Mac" })).toHaveCount(0);
  await expect(page.getByRole("button")).toHaveText(["Disconnect this device"]);
  expect(requested).toEqual(["session"]);
});
