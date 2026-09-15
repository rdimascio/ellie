import assert from "node:assert/strict";
import test from "node:test";
import type { Page, TestInfo } from "@playwright/test";
import { captureFullPage } from "../apps/command-center/e2e/screenshot.ts";

const exactCaptureError = new Error(
  "page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot\nCall log:\n  - taking page screenshot",
);

function fixture(
  captures: Array<Error | undefined>,
  evaluate: () => Promise<unknown> = async () => undefined,
) {
  const calls: { captures: unknown[]; attachments: unknown[]; evaluations: number } = {
    captures: [],
    attachments: [],
    evaluations: 0,
  };
  const page = {
    screenshot: async (options: unknown) => {
      calls.captures.push(options);
      const result = captures.shift();
      if (result) throw result;
      return Buffer.from("screenshot");
    },
    evaluate: async () => {
      calls.evaluations += 1;
      return evaluate();
    },
  } as unknown as Pick<Page, "evaluate" | "screenshot">;
  const testInfo = {
    outputPath: (name: string) => `/tmp/${name}`,
    attach: async (name: string, options: unknown) => {
      calls.attachments.push({ name, options });
    },
  } as unknown as Pick<TestInfo, "attach" | "outputPath">;
  return { calls, page, testInfo };
}

test("successful screenshots are captured once without a render-frame wait", async () => {
  const f = fixture([undefined]);
  await captureFullPage(f.page, f.testInfo, "page.png");
  assert.equal(f.calls.captures.length, 1);
  assert.equal(f.calls.evaluations, 0);
  assert.equal(f.calls.attachments.length, 0);
});

test("retries the exact transient capture failure once and retains the first error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([exactCaptureError, undefined], () => new Promise(() => {}));
  const capture = captureFullPage(f.page, f.testInfo, "page.png");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.calls.captures.length, 1);
  assert.equal(f.calls.evaluations, 1);
  t.mock.timers.tick(99);
  await Promise.resolve();
  assert.equal(f.calls.captures.length, 1);
  t.mock.timers.tick(1);
  await capture;
  assert.equal(f.calls.captures.length, 2);
  assert.equal(f.calls.attachments.length, 1);
  assert.deepEqual(f.calls.captures, [
    { path: "/tmp/page.png", fullPage: true },
    { path: "/tmp/page.png", fullPage: true },
  ]);
  assert.equal((f.calls.attachments[0] as { name: string }).name, "page.png-first-capture-error");
  const attachment = f.calls.attachments[0] as {
    options: { body: Buffer; contentType: string };
  };
  assert.match(attachment.options.body.toString("utf8"), /Unable to capture screenshot/);
  assert.equal(attachment.options.contentType, "text/plain");
});

test("does not retry unrelated screenshot errors", async () => {
  const unrelated = new Error(
    "page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot for clip",
  );
  const f = fixture([unrelated]);
  await assert.rejects(captureFullPage(f.page, f.testInfo, "page.png"), (error) => {
    assert.equal(error, unrelated);
    return true;
  });
  assert.equal(f.calls.captures.length, 1);
  assert.equal(f.calls.evaluations, 0);
  assert.equal(f.calls.attachments.length, 0);
});

test("preserves both errors when the one capture retry also fails", async () => {
  const secondError = new Error("page.screenshot: second capture failed");
  const f = fixture([exactCaptureError, secondError]);
  await assert.rejects(captureFullPage(f.page, f.testInfo, "page.png"), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [exactCaptureError, secondError]);
    assert.match(error.message, /First capture: .*Unable to capture screenshot/s);
    assert.match(error.message, /Second capture: .*second capture failed/s);
    return true;
  });
  assert.equal(f.calls.captures.length, 2);
  assert.equal(f.calls.evaluations, 1);
  assert.equal(f.calls.attachments.length, 1);
});
