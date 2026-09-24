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
import { createIOSGoogleLifeFixture } from "./ios-google-life-fixture.mjs";
import { createIOSHouseholdChoresFixture } from "./ios-household-chores-fixture.mjs";
import { fixtureNodeLauncher } from "./ios-fixture-node-launcher.mjs";
import { verifiedATSResult } from "./ios-ats-result-summary.mjs";
import { parseAppleVersion, selectCompatibleIOSRuntime } from "./ios-runtime-selection.mjs";
import { SpeechStartDiagnostics } from "./speech-start-diagnostics.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = {
  ...process.env,
  DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
};
const owned = mkdtempSync(join(tmpdir(), "ellie-ios-ats-"));
const resultBundle = resolve(root, "test-results/native-ios-ats.xcresult");
const resultSummary = resolve(root, "test-results/native-ios-ats-summary.json");
const unreapedChildren = new Set();
let simulatorID,
  server,
  browserAuth,
  nativeAuth,
  nativeSpeech,
  googleLife,
  chores,
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
const speechDiagnostics = new SpeechStartDiagnostics();
let readSpeechMarkers = () => [],
  readSpeechExitMarkers = () => [];
let speechMarkerEvidenceAvailable = false;
const platform = { xcode: "unknown", sdk: "unknown", runtime: "unknown", device: "unknown" };
const endpointRequests = {
  session: 0,
  inventory: 0,
  command: 0,
  logout: 0,
  unexpected: 0,
};
const endpointResponses = { ...endpointRequests };
const googleRequests = {
  session: 0,
  list: 0,
  agenda: 0,
  preview: 0,
  detail: 0,
  chatState: 0,
  chatSend: 0,
  chatStatus: 0,
  other: 0,
};
const googleResponses = { ...googleRequests };
let baselineChatEvidence;
let heldResponsesClosed = 0;
const googleTokens = {
  allowed: "12".repeat(32),
  denied: "34".repeat(32),
  revocable: "78".repeat(32),
};
const quietControlRoute =
  /^\/__ellie-test\/quiet\/(stats|arm-detail|detail-started\/[0-9]+|release-detail|detail-settled\/[0-9]+|arm-chat-response|chat-response-held\/[0-9]+|release-chat-response|chat-response-released\/[0-9]+)$/;
const quietTokens = {
  allowed: "9a".repeat(32),
  denied: "9b".repeat(32),
  revocable: "9c".repeat(32),
};
let quietControls = 0;

function enterDiagnosticStage(stage) {
  diagnosticStage = stage;
  diagnosticStageStartedAt = performance.now();
}

function endpointStage(request) {
  const path = request.url?.split("?", 1)[0];
  if (
    path?.startsWith("/native/v1/speech/") ||
    path?.startsWith("/__ellie-test/speech/") ||
    path?.startsWith("/__ellie-test/google/") ||
    path?.startsWith("/__ellie-test/chores/") ||
    path?.startsWith("/native/v1/household/") ||
    quietControlRoute.test(request.url ?? "") ||
    /^\/api\/life\/native\/sessions(?:$|\/[^/]+$)/.test(path ?? "")
  ) {
    return undefined;
  }
  if (request.method === "GET" && path === "/native/v1/session") return "session";
  if (request.method === "GET" && path === "/native/v1/nodes") return "inventory";
  if (request.method === "POST" && path === "/native/v1/commands") return "command";
  if (request.method === "POST" && path === "/native/v1/logout") return "logout";
  return "unexpected";
}

