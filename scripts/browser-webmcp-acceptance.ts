import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
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
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { generateBrowserTlsIdentity } from "../apps/cli/src/certificate.ts";
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

const runnerPath = fileURLToPath(import.meta.url);
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
    ],
  });
  await replaceExactly(
    background,
    'const productionOrigins = new Set(["https://www.netflix.com", "https://www.youtube.com"]);',
    `const productionOrigins = new Set([${JSON.stringify(origin)}]);`,
  );
  await replaceExactly(
    background,
    "const reviewedWebMCPBindings = Object.freeze({});",
    `const reviewedWebMCPBindings = Object.freeze(${reviewed});`,
  );
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
      "background.js reviewedWebMCPBindings contains only the two acceptance tools",
      "both reviewed acceptance tools require the Chrome 152 JSON-string argument dialect",
      `manifest.json host_permissions contains only ${origin}/*`,
    ],
    productionManifestSha256: sha256(productionManifest),
  };
}

function fixtureHtml(): string {
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
<script>
const viewport = document.querySelector('#viewport');
const result = document.querySelector('#result');
const update = () => { result.textContent = 'Scroll offset: ' + Math.round(viewport.scrollTop); };
viewport.addEventListener('scroll', update);
Promise.all([
  document.modelContext.registerTool({
    name: 'ellie_acceptance_read',
    description: 'Read the owned acceptance viewport and its current scroll offset.',
    inputSchema: ${JSON.stringify(readSchema)},
    annotations: ${JSON.stringify(readAnnotations)},
    execute: async () => ({
      title: 'Ellie owned WebMCP acceptance',
      summary: result.textContent,
      items: [{id: 'acceptance-viewport', label: 'Owned acceptance viewport', state: String(Math.round(viewport.scrollTop))}]
    })
  }),
  document.modelContext.registerTool({
    name: 'ellie_acceptance_scroll',
    description: 'Scroll the owned acceptance viewport once in the requested direction.',
    inputSchema: ${JSON.stringify(scrollSchema)},
    annotations: ${JSON.stringify(annotations)},
    execute: async ({direction}, context = {}) => {
      context.signal?.throwIfAborted();
      const before = viewport.scrollTop;
      viewport.scrollTop = before + (direction === 'down' ? 120 : -120);
      context.signal?.throwIfAborted();
      const after = viewport.scrollTop;
      if (direction === 'down' ? after <= before : after >= before) throw new Error('scroll_not_observed');
      update();
      return ${JSON.stringify(completedValue)};
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

async function prepareRegistry(home: string, origin: string) {
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
        id: "scroll",
        origin,
        operation: "scroll",
        toolName: "ellie_acceptance_scroll",
        inputSchemaSha256: sha256(canonical(scrollSchema)),
        successValueSha256,
        argumentKey: "direction",
      },
    ],
  });
  const path = join(state, "browser-operations.json");
  const bytes = canonicalReviewedBrowserRegistry(registry);
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
  return { path, sha256: sha256(bytes), registry: loadReviewedBrowserRegistry(path) };
}

async function prepareNativeHost(home: string, profile: string, release: string) {
  const plan = browserWebMCPHostInstallationPlan(release);
  const directories = [join(profile, "NativeMessagingHosts")];
  const paths: string[] = [];
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, plan.manifestName);
    await writeFile(path, plan.manifest, { mode: 0o600 });
    await chmod(path, 0o600);
    paths.push(path);
  }
  return {
    executablePath: plan.executablePath,
    executableSha256: sha256(await readFile(plan.executablePath)),
    manifestSha256: sha256(plan.manifest),
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

async function prepareAcceptanceEnvironment(ownedRoot: string, home: string, release: string) {
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
        response.end(fixtureHtml());
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
    const registry = await prepareRegistry(home, origin);
    const profile = join(ownedRoot, "browser-profile");
    const nativeHost = await prepareNativeHost(home, profile, release);
    bridge = await startBrowserWebMCPBridge({ home });
    const configPath = join(ownedRoot, "agent-browser-config.json");
    await writeFile(configPath, "{}\n", { mode: 0o600 });
    return { bridge, configPath, extension, nativeHost, origin, profile, registry, server, spki };
  } catch (error) {
    await bridge?.close().catch(() => {});
    if (server) await closeFixtureServer(server).catch(() => {});
    await rm(ownedRoot, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
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
    await prepareAcceptanceEnvironment(ownedRoot, home, release);
  const bridgeEvents: Array<{ type: string; status: string; value?: unknown }> = [];
  const operations = new BrowserWebMCPOperations(
    {
      async request(request, signal) {
        const response = await bridge.request(request, signal);
        bridgeEvents.push({
          type: request.type,
          status: response.status,
          ...(response.status === "ok" ? { value: response.value } : {}),
        });
        return response;
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
            HOME: home,
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            LANG: "C",
            LC_ALL: "C",
            AGENT_BROWSER_MAX_OUTPUT: String(maximumCommandOutput),
            AGENT_BROWSER_IDLE_TIMEOUT_MS: "180000",
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
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
        }, commandTimeoutMs);
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timer);
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

    await agent(["tab", "new", `chrome-extension://${ELLIE_BROWSER_EXTENSION_ID}/popup.html`]);
    const extensionIdentity = await agentJson<{ result: unknown }>([
      "eval",
      "({id:chrome.runtime.id,url:location.href})",
    ]);
    assert.deepEqual(extensionIdentity.result, {
      id: ELLIE_BROWSER_EXTENSION_ID,
      url: `chrome-extension://${ELLIE_BROWSER_EXTENSION_ID}/popup.html`,
    });
    const bound = await agentJson<{ result: unknown }>([
      "eval",
      `(async()=>{const tabs=await chrome.tabs.query({});const tab=tabs.find(value=>value.url===${JSON.stringify(`${origin}/`)});if(!tab?.id)throw new Error('fixture_tab_missing');return chrome.runtime.sendMessage({protocol:'ellie.media.v1',tabId:tab.id,command:{type:'bindWebMCP',actionId:crypto.randomUUID()}})})()`,
    ]);
    const bindingReply = bound.result as { ok?: unknown; value?: { availability?: unknown } };
    assert.equal(bindingReply.ok, true);
    assert.equal(bindingReply.value?.availability, "webmcp");
    await waitUntil(() => bridge.connected(), "The real browser did not open the native host.");

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
        webmcpApi: "native Document.prototype.modelContext with registerTool/getTools/executeTool",
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
      commands,
      artifacts: ["before.snapshot.txt", "before.png", "after.snapshot.txt", "after.png"],
    };
  } catch (error) {
    failure = error;
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
      accessibilityFallbackAttempted: false,
      replayAttempted: false,
      commands,
      retainedRoot: ownedRoot,
    };
  } finally {
    if (browserStarted) await agent(["close"]).catch((error) => (cleanupError = String(error)));
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
  if (failure || cleanupError) throw failure ?? new Error(cleanupError);
  console.log(JSON.stringify({ status: "pass", reportDirectory }));
}

await main();
