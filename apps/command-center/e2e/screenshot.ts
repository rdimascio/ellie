import type { Page, TestInfo } from "@playwright/test";

const captureError =
  "page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot";
const frameWaitMs = 100;

type ScreenshotPage = Pick<Page, "evaluate" | "screenshot">;
type ScreenshotTestInfo = Pick<TestInfo, "attach" | "outputPath">;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function isCaptureError(error: unknown): boolean {
  return error instanceof Error && error.message.split("\n", 1)[0] === captureError;
}

async function waitForRenderFrame(page: ScreenshotPage): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, frameWaitMs);
    void page
      .evaluate(
        () =>
          new Promise<void>((resolveFrame) => {
            const browser = globalThis as unknown as {
              requestAnimationFrame(callback: () => void): number;
            };
            browser.requestAnimationFrame(() => resolveFrame());
          }),
      )
      .then(finish, finish);
  });
}

export async function captureFullPage(
  page: ScreenshotPage,
  testInfo: ScreenshotTestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(name);
  try {
    await page.screenshot({ path, fullPage: true });
    return;
  } catch (firstError) {
    if (!isCaptureError(firstError)) throw firstError;
    await testInfo.attach(`${name}-first-capture-error`, {
      body: Buffer.from(errorText(firstError)),
      contentType: "text/plain",
    });
    await waitForRenderFrame(page);
    try {
      await page.screenshot({ path, fullPage: true });
    } catch (secondError) {
      throw new AggregateError(
        [firstError, secondError],
        `Full-page screenshot failed after one bounded retry.\nFirst capture: ${errorText(firstError)}\nSecond capture: ${errorText(secondError)}`,
      );
    }
  }
}
