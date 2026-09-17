import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type Input = {
  ownedRoot: string;
  reportDirectory: string;
  credential: unknown;
  target: string;
};

type ChildResult = { output: string; code: number | null; signal: NodeJS.Signals | null };

export class ComposedIOSCleanupError extends Error {
  override name = "ComposedIOSCleanupError";
}

/** One synthetic iOS Simulator only. No Keychain, real enrollment, or physical device. */
export async function runIOSBrowserComposed(input: Input) {
  const identifier = randomUUID().toLowerCase();
  const developer = resolve(
    process.env.ELLIE_IOS_COMPOSED_DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
  );
  assert.equal(developer, "/Applications/Xcode.app/Contents/Developer");
  const environment = {
    ...process.env,
    LC_ALL: "C",
    LANG: "C",
    LC_CTYPE: "C",
    DEVELOPER_DIR: developer,
  };
  const xcodebuild = join(developer, "usr/bin/xcodebuild");
  const source = resolve(".");
  const derived = join(input.ownedRoot, "ios-derived-data");
  const resultBundle = join(input.reportDirectory, "composed-ios.xcresult");
  const events = join(input.reportDirectory, "ios-runner-events.jsonl");
  await writeFile(events, "", { flag: "wx", mode: 0o600 });
  const event = async (value: Record<string, unknown>) => {
    await appendFile(events, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
  };
  let simulator: string | undefined;
  let active: ChildProcess | undefined;
  let stopActive: ((why: string) => void) | undefined;
  let interrupted: string | undefined;
  let cleanupCertain = true;
  let passed = false;
  let failure: unknown;

  const interrupt = (signal: string) => {
    interrupted ??= signal;
    void event({ kind: "runner-signal", signal, active: active !== undefined });
    stopActive?.(`runner-${signal}`);
  };
  const onTerm = () => interrupt("SIGTERM");
  const onInt = () => interrupt("SIGINT");
  const onHup = () => interrupt("SIGHUP");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  process.on("SIGHUP", onHup);

  async function run(
    label: string,
    executable: string,
    args: string[],
    timeoutMs: number,
    capture = false,
    cleanup = false,
  ): Promise<ChildResult> {
    if (interrupted && !cleanup) throw new Error(`Composed iOS run interrupted before ${label}.`);
    if (active) throw new ComposedIOSCleanupError(`Unreaped direct child prevents ${label}.`);
    const log = createWriteStream(join(input.reportDirectory, `ios-${label}.log`), {
      flags: "wx",
      mode: 0o600,
    });
    let logError = false;
    let stopForLogError: (() => void) | undefined;
    log.on("error", () => {
      logError = true;
      stopForLogError?.();
    });
    const child = spawn(executable, args, {
      cwd: source,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    active = child;
    let output = "";
    let bytes = 0;
    let reason: string | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let eventError: unknown;
    const stop = (why: string) => {
      if (reason) return;
      reason = why;
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") reason = "terminate-failed";
      }
      escalation = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") reason = "reap-failed";
        }
      }, 5_000);
    };
    stopActive = stop;
    stopForLogError = () => stop("log-error");
    if (logError) stopForLogError();
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) {
        stop("output-limit");
        return;
      }
      if (!log.destroyed) log.write(chunk);
      if (capture) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const deadline = setTimeout(() => stop("timeout"), timeoutMs);
    let reapDeadline: ReturnType<typeof setTimeout> | undefined;
    const completion = new Promise<ChildResult & { reaped: boolean }>((done) => {
      child.once("error", () => {
        reason ??= "spawn";
      });
      child.once("close", (code, signal) => done({ output, code, signal, reaped: true }));
      reapDeadline = setTimeout(
        () => done({ output, code: null, signal: null, reaped: false }),
        timeoutMs + 12_000,
      );
    });
    try {
      await event({ kind: "child-start", label, timeoutMs, pid: child.pid ?? null });
    } catch (error) {
      eventError = error;
      stop("event-write");
    }
    const result = await completion;
    clearTimeout(deadline);
    if (reapDeadline) clearTimeout(reapDeadline);
    if (escalation) clearTimeout(escalation);
    if (!log.destroyed) await new Promise<void>((done) => log.end(done));
    await event({
      kind: "child-close",
      label,
      pid: child.pid ?? null,
      code: result.code,
      signal: result.signal,
      reaped: result.reaped,
      reason: reason ?? null,
    });
    if (result.reaped) {
      active = undefined;
      stopActive = undefined;
    }
    if (label === "create") {
      const id = result.output.trim();
      if (
        result.reaped &&
        result.code === 0 &&
        /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(id)
      ) {
        simulator = id;
        await writeFile(join(input.reportDirectory, "owned-simulator-id.txt"), `${id}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      } else {
        cleanupCertain = false;
      }
    }
    if (!result.reaped) throw new Error(`${label}: direct-child-cleanup-uncertain`);
    if (eventError) throw new Error(`${label}: event-write-failed`, { cause: eventError });
    if (reason || result.code !== 0)
      throw new Error(`${label}: ${reason ?? `exit-${result.code}`}`);
    if (interrupted && !cleanup) throw new Error(`${label}: interrupted-${interrupted}`);
    return result;
  }

  try {
    const runtimes = JSON.parse(
      (await run("runtimes", "/usr/bin/xcrun", ["simctl", "list", "runtimes", "-j"], 30_000, true))
        .output,
    ) as {
      runtimes: Array<{ identifier: string; version: string; isAvailable: boolean }>;
    };
    assert.ok(
      runtimes.runtimes.some(
        (runtime) =>
          runtime.identifier === "com.apple.CoreSimulator.SimRuntime.iOS-18-3" &&
          runtime.version === "18.3.1" &&
          runtime.isAvailable,
      ),
      "Exact iOS 18.3 Simulator runtime is unavailable.",
    );
    const created = (
      await run(
        "create",
        "/usr/bin/xcrun",
        [
          "simctl",
          "create",
          `EllieBrowserComposed-${identifier.slice(0, 8)}`,
          "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
          "com.apple.CoreSimulator.SimRuntime.iOS-18-3",
        ],
        30_000,
        true,
      )
    ).output.trim();
    assert.equal(created, simulator, "Owned Simulator identity mismatch.");
    await run("boot", "/usr/bin/xcrun", ["simctl", "boot", simulator!], 60_000);
    await run("bootstatus", "/usr/bin/xcrun", ["simctl", "bootstatus", simulator!, "-b"], 120_000);
    const buildArguments = [
      "-project",
      join(source, "apps/ios/EllieIOS.xcodeproj"),
      "-scheme",
      "EllieIOS",
      "-destination",
      `platform=iOS Simulator,id=${simulator}`,
      "-derivedDataPath",
      derived,
      "-jobs",
      "2",
      "CODE_SIGNING_ALLOWED=NO",
      "ONLY_ACTIVE_ARCH=YES",
      `ELLIE_COMPOSED_BROWSER_FIXTURE_ID=${identifier}`,
    ];
    await run("build", xcodebuild, [...buildArguments, "build-for-testing"], 780_000);
    const app = join(derived, "Build/Products/Debug-iphonesimulator/Ellie.app");
    await realpath(app);
    await run("install", "/usr/bin/xcrun", ["simctl", "install", simulator!, app], 60_000);
    const container = (
      await run(
        "app-container",
        "/usr/bin/xcrun",
        ["simctl", "get_app_container", simulator!, "org.ellie.dashboard.ios", "data"],
        30_000,
        true,
      )
    ).output.trim();
    assert.ok(container.startsWith("/"), "The owned app container is unavailable.");
    const resolvedContainer = await realpath(container);
    assert.ok(
      resolvedContainer.includes(`/Devices/${simulator}/data/Containers/Data/Application/`),
      "The credential destination is not the owned Simulator app container.",
    );
    const fixtureDirectory = join(
      resolvedContainer,
      "Library/Application Support/EllieUITests",
      `browser-composed-${identifier}`,
    );
    await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 });
    await chmod(fixtureDirectory, 0o700);
    const credentialFile = join(fixtureDirectory, "credential.json");
    await writeFile(
      credentialFile,
      `${JSON.stringify({ credential: input.credential, target: input.target })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await chmod(credentialFile, 0o600);
    await event({
      kind: "credential-handoff",
      fixtureID: identifier,
      privateFileMode: "0600",
      location: "owned Simulator app container",
    });
    const tests = [
      "-only-testing:EllieIOSUITests/EllieIOSUITests/" +
        "testComposedSyntheticVoiceUsesPinnedBrowserAndNeverReplaysCancelledScroll",
    ];
    await run(
      "test",
      xcodebuild,
      [
        ...buildArguments,
        "-resultBundlePath",
        resultBundle,
        "-parallel-testing-enabled",
        "NO",
        ...tests,
        "test-without-building",
      ],
      480_000,
    );
    const resultTree = JSON.parse(
      (
        await run(
          "xcresult-tests",
          "/usr/bin/xcrun",
          ["xcresulttool", "get", "test-results", "tests", "--path", resultBundle],
          30_000,
          true,
        )
      ).output,
    ) as { testNodes?: unknown[] };
    const cases: Array<{ nodeIdentifier?: string; result?: string }> = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const node = value as { nodeIdentifier?: string; result?: string; children?: unknown[] };
      if (node.nodeIdentifier?.startsWith("EllieIOSUITests/testComposedSyntheticVoice"))
        cases.push(node);
      node.children?.forEach(visit);
    };
    resultTree.testNodes?.forEach(visit);
    assert.equal(cases.length, 1, "The composed XCTest case must execute exactly once.");
    assert.equal(cases[0]?.result, "Passed", "A skipped XCTest is not acceptance.");
    passed = true;
  } catch (error) {
    failure = error;
  } finally {
    if (active) {
      cleanupCertain = false;
    } else if (simulator) {
      await run(
        "shutdown",
        "/usr/bin/xcrun",
        ["simctl", "shutdown", simulator],
        30_000,
        false,
        true,
      ).catch(() => {});
      if (active) cleanupCertain = false;
      else
        await run(
          "delete",
          "/usr/bin/xcrun",
          ["simctl", "delete", simulator],
          30_000,
          false,
          true,
        ).catch(() => {
          cleanupCertain = false;
        });
      if (active) cleanupCertain = false;
      if (cleanupCertain) {
        try {
          const devices = JSON.parse(
            (
              await run(
                "list-after-delete",
                "/usr/bin/xcrun",
                ["simctl", "list", "-j", "devices"],
                30_000,
                true,
                true,
              )
            ).output,
          ) as {
            devices: Record<string, Array<{ udid: string }>>;
          };
          if (
            Object.values(devices.devices)
              .flat()
              .some((value) => value.udid === simulator)
          )
            cleanupCertain = false;
        } catch {
          cleanupCertain = false;
        }
      }
    }
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    process.off("SIGHUP", onHup);
    await writeFile(
      join(input.reportDirectory, "ios-runner-result.json"),
      `${JSON.stringify(
        {
          fixtureID: identifier,
          simulator,
          passed,
          cleanupCertain,
          interrupted: interrupted ?? null,
          failure: failure instanceof Error ? failure.message : failure ? "unknown" : null,
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
  if (!cleanupCertain)
    throw new ComposedIOSCleanupError("Owned composed iOS Simulator cleanup is uncertain.", {
      cause: failure,
    });
  if (failure) throw failure;
  return { fixtureID: identifier, resultBundle, simulator, cleanupCertain };
}
