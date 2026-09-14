#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserAuth } from "../apps/server/src/browser-auth.ts";
import { createBrowserServer } from "../apps/server/src/browser-server.ts";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import { NativeSpeech } from "../apps/server/src/native-speech.ts";
import { WhisperCliSpeechInput } from "../packages/speech/src/index.ts";
import { parseAppleVersion, selectCompatibleIOSRuntime } from "./ios-runtime-selection.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = {
  ...process.env,
  DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
};
const owned = mkdtempSync(join(tmpdir(), "ellie-ios-ats-"));
const resultBundle = resolve(root, "test-results/native-ios-ats.xcresult");
const unreapedChildren = new Set();
let simulatorID,
  server,
  browserAuth,
  nativeAuth,
  nativeSpeech,
  activeChild,
  interruptChild,
  requestedSignal,
  succeeded = false,
  cleanupCertain = true;
let remoteNodeReads = 0,
  remoteAppOpens = 0,
  speechUploadRequests = 0;
const diagnosticStartedAt = performance.now();
let diagnosticStage = "fixture-setup",
  diagnosticStageStartedAt = diagnosticStartedAt;
const cleanupOutcomes = [];
const platform = { xcode: "unknown", sdk: "unknown", runtime: "unknown", device: "unknown" };
const endpointRequests = {
  session: 0,
  inventory: 0,
  command: 0,
  logout: 0,
  unexpected: 0,
};
const endpointResponses = { ...endpointRequests };

function enterDiagnosticStage(stage) {
  diagnosticStage = stage;
  diagnosticStageStartedAt = performance.now();
}

function endpointStage(request) {
  const path = request.url?.split("?", 1)[0];
  if (path?.startsWith("/native/v1/speech/") || path?.startsWith("/__ellie-test/speech/")) {
    return undefined;
  }
  if (request.method === "GET" && path === "/native/v1/session") return "session";
  if (request.method === "GET" && path === "/native/v1/nodes") return "inventory";
  if (request.method === "POST" && path === "/native/v1/commands") return "command";
  if (request.method === "POST" && path === "/native/v1/logout") return "logout";
  return "unexpected";
}

function recordEndpointRequest(request, response) {
  const stage = endpointStage(request);
  if (!stage) return;
  endpointRequests[stage] += 1;
  response.once("finish", () => {
    endpointResponses[stage] += 1;
  });
}

function diagnosticSummary() {
  const bounded = (value) => Math.min(Math.max(value, 0), 999_999);
  const counts = (value) =>
    ["session", "inventory", "command", "logout", "unexpected"]
      .map((key) => `${key}:${Math.min(value[key], 99)}`)
      .join(",");
  return [
    `stage=${diagnosticStage}`,
    `stageMs=${bounded(Math.round(performance.now() - diagnosticStageStartedAt))}`,
    `totalMs=${bounded(Math.round(performance.now() - diagnosticStartedAt))}`,
    `requests=${counts(endpointRequests)}`,
    `responses=${counts(endpointResponses)}`,
    `xcode=${platform.xcode}`,
    `sdk=${platform.sdk}`,
    `runtime=${platform.runtime}`,
    `device=${platform.device}`,
    `cleanup=${cleanupOutcomes.length ? cleanupOutcomes.join(",") : "not-started"}`,
  ].join(" ");
}

