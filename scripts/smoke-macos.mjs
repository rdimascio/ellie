#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { arch, platform, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "package.json",
  "node_modules/typescript/bin/tsc",
  "packages/macos/native/Geometry.swift",
  "packages/macos/native/EllieHelper.swift",
  "tests/GeometryTests.swift",
];
const manualChecks = [
  ["initialize", "A new server identity is created without replacing existing state."],
  ["pair", "The execution Mac pairs only after its operator verifies the certificate fingerprint."],
  ["open-arc", "Arc opens or activates and the client reports Done."],
  ["top-left", "Arc occupies the usable top-left quarter and the client reports Done."],
  [
    "open-netflix",
    "Netflix opens in Arc with its existing browser profile and the client reports Done.",
  ],
  [
    "largest-fullscreen",
    "Arc moves to the largest logical display, enters native fullscreen, and the client reports Done.",
  ],
  [
    "messages-adjacent",
    "Arc leaves fullscreen; Arc is left and Messages is right on the same display.",
  ],
  [
    "optional-model",
    "A configured local model returns text through Ellie, or the step is recorded as SKIP (unconfigured).",
  ],
  ["revoke", "The revoked node loses access and no command is replayed."],
];

function usage() {
  return `Usage: node scripts/smoke-macos.mjs [options]

Runs the release-candidate checks without reading ~/.ellie, changing permissions,
installing the native helper, or sending an Ellie command.

Options:
  --report PATH          Write a sanitized JSON result (the file must not exist)
  --model-endpoint URL   Probe an already-running local OpenAI-compatible runner
  --model-id ID          Model to probe; required with --model-endpoint
  --help                 Show this help

The model endpoint must use http(s) on literal loopback (127.0.0.1 or [::1]).
Without both model options, the optional model check is reported as unconfigured.`;
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (
      argument === "--report" ||
      argument === "--model-endpoint" ||
      argument === "--model-id"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      const key =
        argument === "--report"
          ? "report"
          : argument === "--model-endpoint"
            ? "modelEndpoint"
            : "modelId";
      options[key] = value;
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (Boolean(options.modelEndpoint) !== Boolean(options.modelId)) {
    throw new Error("--model-endpoint and --model-id must be supplied together.");
  }
  if (options.modelId && (options.modelId.length > 200 || /[\r\n]/u.test(options.modelId))) {
    throw new Error("--model-id must be 1-200 characters on one line.");
  }
  return options;
}

export function localRunnerOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The model endpoint is not a valid URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("The model endpoint must be HTTP(S) on literal loopback.");
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error(
      "The model endpoint must be an origin without credentials, query, fragment, or path.",
    );
  }
  return url.origin;
}

