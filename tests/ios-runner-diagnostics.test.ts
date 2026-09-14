import assert from "node:assert/strict";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const sourceRunner = resolve("scripts/test-ios.mjs");

type FixtureMode =
  | "nonzero"
  | "overflow"
  | "timeout"
  | "descendant"
  | "interrupt"
  | "retained"
  | "cleanup-failure"
  | "kill-escalation"
  | "split"
  | "build-failure"
  | "test-failure";

async function fixture(mode: FixtureMode) {
  const root = await mkdtemp(join(tmpdir(), "ellie-ios-runner-test-"));
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  await mkdir(scripts);
  await mkdir(bin);
  let runner = await readFile(sourceRunner, "utf8");
  if (mode === "timeout" || mode === "kill-escalation") {
    const shortened = runner.replace("timeout: 120_000,", "timeout: 100,");
    assert.notEqual(shortened, runner, "boot-readiness deadline fixture replacement must apply");
    assert.equal(
      shortened.includes("timeout: 120_000,"),
      false,
      "the production deadline must have one exact fixture replacement",
    );
    runner = shortened;
  }
  if (mode === "kill-escalation") {
    const shortened = runner
      .replace(
        'killTimer ??= setTimeout(() => signalDirectChild(child, "SIGKILL"), 5_000);',
        'killTimer ??= setTimeout(() => signalDirectChild(child, "SIGKILL"), 100);',
      )
      .replace("}, 7_000);", "}, 2_500);");
    assert.notEqual(shortened, runner, "the termination grace fixture replacement must apply");
    assert.equal(shortened.includes('signalDirectChild(child, "SIGKILL"), 5_000)'), false);
    assert.equal(shortened.includes("}, 7_000);"), false);
    runner = shortened;
  }
  if (mode === "descendant" || mode === "cleanup-failure") {
    const isolated = runner.replace(
      "mkdtempSync(`${tmpdir()}/ellie-ios-derived-`)",
      "mkdtempSync(`${root}/owned-derived-`)",
    );
    assert.notEqual(isolated, runner, "the owned derived-data fixture replacement must apply");
    runner = isolated;
  }
  await writeFile(join(scripts, "test-ios.mjs"), runner);
  await copyFile(
    resolve("scripts/ios-runtime-selection.mjs"),
    join(scripts, "ios-runtime-selection.mjs"),
  );
  if (mode === "retained") {
    await mkdir(join(root, "test-results/native-ios.xcresult"), { recursive: true });
    await writeFile(join(root, "test-results/native-ios.xcresult/retained"), "evidence\n");
  }
  await writeFile(
    join(bin, "xcrun"),
    `#!/bin/sh
printf '%s\n' "$$" >> "$ELLIE_RUNNER_TEST_ROOT/mock-process-groups"
if [ "$1 $2 $3 $4" = "simctl list runtimes --json" ]; then
  if [ "$ELLIE_RUNNER_TEST_MODE" = "nonzero" ]; then exit 7; fi
  if [ "$ELLIE_RUNNER_TEST_MODE" = "descendant" ]; then
    printf '%s\n' "$$" > "$ELLIE_RUNNER_TEST_ROOT/descendant.pgid"
    (/bin/sleep 0.2; /usr/bin/touch "$ELLIE_RUNNER_TEST_ROOT/descendant.done") >/dev/null 2>&1 &
    exit 7
  fi
  if [ "$ELLIE_RUNNER_TEST_MODE" = "overflow" ]; then
    exec awk 'BEGIN { for (i = 0; i < 1100000; i++) printf "x" }'
  else
    printf '%s\\n' '{"runtimes":[{"isAvailable":true,"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-18-3","version":"18.3","supportedDeviceTypes":[{"productFamily":"iPhone","name":"iPhone","identifier":"test.iPhone"}]}]}'
  fi
elif [ "$1 $2 $3" = "--sdk iphonesimulator --show-sdk-version" ]; then
  printf '%s\n' '18.5'
elif [ "$1 $2" = "simctl create" ]; then
  printf '%s\\n' 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
elif [ "$1 $2" = "simctl bootstatus" ] && { [ "$ELLIE_RUNNER_TEST_MODE" = "timeout" ] || [ "$ELLIE_RUNNER_TEST_MODE" = "interrupt" ] || [ "$ELLIE_RUNNER_TEST_MODE" = "kill-escalation" ]; }; then
  if [ "$ELLIE_RUNNER_TEST_MODE" = "interrupt" ]; then
    /usr/bin/touch "$ELLIE_RUNNER_TEST_ROOT/interrupt.ready"
  fi
  if [ "$ELLIE_RUNNER_TEST_MODE" = "kill-escalation" ]; then
    trap '' TERM
    exec /bin/sleep 5
  else
    trap 'exit 0' TERM
    while :; do sleep 1; done
  fi
elif [ "$1 $2" = "simctl shutdown" ] && [ "$ELLIE_RUNNER_TEST_MODE" = "cleanup-failure" ]; then
  exit 8
else
  exit 0
fi
`,
  );
  await chmod(join(bin, "xcrun"), 0o700);
  await writeFile(
    join(bin, "xcodebuild"),
    `#!/bin/sh
printf '%s\n' "$$" >> "$ELLIE_RUNNER_TEST_ROOT/mock-process-groups"
for argument in "$@"; do
  if [ "$previous_argument" = "-resultBundlePath" ]; then result_bundle="$argument"; fi
  printf '%s\n' "$argument"
  last_argument="$argument"
  previous_argument="$argument"
done >> "$ELLIE_RUNNER_TEST_ROOT/xcodebuild-arguments"
if [ "$last_argument" = "test-without-building" ] && [ -n "$result_bundle" ]; then mkdir -p "$result_bundle"; fi
printf '%s\n' END >> "$ELLIE_RUNNER_TEST_ROOT/xcodebuild-arguments"
if [ "$1" = "-version" ]; then
  printf '%s\n' 'Xcode 16.4' 'Build version 16F6'
elif [ "$ELLIE_RUNNER_TEST_MODE" = "build-failure" ] && [ "$last_argument" = "build-for-testing" ]; then
  exit 9
elif [ "$ELLIE_RUNNER_TEST_MODE" = "test-failure" ] && [ "$last_argument" = "test-without-building" ]; then
  exit 10
else
  exit 0
fi
`,
  );
  await chmod(join(bin, "xcodebuild"), 0o700);
  return { bin, root };
}

