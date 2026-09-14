import { expect, test } from "@playwright/test";

test("creates and edits a dashboard, then restores it after reload", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:4173") external.push(request.url());
  });
  await page.goto("/?view=dashboards");
  await page.getByLabel("New dashboard").fill("Kitchen");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByLabel("Widget type").selectOption("note");
  await page.getByRole("button", { name: "Add widget" }).click();
  await page.getByLabel("Note title").fill("Tonight");
  await page.getByLabel("Tonight note").fill("Pasta at 6:30");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("ellie.command-center.dashboards.v1")))
    .toContain("Pasta at 6:30");
  await page.reload();
  await page.locator(".dashboard-list button", { hasText: "Kitchen" }).click();
  await expect(page.getByLabel("Dashboard name")).toHaveValue("Kitchen");
  await expect(page.getByLabel("Tonight note")).toHaveValue("Pasta at 6:30");
  expect(external).toEqual([]);
});

test("reorders, configures, and removes composable widgets", async ({ page }) => {
  await page.goto("/?view=dashboards");
  await page.getByLabel("Widget type").selectOption("calendar");
  await page.getByRole("button", { name: "Add widget" }).click();
  await expect(page.getByText("Calendar isn’t connected.")).toBeVisible();
  await page.getByLabel("Calendar size").selectOption("wide");
  await expect(page.locator(".dashboard-widget").last()).toHaveClass(/wide/);
  await page.getByRole("button", { name: "Move Calendar earlier" }).click();
  await expect(page.locator(".widget-heading input").nth(2)).toHaveValue("Calendar");
  await page.getByRole("button", { name: "Remove Calendar" }).click();
  await expect(page.getByText("Calendar isn’t connected.")).toHaveCount(0);
});

test("rejects invalid imported and stored data without losing a valid board", async ({ page }) => {
  await page.goto("/?view=dashboards");
  await page.getByLabel("Import dashboards file").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      '{"version":1,"dashboards":[{"id":"x","name":"Bad","widgets":[{"type":"script"}]}]}',
    ),
  });
  await expect(page.locator(".dashboard-workspace").getByRole("status")).toContainText(
    "not a valid Ellie dashboard export",
  );
  await expect(page.getByLabel("Dashboard name")).toHaveValue("Home board");

  await page.evaluate(() => localStorage.setItem("ellie.command-center.dashboards.v1", "not-json"));
  await page.reload();
  await expect(page.locator(".dashboard-workspace").getByRole("status")).toContainText(
    "starter board was restored",
  );
  await expect(page.getByLabel("Dashboard name")).toHaveValue("Home board");
});

test("dashboard editor fits phone, desktop, and TV widths", async ({ page }, testInfo) => {
  await page.goto("/?view=dashboards");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath(`dashboard-${testInfo.project.name}.png`),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("editor handles model limits, unavailable reset storage, and imported clock zones", async ({
  page,
}) => {
  const dashboard = (id: string, widgets: unknown[] = []) => ({
    id,
    name: `Board ${id}`,
    widgets,
  });
  const importState = async (dashboards: unknown[]) => {
    await page.getByLabel("Import dashboards file").setInputFiles({
      name: "dashboards.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ version: 1, dashboards })),
    });
  };

  await page.goto("/?view=dashboards");
  const status = page.locator(".dashboard-workspace").getByRole("status");
  await importState(Array.from({ length: 12 }, (_, index) => dashboard(`board-${index}`)));
  await page.getByLabel("New dashboard").fill("One too many");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(status).toContainText("Too many dashboards");
  await expect(page.locator(".dashboard-list button")).toHaveCount(12);

  const notes = Array.from({ length: 24 }, (_, index) => ({
    id: `note-${index}`,
    type: "note",
    title: `Note ${index}`,
    size: "small",
    config: { text: "" },
  }));
  await importState([dashboard("full", notes)]);
  await page.getByRole("button", { name: "Add widget" }).click();
  await expect(status).toContainText("Too many widgets");
  await expect(page.locator(".dashboard-widget")).toHaveCount(24);
  await expect(page.getByLabel("Note 0 note")).toHaveAttribute("maxlength", "2000");

  await importState([
    dashboard("zoned", [
      {
        id: "clock",
        type: "clock",
        title: "Honolulu clock",
        size: "small",
        config: { timeZone: "Pacific/Honolulu" },
      },
    ]),
  ]);
  const clock = page.locator(".widget-clock");
  await expect(clock).toBeVisible();
  const displayed = (await clock.textContent()) ?? "";
  const expected = await clock.evaluate((element) =>
    new Date(element.getAttribute("datetime")!).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "Pacific/Honolulu",
    }),
  );
  expect(displayed).toContain(expected);

  await page.evaluate(() => {
    Storage.prototype.removeItem = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
  });
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(status).toContainText("browser storage is unavailable");
  await expect(page.getByLabel("Dashboard name")).toHaveValue("Home board");
});
