#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserAuth } from "../apps/server/src/browser-auth.ts";
import { createBrowserServer } from "../apps/server/src/browser-server.ts";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import { NativeSpeech } from "../apps/server/src/native-speech.ts";
import { WhisperCliSpeechInput } from "../packages/speech/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = {
  ...process.env,
  DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
};
const owned = mkdtempSync(join(tmpdir(), "ellie-ios-ats-"));
const resultBundle = resolve(root, "test-results/native-ios-ats.xcresult");
const processGroups = new Set();
let simulatorID,
  server,
  browserAuth,
  nativeAuth,
  nativeSpeech,
  activeChild,
  interruptChild,
  requestedSignal,
  succeeded = false;
let remoteNodeReads = 0,
  remoteAppOpens = 0,
  speechUploadRequests = 0;

function terminate(child, signal) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function terminateGroup(processGroup, signal) {
  try {
    process.kill(-processGroup, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function stopOwnedProcessGroups() {
  await Promise.all([...processGroups].map(stopProcessGroup));
}

async function stopProcessGroup(processGroup) {
  if (!Number.isInteger(processGroup) || processGroup <= 0) return;
  terminateGroup(processGroup, "SIGKILL");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroup, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        processGroups.delete(processGroup);
        return;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("An owned iOS test process group did not stop.");
}

function execute(file, args, { capture = false, timeout = 30_000, cleanup = false } = {}) {
  if (requestedSignal && !cleanup)
    return Promise.reject(new Error("iOS transport test interrupted."));
  return new Promise((resolvePromise, reject) => {
    let stdout = "",
      failure,
      killTimer;
    const child = spawn(file, args, {
      cwd: root,
      env: environment,
      detached: true,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    if (Number.isInteger(child.pid) && child.pid > 0) processGroups.add(child.pid);
    activeChild = child;
    function stop(message) {
      failure ??= new Error(message);
      terminate(child, "SIGTERM");
      killTimer ??= setTimeout(() => terminate(child, "SIGKILL"), 5_000);
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
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      try {
        await stopProcessGroup(child.pid);
      } catch (error) {
        failure ??= error;
      }
      if (activeChild === child) {
        activeChild = undefined;
        interruptChild = undefined;
      }
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${file} exited with ${signal ?? code}.`));
      else resolvePromise(stdout.trim());
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    requestedSignal = signal;
    interruptChild?.();
  });
}

try {
  rmSync(resultBundle, { recursive: true, force: true });
  mkdirSync(dirname(resultBundle), { recursive: true });
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
  const pin = createHash("sha256").update(readFileSync(der)).digest("hex");
  const token = "c".repeat(64);
  const fakeWhisper = join(owned, "fake-whisper.mjs");
  const fakeModel = join(owned, "fake-model.bin");
  const invocationLog = join(owned, "speech-invocations");
  writeFileSync(fakeModel, "synthetic model fixture", { mode: 0o600 });
  writeFileSync(
    fakeWhisper,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const value = (name) => process.argv[process.argv.indexOf(name) + 1];
const audio = readFileSync(value("-f"));
appendFileSync(${JSON.stringify(invocationLog)}, "invoked\\n");
if (audio[44] === 1) {
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1000);
} else if (audio[44] === 2) {
  setTimeout(() => writeFileSync(value("-of") + ".txt", "Open Safari\\n"), 11_000);
} else {
  writeFileSync(value("-of") + ".txt", "Open Safari\\n");
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
  ]) {
    const next = await nativeAuth.invite({
      label,
      grants: [{ target: "speech-fixture-no-node", capabilities: ["app.open"] }],
    });
    speechClients.push(await nativeAuth.pair(next.code, candidate.repeat(64)));
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
  await nativeSpeech.revoke(speechClients[2].id);
  await nativeAuth.revoke(speechClients[3].id);
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
  hosted.server.prependListener("request", (request, response) => {
    if (request.method === "POST" && request.url === "/native/v1/speech/transcriptions") {
      speechUploadRequests += 1;
    }
    if (request.headers["x-ellie-turn-id"] !== "77777777-7777-4777-8777-777777777777") return;
    response.end = function () {
      response.socket?.destroy();
      return response;
    };
  });
  await new Promise((resolveListen, reject) => {
    hosted.server.once("error", reject);
    hosted.server.listen(address.port, "127.0.0.1", resolveListen);
  });

  const runtimes = JSON.parse(
    await execute("xcrun", ["simctl", "list", "runtimes", "--json"], {
      capture: true,
      timeout: 15_000,
    }),
  )
    .runtimes.filter(
      (item) =>
        item.isAvailable &&
        item.identifier?.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") &&
        Number(item.version?.split(".")[0]) >= 17,
    )
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  if (!runtimes.length)
    throw new Error("No available iOS 17 or newer Simulator runtime was found.");
  const compatible =
    runtimes[0].supportedDeviceTypes?.filter((item) => item.productFamily === "iPhone") ?? [];
  const device = compatible.find((item) => item.name === "iPhone 16") ?? compatible[0];
  if (!device) throw new Error("The selected iOS runtime has no supported iPhone.");
  simulatorID = await execute(
    "xcrun",
    [
      "simctl",
      "create",
      `Ellie iOS ATS Tests ${randomUUID().slice(0, 8)}`,
      device.identifier,
      runtimes[0].identifier,
    ],
    { capture: true },
  );
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(simulatorID)) {
    simulatorID = undefined;
    throw new Error("Simulator creation returned an invalid identifier.");
  }
  await execute("xcrun", ["simctl", "boot", simulatorID]);
  await execute("xcrun", ["simctl", "bootstatus", simulatorID, "-b"], { timeout: 180_000 });
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
  const invocationDeadline = Date.now() + 3_000;
  let speechInvocations = 0;
  do {
    try {
      speechInvocations = readFileSync(invocationLog, "utf8").trim().split("\n").length;
    } catch {
      speechInvocations = 0;
    }
    if (speechInvocations >= 4 || Date.now() >= invocationDeadline) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  } while (true);
  if (speechUploadRequests !== 5 || speechInvocations < 4 || speechInvocations > 5) {
    throw new Error(
      `Production speech observed ${speechUploadRequests} uploads and ${speechInvocations} fixture processes.`,
    );
  }
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
  console.log(
    "iOS app-hosted pinned HTTPS, native speech, cancellation, rejection, Keychain and built-policy checks passed.",
  );
} finally {
  if (server) {
    server.shutdown();
  }
  await nativeSpeech?.close();
  await nativeAuth?.close();
  await browserAuth?.close();
  if (simulatorID) {
    for (const action of ["shutdown", "delete"]) {
      try {
        await execute("xcrun", ["simctl", action, simulatorID], { timeout: 15_000, cleanup: true });
      } catch {
        console.warn(`The owned iOS simulator could not complete ${action}: ${simulatorID}`);
      }
    }
  }
  await stopOwnedProcessGroups();
  rmSync(owned, { recursive: true, force: true });
  if (succeeded) rmSync(resultBundle, { recursive: true, force: true });
}

if (requestedSignal)
  process.exitCode =
    128 + (requestedSignal === "SIGINT" ? 2 : requestedSignal === "SIGTERM" ? 15 : 1);