async function runFixture(mode: FixtureMode) {
  const owned = await fixture(mode);
  let outcome:
    | {
        diagnostic: string;
        result: ReturnType<typeof spawnSync>;
        retainedDerived: number;
        retainedEvidence: string | undefined;
        xcodeArguments: string;
      }
    | undefined;
  let operationError: unknown;
  let outerResult: ReturnType<typeof spawnSync> | undefined;
  try {
    const result = spawnSync(process.execPath, ["scripts/test-ios.mjs"], {
      cwd: owned.root,
      encoding: "utf8",
      env: {
        ...process.env,
        ELLIE_RUNNER_TEST_MODE: mode,
        ELLIE_RUNNER_TEST_ROOT: owned.root,
        PATH: `${owned.bin}:${process.env.PATH ?? ""}`,
      },
      timeout: 10_000,
    });
    outerResult = result;
    const diagnostic = await readFile(
      join(owned.root, "test-results/native-ios-runner-diagnostic.txt"),
      "utf8",
    );
    const retainedDerived =
      mode === "descendant" || mode === "cleanup-failure"
        ? (await readdir(owned.root)).filter((name) => name.startsWith("owned-derived-")).length
        : 0;
    const retainedEvidence =
      mode === "retained"
        ? await readFile(join(owned.root, "test-results/native-ios.xcresult/retained"), "utf8")
        : undefined;
    let xcodeArguments = "";
    try {
      xcodeArguments = await readFile(join(owned.root, "xcodebuild-arguments"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    outcome = { diagnostic, result, retainedDerived, retainedEvidence, xcodeArguments };
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    if (mode === "descendant") {
      const deadline = performance.now() + 2_000;
      while (performance.now() < deadline) {
        try {
          await access(join(owned.root, "descendant.done"));
          break;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
      }
      await access(join(owned.root, "descendant.done"));
    }
    guardCleanOuterResult(outerResult);
    await requireRecordedGroupsAbsent(owned.root);
    await rm(owned.root, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) throw cleanupError;
  if (operationError) throw operationError;
  assert.ok(outcome);
  return outcome;
}

test("build and UI execution use separate xcodebuild invocations", async () => {
  const { result, xcodeArguments } = await runFixture("split");
  assert.equal(result.status, 0);
  const calls = xcodeArguments
    .split("END\n")
    .map((value) => value.trim().split("\n"))
    .filter((value) => value[0]);
  assert.equal(calls.length, 3);
  const build = calls[1];
  const testCall = calls[2];
  assert.ok(build && testCall);
  assert.equal(build.at(-1), "build-for-testing");
  assert.equal(build.includes("-resultBundlePath"), false);
  assert.equal(testCall.at(-1), "test-without-building");
  assert.equal(testCall.includes("-resultBundlePath"), true);
});

test("a build-for-testing failure never starts UI execution", async () => {
  const { diagnostic, result, xcodeArguments } = await runFixture("build-failure");
  assert.equal(result.status, 1);
  assert.match(diagnostic, /stage=xcode-build-for-testing outcome=exit-status/);
  assert.match(xcodeArguments, /build-for-testing/);
  assert.doesNotMatch(xcodeArguments, /test-without-building/);
});

test("a test-without-building failure retains its distinct stage and result", async () => {
  const { diagnostic, result, xcodeArguments } = await runFixture("test-failure");
  assert.equal(result.status, 1);
  assert.match(diagnostic, /stage=xcode-test-without-building outcome=exit-status/);
  assert.match(diagnostic, /result=retained/);
  assert.match(xcodeArguments, /build-for-testing/);
  assert.match(xcodeArguments, /test-without-building/);
});

function guardCleanOuterResult(result: ReturnType<typeof spawnSync> | undefined) {
  if (!result || result.error || result.signal || !Number.isInteger(result.status))
    throw new Error("fixture runner termination is uncertain");
}

async function requireRecordedGroupsAbsent(root: string) {
  let groups: number[] = [];
  try {
    groups = (await readFile(join(root, "mock-process-groups"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assert.ok(groups.every((value) => Number.isInteger(value) && value > 1));
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    let present = false;
    for (const group of groups) {
      try {
        process.kill(-group, 0);
        present = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (!present) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("mock process-group cleanup remains uncertain");
}

test("early process failure preserves a diagnostic without an xcresult", async () => {
  const { diagnostic, result } = await runFixture("nonzero");
  assert.equal(result.status, 1);
  assert.match(
    diagnostic,
    /^iOS runner diagnostic: stage=simulator-discovery outcome=exit-status stageMs=\d+ totalMs=\d+ xcode=not-started result=not-created xcodeVersion=16\.4 sdkVersion=18\.5 runtime=unknown device=unknown cleanup=derived-removed\n$/,
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

test("a reaped leader with a still-observable finite child retains owned evidence", async () => {
  const { diagnostic, result, retainedDerived } = await runFixture("descendant");
  assert.equal(result.status, 1);
  assert.match(diagnostic, /outcome=cleanup-uncertain/);
  assert.match(diagnostic, /cleanup=derived-retained/);
  assert.match(result.stderr.toString(), /ownership is uncertain/);
  assert.equal(retainedDerived, 1);
});

test("a prior retained result blocks a new run without replacing evidence", async () => {
  const { diagnostic, result, retainedEvidence } = await runFixture("retained");
  assert.equal(result.status, 1);
  assert.match(diagnostic, /outcome=retained-result/);
  assert.match(diagnostic, /result=retained/);
  assert.equal(retainedEvidence, "evidence\n");
});

test("simulator cleanup failure retains derived evidence and fails the run", async () => {
  const { diagnostic, result, retainedDerived } = await runFixture("cleanup-failure");
  assert.equal(result.status, 1);
  assert.match(diagnostic, /outcome=cleanup-uncertain/);
  assert.match(diagnostic, /cleanup=shutdown-failed,delete-complete,derived-retained/);
  assert.equal(retainedDerived, 1);
});

test("a finite direct child ignoring TERM is killed and reaped within the shortened fixture bound", async () => {
  const started = performance.now();
  const { diagnostic, result } = await runFixture("kill-escalation");
  assert.equal(result.status, 1);
  assert.match(diagnostic, /stage=simulator-boot-ready outcome=timeout/);
  assert.doesNotMatch(diagnostic, /cleanup-uncertain/);
  assert.ok(performance.now() - started < 4_000);
});

test("runner interruption terminates and reaps only its retained direct child", async () => {
  const owned = await fixture("interrupt");
  let child: ReturnType<typeof spawn> | undefined;
  let cleanupCertain = false;
  let forcedKill = false;
  try {
    child = spawn(process.execPath, ["scripts/test-ios.mjs"], {
      cwd: owned.root,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        ELLIE_RUNNER_TEST_MODE: "interrupt",
        ELLIE_RUNNER_TEST_ROOT: owned.root,
        PATH: `${owned.bin}:${process.env.PATH ?? ""}`,
      },
    });
    const running = child;
    let stderr = "";
    running.stderr!.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const deadline = performance.now() + 2_000;
    while (performance.now() < deadline) {
      try {
        await access(join(owned.root, "interrupt.ready"));
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    await access(join(owned.root, "interrupt.ready"));
    assert.equal(running.kill("SIGTERM"), true);
    const outcome = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
        running.once("exit", (code, signal) => resolveExit({ code, signal })),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("interrupted runner did not exit")), 3_000),
      ),
    ]);
    assert.equal(outcome.code, 143);
    assert.equal(outcome.signal, null);
    assert.match(stderr, /outcome=interrupted/);
    assert.match(stderr, /cleanup=shutdown-complete,delete-complete,derived-removed/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolveExit) => child!.once("exit", () => resolveExit())),
        new Promise<void>((resolveWait) => setTimeout(resolveWait, 500)),
      ]);
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      forcedKill = true;
      child.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolveExit) => child!.once("exit", () => resolveExit())),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("owned runner cleanup remained uncertain")), 2_000),
        ),
      ]);
    }
    if (child?.pid) {
      try {
        process.kill(child.pid, 0);
        cleanupCertain = false;
      } catch (error) {
        cleanupCertain = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    } else {
      cleanupCertain = child === undefined;
    }
    if (forcedKill) cleanupCertain = false;
    if (cleanupCertain) {
      try {
        await requireRecordedGroupsAbsent(owned.root);
      } catch {
        cleanupCertain = false;
      }
    }
    if (cleanupCertain) await rm(owned.root, { recursive: true, force: true });
  }
});
