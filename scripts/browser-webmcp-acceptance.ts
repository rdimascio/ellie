import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { createServer } from "node:https";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateBrowserTlsIdentity } from "../apps/cli/src/certificate.ts";
import { defaults } from "@ellie/config";
import { record } from "@ellie/protocol";
import { BrowserNodeExecutor } from "../apps/node/src/browser-executor.ts";
import { BrowserOperationSelector } from "../apps/node/src/browser-operation-selector.ts";
import { BrowserAccessibilityRuntime } from "../apps/node/src/browser-accessibility-runtime.ts";
import { runNode } from "../apps/node/src/index.ts";
import { BrowserAuth } from "../apps/server/src/browser-auth.ts";
import { createBrowserRemote } from "../apps/server/src/browser-remote.ts";
import { createBrowserServer } from "../apps/server/src/browser-server.ts";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import { fixture as coordinatorFixture } from "../tests/helpers.ts";
import { BrowserWebMCPOperations } from "../apps/node/src/browser-operations.ts";
import {
  canonicalReviewedBrowserRegistry,
  loadReviewedBrowserRegistry,
  reviewedBrowserRegistry,
} from "../apps/node/src/browser-operation-registry.ts";
import {
  BROWSER_WEBMCP_NATIVE_HOST,
  ELLIE_BROWSER_EXTENSION_ID,
  browserWebMCPHostInstallationPlan,
} from "../apps/node/src/browser-native-host.ts";
import { startBrowserWebMCPBridge } from "../apps/node/src/browser-webmcp-bridge.ts";
import { ComposedIOSCleanupError, runIOSBrowserComposed } from "./ios-browser-composed-runner.ts";

const runnerPath = fileURLToPath(import.meta.url);
export class NativeJourneySetupCleanupError extends Error {
  override name = "NativeJourneySetupCleanupError";
}

export class AcceptanceEnvironmentSetupCleanupError extends Error {
  override name = "AcceptanceEnvironmentSetupCleanupError";

  constructor(
    message: string,
    options: ErrorOptions & { cleanupFailures: readonly string[]; retainedRoot: string },
  ) {
    super(message, options);
    this.cleanupFailures = options.cleanupFailures;
    this.retainedRoot = options.retainedRoot;
  }

  readonly cleanupFailures: readonly string[];
  readonly retainedRoot: string;
}

/** Preserve both the setup failure and uncertain ownership when setup cleanup fails. */
export async function settleFailedNativeJourneySetup(
  error: unknown,
  close: () => Promise<void>,
): Promise<never> {
  try {
    await close();
  } catch {
    throw new NativeJourneySetupCleanupError("Owned native journey setup cleanup is uncertain.", {
      cause: error,
    });
  }
  throw error;
}

export function settleAcceptanceOutcome(failure: unknown, cleanupError: string | undefined): void {
  if (failure) throw failure;
  if (cleanupError) throw new Error(cleanupError);
}

export async function settleFailedAcceptanceEnvironmentSetup(
  error: unknown,
  options: {
    ownedRoot: string;
    closeBridge: () => Promise<void>;
    closeServer: () => Promise<void>;
    removeOwnedRoot: () => Promise<void>;
    cleanupDeadlineMs?: number;
  },
): Promise<never> {
  const deadline = options.cleanupDeadlineMs ?? 5_000;
  const bounded = (work: () => Promise<void>, message: string) =>
    within(Promise.resolve().then(work), deadline, message);
  const attempts = await Promise.allSettled([
    bounded(options.closeBridge, "bridge cleanup timed out"),
    bounded(options.closeServer, "server cleanup timed out"),
  ]);
  const cleanupFailures = attempts.flatMap((result, index) =>
    result.status === "rejected"
      ? [`${index === 0 ? "bridge" : "server"}: ${String(result.reason)}`]
      : [],
  );
  if (cleanupFailures.length > 0) {
    throw new AcceptanceEnvironmentSetupCleanupError(
      "Owned acceptance environment setup cleanup is uncertain.",
      { cause: error, cleanupFailures, retainedRoot: options.ownedRoot },
    );
  }
  try {
    await options.removeOwnedRoot();
  } catch (cleanup) {
    throw new AcceptanceEnvironmentSetupCleanupError(
      "Owned acceptance environment setup cleanup is uncertain.",
      {
        cause: error,
        cleanupFailures: [`owned-root: ${String(cleanup)}`],
        retainedRoot: options.ownedRoot,
      },
    );
  }
  throw error;
}

export function acceptanceEnvironmentSetupFailureReport(error: unknown): Record<string, unknown> {
  const uncertain = error instanceof AcceptanceEnvironmentSetupCleanupError;
  const firstFailure = uncertain ? error.cause : error;
  return {
    version: 1,
    status: "fail",
    phase: "acceptance-environment-setup",
    error: String(firstFailure instanceof Error ? firstFailure.message : firstFailure).slice(
      0,
      4_096,
    ),
    cleanup: {
      certain: !uncertain,
      ...(uncertain
        ? {
            retainedRoot: error.retainedRoot,
            failures: error.cleanupFailures.map((value) => value.slice(0, 1_024)),
          }
        : {}),
    },
    replayAttempted: false,
    accessibilityFallbackAttempted: false,
  };
}
const sourceExtension = resolve("apps/browser-media-extension");
const agentBrowserPath = resolve("node_modules/.bin/agent-browser");
const hostname = "ellie-browser-acceptance.local";
const readSchema = Object.freeze({ type: "object", additionalProperties: false });
const scrollSchema = Object.freeze({
  type: "object",
  properties: { direction: { type: "string", enum: ["up", "down"] } },
  required: ["direction"],
  additionalProperties: false,
});
const searchSchema = Object.freeze({
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
});
const selectSchema = Object.freeze({
  type: "object",
  properties: { itemId: { type: "string" } },
  required: ["itemId"],
  additionalProperties: false,
});
const playbackSchema = Object.freeze({
  type: "object",
  properties: { action: { type: "string", enum: ["play", "pause"] } },
  required: ["action"],
  additionalProperties: false,
});
const annotations = Object.freeze({
  readOnlyHint: false,
  untrustedContentHint: false,
  consequentialHint: false,
});
const readAnnotations = Object.freeze({ ...annotations, readOnlyHint: true });
const completedValue = Object.freeze({ applied: true });
const maximumCommandOutput = 1024 * 1024;
const commandTimeoutMs = 30_000;

type CommandRecord = { args: string[]; durationMs: number; ok: boolean };
type JsonCommand<T> = { success: boolean; data: T; error: unknown };

const canonical = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  assert.ok(value && typeof value === "object");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const successValueSha256 = sha256(canonical(completedValue));

function requiredAbsolutePath(name: string): string {
  const value = process.env[name];
  if (!value || !value.startsWith("/") || resolve(value) !== value || value.includes("\0"))
    throw new Error(`${name} must be an explicit canonical absolute path.`);
  return value;
}

async function replaceExactly(path: string, needle: string, replacement: string): Promise<void> {
  const before = await readFile(path, "utf8");
  if (before.split(needle).length - 1 !== 1)
    throw new Error(`Fixture patch target changed in ${basename(path)}.`);
  await writeFile(path, before.replace(needle, replacement), { mode: 0o600 });
}

