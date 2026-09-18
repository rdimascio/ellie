import assert from "node:assert/strict";
import test from "node:test";
import { startDesignPreview } from "./design-preview.ts";
import { runMobileDesignAcceptance } from "./mobile-design.e2e.ts";

test("design acceptance closes its owned preview when browser launch fails", async () => {
  let fixture: Awaited<ReturnType<typeof startDesignPreview>> | undefined;
  const launchFailure = new Error("Synthetic browser launch failure");
  try {
    await assert.rejects(
      runMobileDesignAcceptance({
        startPreview: async () => (fixture = await startDesignPreview()),
        launchBrowser: async () => {
          assert.equal(fixture?.server.listening, true);
          throw launchFailure;
        },
      }),
      (error) => error === launchFailure,
    );
    assert.ok(fixture);
    assert.equal(fixture.server.listening, false, "the failure must not leave a listening server");
  } finally {
    if (fixture?.server.listening)
      await new Promise<void>((done, reject) =>
        fixture!.server.close((error) => (error ? reject(error) : done())),
      );
  }
});
