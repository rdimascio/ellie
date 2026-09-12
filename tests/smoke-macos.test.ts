import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

// @ts-expect-error The standalone smoke command intentionally remains JavaScript.
import { localRunnerOrigin, parseArgs } from "../scripts/smoke-macos.mjs";

const execute = promisify(execFile);

test("macOS smoke options keep model probes explicit and on literal loopback", () => {
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(
    parseArgs([
      "--model-endpoint",
      "http://127.0.0.1:8080",
      "--model-id",
      "local-test-model",
      "--report",
      "/tmp/result.json",
    ]),
    {
      modelEndpoint: "http://127.0.0.1:8080",
      modelId: "local-test-model",
      report: "/tmp/result.json",
    },
  );
  assert.throws(
    () => parseArgs(["--model-endpoint", "http://127.0.0.1:8080"]),
    /supplied together/,
  );
  assert.equal(localRunnerOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(localRunnerOrigin("https://[::1]:8443"), "https://[::1]:8443");
  for (const unsafe of [
    "http://localhost:8080",
    "http://192.168.1.10:8080",
    "https://user:secret@127.0.0.1:8443",
    "http://127.0.0.1:8080/runner",
    "file:///tmp/runner",
  ])
    assert.throws(() => localRunnerOrigin(unsafe));
});

test(
  "smoke command rejects Linux before native work and records an unconfigured optional model",
  {
    skip: process.platform === "darwin",
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ellie-smoke-test-"));
    const reportPath = join(directory, "report.json");
    try {
      await assert.rejects(
        execute(process.execPath, ["scripts/smoke-macos.mjs", "--report", reportPath]),
        (error) => {
          assert.equal((error as { code?: number }).code, 1);
          return true;
        },
      );
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      assert.equal(report.result, "failed");
      assert.equal(
        report.checks.find((item: { name: string }) => item.name === "macOS platform").status,
        "failed",
      );
      assert.equal(
        report.checks.find((item: { name: string }) => item.name === "Swift helper build").status,
        "not-run",
      );
      assert.equal(
        report.checks.find((item: { name: string }) => item.name === "optional local model probe")
          .status,
        "unconfigured",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