async function prepareExtension(root: string, origin: string) {
  const relevantFiles = [
    "background.js",
    "manifest.json",
    "media-controller.js",
    "youtube-tv-controller.js",
    "disneyplus-controller.js",
    "webmcp-controller.js",
  ];
  const productionFiles = await Promise.all(
    relevantFiles.map(async (name) => ({
      name,
      sha256: sha256(await readFile(join(sourceExtension, name))),
    })),
  );
  const extension = join(root, "extension");
  await cp(sourceExtension, extension, { recursive: true });
  const background = join(extension, "background.js");
  const reviewed = JSON.stringify({
    [origin]: [
      {
        name: "ellie_acceptance_read",
        inputSchema: readSchema,
        annotations: readAnnotations,
        argumentEncoding: "json-string",
      },
      {
        name: "ellie_acceptance_scroll",
        inputSchema: scrollSchema,
        annotations,
        argumentEncoding: "json-string",
      },
      ...[
        ["ellie_acceptance_search", searchSchema],
        ["ellie_acceptance_select", selectSchema],
        ["ellie_acceptance_playback", playbackSchema],
      ].map(([name, inputSchema]) => ({
        name,
        inputSchema,
        annotations,
        argumentEncoding: "json-string",
      })),
    ],
  });
  await replaceExactly(
    background,
    `const productionOrigins = new Set([\n  "https://www.netflix.com",\n  "https://www.youtube.com",\n  "https://tv.youtube.com",\n  "https://www.disneyplus.com",\n]);`,
    `const productionOrigins = new Set([${JSON.stringify(origin)}]);`,
  );
  await replaceExactly(
    background,
    "const reviewedWebMCPBindings = Object.freeze({});",
    `const reviewedWebMCPBindings = Object.freeze(${reviewed});`,
  );
  const acceptanceLauncher =
    '<!doctype html><meta charset="utf-8"><title>Acceptance popup launcher</title>\n';
  await writeFile(join(extension, "acceptance-launcher.html"), acceptanceLauncher, {
    mode: 0o600,
  });
  const manifestPath = join(extension, "manifest.json");
  const productionManifest = await readFile(manifestPath);
  const manifest = JSON.parse(productionManifest.toString("utf8"));
  manifest.host_permissions = [`${origin}/*`];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const files = await Promise.all(
    relevantFiles.map(async (name) => ({
      name,
      sha256: sha256(await readFile(join(extension, name))),
    })),
  );
  return {
    extension,
    files,
    productionFiles,
    fixtureDifferences: [
      `background.js productionOrigins contains only ${origin}`,
      "background.js reviewedWebMCPBindings contains only the five acceptance tools",
      "all reviewed acceptance tools require the Chrome 152 JSON-string argument dialect",
      `manifest.json host_permissions contains only ${origin}/*`,
      "acceptance-launcher.html opens the genuine action popup without adding a popup.html tab",
    ],
    acceptanceLauncherSha256: sha256(acceptanceLauncher),
    productionManifestSha256: sha256(productionManifest),
  };
}