function recordEndpointRequest(request, response) {
  const path = request.url?.split("?", 1)[0];
  let google;
  if (request.method === "POST" && path === "/native/v1/life/session") google = "session";
  else if (request.method === "GET" && path === "/api/connections") google = "list";
  else if (request.method === "GET" && /^\/api\/connections\/[^/]+\/agenda$/.test(path ?? ""))
    google = "agenda";
  else if (request.method === "GET" && /^\/api\/connections\/[^/]+\/preview$/.test(path ?? ""))
    google = "preview";
  else if (
    request.method === "GET" &&
    /^\/api\/connections\/[^/]+\/messages\/[^/]+$/.test(path ?? "")
  )
    google = "detail";
  else if (request.method === "GET" && path === "/api/life/native/chat/state") google = "chatState";
  else if (request.method === "POST" && path === "/api/life/native/chat") google = "chatSend";
  else if (
    request.method === "GET" &&
    /^\/api\/life\/native\/chat\/requests\/native_[0-9a-f-]+$/.test(path ?? "")
  )
    google = "chatStatus";
  else if (path?.startsWith("/api/connections/") || path?.startsWith("/native/v1/life/"))
    google = "other";
  if (google) {
    googleRequests[google] += 1;
    response.once("finish", () => {
      googleResponses[google] += 1;
    });
    if (google === "detail" && path?.endsWith("/messages/held_message"))
      response.once("close", () => {
        heldResponsesClosed += 1;
      });
    return;
  }
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
  const lifeCounts = (value) =>
    [
      "session",
      "list",
      "agenda",
      "preview",
      "detail",
      "chatState",
      "chatSend",
      "chatStatus",
      "other",
    ]
      .map((key) => `${key}:${Math.min(value[key], 99)}`)
      .join(",");
  let speech = "unavailable";
  try {
    speech = speechMarkerEvidenceAvailable
      ? speechDiagnostics.summary(readSpeechMarkers(), readSpeechExitMarkers())
      : speechDiagnostics.summary();
  } catch {
    // Keep the original failure and avoid exposing owned marker paths or contents.
  }
  return [
    `stage=${diagnosticStage}`,
    `stageMs=${bounded(Math.round(performance.now() - diagnosticStageStartedAt))}`,
    `totalMs=${bounded(Math.round(performance.now() - diagnosticStartedAt))}`,
    `requests=${counts(endpointRequests)}`,
    `responses=${counts(endpointResponses)}`,
    `lifeRequests=${lifeCounts(googleRequests)}`,
    `lifeResponses=${lifeCounts(googleResponses)}`,
    `speech=${speech}`,
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
  try {
    lstatSync(resultSummary);
    throw new Error("A previous ATS summary is retained; move or remove it before another run.");
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
  const fakeWhisperLauncher = join(owned, "fake-whisper");
  const fakeModel = join(owned, "fake-model.bin");
  const invocationLog = join(owned, "speech-invocations");
  const processExitLog = join(owned, "speech-process-exits");
  writeFileSync(fakeModel, "synthetic model fixture", { mode: 0o600 });
  writeFileSync(
    fakeWhisper,
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
    { mode: 0o600 },
  );
  writeFileSync(fakeWhisperLauncher, fixtureNodeLauncher(process.execPath, fakeWhisper), {
    mode: 0o700,
  });
  chmodSync(fakeWhisperLauncher, 0o700);
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
    "invite-primary",
    "native-ats",
    "invite-speech-denied",
    "speech-denied",
    "invite-speech-granted",
    "speech-granted",
    "invite-speech-revoked",
    "speech-revoked",
    "invite-session-revoked",
    "session-revoked",
    "invite-speech-cancel",
    "speech-cancel",
    "invite-speech-disconnect",
    "speech-disconnect",
    "invite-google-allowed",
    "google-allowed",
    "invite-google-denied",
    "google-denied",
    "invite-google-revocable",
    "google-revocable",
    "invite-quiet-allowed",
    "quiet-allowed",
    "invite-quiet-denied",
    "quiet-denied",
    "invite-quiet-revocable",
    "quiet-revocable",
    "invite-chores-a",
    "chores-client-a",
    "invite-chores-b",
    "chores-client-b",
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
        executable: fakeWhisperLauncher,
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
  const googleClients = {};
  for (const role of ["allowed", "denied", "revocable"]) {
    const next = await nativeAuth.invite({
      label: `Google ${role}`,
      grants: [{ target: "google-fixture-no-node", capabilities: ["app.open"] }],
    });
    googleClients[role] = await nativeAuth.pair(next.code, googleTokens[role]);
    if (googleClients[role].id !== `google-${role}`)
      throw new Error("Google fixture client identity is invalid.");
  }
  const googleDirectory = join(owned, "google-life");
  mkdirSync(googleDirectory, { mode: 0o700 });
  const quietClients = {};
  for (const role of ["allowed", "denied", "revocable"]) {
    const invitation = await nativeAuth.invite({
      label: `Quiet ${role}`,
      grants: [{ target: "quiet-fixture-no-node", capabilities: ["app.open"] }],
    });
    quietClients[role] = await nativeAuth.pair(invitation.code, quietTokens[role]);
    if (quietClients[role].id !== `quiet-${role}`)
      throw new Error("Quiet fixture client identity is invalid.");
  }
  googleLife = await createIOSGoogleLifeFixture({
    directory: googleDirectory,
    nativeAuth,
    grantedClientIds: [
      googleClients.allowed.id,
      googleClients.revocable.id,
      quietClients.allowed.id,
      quietClients.revocable.id,
    ],
    quiet: true,
  });
  if (!googleLife.quiet) throw new Error("Synthetic Quiet fixture is unavailable.");
  baselineChatEvidence = googleLife.control.chatEvidence();
  const choresTokens = { a: "ab".repeat(32), b: "bc".repeat(32) };
  const choresClients = {};
  for (const role of ["a", "b"]) {
    const invitation = await nativeAuth.invite({
      label: `Synthetic chores ${role}`,
      grants: [{ target: "chores-fixture-no-node", capabilities: ["app.open"] }],
    });
    choresClients[role] = await nativeAuth.pair(invitation.code, choresTokens[role]);
    if (choresClients[role].id !== `chores-client-${role}`)
      throw new Error("Chores fixture client identity is invalid.");
  }
  chores = await createIOSHouseholdChoresFixture({
    directory: join(owned, "chores-household"),
    nativeAuth,
    clients: choresClients,
    tokens: choresTokens,
  });
  const disconnectBearer = `Bearer ${"de".repeat(32)}`;
  const cancelBearer = `Bearer ${"cd".repeat(32)}`;
  readSpeechMarkers = () => {
    try {
      return readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  };
  readSpeechExitMarkers = () => {
    try {
      return readFileSync(processExitLog, "utf8").trim().split("\n").filter(Boolean);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  };
  speechMarkerEvidenceAvailable = true;
  const fixtureTranscribe = nativeSpeech.transcribe.bind(nativeSpeech);
  nativeSpeech.transcribe = async (bearer, turnId, audio, disconnected) => {
    speechDiagnostics.delivered(turnId, bearer);
    try {
      return await fixtureTranscribe(bearer, turnId, audio, disconnected);
    } finally {
      speechDiagnostics.settled(turnId);
    }
  };
  const hosted = createBrowserServer({
    cert: readFileSync(cert),
    key: readFileSync(key),
    origin,
    auth: browserAuth,
    nativeAuth,
    household: chores.household,
    speech: nativeSpeech,
    nativeLife: googleLife.nativeLife,
    lifeApplication: googleLife.lifeApplication,
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
    if (chores.handleControl(request, response)) return;
    chores.wrapProduction(request, response);
    const quietAction = quietControlRoute.exec(request.url ?? "");
    if (quietAction) {
      void (async () => {
        const valid =
          request.method === "GET" &&
          request.headers.authorization === `Bearer ${quietTokens.allowed}` &&
          request.headers["x-ellie-version"] === "1";
        let ok = valid;
        if (ok) {
          quietControls++;
          const action = quietAction[1];
          const control = googleLife.quiet.control;
          if (action === "arm-detail") control.armDetail();
          else if (action === "release-detail") control.releaseDetail();
          else if (action === "arm-chat-response") control.armChatResponse();
          else if (action === "release-chat-response") control.releaseChatResponse();
          else if (action !== "stats") {
            const [counter, targetText] = action.split("/");
            const target = Number(targetText);
            const read =
              counter === "detail-started"
                ? control.detailStarted
                : counter === "detail-settled"
                  ? control.detailSettled
                  : counter === "chat-response-held"
                    ? control.chatResponseHeld
                    : control.chatResponseReleased;
            const deadline = Date.now() + 5_000;
            while (read() < target && Date.now() < deadline)
              await new Promise((resolveWait) => setTimeout(resolveWait, 20));
            ok = read() >= target;
          }
        }
        const control = googleLife.quiet.control;
        response.writeHead(ok ? 200 : 409, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(
          JSON.stringify({
            ok,
            detailStarted: control.detailStarted(),
            detailSettled: control.detailSettled(),
            chatResponseHeld: control.chatResponseHeld(),
            chatResponseReleased: control.chatResponseReleased(),
            nativeChatPosts: control.nativeChatPosts(),
            durableTurns: control.durableTurns(),
          }),
        );
      })().catch(() => response.destroy());
      return;
    }
    const googleControl =
      /^\/__ellie-test\/google\/(held-started\/[123]|settled\/[123]|release|calendar-change-after-list|calendar-changed\/1)$/.exec(
        request.url ?? "",
      );
    if (googleControl) {
      void (async () => {
        const expected = `Bearer ${googleTokens.allowed}`;
        if (
          request.method !== "GET" ||
          request.headers.authorization !== expected ||
          request.headers["x-ellie-version"] !== "1"
        ) {
          response.writeHead(403, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end('{"ok":false}');
          return;
        }
        if (googleControl[1] === "release") googleLife.control.releaseHeld();
        else if (googleControl[1] === "calendar-change-after-list")
          googleLife.control.armCalendarChangeAfterNextList();
        else {
          const target = Number(googleControl[1].at(-1));
          const deadline = Date.now() + 5_000;
          const ready = () =>
            googleControl[1] === "calendar-changed/1"
              ? googleLife.control.calendarChanges() >= target
              : googleControl[1].startsWith("held-started/")
                ? googleLife.control.heldReadStarted() >= target
                : googleLife.control.heldReadCompleted() >= target &&
                  googleLife.control.heldHandled() >= target &&
                  heldResponsesClosed >= target;
          while (Date.now() < deadline && !ready())
            await new Promise((resolveWait) => setTimeout(resolveWait, 20));
          if (!ready()) {
            response.writeHead(503, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
            response.end('{"ok":false}');
            return;
          }
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end('{"ok":true}');
      })().catch(() => response.destroy());
      return;
    }
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
          const processMarkers = readSpeechMarkers();
          const exitMarkers = readSpeechExitMarkers();
          const observation = speechDiagnostics.observe(
            bearer,
            phase,
            marker,
            processMarkers,
            exitMarkers,
          );
          if (observation.ready) {
            response.writeHead(200, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
            response.end('{"ok":true}');
            return;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
        const observation = speechDiagnostics.observe(
          bearer,
          phase,
          marker,
          readSpeechMarkers(),
          readSpeechExitMarkers(),
        );
        speechDiagnostics.timeout(observation);
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
      speechDiagnostics.noteUpload(request.headers.authorization ?? "");
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
  enterDiagnosticStage("xcresult-summary");
  const atsResult = verifiedATSResult(
    JSON.parse(
      await execute(
        "xcrun",
        [
          "xcresulttool",
          "get",
          "test-results",
          "summary",
          "--path",
          resultBundle,
          "--format",
          "json",
        ],
        { capture: true, timeout: 30_000 },
      ),
    ),
    JSON.parse(
      await execute(
        "xcrun",
        [
          "xcresulttool",
          "get",
          "test-results",
          "tests",
          "--path",
          resultBundle,
          "--format",
          "json",
        ],
        { capture: true, timeout: 30_000 },
      ),
    ),
  );
  writeFileSync(
    resultSummary,
    `${JSON.stringify(
      {
        ...atsResult,
        toolchain: { xcode: platform.xcode, sdk: platform.sdk, runtime: platform.runtime },
        sourceSha256: {
          runner: createHash("sha256")
            .update(readFileSync(fileURLToPath(import.meta.url)))
            .digest("hex"),
          googleTests: createHash("sha256")
            .update(
              readFileSync(resolve(root, "apps/ios/Tests/NativeGoogleHTTPSIntegrationTests.swift")),
            )
            .digest("hex"),
          choresTests: createHash("sha256")
            .update(
              readFileSync(
                resolve(root, "apps/ios/Tests/HouseholdChoresHTTPSIntegrationTests.swift"),
              ),
            )
            .digest("hex"),
          quietTests: createHash("sha256")
            .update(
              readFileSync(resolve(root, "apps/ios/Tests/QuietLifeHTTPSIntegrationTests.swift")),
            )
            .digest("hex"),
        },
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    `ATS xcresult: ${atsResult.counts.passed}/${atsResult.counts.total} passed, ${atsResult.counts.failed} failed, ${atsResult.counts.skipped} skipped; Google HTTPS ${atsResult.googleCases.length}/${atsResult.googleCases.length} passed.`,
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
      JSON.stringify({ session: 1, inventory: 2, command: 1, logout: 3, unexpected: 0 }) ||
    JSON.stringify(endpointResponses) !== JSON.stringify(endpointRequests)
  ) {
    throw new Error("The synthetic listener observed an unexpected request lifecycle.");
  }
  if (
    googleRequests.other !== 0 ||
    googleRequests.session < 4 ||
    googleRequests.list < 3 ||
    googleRequests.agenda < 1 ||
    googleRequests.preview < 1 ||
    googleRequests.detail < 6 ||
    googleRequests.chatState < 1 ||
    googleRequests.chatSend !== 2 ||
    googleRequests.chatStatus !== 2 ||
    googleLife.control.chatEvidence().plans !== 2 ||
    googleLife.control.chatEvidence().conversations !== baselineChatEvidence.conversations + 2 ||
    googleLife.control.chatEvidence().records !== baselineChatEvidence.records ||
    googleLife.control.chatEvidence().tasks !== baselineChatEvidence.tasks ||
    googleLife.control.bodyReads().unicode_message !== 1 ||
    googleLife.control.bodyReads().truncated_message !== 1 ||
    googleLife.control.bodyReads().unavailable_message !== 1
  ) {
    throw new Error("The Google fixture did not traverse the expected finite Life routes.");
  }
  if (
    quietControls !== 20 ||
    googleLife.quiet.control.nativeChatPosts() !== 2 ||
    googleLife.quiet.control.detailStarted() !== 3 ||
    googleLife.quiet.control.detailSettled() !== 3 ||
    googleLife.quiet.control.chatResponseHeld() !== 1 ||
    googleLife.quiet.control.chatResponseReleased() !== 1
  ) {
    throw new Error("The pinned Quiet fixture did not traverse the expected finite lifecycle.");
  }
  console.log(
    `ATS Quiet HTTPS: ${quietControls} controls, ${googleLife.quiet.control.detailStarted()} held details, ` +
      `${googleLife.quiet.control.nativeChatPosts()} combined Google and Quiet chat POSTs.`,
  );
  if (
    chores.counts.writes !== 3 ||
    chores.counts.dropped !== 1 ||
    chores.counts.held !== 1 ||
    chores.counts.releaseAttempts !== 1 ||
    chores.counts.reads !== 5 ||
    chores.counts.controls !== 5
  ) {
    throw new Error(
      "The pinned chores fixture did not traverse the expected finite write/read lifecycle.",
    );
  }
  console.log(
    `ATS household HTTPS: ${chores.counts.reads} reads, ${chores.counts.writes} conditional PUTs, ` +
      `${chores.counts.dropped} dropped response, ${chores.counts.held} held response, ` +
      `${chores.counts.releaseAttempts} canceled-response release attempt.`,
  );
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
  if (error?.fixtureCleanupUncertain) cleanupCertain = false;
  runFailure = error;
  console.error(error instanceof Error ? error.message : "ATS synthetic validation failed.");
} finally {
  if (!succeeded) console.error(`ATS synthetic diagnostics: ${diagnosticSummary()}`);
  if (server) {
    server.shutdown();
  }
  const teardownSettled = await settleFixtureTeardown(async () => {
    googleLife?.control.releaseHeld();
    googleLife?.quiet?.releaseAll();
    await googleLife?.close();
    await nativeSpeech?.close();
    await nativeAuth?.close();
    await chores?.close();
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
    if (speechMarkerEvidenceAvailable) diagnosticSummary();
    rmSync(owned, { recursive: true, force: true });
    speechMarkerEvidenceAvailable = false;
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
