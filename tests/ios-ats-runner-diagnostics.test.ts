import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runner = resolve("scripts/test-ios-ats.mjs");
const resultBundle = resolve("test-results/native-ios-ats.xcresult");

type Mode =
  | "overflow"
  | "descendant"
  | "kill-escalation"
  | "malformed-platform"
  | "malformed-runtime"
  | "teardown-timeout";

async function fixture(mode: Mode) {
  const root = await mkdtemp(join(tmpdir(), "ellie-ats-runner-test-"));
  const executable = join(root, "xcodebuild");
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\n' "$$" >> "${root}/group"
if [ "${mode}" = overflow ]; then
  exec awk 'BEGIN { for (i = 0; i < 1100000; i++) printf "x" }'
fi
if [ "${mode}" = kill-escalation ]; then
  trap '' TERM
  exec /bin/sleep 5
fi
if [ "${mode}" = malformed-platform ] || [ "${mode}" = teardown-timeout ]; then
  printf '%s\n' 'Xcode 9999.1' 'Build version PRIVATE-MARKER'
  exit 0
fi
if [ "${mode}" = malformed-runtime ]; then
  printf '%s\n' 'Xcode 16.4' 'Build version 16F6'
  exit 0
fi
(/bin/sleep 0.3) >/dev/null 2>&1 &
exit 7
`,
  );
  await chmod(executable, 0o700);
  if (mode === "malformed-runtime") {
    const xcrun = join(root, "xcrun");
    await writeFile(
      xcrun,
      `#!/bin/sh
printf '%s\n' "$$" >> "${root}/group"
if [ "$1 $2 $3" = "--sdk iphonesimulator --show-sdk-version" ]; then
  printf '%s\n' '18.5'
else
  printf '%s\n' 'PRIVATE-RUNTIME-MARKER{'
fi
`,
    );
    await chmod(xcrun, 0o700);
  }
  return root;
}

async function groupAbsent(group: number) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const listed = spawnSync("/bin/ps", ["-axo", "pgid="], { encoding: "utf8" });
    if (listed.status !== 0 || listed.signal || listed.error)
      throw new Error("fixture process-group observation failed");
    const groups = listed.stdout
      .split("\n")
      .map((value) => Number(value.trim()))
      .filter(Number.isInteger);
    if (!groups.includes(group)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("finite fixture group remains observable");
}

function cleanupAdmitted(result: ReturnType<typeof spawnSync> | undefined, groups: number[]) {
  return Boolean(
    result &&
    !result.error &&
    !result.signal &&
    Number.isInteger(result.status) &&
    groups.length > 0 &&
    groups.every((group) => Number.isInteger(group) && group > 1),
  );
}

async function run(mode: Mode) {
  const root = await fixture(mode);
  let retained: string | undefined;
  let fixtureRunner: string | undefined;
  let cleanupSafe = false;
  try {
    let selectedRunner = runner;
    if (mode === "kill-escalation" || mode === "teardown-timeout") {
      fixtureRunner = resolve(`scripts/.test-ios-ats-${process.pid}.mjs`);
      let source = await readFile(runner, "utf8");
      if (mode === "teardown-timeout") {
        const shortenedTeardown = source
          .replace("timeout = 10_000", "timeout = 100")
          .replace("await nativeSpeech?.close();", "await new Promise(() => {});");
        assert.notEqual(shortenedTeardown, source);
        source = shortenedTeardown;
      }
      if (mode === "kill-escalation") {
        const shortenedDiscovery = source.replace("timeout: 15_000,", "timeout: 500,");
        assert.notEqual(shortenedDiscovery, source);
        source = shortenedDiscovery
          .replace(
            'killTimer ??= setTimeout(() => signalDirectChild(child, "SIGKILL"), 5_000);',
            'killTimer ??= setTimeout(() => signalDirectChild(child, "SIGKILL"), 100);',
          )
          .replace("}, 7_000);", "}, 2_500);");
        assert.doesNotMatch(source, /signalDirectChild\(child, "SIGKILL"\), 5_000/);
        assert.doesNotMatch(source, /\}, 7_000\);/);
      }
      await writeFile(fixtureRunner, source);
      selectedRunner = fixtureRunner;
    }
    const result = spawnSync(process.execPath, [selectedRunner], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` },
      timeout: 15_000,
    });
    const match = /Owned ATS evidence was retained: ([^\n]+)/.exec(result.stderr);
    retained = match?.[1];
    let groupText: string;
    try {
      groupText = await readFile(join(root, "group"), "utf8");
    } catch (error) {
      throw new Error(`mock xcodebuild did not start: ${result.stderr}`, { cause: error });
    }
    const groups = groupText.trim().split("\n").map(Number);
    if (!cleanupAdmitted(result, groups))
      throw new Error(`fixture runner cleanup is uncertain; retained ${root}`);
    for (const group of groups) await groupAbsent(group);
    assert.equal(result.status, 1);
    cleanupSafe = true;
    return { result, retained };
  } finally {
    if (cleanupSafe) {
      if (retained) await rm(retained, { recursive: true, force: true });
      if (fixtureRunner) await rm(fixtureRunner, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  }
}

test("ATS startup output is bounded by the retained direct producer", async () => {
  await assert.rejects(readFile(resultBundle), { code: "ENOENT" });
  const { result, retained } = await run("overflow");
  assert.match(result.stderr, /Command output exceeded its bound/);
  assert.doesNotMatch(result.stderr, /cleanup is uncertain/);
  assert.equal(retained, undefined);
});

test("ATS evidence is retained when a reaped leader leaves a finite group member", async () => {
  await assert.rejects(readFile(resultBundle), { code: "ENOENT" });
  const { result, retained } = await run("descendant");
  assert.match(result.stderr, /cleanup is uncertain/);
  assert.ok(retained);
});

test("ATS timeout escalates only its finite retained direct child", async () => {
  await assert.rejects(readFile(resultBundle), { code: "ENOENT" });
  const { result, retained } = await run("kill-escalation");
  assert.match(result.stderr, /exceeded its deadline/);
  assert.doesNotMatch(result.stderr, /cleanup is uncertain/);
  assert.equal(retained, undefined);
});

test("ATS platform diagnostics never include malformed captured metadata", async () => {
  await assert.rejects(readFile(resultBundle), { code: "ENOENT" });
  const { result } = await run("malformed-platform");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Selected Xcode version output is invalid/);
  assert.match(result.stderr, /xcode=unknown sdk=unknown runtime=unknown device=unknown/);
  assert.doesNotMatch(result.stderr, /PRIVATE-MARKER/);
});