function fixtureHtml(composed = false): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Ellie owned WebMCP acceptance</title>
<style>
body{font:18px system-ui;margin:40px;max-width:700px}.viewport{height:180px;overflow:auto;border:2px solid #333;border-radius:12px}.space{height:420px;padding:16px}.result{font-weight:700}
</style>
<h1>Ellie owned WebMCP acceptance</h1>
<p id="registration">Registering real browser tools…</p>
<p id="result" class="result">Scroll offset: 0</p>
<div id="viewport" class="viewport" tabindex="0" aria-label="Acceptance viewport"><div class="space">Owned fixture content</div></div>
<section id="media" aria-label="Owned synthetic media page"><p id="phase">Home</p><p id="query"></p><p id="selection"></p><p id="playback"></p></section>
<script>
const viewport = document.querySelector('#viewport');
const result = document.querySelector('#result');
const update = () => { result.textContent = 'Scroll offset: ' + Math.round(viewport.scrollTop); };
viewport.addEventListener('scroll', update);
let phase = 'home'; let query = ''; let playback = 'paused'; let mutationCount = 0;
let scrollInvocations = 0; document.body.dataset.scrollInvocations = '0';
let scrollAbortObserved = 0; document.body.dataset.scrollAbortObserved = '0';
let scrollEntries = 0; document.body.dataset.scrollEntries = '0';
let scrollCallbacks = 0; document.body.dataset.scrollCallbacks = '0';
document.body.dataset.scrollStage = 'none';
document.body.dataset.scrollHasSignal = 'false';
document.body.dataset.scrollDirectionState = 'none';
const media = () => {
  document.querySelector('#phase').textContent = phase;
  document.querySelector('#query').textContent = query;
  document.querySelector('#selection').textContent = phase === 'watch' ? 'Owned synthetic video' : '';
  document.querySelector('#playback').textContent = phase === 'watch' ? playback : '';
  document.body.dataset.mutations = String(mutationCount);
};
media();
Promise.all([
  document.modelContext.registerTool({
    name: 'ellie_acceptance_read',
    description: 'Read the owned acceptance viewport and its current scroll offset.',
    inputSchema: ${JSON.stringify(readSchema)},
    annotations: ${JSON.stringify(readAnnotations)},
    execute: async () => ({
      title: 'Ellie owned WebMCP acceptance',
      summary: phase + ': ' + query + ': ' + playback,
      items: [
        {id: 'acceptance-viewport', label: 'Owned acceptance viewport', state: String(Math.round(viewport.scrollTop))},
        ...(phase === 'results' ? [{id: 'owned-video-1', label: 'Owned synthetic video'}] : [])
      ]
    })
  }),
  document.modelContext.registerTool({
    name: 'ellie_acceptance_scroll',
    description: 'Scroll the owned acceptance viewport once in the requested direction.',
    inputSchema: ${JSON.stringify(scrollSchema)},
    annotations: ${JSON.stringify(annotations)},
    execute: async ({direction}, context = {}) => {
      if (${composed}) {
        scrollCallbacks++; document.body.dataset.scrollCallbacks = String(scrollCallbacks);
        document.body.dataset.scrollDirectionState =
          direction === 'down' ? 'down' : direction === 'up' ? 'up' :
          direction === undefined ? 'missing' : 'other';
        document.body.dataset.scrollHasSignal = String(context.signal !== undefined);
      }
      if (${composed} && direction === 'down') {
        scrollEntries++; document.body.dataset.scrollEntries = String(scrollEntries);
        document.body.dataset.scrollStage = 'entered';
      }
      context.signal?.throwIfAborted();
      if (${composed} && direction === 'down') {
        scrollInvocations++; document.body.dataset.scrollInvocations = String(scrollInvocations);
        document.body.dataset.scrollStage = 'holding';
        await new Promise((_, reject) => {
          const signal = context.signal;
          const onAbort = () => {
            clearTimeout(deadline);
            scrollAbortObserved++; document.body.dataset.scrollAbortObserved = String(scrollAbortObserved);
            document.body.dataset.scrollStage = 'aborted';
            reject(new Error('scroll_cancelled'));
          };
          const deadline = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            document.body.dataset.scrollStage = 'deadline';
            reject(new Error('scroll_cancel_not_observed'));
          }, 12000);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, {once: true});
        });
      }
      const before = viewport.scrollTop;
      viewport.scrollTop = before + (direction === 'down' ? 120 : -120);
      context.signal?.throwIfAborted();
      const after = viewport.scrollTop;
      if (direction === 'down' ? after <= before : after >= before) throw new Error('scroll_not_observed');
      update();
      if (${composed}) { mutationCount++; media(); document.body.dataset.scrollStage = 'mutated'; }
      return ${JSON.stringify(completedValue)};
    }
  }),
  document.modelContext.registerTool({
    name: 'ellie_acceptance_search',
    description: 'Search the owned synthetic media page once.',
    inputSchema: ${JSON.stringify(searchSchema)},
    annotations: ${JSON.stringify(annotations)},
    execute: async ({query: requested}, context = {}) => {
      context.signal?.throwIfAborted();
      if (phase !== 'home' || requested !== 'owned synthetic video') throw new Error('search_not_reviewed');
      query = requested; phase = 'results'; mutationCount++; media();
      return ${JSON.stringify(completedValue)};
    }
  }),
  document.modelContext.registerTool({
    name: 'ellie_acceptance_select',
    description: 'Select the one observed owned media result.',
    inputSchema: ${JSON.stringify(selectSchema)},
    annotations: ${JSON.stringify(annotations)},
    execute: async ({itemId}, context = {}) => {
      context.signal?.throwIfAborted();
      if (phase !== 'results' || itemId !== 'owned-video-1') throw new Error('selection_not_reviewed');
      phase = 'watch'; mutationCount++; media();
      return ${JSON.stringify(completedValue)};
    }
  }),
  document.modelContext.registerTool({
    name: 'ellie_acceptance_playback',
    description: 'Control the owned synthetic media playback state.',
    inputSchema: ${JSON.stringify(playbackSchema)},
    annotations: ${JSON.stringify(annotations)},
    execute: async ({action}, context = {}) => {
      context.signal?.throwIfAborted();
      if (phase !== 'watch' || (action === 'play' && playback !== 'paused') ||
          (action === 'pause' && playback !== 'playing')) throw new Error('playback_not_reviewed');
      playback = action === 'play' ? 'playing' : 'paused'; mutationCount++; media();
      // The first play deliberately loses its completion proof after one visible mutation.
      return action === 'play' ? {applied: false} : ${JSON.stringify(completedValue)};
    }
  })
]).then(() => {
  document.querySelector('#registration').textContent = 'Real WebMCP tools registered';
  document.body.dataset.webmcpReady = 'true';
}).catch(() => {
  document.querySelector('#registration').textContent = 'WebMCP registration failed';
  document.body.dataset.webmcpFailed = 'true';
});
</script>`;
}

async function prepareRegistry(home: string, origin: string, composed = false) {
  const state = join(home, ".ellie");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  const registry = reviewedBrowserRegistry({
    version: 1,
    bindings: [
      {
        id: "viewport",
        origin,
        operation: "read",
        toolName: "ellie_acceptance_read",
        inputSchemaSha256: sha256(canonical(readSchema)),
      },
      {
        id: "catalog",
        origin,
        operation: "read",
        toolName: "ellie_acceptance_read",
        inputSchemaSha256: sha256(canonical(readSchema)),
      },
      {
        id: "player",
        origin,
        operation: "read",
        toolName: "ellie_acceptance_read",
        inputSchemaSha256: sha256(canonical(readSchema)),
      },
      ...(composed
        ? [
            {
              id: "summary",
              origin,
              operation: "read" as const,
              toolName: "ellie_acceptance_read",
              inputSchemaSha256: sha256(canonical(readSchema)),
            },
          ]
        : []),
      {
        id: "scroll",
        origin,
        operation: "scroll",
        toolName: "ellie_acceptance_scroll",
        inputSchemaSha256: sha256(canonical(scrollSchema)),
        successValueSha256,
        argumentKey: "direction",
      },
      {
        id: "search",
        origin,
        operation: "search",
        toolName: "ellie_acceptance_search",
        inputSchemaSha256: sha256(canonical(searchSchema)),
        successValueSha256,
        argumentKey: "query",
      },
      {
        id: "select",
        origin,
        operation: "select",
        toolName: "ellie_acceptance_select",
        inputSchemaSha256: sha256(canonical(selectSchema)),
        successValueSha256,
        argumentKey: "itemId",
      },
      {
        id: "playback",
        origin,
        operation: "playback",
        toolName: "ellie_acceptance_playback",
        inputSchemaSha256: sha256(canonical(playbackSchema)),
        successValueSha256,
        argumentKey: "action",
      },
    ],
  });
  const path = join(state, "browser-operations.json");
  const bytes = canonicalReviewedBrowserRegistry(registry);
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
  return { path, sha256: sha256(bytes), registry: loadReviewedBrowserRegistry(path) };
}

async function prepareNativeHost(
  home: string,
  profile: string,
  release: string,
  composedBootstrap?: string,
) {
  const plan = browserWebMCPHostInstallationPlan(release);
  const manifest = composedBootstrap
    ? `${JSON.stringify({ ...JSON.parse(plan.manifest), path: composedBootstrap })}\n`
    : plan.manifest;
  const directories = [join(profile, "NativeMessagingHosts")];
  const paths: string[] = [];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, plan.manifestName);
    await writeFile(path, manifest, { mode: 0o600 });
    await chmod(path, 0o600);
    paths.push(path);
  }
  return {
    executablePath: composedBootstrap ?? plan.executablePath,
    executableSha256: sha256(await readFile(composedBootstrap ?? plan.executablePath)),
    manifestSha256: sha256(manifest),
    manifestPaths: paths.map((path) =>
      path.startsWith(profile)
        ? `$PROFILE${path.slice(profile.length)}`
        : `$HOME${path.slice(home.length)}`,
    ),
  };
}

async function gitValue(args: string[]): Promise<string> {
  return new Promise((resolveValue, reject) => {
    const child = spawn("git", args, { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolveValue(output.trim()) : reject(new Error("Git provenance unavailable.")),
    );
  });
}

async function waitUntil(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(message);
}

async function closeFixtureServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}

async function availablePort(): Promise<number> {
  const reservation = createNetServer();
  try {
    await new Promise<void>((resolveListen, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolveListen);
    });
    return (reservation.address() as AddressInfo).port;
  } finally {
    if (reservation.listening)
      await new Promise<void>((resolveClose) => reservation.close(() => resolveClose()));
  }
}

async function within<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function generateComposedLoopbackIdentity(ownedRoot: string) {
  const config = join(ownedRoot, "ios-loopback-openssl.cnf");
  const key = join(ownedRoot, "ios-loopback-key.pem");
  const cert = join(ownedRoot, "ios-loopback-cert.pem");
  await writeFile(
    config,
    "[req]\ndistinguished_name=dn\nx509_extensions=server\nprompt=no\n[dn]\nCN=127.0.0.1\n[server]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
    { mode: 0o600 },
  );
  await new Promise<void>((resolveDone, reject) => {
    const child = spawn(
      "/usr/bin/openssl",
      [
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
      ],
      { stdio: "ignore" },
    );
    let timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
    }, 30_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (code === 0 && !timedOut) resolveDone();
      else reject(new Error("Owned loopback certificate generation failed."));
    });
  });
  const [leafKey, leafCert] = await Promise.all([readFile(key, "utf8"), readFile(cert, "utf8")]);
  const parsed = new X509Certificate(leafCert);
  assert.equal(parsed.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(parsed.ca, false);
  assert.ok(parsed.checkPrivateKey(createPrivateKey(leafKey)));
  assert.ok(parsed.validFromDate.getTime() <= Date.now());
  assert.ok(parsed.validToDate.getTime() > Date.now());
  return { leafKey, leafCert, pin: sha256(parsed.raw) };
}

async function startNativeJourney(
  operations: BrowserWebMCPOperations,
  ownedRoot: string,
  composed = false,
) {
  const target = "owned-browser-node";
  const coordinator = await coordinatorFixture(5_000);
  const nodeAbort = new AbortController();
  const events: string[] = [];
  let node: Promise<void> | undefined;
  let listener: ReturnType<typeof createBrowserServer> | undefined;
  const nativeHttpEvents: Array<Record<string, string | number | boolean>> = [];
  let accessibility: BrowserAccessibilityRuntime | undefined;
  let cleanupStarted = false;
  const close = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    nodeAbort.abort();
    const closed = listener?.server.listening
      ? new Promise<void>((resolveClose) => listener!.server.once("close", resolveClose))
      : Promise.resolve();
    listener?.shutdown();
    await within(
      Promise.all([closed, node, accessibility?.close(), coordinator.close()]),
      5_000,
      "Owned native journey cleanup is uncertain.",
    );
  };
  try {
    const client = await coordinator.pair(target);
    accessibility = new BrowserAccessibilityRuntime(
      join(ownedRoot, "unavailable-ax"),
      () => undefined,
    );
    const selector = new BrowserOperationSelector(
      (signal, refresh) =>
        refresh ? operations.bindingRefresh(signal) : operations.bindingStatus(signal),
      operations,
      accessibility,
    );
    let registered!: () => void;
    const ready = new Promise<void>((resolveReady) => (registered = resolveReady));
    node = runNode({
      client,
      preferences: defaults,
      signal: nodeAbort.signal,
      executor: new BrowserNodeExecutor(
        {
          capabilities: async () => ["app.open"],
          execute: async () => {
            throw new Error("Desktop dispatch is outside this fixture.");
          },
        },
        selector,
      ),
      onStatus: registered,
      onEvent: (event) => events.push(event),
    });
    await within(ready, 5_000, "Owned browser node did not register.");
    const identity = composed
      ? await generateComposedLoopbackIdentity(ownedRoot)
      : await generateBrowserTlsIdentity("ellie-native-acceptance.local", {
          tempDir: ownedRoot,
        });
    const port = await availablePort();
    const nativeHost = composed ? "127.0.0.1" : "ellie-native-acceptance.local";
    const nativeOrigin = `https://${nativeHost}:${port}`;
    const auth = new NativeAuth(NativeAuth.empty(), async () => {});
    listener = createBrowserServer({
      key: identity.leafKey,
      cert: identity.leafCert,
      origin: nativeOrigin,
      auth: new BrowserAuth(BrowserAuth.empty(), async () => {}),
      nativeAuth: auth,
      remote: createBrowserRemote(coordinator.controller, [
        { id: target, label: "Owned browser node" },
      ]),
    });
    if (composed) {
      listener.server.on("request", (request, response) => {
        if (request.method !== "POST" || request.url !== "/native/v1/commands") return;
        if (nativeHttpEvents.length >= 32) return;
        const event: Record<string, string | number | boolean> = {
          receivedAtMonotonicMs: performance.now(),
        };
        nativeHttpEvents.push(event);
        request.once("aborted", () => {
          event.requestAbortedAtMonotonicMs = performance.now();
        });
        request.once("close", () => {
          event.requestClosedAtMonotonicMs = performance.now();
          event.requestCompleteOnClose = request.complete;
        });
        response.once("finish", () => {
          event.responseFinishedAtMonotonicMs = performance.now();
          event.statusCode = response.statusCode;
        });
        response.once("close", () => {
          event.responseClosedAtMonotonicMs = performance.now();
          event.responseWritableEndedOnClose = response.writableEnded;
        });
      });
    }
    await new Promise<void>((resolveListen, reject) => {
      listener!.server.once("error", reject);
      listener!.server.listen(port, "127.0.0.1", resolveListen);
    });
    const request = async (path: string, body: unknown, token?: string) => {
      const payload = JSON.stringify(body);
      return new Promise<{ status: number; body: unknown }>((resolveResponse, reject) => {
        const call = httpsRequest(
          {
            host: "127.0.0.1",
            port,
            servername: composed ? undefined : nativeHost,
            path,
            method: "POST",
            ca: "rootCert" in identity ? identity.rootCert : identity.leafCert,
            rejectUnauthorized: true,
            timeout: 5_000,
            headers: {
              host: `${nativeHost}:${port}`,
              "x-ellie-version": "1",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 64 * 1024)
                call.destroy(new Error("Owned native reply exceeded its bound."));
              else chunks.push(Buffer.from(chunk));
            });
            response.once("error", reject);
            response.once("end", () => {
              try {
                resolveResponse({
                  status: response.statusCode ?? 0,
                  body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        call.once("timeout", () => call.destroy(new Error("Owned native request timed out.")));
        call.once("error", reject);
        call.end(payload);
      });
    };
    const pair = async (token: string, capabilities: ("browser.read" | "browser.control")[]) => {
      const invitation = await auth.invite({
        label: "Owned synthetic phone",
        grants: [{ target, capabilities }],
      });
      const reply = await request("/native/v1/pair", { invitation: invitation.code, token });
      assert.equal(reply.status, 200);
      return record(reply.body).client;
    };
    return {
      close,
      coordinator,
      events,
      nativeHttpEvents,
      pair,
      request,
      target,
      ...(composed
        ? {
            credential: {
              origin: nativeOrigin,
              certificateSha256:
                "pin" in identity
                  ? identity.pin
                  : sha256(new X509Certificate(identity.leafCert).raw),
            },
          }
        : {}),
    };
  } catch (error) {
    return settleFailedNativeJourneySetup(error, close);
  }
}

async function prepareAcceptanceEnvironment(
  ownedRoot: string,
  home: string,
  release: string,
  reportDirectory: string,
  composed = false,
) {
  let server: ReturnType<typeof createServer> | undefined;
  let bridge: Awaited<ReturnType<typeof startBrowserWebMCPBridge>> | undefined;
  try {
    const identity = await generateBrowserTlsIdentity(hostname, { tempDir: ownedRoot });
    server = createServer(
      { key: identity.leafKey, cert: identity.leafCert },
      (_request, response) => {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'",
        });
        response.end(fixtureHtml(composed));
      },
    );
    await new Promise<void>((resolveListen, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `https://${hostname}:${address.port}`;
    const spki = createHash("sha256")
      .update(
        new X509Certificate(identity.leafCert).publicKey.export({ type: "spki", format: "der" }),
      )
      .digest("base64");
    const extension = await prepareExtension(ownedRoot, origin);
    const registry = await prepareRegistry(home, origin, composed);
    const profile = join(ownedRoot, "browser-profile");
    let composedBootstrap: string | undefined;
    if (composed) {
      composedBootstrap = join(ownedRoot, "native-host-bootstrap.mjs");
      const moduleURL = pathToFileURL(resolve("apps/node/src/browser-native-host.ts")).href;
      await writeFile(
        composedBootstrap,
        `#!${process.execPath}\nimport { runBrowserWebMCPNativeHost } from ${JSON.stringify(moduleURL)};\nawait runBrowserWebMCPNativeHost({ home: ${JSON.stringify(home)} }).catch(() => { process.exitCode = 1; });\n`,
        { mode: 0o500 },
      );
      await chmod(composedBootstrap, 0o500);
    }
    const nativeHost = await prepareNativeHost(home, profile, release, composedBootstrap);
    bridge = await startBrowserWebMCPBridge({ home });
    const configPath = join(ownedRoot, "agent-browser-config.json");
    await writeFile(configPath, "{}\n", { mode: 0o600 });
    return { bridge, configPath, extension, nativeHost, origin, profile, registry, server, spki };
  } catch (error) {
    try {
      return await settleFailedAcceptanceEnvironmentSetup(error, {
        ownedRoot,
        closeBridge: () => bridge?.close() ?? Promise.resolve(),
        closeServer: () => (server ? closeFixtureServer(server) : Promise.resolve()),
        removeOwnedRoot: () => rm(ownedRoot, { recursive: true, force: true }),
      });
    } catch (settled) {
      await writeFile(
        join(reportDirectory, "report.json"),
        `${JSON.stringify(acceptanceEnvironmentSetupFailureReport(settled), null, 2)}\n`,
        { mode: 0o600 },
      );
      throw settled;
    }
  }
}

async function main() {
  const composedSetting = process.env.ELLIE_BROWSER_ACCEPTANCE_IOS_COMPOSED;
  if (composedSetting !== undefined && composedSetting !== "1")
    throw new Error("Invalid composed iOS acceptance setting.");
  const composed = composedSetting === "1";
  const bindOnlySetting = process.env.ELLIE_BROWSER_ACCEPTANCE_BIND_ONLY;
  if (bindOnlySetting !== undefined && bindOnlySetting !== "1")
    throw new Error("Invalid bind-only acceptance setting.");
  const bindOnly = bindOnlySetting === "1";
  if (bindOnly && composed) throw new Error("Bind-only acceptance cannot launch composed iOS.");
  const sourceStatus = await gitValue(["status", "--short"]);
  if (sourceStatus && process.env.ELLIE_BROWSER_ACCEPTANCE_ALLOW_DIRTY !== "1")
    throw new Error(
      "Browser acceptance requires a clean source checkout. Set ELLIE_BROWSER_ACCEPTANCE_ALLOW_DIRTY=1 only for a non-release development run.",
    );
  const release = await realpath(requiredAbsolutePath("ELLIE_BROWSER_ACCEPTANCE_RELEASE"));
  const browserExecutable = await realpath(
    requiredAbsolutePath("ELLIE_BROWSER_ACCEPTANCE_BROWSER"),
  );
  const releaseInfo = await lstat(release);
  if (
    !releaseInfo.isDirectory() ||
    releaseInfo.isSymbolicLink() ||
    (releaseInfo.mode & 0o777) !== 0o555
  )
    throw new Error(
      "The owner-provided staged development artifact must be an immutable directory.",
    );

  const reportDirectory = resolve(
    process.env.REPORT_DIR ?? join(tmpdir(), `ellie-browser-webmcp-report-${Date.now()}`),
  );
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await chmod(reportDirectory, 0o700);
  // macOS limits Unix-domain socket paths to roughly one hundred bytes. Keep this owned root
  // canonical and short enough for BrowserBridge/browser-webmcp-v1.sock.
  const ownedRoot = await mkdtemp("/tmp/ellie-bw-");
  await chmod(ownedRoot, 0o700);
  const home = join(ownedRoot, "home");
  await mkdir(home, { mode: 0o700 });
  await mkdir(join(home, "Library", "Application Support", "Ellie"), {
    recursive: true,
    mode: 0o700,
  });
  const { bridge, configPath, extension, nativeHost, origin, profile, registry, server, spki } =
    await prepareAcceptanceEnvironment(ownedRoot, home, release, reportDirectory, composed);
  const bridgeEvents: Array<{ type: string; status: string; value?: unknown }> = [];
  const bridgeTrace: Array<Record<string, string | number | boolean>> = [];
  type OwnedWindowState = {
    tabMatches: boolean;
    windowMatches: boolean;
    urlMatches: boolean;
    active: boolean;
    complete: boolean;
    focused: boolean;
  };
  const ownedWindowChecks: Array<{
    before: OwnedWindowState;
    after?: OwnedWindowState;
    focusAttempted: boolean;
  }> = [];
  let prepareOwnedWindowForRefresh: (() => Promise<void>) | undefined;
  let inspectOwnedWindowForMutation: (() => Promise<OwnedWindowState>) | undefined;
  const operations = new BrowserWebMCPOperations(
    {
      async request(request, signal) {
        const before = bridge.connectionContext();
        const trace: Record<string, string | number | boolean> = {
          type: request.type,
          startedAtMonotonicMs: performance.now(),
          signalAbortedBefore: signal.aborted,
          connectedBefore: bridge.connected(),
          contextBefore: before !== undefined,
        };
        if (composed && request.type === "tool.execute") {
          const direction = request.args.direction;
          trace.directionState =
            direction === "down"
              ? "down"
              : direction === "up"
                ? "up"
                : direction === undefined
                  ? "missing"
                  : "other";
        }
        if (composed && bridgeTrace.length < 64) bridgeTrace.push(trace);
        const onAbort = () => {
          trace.signalAbortedAtMonotonicMs = performance.now();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          if (composed && request.type === "binding.refresh") {
            assert.ok(prepareOwnedWindowForRefresh, "The owned browser binding was not captured.");
            if (signal.aborted) throw new Error("cancelled");
            await prepareOwnedWindowForRefresh();
            if (signal.aborted) throw new Error("cancelled");
          }
          if (composed && request.type === "tool.execute" && request.args.direction === "down") {
            try {
              const window = await inspectOwnedWindowForMutation?.();
              if (window) {
                trace.ownedTabMatches = window.tabMatches;
                trace.ownedWindowMatches = window.windowMatches;
                trace.ownedUrlMatches = window.urlMatches;
                trace.ownedTabActive = window.active;
                trace.ownedPageComplete = window.complete;
                trace.ownedWindowFocused = window.focused;
              }
            } catch {
              trace.ownedWindowObservation = "unavailable";
            }
          }
          const response = await bridge.request(request, signal);
          bridgeEvents.push({
            type: request.type,
            status: response.status,
            ...(response.status === "ok" ? { value: response.value } : {}),
          });
          trace.status = response.status;
          return response;
        } catch (error) {
          trace.errorKind = signal.aborted ? "cancelled" : "request_failed";
          throw error;
        } finally {
          signal.removeEventListener("abort", onAbort);
          const after = bridge.connectionContext();
          trace.finishedAtMonotonicMs = performance.now();
          trace.signalAbortedAfter = signal.aborted;
          trace.connectedAfter = bridge.connected();
          trace.contextAfter = after !== undefined;
          trace.sameConnection =
            before !== undefined && after?.connectionId === before.connectionId;
        }
      },
    },
    registry.registry,
  );
  const session = `eb-${process.pid}-${randomUUID().slice(0, 4)}`;
  const commands: CommandRecord[] = [];
  let browserStarted = false;
  let actionDispatched = false;
  let actionConfirmed = false;
  let visibleEffectConfirmed = false;
  let rollbackDispatched = false;
  let rollbackConfirmed = false;
  let statusResult: unknown;
  let readResult: unknown;
  let actionResult: unknown;
  let rollbackResult: unknown;
  let browserUserAgent = "";
  let nativeJourney: Awaited<ReturnType<typeof startNativeJourney>> | undefined;
  let nativeEvidence: Record<string, unknown> | undefined;
  let ownedFixtureTabId: number | undefined;
  let fixtureAtFailure: unknown;
  let retainedRoot = true;
  let cleanupError: string | undefined;

  const agent = async (args: string[], launch = false): Promise<string> => {
    const started = Date.now();
    const common = ["--namespace", session, "--config", configPath, "--session", session];
    const launchArgs = launch
      ? [
          "--executable-path",
          browserExecutable,
          "--profile",
          profile,
          "--extension",
          extension.extension,
          "--args",
          `--host-resolver-rules=MAP ${hostname} 127.0.0.1,--ignore-certificate-errors-spki-list=${spki}`,
        ]
      : [];
    const evalIndex = args.indexOf("eval");
    const safeArgs = evalIndex === -1 ? args : [...args.slice(0, evalIndex + 1), "[script]"];
    try {
      const output = await new Promise<string>((resolveOutput, reject) => {
        const child = spawn(agentBrowserPath, [...common, ...launchArgs, ...args], {
          cwd: resolve("."),
          env: {
            HOME: process.env.HOME,
            CODEX_HOME: process.env.CODEX_HOME,
            ...(composed ? {} : { HOME: home }),
            PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            LANG: "C",
            LC_ALL: "C",
            AGENT_BROWSER_MAX_OUTPUT: String(maximumCommandOutput),
            AGENT_BROWSER_IDLE_TIMEOUT_MS: composed ? "1800000" : "180000",
            AGENT_BROWSER_SOCKET_DIR: join(ownedRoot, "ab"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const append = (current: string, chunk: Buffer) =>
          (current + chunk.toString("utf8")).slice(-maximumCommandOutput);
        child.stdout.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
        child.stderr.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
        let timedOut = false;
        let escalation: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          escalation = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }, 1_000);
        }, commandTimeoutMs);
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timer);
          if (escalation) clearTimeout(escalation);
          const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
          if (code === 0 && !timedOut) resolveOutput(combined);
          else
            reject(
              new Error(
                `agent-browser ${safeArgs.join(" ")} failed (${code}): ${combined.slice(-8_192)}`,
              ),
            );
        });
      });
      commands.push({ args: safeArgs, durationMs: Date.now() - started, ok: true });
      return output;
    } catch (error) {
      commands.push({ args: safeArgs, durationMs: Date.now() - started, ok: false });
      throw error;
    }
  };
  const agentJson = async <T>(args: string[], launch = false): Promise<T> => {
    const parsed = JSON.parse(await agent(["--json", ...args], launch)) as JsonCommand<T>;
    if (!parsed.success) throw new Error("agent-browser returned an unsuccessful result.");
    return parsed.data;
  };
  const artifact = (name: string) => join(reportDirectory, name);
  let report: Record<string, unknown>;
  let failure: unknown;
  try {
    // A failed navigation can still leave an owned daemon/browser to close.
    browserStarted = true;
    await agentJson(["open", `${origin}/`], true);
    await agent(["wait", "--fn", "document.body.dataset.webmcpReady === 'true'"]);
    const webmcp = await agentJson<{ result: unknown }>([
      "eval",
      "({native:Object.prototype.hasOwnProperty.call(Document.prototype,'modelContext'),register:typeof document.modelContext?.registerTool,get:typeof document.modelContext?.getTools,execute:typeof document.modelContext?.executeTool,userAgent:navigator.userAgent})",
    ]);
    const webmcpResult = webmcp.result as Record<string, unknown>;
    browserUserAgent = String(webmcpResult.userAgent ?? "");
    delete webmcpResult.userAgent;
    assert.deepEqual(webmcpResult, {
      native: true,
      register: "function",
      get: "function",
      execute: "function",
    });
    const beforeSnapshot = await agent(["snapshot", "-c"]);
    await writeFile(artifact("before.snapshot.txt"), `${beforeSnapshot}\n`, {
      mode: 0o600,
    });
    await agent(["screenshot", artifact("before.png")]);
    await chmod(artifact("before.png"), 0o600);
    const directTools = await agent(["webmcp", "list"]);
    assert.match(directTools, /ellie_acceptance_read/);
    assert.match(directTools, /ellie_acceptance_scroll/);

    await agent([
      "tab",
      "new",
      `chrome-extension://${ELLIE_BROWSER_EXTENSION_ID}/acceptance-launcher.html`,
    ]);
    const extensionIdentity = await agentJson<{ result: unknown }>([
      "eval",
      "({id:chrome.runtime.id,url:location.href})",
    ]);
    assert.deepEqual(extensionIdentity.result, {
      id: ELLIE_BROWSER_EXTENSION_ID,
      url: `chrome-extension://${ELLIE_BROWSER_EXTENSION_ID}/acceptance-launcher.html`,
    });
    const opened = await agentJson<{ result: unknown }>([
      "eval",
      `(async()=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(value=>value.url===${JSON.stringify(`${origin}/`)});if(!tab?.id)throw new Error('fixture_tab_missing');await chrome.tabs.update(tab.id,{active:true});const selected=await chrome.tabs.get(tab.id);const ownerWindow=await chrome.windows.get(selected.windowId);await chrome.action.openPopup({windowId:selected.windowId});const deadline=Date.now()+5000;let popup;while(Date.now()<deadline){[popup]=chrome.extension.getViews({type:'popup',windowId:selected.windowId});if(popup)break;await new Promise(resolve=>setTimeout(resolve,25))}if(!popup)throw new Error('genuine_popup_missing');const contexts=await chrome.runtime.getContexts({documentUrls:[chrome.runtime.getURL('popup.html')]});const genuine=contexts.length===1&&contexts[0].contextType==='POPUP'&&contexts[0].tabId===-1&&contexts[0].windowId===-1;if(!genuine)throw new Error('genuine_popup_context_missing');const button=popup.document.querySelector('#bind-webmcp');if(!button)throw new Error('bind_control_missing');button.click();let status='';while(Date.now()<deadline){status=popup.document.querySelector('#status')?.textContent??'';if(status!=='Working…'&&status!=='Ready')break;await new Promise(resolve=>setTimeout(resolve,25))}if(status!=='Page selected.')throw new Error('popup_bind_failed:'+status);popup.close();return {anchor:{tabId:selected.id,windowId:selected.windowId,url:selected.url},precondition:{tabActive:selected.active===true,tabComplete:selected.status==='complete',windowFocused:ownerWindow.focused===true},popup:{genuine,status}}})()`,
    ]);
    const popupBinding = opened.result as {
      anchor?: { tabId?: unknown; windowId?: unknown; url?: unknown };
      precondition?: { tabActive?: unknown; tabComplete?: unknown; windowFocused?: unknown };
    };
    assert.equal(popupBinding.precondition?.tabActive, true);
    assert.equal(popupBinding.precondition?.tabComplete, true);
    assert.equal(popupBinding.precondition?.windowFocused, true);
    await waitUntil(() => bridge.connected(), "The real browser did not open the native host.");
    const bindingStatus = await bridge.request(
      {
        protocol: "ellie.browser-webmcp.v1",
        id: randomUUID(),
        type: "binding.status",
      },
      AbortSignal.timeout(2_000),
    );
    assert.equal(bindingStatus.status, "ok", "The genuine popup did not bind the owned page.");
    assert.equal(record(bindingStatus.value).availability, "webmcp");

    if (bindOnly) {
      const anchor = popupBinding.anchor;
      assert.ok(anchor);
      assert.ok(Number.isInteger(anchor.tabId) && Number(anchor.tabId) > 0);
      assert.ok(Number.isInteger(anchor.windowId) && Number(anchor.windowId) > 0);
      assert.equal(anchor?.url, `${origin}/`);
      report = {
        version: 1,
        status: "pass",
        mode: "synthetic-genuine-popup-bind-only",
        startedFromCleanSource: sourceStatus.length === 0,
        source: {
          commit: await gitValue(["rev-parse", "HEAD"]),
          tree: await gitValue(["rev-parse", "HEAD^{tree}"]),
          runnerSha256: sha256(await readFile(runnerPath)),
        },
        browser: {
          executableSha256: sha256(await readFile(browserExecutable)),
          userAgent: browserUserAgent,
          profile: "owned temporary profile",
        },
        binding: {
          origin,
          url: anchor.url,
          availability: record(bindingStatus.value).availability,
          popup: "Chrome action POPUP context",
        },
        nativeHost,
        extension: {
          id: ELLIE_BROWSER_EXTENSION_ID,
          acceptanceLauncherSha256: extension.acceptanceLauncherSha256,
          productionFiles: extension.productionFiles,
          fixtureFiles: extension.files,
          fixtureDifferences: extension.fixtureDifferences,
        },
        replayAttempted: false,
        accessibilityFallbackAttempted: false,
        commands,
        artifacts: ["before.snapshot.txt", "before.png"],
      };
    } else if (composed) {
      const anchor = popupBinding.anchor;
      assert.ok(Number.isInteger(anchor?.tabId) && Number(anchor?.tabId) > 0);
      assert.ok(Number.isInteger(anchor?.windowId) && Number(anchor?.windowId) > 0);
      assert.equal(anchor?.url, `${origin}/`);
      const tabId = Number(anchor.tabId);
      ownedFixtureTabId = tabId;
      const windowId = Number(anchor.windowId);
      const inspectOwnedWindow = async () => {
        const inspected = await agentJson<{ result: OwnedWindowState }>([
          "eval",
          `(async()=>{const tab=await chrome.tabs.get(${tabId});const window=await chrome.windows.get(${windowId});return {tabMatches:tab.id===${tabId},windowMatches:tab.windowId===${windowId}&&window.id===${windowId},urlMatches:tab.url===${JSON.stringify(`${origin}/`)},active:tab.active===true,complete:tab.status==='complete',focused:window.focused===true}})()`,
        ]);
        return inspected.result;
      };
      inspectOwnedWindowForMutation = inspectOwnedWindow;
      const assertOwnedWindow = (state: OwnedWindowState) => {
        assert.equal(state.tabMatches, true, "The selected browser tab changed.");
        assert.equal(state.windowMatches, true, "The selected browser window changed.");
        assert.equal(state.urlMatches, true, "The selected browser URL changed.");
        assert.equal(state.active, true, "The selected browser tab is no longer active.");
        assert.equal(state.complete, true, "The selected browser page is not complete.");
      };
      prepareOwnedWindowForRefresh = async () => {
        const before = await inspectOwnedWindow();
        const check: (typeof ownedWindowChecks)[number] = { before, focusAttempted: false };
        ownedWindowChecks.push(check);
        assertOwnedWindow(before);
        if (!before.focused) {
          // XCTest foregrounds Simulator. Restore genuine focus to this exact owned browser
          // window only; the production extension still checks focus before dispatch.
          check.focusAttempted = true;
          await agentJson([
            "eval",
            `(async()=>{await chrome.windows.update(${windowId},{focused:true});return true})()`,
          ]);
        }
        const after = await inspectOwnedWindow();
        check.after = after;
        assertOwnedWindow(after);
        assert.equal(after.focused, true, "The owned browser window is not focused.");
      };
      nativeJourney = await startNativeJourney(operations, ownedRoot, true);
      const native = nativeJourney;
      const token = randomBytes(32).toString("hex");
      const client = await native.pair(token, ["browser.read", "browser.control"]);
      const info = native.credential;
      assert.ok(info);
      const beforeJobs = native.coordinator.jobStore.list(native.target, 100).length;
      const ios = await runIOSBrowserComposed({
        ownedRoot,
        reportDirectory,
        credential: { ...info, client, token },
        target: native.target,
      });
      const tabs = await agentJson<{
        tabs: Array<{ tabId: string; url: string; active: boolean }>;
      }>(["tab", "list"]);
      const fixtureTab = tabs.tabs.find((tab) => tab.url === `${origin}/`);
      assert.ok(fixtureTab);
      await agent(["tab", fixtureTab.tabId]);
      const observed = await agentJson<{ result: unknown }>([
        "eval",
        "({phase:document.querySelector('#phase').textContent,query:document.querySelector('#query').textContent,selection:document.querySelector('#selection').textContent,playback:document.querySelector('#playback').textContent,mutations:Number(document.body.dataset.mutations),scrollCallbacks:Number(document.body.dataset.scrollCallbacks),scrollDirectionState:document.body.dataset.scrollDirectionState,scrollEntries:Number(document.body.dataset.scrollEntries),scrollInvocations:Number(document.body.dataset.scrollInvocations),scrollAbortObserved:Number(document.body.dataset.scrollAbortObserved),scrollStage:document.body.dataset.scrollStage,scrollHasSignal:document.body.dataset.scrollHasSignal})",
      ]);
      const media = record(observed.result);
      nativeEvidence = { mediaAfterIOS: media };
      assert.equal(media.phase, "watch");
      assert.equal(media.query, "owned synthetic video");
      assert.equal(media.selection, "Owned synthetic video");
      assert.equal(media.playback, "playing");
      assert.equal(media.scrollEntries, 1, "The delayed page tool must be entered once.");
      assert.equal(media.scrollInvocations, 1, "The delayed command must reach the page once.");
      assert.equal(
        media.scrollAbortObserved,
        1,
        "The user's cancellation must reach the page tool.",
      );
      assert.equal(media.mutations, 3, "The cancelled scroll must not mutate the page.");
      assert.equal(media.scrollStage, "aborted", "The page tool must stop on cancellation.");
      assert.equal(
        media.scrollHasSignal,
        "true",
        "The page tool must receive a cancellation signal.",
      );
      const jobs = native.coordinator.jobStore.list(native.target, 100).slice(beforeJobs);
      assert.equal(
        jobs.length,
        14,
        "Only five explicit reads and four user actions may submit jobs.",
      );
      assert.equal(
        bridgeEvents.filter((event) => event.type === "tool.execute").length,
        9,
        "Five observed reads and four mutations may reach WebMCP exactly once each.",
      );
      report = {
        version: 1,
        status: "pass",
        mode: "synthetic-ios-composed",
        startedFromCleanSource: sourceStatus.length === 0,
        source: {
          commit: await gitValue(["rev-parse", "HEAD"]),
          tree: await gitValue(["rev-parse", "HEAD^{tree}"]),
          runnerSha256: sha256(await readFile(runnerPath)),
        },
        browser: {
          executableSha256: sha256(await readFile(browserExecutable)),
          userAgent: browserUserAgent,
          profile: "owned temporary profile",
        },
        nativeHost: {
          ...nativeHost,
          scope:
            "production native-host function via owned explicit-home bootstrap; shipped launcher separately covered",
        },
        ios: {
          simulator: ios.simulator,
          fixtureID: ios.fixtureID,
          resultBundle: "private composed-ios.xcresult",
          cleanupCertain: ios.cleanupCertain,
          transcript: "synthetic, injected without microphone or model",
        },
        nativeJourney: {
          path: "iOS UI → pinned loopback HTTPS → NativeAuth scoped grant → coordinator → node → loaded WebMCP",
          jobs: jobs.map((job) => ({ state: job.state })),
          nodeEvents: native.events,
        },
        observedMedia: media,
        bridgeEvents: bridgeEvents.map(({ type, status }) => ({ type, status })),
        ownedWindowChecks,
        replayAttempted: false,
        accessibilityFallbackAttempted: false,
        commands,
        artifacts: ["before.snapshot.txt", "before.png", "composed-ios.xcresult"],
      };
    } else {
      const signal = new AbortController().signal;
      const status = await operations.execute({ tool: "browser.status" }, signal);
      statusResult = status;
      assert.equal(status.ok, true);
      assert.equal(status.browser.source, "webmcp");
      assert.equal(status.browser.operation, "status");
      assert.equal(status.browser.status, "connected");
      assert.ok(status.browser.operation === "status" && status.browser.revision);
      const revision = status.browser.revision;
      const read = await operations.execute(
        { tool: "browser.read", view: "viewport", revision },
        signal,
      );
      readResult = read;
      assert.equal(read.ok, true);
      assert.equal(read.browser.source, "webmcp");
      assert.equal(read.browser.operation, "read");
      assert.equal(read.browser.view.items[0]?.state, "0");

      actionDispatched = true;
      const action = await operations.execute(
        { tool: "browser.scroll", direction: "down", revision },
        signal,
      );
      actionResult = action;
      actionConfirmed =
        action.ok === true &&
        action.browser.source === "webmcp" &&
        action.browser.operation === "command" &&
        action.browser.status === "completed";
      if (!actionConfirmed)
        throw new Error(
          "The browser action outcome was not confirmed; no replay or cleanup dispatch was attempted.",
        );

      const tabs = await agentJson<{
        tabs: Array<{ tabId: string; url: string; active: boolean }>;
      }>(["tab", "list"]);
      const fixtureTab = tabs.tabs.find((tab) => tab.url === `${origin}/`);
      assert.ok(fixtureTab);
      await agent(["tab", fixtureTab.tabId]);
      const visible = await agentJson<{ result: unknown }>([
        "eval",
        "({offset:Math.round(document.querySelector('#viewport').scrollTop),text:document.querySelector('#result').textContent})",
      ]);
      const visibleResult = visible.result as { offset?: unknown; text?: unknown };
      assert.equal(typeof visibleResult.offset, "number");
      assert.ok(Number(visibleResult.offset) > 0);
      assert.equal(visibleResult.text, `Scroll offset: ${visibleResult.offset}`);
      visibleEffectConfirmed = true;
      await writeFile(artifact("after.snapshot.txt"), `${await agent(["snapshot", "-c"])}\n`, {
        mode: 0o600,
      });
      await agent(["screenshot", artifact("after.png")]);
      await chmod(artifact("after.png"), 0o600);

      rollbackDispatched = true;
      const rollback = await operations.execute(
        { tool: "browser.scroll", direction: "up", revision },
        signal,
      );
      rollbackResult = rollback;
      rollbackConfirmed =
        rollback.ok === true &&
        rollback.browser.source === "webmcp" &&
        rollback.browser.operation === "command" &&
        rollback.browser.status === "completed";
      if (!rollbackConfirmed)
        throw new Error("The confirmed action's rollback outcome is unknown; it was not replayed.");
      const rolledBack = await agentJson<{ result: unknown }>([
        "eval",
        "({offset:Math.round(document.querySelector('#viewport').scrollTop),text:document.querySelector('#result').textContent})",
      ]);
      assert.deepEqual(rolledBack.result, { offset: 0, text: "Scroll offset: 0" });

      nativeJourney = await startNativeJourney(operations, ownedRoot);
      const native = nativeJourney;
      const browserResult = (reply: { status: number; body: unknown }) => {
        assert.equal(reply.status, 200);
        return record(record(record(reply.body).result).browser);
      };
      const command = (action: Record<string, unknown>, token: string) =>
        native.request("/native/v1/commands", { nodeId: native.target, action }, token);
      const readOnlyToken = "1".repeat(64);
      const controlToken = "2".repeat(64);
      await native.pair(readOnlyToken, ["browser.read"]);
      const firstStatus = browserResult(await command({ tool: "browser.status" }, readOnlyToken));
      assert.equal(firstStatus.status, "connected");
      assert.equal(typeof firstStatus.revision, "string");
      const beforeDeniedJobs = native.coordinator.jobStore.list(native.target, 100).length;
      assert.equal(
        (
          await command(
            {
              tool: "browser.search",
              query: "owned synthetic video",
              revision: firstStatus.revision,
            },
            readOnlyToken,
          )
        ).status,
        403,
      );
      assert.equal(native.coordinator.jobStore.list(native.target, 100).length, beforeDeniedJobs);
      await native.pair(controlToken, ["browser.read", "browser.control"]);
      const nativeStatus = browserResult(await command({ tool: "browser.status" }, controlToken));
      assert.equal(nativeStatus.status, "connected");
      const nativeRevision = String(nativeStatus.revision);
      const nativeRead = browserResult(
        await command(
          { tool: "browser.read", view: "catalog", revision: nativeRevision },
          controlToken,
        ),
      );
      assert.equal(nativeRead.status, "completed");
      assert.match(String(record(nativeRead.view).summary), /^home:/);
      const beforeStaleEvents = bridgeEvents.length;
      const stale = await command(
        { tool: "browser.search", query: "owned synthetic video", revision: "a".repeat(64) },
        controlToken,
      );
      assert.equal(
        stale.status,
        502,
        "native transport conservatively reports post-dispatch uncertainty",
      );
      assert.equal(record(stale.body).outcome, "unknown");
      assert.deepEqual(
        bridgeEvents.slice(beforeStaleEvents).map((event) => event.type),
        ["binding.status", "binding.status"],
        "a stale revision cannot reach the companion mutation tool",
      );
      assert.equal(
        browserResult(
          await command(
            { tool: "browser.search", query: "owned synthetic video", revision: nativeRevision },
            controlToken,
          ),
        ).status,
        "completed",
      );
      const results = browserResult(
        await command(
          { tool: "browser.read", view: "catalog", revision: nativeRevision },
          controlToken,
        ),
      );
      assert.match(String(record(results.view).summary), /^results: owned synthetic video:/);
      const resultItems = record(results.view).items;
      assert.ok(Array.isArray(resultItems));
      const selected = resultItems.find((item) => record(item).id === "owned-video-1");
      assert.ok(selected);
      assert.equal(
        browserResult(
          await command(
            { tool: "browser.select", itemId: record(selected).id, revision: nativeRevision },
            controlToken,
          ),
        ).status,
        "completed",
      );
      const watch = browserResult(
        await command(
          { tool: "browser.read", view: "player", revision: nativeRevision },
          controlToken,
        ),
      );
      assert.match(String(record(watch.view).summary), /^watch: owned synthetic video: paused$/);
      const play = await command(
        { tool: "browser.playback", action: "play", revision: nativeRevision },
        controlToken,
      );
      assert.equal(play.status, 200);
      assert.equal(record(play.body).outcome, "unknown");
      assert.equal(record(record(record(play.body).result).browser).status, "unknown");
      const afterUnknownJobs = native.coordinator.jobStore.list(native.target, 100).length;
      const playing = browserResult(
        await command(
          { tool: "browser.read", view: "player", revision: nativeRevision },
          controlToken,
        ),
      );
      assert.match(String(record(playing.view).summary), /^watch: owned synthetic video: playing$/);
      assert.equal(
        native.coordinator.jobStore.list(native.target, 100).length,
        afterUnknownJobs + 1,
        "fresh read does not replay the unknown play mutation",
      );
      assert.equal(
        browserResult(
          await command(
            { tool: "browser.playback", action: "pause", revision: nativeRevision },
            controlToken,
          ),
        ).status,
        "completed",
      );
      const finalRead = browserResult(
        await command(
          { tool: "browser.read", view: "player", revision: nativeRevision },
          controlToken,
        ),
      );
      assert.match(
        String(record(finalRead.view).summary),
        /^watch: owned synthetic video: paused$/,
      );
      const visibleMedia = await agentJson<{ result: unknown }>([
        "eval",
        "({phase:document.querySelector('#phase').textContent,query:document.querySelector('#query').textContent,selection:document.querySelector('#selection').textContent,playback:document.querySelector('#playback').textContent,mutations:Number(document.body.dataset.mutations)})",
      ]);
      assert.deepEqual(visibleMedia.result, {
        phase: "watch",
        query: "owned synthetic video",
        selection: "Owned synthetic video",
        playback: "paused",
        mutations: 4,
      });
      await bridge.close();
      const disconnected = await command({ tool: "browser.status" }, controlToken);
      assert.equal(disconnected.status, 200);
      assert.equal(record(disconnected.body).outcome, "failed");
      assert.equal(
        native.coordinator.jobStore.list(native.target, 100).length,
        afterUnknownJobs + 4,
        "disconnect does not create any replay job",
      );
      nativeEvidence = {
        path: "pinned native HTTPS → scoped grant → coordinator job → owned node → production WebMCP selector → loaded extension",
        deniedControlStatus: 403,
        staleRevisionOutcome: "unknown transport result; no companion mutation dispatched",
        search: "completed",
        select: "completed",
        play: "unknown",
        pause: "completed",
        freshReadAfterUnknown: "playing",
        visibleMedia: visibleMedia.result,
        disconnectedStatus: "failed",
        jobs: native.coordinator.jobStore
          .list(native.target, 100)
          .map((job) => ({ state: job.state })),
        nodeEvents: native.events,
      };

      report = {
        version: 1,
        status: "pass",
        startedFromCleanSource: sourceStatus.length === 0,
        source: {
          commit: await gitValue(["rev-parse", "HEAD"]),
          tree: await gitValue(["rev-parse", "HEAD^{tree}"]),
          runnerSha256: sha256(await readFile(runnerPath)),
          controllerSha256: sha256(await readFile(join(sourceExtension, "webmcp-controller.js"))),
        },
        browser: {
          executable: browserExecutable,
          executableSha256: sha256(await readFile(browserExecutable)),
          userAgent: browserUserAgent,
          driver: `agent-browser ${JSON.parse(await readFile("node_modules/agent-browser/package.json", "utf8")).version}`,
          profile: "owned temporary profile",
          webmcpApi:
            "native Document.prototype.modelContext with registerTool/getTools/executeTool",
          webmcpDialect:
            "reviewed Chrome 152 dialect: serialized schemas, JSON-string arguments and results",
          certificateTrust: "one owned leaf SPKI launch exception; no user trust-store change",
        },
        extension: {
          id: ELLIE_BROWSER_EXTENSION_ID,
          source: "production extension copy",
          productionManifestSha256: extension.productionManifestSha256,
          productionFiles: extension.productionFiles,
          fixtureFiles: extension.files,
          fixtureDifferences: extension.fixtureDifferences,
        },
        nativeHost: {
          name: BROWSER_WEBMCP_NATIVE_HOST,
          release,
          ...nativeHost,
        },
        runtime: {
          bridge: "reviewed Node Unix bridge seam",
          authenticatedBrowserAncestry: false,
          registrySha256: registry.sha256,
          events: bridgeEvents,
        },
        journey: {
          origin,
          status: status.browser,
          read: read.browser,
          action: { operation: "scroll", direction: "down", confirmed: actionConfirmed },
          visibleEffectConfirmed,
          rollback: { operation: "scroll", direction: "up", confirmed: rollbackConfirmed },
          accessibilityFallbackAttempted: false,
          replayAttempted: false,
        },
        nativeJourney: nativeEvidence,
        commands,
        artifacts: ["before.snapshot.txt", "before.png", "after.snapshot.txt", "after.png"],
      };
    }
  } catch (error) {
    failure = error;
    if (error instanceof NativeJourneySetupCleanupError)
      cleanupError = "Owned native journey setup cleanup is uncertain.";
    if (error instanceof ComposedIOSCleanupError)
      cleanupError = "Owned iOS Simulator cleanup is uncertain.";
    if (composed && ownedFixtureTabId !== undefined && browserStarted && !cleanupError) {
      try {
        const inspection = await agentJson<{ result: unknown }>([
          "eval",
          `(async()=>{const rows=await chrome.scripting.executeScript({target:{tabId:${ownedFixtureTabId}},world:'MAIN',func:()=>({scrollCallbacks:Number(document.body.dataset.scrollCallbacks),scrollDirectionState:document.body.dataset.scrollDirectionState,scrollEntries:Number(document.body.dataset.scrollEntries),scrollInvocations:Number(document.body.dataset.scrollInvocations),scrollAbortObserved:Number(document.body.dataset.scrollAbortObserved),scrollStage:document.body.dataset.scrollStage,scrollHasSignal:document.body.dataset.scrollHasSignal,mutations:Number(document.body.dataset.mutations),scrollTop:Math.round(document.querySelector('#viewport')?.scrollTop??-1)})});return rows[0]?.result??null})()`,
        ]);
        fixtureAtFailure = inspection.result;
      } catch {
        fixtureAtFailure = "owned_page_observation_unavailable";
      }
    }
    report = {
      version: 1,
      status: "fail",
      error: error instanceof Error ? error.message : "Acceptance failed.",
      actionDispatched,
      actionConfirmed,
      visibleEffectConfirmed,
      rollbackDispatched,
      rollbackConfirmed,
      statusResult,
      readResult,
      actionResult,
      rollbackResult,
      bridgeEvents,
      ...(composed
        ? {
            diagnostics: {
              bridgeTrace,
              nativeHttpEvents: nativeJourney?.nativeHttpEvents ?? [],
              mediaAfterIOS: nativeEvidence?.mediaAfterIOS ?? null,
              fixtureAtFailure: fixtureAtFailure ?? "unavailable",
            },
          }
        : {}),
      ownedWindowChecks,
      accessibilityFallbackAttempted: false,
      replayAttempted: false,
      commands,
      retainedRoot: ownedRoot,
    };
  } finally {
    if (browserStarted) await agent(["close"]).catch((error) => (cleanupError = String(error)));
    await nativeJourney?.close().catch((error) => (cleanupError = String(error)));
    await bridge.close().catch((error) => (cleanupError = String(error)));
    await closeFixtureServer(server).catch((error) => (cleanupError = String(error)));
    if (!failure && !cleanupError) {
      await rm(ownedRoot, { recursive: true });
      retainedRoot = false;
    }
    report!.cleanup = {
      certain: !cleanupError,
      retainedRoot: retainedRoot ? ownedRoot : undefined,
    };
    if (cleanupError) {
      report!.status = "fail";
      report!.cleanupError = "Owned browser/runtime cleanup was incomplete.";
    }
    await writeFile(artifact("report.json"), `${JSON.stringify(report!, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  settleAcceptanceOutcome(failure, cleanupError);
  console.log(JSON.stringify({ status: "pass", reportDirectory }));
}

if (process.argv[1] && resolve(process.argv[1]) === runnerPath) await main();