function run(file, args, { capture = false, input } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {
      cwd: root,
      stdio: [
        input === undefined ? "ignore" : "pipe",
        capture ? "pipe" : "inherit",
        capture ? "pipe" : "inherit",
      ],
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        if (stdout.length < 64 * 1024) stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
      });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun({ stdout: stdout.trim(), stderr: stderr.trim() });
      else
        reject(
          new Error(
            signal ? `Command ended from signal ${signal}.` : `Command exited with status ${code}.`,
          ),
        );
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function boundedJson(response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Local runner returned HTTP ${response.status}.`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 128 * 1024) throw new Error("Local runner response exceeded 128 KiB.");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Local runner returned invalid JSON.");
  }
}

async function probeLocalModel(endpoint, modelId) {
  const origin = localRunnerOrigin(endpoint);
  const request = async (path, init = {}) =>
    boundedJson(
      await fetch(new URL(path, origin), {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json" },
      }),
    );
  const inventory = await request("/v1/models");
  if (!Array.isArray(inventory?.data) || !inventory.data.some((item) => item?.id === modelId)) {
    throw new Error("The requested model is not present in the local runner inventory.");
  }
  const completion = await request("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "Reply with a short greeting." }],
      max_tokens: 32,
      stream: false,
    }),
  });
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("The local runner returned no completion text.");
  }
}

function result(name, status, detail) {
  return { name, status, ...(detail ? { detail } : {}) };
}

async function writeReport(path, report) {
  const destination = resolve(path);
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log("REPORT written.");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL arguments: ${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  const startedAt = new Date().toISOString();
  const checks = [];
  const environment = { platform: platform(), architecture: arch(), nodeVersion: process.version };
  let revision;
  let temporaryDirectory;

  const check = async (name, action, failureDetail) => {
    const began = Date.now();
    try {
      const value = await action();
      checks.push({ ...result(name, "passed"), durationMs: Date.now() - began });
      console.log(`PASS ${name}`);
      return value;
    } catch (error) {
      checks.push({
        ...result(name, "failed", failureDetail ?? error.message),
        durationMs: Date.now() - began,
      });
      console.error(`FAIL ${name}: ${error.message}`);
      return undefined;
    }
  };

  if (platform() !== "darwin") {
    checks.push(result("macOS platform", "failed", "This smoke gate requires macOS."));
    console.error(
      `FAIL macOS platform: unsupported platform ${platform()}; run this gate on a physical Mac.`,
    );
  } else {
    checks.push(result("macOS platform", "passed"));
    console.log("PASS macOS platform");
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor === 24) {
    checks.push(result("Node.js 24", "passed"));
    console.log("PASS Node.js 24");
  } else {
    checks.push(result("Node.js 24", "failed", "Node.js 24 is required."));
    console.error(`FAIL Node.js 24: found ${process.version}; install Node.js 24.`);
  }

  await check(
    "checkout inputs",
    async () => {
      for (const file of requiredFiles) {
        try {
          await access(join(root, file), constants.R_OK);
        } catch {
          if (file.startsWith("node_modules/")) {
            throw new Error(
              "Installed TypeScript is missing. Install the locked workspace dependencies first.",
            );
          }
          throw new Error(`Required checkout file ${file} is missing.`);
        }
      }
    },
    "Required source files or installed TypeScript are missing.",
  );

  revision = await check(
    "clean Git checkout",
    async () => {
      const head = await run("git", ["rev-parse", "HEAD"], { capture: true });
      const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        capture: true,
      });
      if (status.stdout)
        throw new Error(
          "The checkout has tracked or untracked changes. Commit, stash, or remove them before recording a release candidate.",
        );
      return head.stdout;
    },
    "The Git checkout is unavailable or not clean.",
  );

  if (platform() === "darwin") {
    const macos = await check(
      "macOS version",
      async () => (await run("/usr/bin/sw_vers", ["-productVersion"], { capture: true })).stdout,
      "Unable to read the macOS product version.",
    );
    if (macos) environment.macosVersion = macos;
    const model = await check(
      "hardware model",
      async () => (await run("/usr/sbin/sysctl", ["-n", "hw.model"], { capture: true })).stdout,
      "Unable to read the non-unique hardware model identifier.",
    );
    if (model) environment.hardwareModel = model;
    await check(
      "Xcode Command Line Tools",
      async () => {
        await access("/usr/bin/xcode-select", constants.X_OK);
        await run("/usr/bin/xcode-select", ["-p"], { capture: true });
        await access("/usr/bin/xcrun", constants.X_OK);
        await run("/usr/bin/xcrun", ["--find", "swiftc"], { capture: true });
      },
      "Install Xcode Command Line Tools before running the smoke gate.",
    );
    await check(
      "codesign",
      () => access("/usr/bin/codesign", constants.X_OK),
      "The macOS codesign tool is missing.",
    );
    await check(
      "OpenSSL/LibreSSL",
      async () => {
        await access("/usr/bin/openssl", constants.X_OK);
        await run("/usr/bin/openssl", ["version"], { capture: true });
      },
      "The macOS OpenSSL/LibreSSL command is missing or unusable.",
    );
  }

  const readinessFailed = checks.some((item) => item.status === "failed");
  if (!readinessFailed) {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "ellie-smoke-"));
    await check("TypeScript", () =>
      run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"]),
    );
    const tests = readdir(join(root, "tests")).then((files) =>
      files
        .filter((file) => file.endsWith(".test.ts"))
        .sort()
        .map((file) => join("tests", file)),
    );
    await check("Node test suite", async () => run(process.execPath, ["--test", ...(await tests)]));
    const helper = join(temporaryDirectory, "ellie-macos");
    const helperBuilt = await check("Swift helper build", () =>
      run("/usr/bin/xcrun", [
        "swiftc",
        "-swift-version",
        "5",
        "-O",
        "-parse-as-library",
        "packages/macos/native/Geometry.swift",
        "packages/macos/native/EllieHelper.swift",
        "-o",
        helper,
      ]),
    );
    if (helperBuilt !== undefined) {
      await check("temporary helper signing", () =>
        run("/usr/bin/codesign", [
          "--force",
          "--sign",
          "-",
          "--identifier",
          "org.ellie.helper.smoke",
          helper,
        ]),
      );
      await check(
        "native telemetry",
        async () => {
          const response = await run(helper, [], {
            capture: true,
            input: JSON.stringify({ command: "telemetry" }),
          });
          const status = JSON.parse(response.stdout);
          if (
            !Number.isSafeInteger(status.availableMemoryBytes) ||
            status.availableMemoryBytes < 0 ||
            status.availableMemoryBytes > totalmem()
          ) {
            throw new Error("Native admission memory is missing or invalid.");
          }
        },
        "The temporary helper did not return a bounded admission-memory reading.",
      );
    } else {
      checks.push(result("temporary helper signing", "not-run", "Swift helper build failed."));
      console.log("SKIP temporary helper signing: Swift helper build failed.");
      checks.push(result("native telemetry", "not-run", "Swift helper build failed."));
      console.log("SKIP native telemetry: Swift helper build failed.");
    }
    const geometry = join(temporaryDirectory, "geometry-tests");
    const geometryBuilt = await check("geometry test build", () =>
      run("/usr/bin/xcrun", [
        "swiftc",
        "-swift-version",
        "5",
        "-parse-as-library",
        "packages/macos/native/Geometry.swift",
        "tests/GeometryTests.swift",
        "-o",
        geometry,
      ]),
    );
    if (geometryBuilt !== undefined) await check("geometry tests", () => run(geometry, []));
    else {
      checks.push(result("geometry tests", "not-run", "Geometry test build failed."));
      console.log("SKIP geometry tests: geometry test build failed.");
    }
  } else {
    for (const name of [
      "TypeScript",
      "Node test suite",
      "Swift helper build",
      "temporary helper signing",
      "native telemetry",
      "geometry test build",
      "geometry tests",
    ]) {
      checks.push(result(name, "not-run", "Required readiness checks failed."));
    }
  }

  if (options.modelEndpoint && !readinessFailed) {
    await check(
      "optional local model probe",
      () => probeLocalModel(options.modelEndpoint, options.modelId),
      "The explicitly requested local model probe failed.",
    );
  } else if (options.modelEndpoint) {
    checks.push(
      result("optional local model probe", "not-run", "Required readiness checks failed."),
    );
    console.log("SKIP optional local model probe: required readiness checks failed.");
  } else {
    checks.push(
      result(
        "optional local model probe",
        "unconfigured",
        "No local runner was requested; desktop acceptance does not require a model.",
      ),
    );
    console.log("SKIP optional local model probe: unconfigured (not required).");
  }

  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  const failed = checks.some((item) => item.status === "failed");
  const report = {
    schemaVersion: 1,
    kind: "ellie-macos-smoke",
    startedAt,
    finishedAt: new Date().toISOString(),
    result: failed ? "failed" : "passed",
    environment,
    ...(revision ? { revision } : {}),
    checks,
    manualAcceptance: {
      status: "not-run",
      instructions: "docs/testing.md",
      steps: manualChecks.map(([id, expected]) => ({ id, status: "not-run", expected })),
    },
  };
  if (options.report) {
    try {
      await writeReport(options.report, report);
    } catch (error) {
      console.error(`FAIL report: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(failed ? "SMOKE RESULT: FAILED" : "SMOKE RESULT: PASSED");
  if (failed) process.exitCode = 1;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  try {
    await main();
  } catch {
    console.error("FAIL smoke gate: an unexpected internal error occurred.");
    process.exitCode = 1;
  }
}