function groupAbsent(processGroup) {
  if (!Number.isInteger(processGroup) || processGroup <= 1) return true;
  try {
    process.kill(-processGroup, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

function signalDirectChild(child, signal) {
  if (
    !child ||
    !Number.isInteger(child.pid) ||
    child.pid <= 1 ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return false;
  return child.kill(signal);
}

function execute(file, args, { capture = false, timeout = 30_000, cleanup = false } = {}) {
  if (requestedSignal && !cleanup)
    return Promise.reject(new Error("iOS transport test interrupted."));
  return new Promise((resolvePromise, reject) => {
    let stdout = "",
      failure,
      killTimer,
      reapTimer,
      settled = false;
    const child = spawn(file, args, {
      cwd: root,
      env: environment,
      detached: true,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    unreapedChildren.add(child);
    activeChild = child;
    function stop(message) {
      if (settled) return;
      failure ??= new Error(message);
      signalDirectChild(child, "SIGTERM");
      killTimer ??= setTimeout(() => signalDirectChild(child, "SIGKILL"), 5_000);
      reapTimer ??= setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        cleanupCertain = false;
        child.stdout?.destroy();
        child.unref();
        reject(new Error(`${file} direct child cleanup is uncertain.`));
      }, 7_000);
    }
    interruptChild = () => stop("iOS transport test interrupted.");
    if (capture)
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        if (stdout.length + chunk.length > 1_048_576) stop("Command output exceeded its bound.");
        else stdout += chunk;
      });
    const timer = setTimeout(() => stop(`${file} exceeded its deadline.`), timeout);
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      unreapedChildren.delete(child);
      if (activeChild === child) {
        activeChild = undefined;
        interruptChild = undefined;
      }
      if (settled) return;
      settled = true;
      try {
        if (!groupAbsent(child.pid)) {
          cleanupCertain = false;
          failure ??= new Error(`${file} left process-group members; cleanup is uncertain.`);
        }
      } catch (error) {
        cleanupCertain = false;
        failure ??= error;
      }
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${file} exited with ${signal ?? code}.`));
      else resolvePromise(stdout.trim());
    });
  });
}

async function settleFixtureTeardown(operation, timeout = 10_000) {
  let timer;
  try {
    await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Fixture teardown exceeded its deadline.")),
          timeout,
        );
      }),
    ]);
    cleanupOutcomes.push("fixture-teardown-complete");
    return true;
  } catch (error) {
    cleanupCertain = false;
    cleanupOutcomes.push(
      error instanceof Error && error.message.includes("deadline")
        ? "fixture-teardown-timeout"
        : "fixture-teardown-failed",
    );
    console.warn("The synthetic ATS fixture did not close cleanly; owned evidence was retained.");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    requestedSignal = signal;
    interruptChild?.();
  });
}

let runFailure;
try {
  try {
    lstatSync(resultBundle);
    throw new Error("A previous ATS result is retained; move or remove it before another run.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(resultBundle), { recursive: true });
  enterDiagnosticStage("fixture-certificate");
  const cert = join(owned, "cert.pem"),
    key = join(owned, "key.pem"),
    der = join(owned, "cert.der");
  const config = join(owned, "openssl.cnf");
  writeFileSync(
    config,
    [
      "[req]",
      "distinguished_name=dn",
      "x509_extensions=server",
      "prompt=no",
      "[dn]",
      "CN=127.0.0.1",
      "[server]",
      "subjectAltName=IP:127.0.0.1",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "2",
    "-config",
    config,
  ]);
  await execute("openssl", ["x509", "-in", cert, "-outform", "DER", "-out", der]);
  enterDiagnosticStage("fixture-listener");
  const pin = createHash("sha256").update(readFileSync(der)).digest("hex");
  const token = "c".repeat(64);
  const fakeWhisper = join(owned, "fake-whisper.mjs");
  const fakeModel = join(owned, "fake-model.bin");
  const invocationLog = join(owned, "speech-invocations");
  const processExitLog = join(owned, "speech-process-exits");
  writeFileSync(fakeModel, "synthetic model fixture", { mode: 0o600 });
  writeFileSync(
    fakeWhisper,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
const audio = readFileSync(value("-f"));
const marker = String(audio[44]);
if (audio[44] >= 3) {
  process.on("SIGTERM", () => {
    appendFileSync(${JSON.stringify(processExitLog)}, marker + "\\n");
    process.exit(143);
  });
  appendFileSync(${JSON.stringify(invocationLog)}, marker + "\\n");
  setTimeout(() => process.exit(70), 45_000);
  setInterval(() => {}, 1000);
} else if (audio[44] === 2) {
  appendFileSync(${JSON.stringify(invocationLog)}, marker + "\\n");
  setTimeout(() => {
    writeFileSync(value("-of") + ".txt", "Open Safari\\n");
    appendFileSync(${JSON.stringify(processExitLog)}, marker + "\\n");
  }, 11_000);
} else {
  appendFileSync(${JSON.stringify(invocationLog)}, marker + "\\n");
  writeFileSync(value("-of") + ".txt", "Open Safari\\n");
  appendFileSync(${JSON.stringify(processExitLog)}, marker + "\\n");
}
`,
    { mode: 0o700 },
  );
  chmodSync(fakeWhisper, 0o700);
  const reservation = createNetServer();
  await new Promise((resolveListen, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolveListen);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Fixture has no loopback port.");
  const origin = `https://127.0.0.1:${address.port}`;
  await new Promise((resolveClose) => reservation.close(resolveClose));
  browserAuth = new BrowserAuth(BrowserAuth.empty(), async () => {});
  const nativeIDs = [
    "native-ats",
    "speech-denied",
    "speech-granted",
    "speech-revoked",
    "session-revoked",
    "speech-cancel",
    "speech-disconnect",
  ];
  nativeAuth = new NativeAuth(NativeAuth.empty(), async () => {}, {
    token: () => "a".repeat(64),
    id: () => nativeIDs.shift() ?? `unexpected-${randomUUID()}`,
  });
  const invitation = await nativeAuth.invite({
    label: "Phone",
    grants: [{ target: "studio-mac", capabilities: ["app.open"] }],
  });
  await nativeAuth.pair(invitation.code, token);
  const speechClients = [];
  for (const [label, candidate] of [
    ["Speech Denied", "d"],
    ["Speech Granted", "e"],
    ["Speech Revoked", "f"],
    ["Session Revoked", "b"],
    ["Speech Cancel", "cd"],
    ["Speech Disconnect", "de"],
  ]) {
    const next = await nativeAuth.invite({
      label,
      grants: [{ target: "speech-fixture-no-node", capabilities: ["app.open"] }],
    });
    speechClients.push(await nativeAuth.pair(next.code, candidate.repeat(64 / candidate.length)));
  }
  nativeSpeech = NativeSpeech.memory(
    nativeAuth,
    () =>
      new WhisperCliSpeechInput({
        executable: fakeWhisper,
        model: fakeModel,
        maxAudioBytes: 1_100_000,
        maxAudioDurationMs: 30_000,
        maxTranscriptBytes: 16_384,
        timeoutMs: 35_000,
      }),
  );
  await nativeSpeech.grant({
    clientId: speechClients[1].id,
    capability: "speech.transcribe",
  });
  await nativeSpeech.grant({
    clientId: speechClients[2].id,
    capability: "speech.transcribe",
  });
  await nativeSpeech.grant({
    clientId: speechClients[4].id,
    capability: "speech.transcribe",
  });
  await nativeSpeech.grant({
    clientId: speechClients[5].id,
    capability: "speech.transcribe",
  });
  await nativeSpeech.revoke(speechClients[2].id);
  await nativeAuth.revoke(speechClients[3].id);
  const disconnectBearer = `Bearer ${"de".repeat(32)}`;
  const cancelBearer = `Bearer ${"cd".repeat(32)}`;
  const readSpeechMarkers = () => {
    try {
      return readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  };
  const readSpeechExitMarkers = () => {
    try {
      return readFileSync(processExitLog, "utf8").trim().split("\n").filter(Boolean);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  };
  const settledTurns = new Set();
  const activeTurns = new Map();
  const fixtureTranscribe = nativeSpeech.transcribe.bind(nativeSpeech);
  nativeSpeech.transcribe = async (bearer, turnId, audio, disconnected) => {
    activeTurns.set(turnId, bearer);
    try {
      return await fixtureTranscribe(bearer, turnId, audio, disconnected);
    } finally {
      settledTurns.add(turnId);
    }
  };
  const hosted = createBrowserServer({
    cert: readFileSync(cert),
    key: readFileSync(key),
    origin,
    auth: browserAuth,
    nativeAuth,
    speech: nativeSpeech,
    remote: {
      async nodes() {
        remoteNodeReads += 1;
        return [
          { id: "studio-mac", label: "Studio Mac", online: true, capabilities: ["app.open"] },
        ];
      },
      async openApp(node, app) {
        if (node !== "studio-mac" || app !== "safari") throw new Error("Unexpected command");
        remoteAppOpens += 1;
        return { ok: true, message: "synthetic" };
      },
    },
  });
  server = hosted;
  const productionListeners = hosted.server.listeners("request");
  hosted.server.removeAllListeners("request");
  hosted.server.on("request", (request, response) => {
    recordEndpointRequest(request, response);
    const control = /^\/__ellie-test\/speech\/(cancel|disconnect)\/(started|settled)$/.exec(
      request.url ?? "",
    );
    if (control) {
      const [, fixtureCase, phase] = control;
      const bearer = fixtureCase === "cancel" ? cancelBearer : disconnectBearer;
      const marker = fixtureCase === "cancel" ? "3" : "4";
      void (async () => {
        if (
          request.method !== "GET" ||
          request.headers.authorization !== bearer ||
          request.headers["x-ellie-version"] !== "1"
        ) {
          response.writeHead(403, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end('{"ok":false}');
          return;
        }
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const turns = [...activeTurns].filter(([, owner]) => owner === bearer).map(([id]) => id);
          const processMarkers = readSpeechMarkers();
          const exitMarkers = readSpeechExitMarkers();
          const ready =
            phase === "started"
              ? turns.some((id) => !settledTurns.has(id)) && processMarkers.includes(marker)
              : turns.length === 1 &&
                turns.every((id) => settledTurns.has(id)) &&
                exitMarkers.includes(marker);
          if (ready) {
            response.writeHead(200, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
            response.end('{"ok":true}');
            return;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
        response.writeHead(503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end('{"ok":false}');
      })().catch(() => response.destroy());
      return;
    }
    if (request.method === "POST" && request.url === "/native/v1/speech/transcriptions") {
      speechUploadRequests += 1;
    }
    if (request.headers["x-ellie-turn-id"] === "77777777-7777-4777-8777-777777777777") {
      response.end = function () {
        response.socket?.destroy();
        return response;
      };
    }
    for (const listener of productionListeners) listener.call(hosted.server, request, response);
  });
  await new Promise((resolveListen, reject) => {
    hosted.server.once("error", reject);
    hosted.server.listen(address.port, "127.0.0.1", resolveListen);
  });

  enterDiagnosticStage("simulator-discovery");
  const xcodeVersion = await execute("xcodebuild", ["-version"], {
    capture: true,
    timeout: 15_000,
  });
  const xcodeMatch =
    /^Xcode ([0-9]+\.[0-9]+(?:\.[0-9]+)?)\nBuild version [A-Za-z0-9]{1,32}\n?$/.exec(xcodeVersion);
  if (!xcodeMatch) throw new Error("Selected Xcode version output is invalid.");
  parseAppleVersion(xcodeMatch[1]);
  platform.xcode = xcodeMatch[1];
  const sdkVersion = (
    await execute("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-version"], {
      capture: true,
      timeout: 15_000,
    })
  ).trim();
  parseAppleVersion(sdkVersion);
  platform.sdk = sdkVersion;
  let runtimeInventory;
  try {
    runtimeInventory = JSON.parse(
      await execute("xcrun", ["simctl", "list", "runtimes", "--json"], {
        capture: true,
        timeout: 15_000,
      }),
    );
  } catch {
    throw new Error("Simulator runtime inventory is invalid.");
  }
  const runtimes = runtimeInventory?.runtimes;
  const selectedRuntime = selectCompatibleIOSRuntime(runtimes, sdkVersion);
  platform.runtime = selectedRuntime.version;
  const compatible =
    selectedRuntime.supportedDeviceTypes?.filter((item) => item.productFamily === "iPhone") ?? [];
  const device = compatible.find((item) => item.name === "iPhone 16") ?? compatible[0];
  if (
    !device ||
    typeof device.identifier !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(device.identifier)
  )
    throw new Error("The selected iOS runtime has no valid supported iPhone.");
  platform.device = device.identifier;
  enterDiagnosticStage("simulator-create");
  simulatorID = await execute(
    "xcrun",
    [
      "simctl",
      "create",
      `Ellie iOS ATS Tests ${randomUUID().slice(0, 8)}`,
      device.identifier,
      selectedRuntime.identifier,
    ],
    { capture: true },
  );
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(simulatorID)) {
    simulatorID = undefined;
    throw new Error("Simulator creation returned an invalid identifier.");
  }
  enterDiagnosticStage("simulator-boot");
  await execute("xcrun", ["simctl", "boot", simulatorID]);
  await execute("xcrun", ["simctl", "bootstatus", simulatorID, "-b"], { timeout: 180_000 });
  enterDiagnosticStage("xcode-test");
  await execute(
    "xcodebuild",
    [
      "-quiet",
      "-project",
      "apps/ios/EllieIOS.xcodeproj",
      "-scheme",
      "EllieIOSATS",
      "-destination",
      `platform=iOS Simulator,id=${simulatorID}`,
      "-parallel-testing-enabled",
      "NO",
      "-derivedDataPath",
      join(owned, "DerivedData"),
      "-resultBundlePath",
      resultBundle,
      `ELLIE_ATS_TEST_ORIGIN=${origin}`,
      `ELLIE_ATS_TEST_PIN=${pin}`,
      "ELLIE_SPEECH_TEST_ENABLED=YES",
      "CODE_SIGNING_ALLOWED=YES",
      "test",
    ],
    { timeout: 600_000 },
  );
  if (remoteNodeReads !== 2 || remoteAppOpens !== 1) {
    throw new Error("The production native routes did not perform the expected finite operations.");
  }
  const speechMarkers = readSpeechMarkers().sort();
  const speechExitMarkers = readSpeechExitMarkers().sort();
  const expectedSpeechMarkers = ["0", "0", "2", "3", "4"];
  if (
    speechUploadRequests !== 5 ||
    JSON.stringify(speechMarkers) !== JSON.stringify(expectedSpeechMarkers) ||
    JSON.stringify(speechExitMarkers) !== JSON.stringify(expectedSpeechMarkers)
  ) {
    throw new Error(
      `Production speech observed ${speechUploadRequests} uploads and ${speechMarkers.length} fixture processes.`,
    );
  }
  if (
    JSON.stringify(endpointRequests) !==
      JSON.stringify({ session: 1, inventory: 2, command: 1, logout: 1, unexpected: 0 }) ||
    JSON.stringify(endpointResponses) !== JSON.stringify(endpointRequests)
  ) {
    throw new Error("The synthetic listener observed an unexpected request lifecycle.");
  }
  enterDiagnosticStage("built-policy");
  const appInfo = JSON.parse(
    await execute(
      "plutil",
      [
        "-convert",
        "json",
        "-o",
        "-",
        join(owned, "DerivedData/Build/Products/Debug-iphonesimulator/Ellie.app/Info.plist"),
      ],
      { capture: true },
    ),
  );
  const policy = appInfo.NSAppTransportSecurity;
  if (
    JSON.stringify(policy) !== JSON.stringify({ NSAllowsLocalNetworking: true }) ||
    "EllieATSTestOrigin" in appInfo ||
    "EllieATSTestPin" in appInfo
  ) {
    throw new Error(
      "Built app transport policy or test isolation differs from the expected configuration.",
    );
  }
  succeeded = true;
  enterDiagnosticStage("complete");
  console.log(`ATS synthetic diagnostics: ${diagnosticSummary()}`);
  console.log(
    "iOS app-hosted pinned HTTPS, native speech, cancellation, rejection, Keychain and built-policy checks passed.",
  );
} catch (error) {
  runFailure = error;
  console.error(error instanceof Error ? error.message : "ATS synthetic validation failed.");
} finally {
  if (!succeeded) console.error(`ATS synthetic diagnostics: ${diagnosticSummary()}`);
  if (server) {
    server.shutdown();
  }
  const teardownSettled = await settleFixtureTeardown(async () => {
    await nativeSpeech?.close();
    await nativeAuth?.close();
    await browserAuth?.close();
  });
  if (simulatorID) {
    for (const action of ["shutdown", "delete"]) {
      try {
        await execute("xcrun", ["simctl", action, simulatorID], { timeout: 15_000, cleanup: true });
        cleanupOutcomes.push(`${action}-complete`);
      } catch {
        cleanupCertain = false;
        cleanupOutcomes.push(`${action}-failed`);
        console.warn(`The owned iOS simulator could not complete ${action}: ${simulatorID}`);
      }
    }
  }
  if (unreapedChildren.size) {
    for (const child of unreapedChildren) signalDirectChild(child, "SIGKILL");
    cleanupCertain = false;
    cleanupOutcomes.push("child-cleanup-uncertain");
  }
  if (cleanupCertain) {
    rmSync(owned, { recursive: true, force: true });
    cleanupOutcomes.push("owned-removed");
    if (succeeded) rmSync(resultBundle, { recursive: true, force: true });
  } else {
    cleanupOutcomes.push("owned-retained");
    console.warn(`Owned ATS evidence was retained: ${owned}`);
  }
  if (!succeeded || !cleanupCertain)
    console.error(`ATS cleanup diagnostics: ${diagnosticSummary()}`);
  if (!teardownSettled) process.exit(1);
}

if (!cleanupCertain) process.exitCode = 1;
else if (requestedSignal)
  process.exitCode =
    128 + (requestedSignal === "SIGINT" ? 2 : requestedSignal === "SIGTERM" ? 15 : 1);
else if (runFailure) process.exitCode = 1;