test("ATS runtime JSON failures are fixed and do not echo captured input", async () => {
  await assert.rejects(readFile(resultBundle), { code: "ENOENT" });
  const { result } = await run("malformed-runtime");
  assert.match(result.stderr, /Simulator runtime inventory is invalid/);
  assert.doesNotMatch(result.stderr, /PRIVATE-RUNTIME-MARKER/);
});

test("fixture cleanup admission rejects missing observations and uncertain runners", () => {
  assert.equal(cleanupAdmitted(undefined, [42]), false);
  assert.equal(
    cleanupAdmitted({ status: null, signal: "SIGTERM" } as ReturnType<typeof spawnSync>, [42]),
    false,
  );
  assert.equal(
    cleanupAdmitted({ status: 1, signal: null } as ReturnType<typeof spawnSync>, []),
    false,
  );
});

test("ATS teardown timeout retains evidence and preserves the original failure", async () => {
  await assert.rejects(readFile(resultBundle), { code: "ENOENT" });
  const { result, retained } = await run("teardown-timeout");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Selected Xcode version output is invalid/);
  assert.match(result.stderr, /fixture-teardown-timeout/);
  assert.ok(retained);
});

test("embedded speech cancellation fixture has a finite fail-only watchdog", async () => {
  const source = await readFile(runner, "utf8");
  const match = /setTimeout\(\(\) => process\.exit\(70\), 45_000\);/.exec(source);
  assert.ok(match);
  const root = await mkdtemp(join(tmpdir(), "ellie-ats-watchdog-test-"));
  const executable = join(root, "watchdog.mjs");
  let cleanupSafe = false;
  try {
    await writeFile(
      executable,
      `${match[0].replace("45_000", "100")}\nsetInterval(() => {}, 1000);\n`,
    );
    const result = spawnSync(process.execPath, [executable], { timeout: 2_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 70);
    cleanupSafe = true;
  } finally {
    if (cleanupSafe) await rm(root, { recursive: true, force: true });
  }
});
