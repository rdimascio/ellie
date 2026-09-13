import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourceRunner = resolve("scripts/test-ios.mjs");

async function fixture(mode: "nonzero" | "overflow" | "timeout") {
  const root = await mkdtemp(join(tmpdir(), "ellie-ios-runner-test-"));
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  await mkdir(scripts);
  await mkdir(bin);
  let runner = await readFile(sourceRunner, "utf8");
  if (mode === "timeout") {
    const shortened = runner.replace("timeout: 120_000,", "timeout: 100,");
    assert.notEqual(shortened, runner, "boot-readiness deadline fixture replacement must apply");
    assert.equal(
      shortened.includes("timeout: 120_000,"),
      false,
      "the production deadline must have one exact fixture replacement",
    );
    runner = shortened;
  }
  await writeFile(join(scripts, "test-ios.mjs"), runner);
  await writeFile(
    join(bin, "xcrun"),
    `#!/bin/sh
if [ "$1 $2 $3 $4" = "simctl list runtimes --json" ]; then
  if [ "$ELLIE_RUNNER_TEST_MODE" = "nonzero" ]; then exit 7; fi
  if [ "$ELLIE_RUNNER_TEST_MODE" = "overflow" ]; then
    awk 'BEGIN { for (i = 0; i < 1100000; i++) printf "x" }'
  else
    printf '%s\\n' '{"runtimes":[{"isAvailable":true,"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-3","version":"18.3","supportedDeviceTypes":[{"productFamily":"iPhone","name":"iPhone","identifier":"test.iPhone"}]}]}'
  fi
elif [ "$1 $2" = "simctl create" ]; then
  printf '%s\\n' 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
elif [ "$1 $2" = "simctl bootstatus" ] && [ "$ELLIE_RUNNER_TEST_MODE" = "timeout" ]; then
  trap 'exit 0' TERM
  while :; do sleep 1; done
else
  exit 0
fi
`,
  );
  await chmod(join(bin, "xcrun"), 0o700);
  return { bin, root };
}

async function runFixture(mode: "nonzero" | "overflow" | "timeout") {
  const owned = await fixture(mode);
  try {
    const result = spawnSync(process.execPath, ["scripts/test-ios.mjs"], {
      cwd: owned.root,
      encoding: "utf8",
      env: {
        ...process.env,
        ELLIE_RUNNER_TEST_MODE: mode,
        PATH: `${owned.bin}:${process.env.PATH ?? ""}`,
      },
      timeout: 10_000,
    });
    const diagnostic = await readFile(
      join(owned.root, "test-results/native-ios-runner-diagnostic.txt"),
      "utf8",
    );
    return { diagnostic, result };
  } finally {
    await rm(owned.root, { recursive: true, force: true });
  }
}

test("early process failure preserves a diagnostic without an xcresult", async () => {
  const { diagnostic, result } = await runFixture("nonzero");
  assert.equal(result.status, 1);
  assert.match(
    diagnostic,
    /^iOS runner diagnostic: stage=simulator-discovery outcome=exit-status stageMs=\d+ totalMs=\d+ xcode=not-started result=not-created cleanup=not-started\n$/,
  );
});

test("captured startup output remains bounded", async () => {
  const { diagnostic, result } = await runFixture("overflow");
  assert.equal(result.status, 1);
  assert.match(diagnostic, /outcome=output-limit/);
  assert.match(diagnostic, /result=not-created/);
});

test("deadline failure survives a child that exits successfully after TERM", async () => {
  const { diagnostic, result } = await runFixture("timeout");
  assert.equal(result.status, 1);
  assert.match(diagnostic, /stage=simulator-boot-ready outcome=timeout/);
  assert.match(diagnostic, /xcode=not-started result=not-created/);
});
