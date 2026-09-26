import { access, lstat, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { homedir } from "node:os";
import {
  stateDir,
  ensureState,
  save,
  defaults,
  serverConfig,
  nodeConfig,
  serverUrl,
  Keychain,
  KeychainFailure,
} from "@ellie/config";
import { identifier, jobMetadata, record, string } from "@ellie/protocol";
import { Client, discoverCertificate, fingerprint } from "@ellie/transport";
import { MacOSExecutor } from "@ellie/macos";
import { WhisperCliSpeechInput, whisperCliAvailability } from "@ellie/speech";
import { Auth, newToken } from "../../server/src/auth.ts";
import { createEllieServer } from "../../server/src/index.ts";
import { JobStore } from "../../server/src/jobs.ts";
import { loadBrowserAssets } from "../../server/src/browser-assets.ts";
import { LocalInferenceWorker } from "../../node/src/inference.ts";
import { runNode } from "../../node/src/index.ts";
import { BrowserNodeExecutor } from "../../node/src/browser-executor.ts";
import { BrowserWebMCPOperations } from "../../node/src/browser-operations.ts";
import { BrowserAccessibilityRuntime } from "../../node/src/browser-accessibility-runtime.ts";
import { BrowserOperationSelector } from "../../node/src/browser-operation-selector.ts";
import { BrowserCompanionOperations } from "../../node/src/browser-companion-operations.ts";
import { startBrowserKernelBridge } from "../../node/src/browser-kernel-bridge.ts";
import { runBrowserWebMCPNativeHost } from "../../node/src/browser-native-host.ts";
import {
  browserNativeHostPreflight,
  installBrowserNativeHost,
  uninstallBrowserNativeHost,
} from "./browser-native-host-management.ts";
import { reviewedBrowserBindings } from "./browser-registry-source.ts";
import { packagedBrowserHelpers } from "./browser-runtime-paths.ts";

import { generateCertificate } from "./certificate.ts";
import { generateBrowserTlsIdentity } from "./certificate.ts";
import {
  browserStatus,
  exportBrowserCa,
  initializeBrowser,
  systemLocalHostname,
} from "./browser-setup.ts";
import { createBrowserRuntime } from "./browser-runtime.ts";
import { createBrowserRemote } from "../../server/src/browser-remote.ts";
import { parseBrowserCommand, runBrowserCommand } from "./browser-commands.ts";
import { parsePursueCommand, runBrowserPursuit } from "./browser-pursue.ts";
import { parseNativeCommand, runNativeCommand } from "./native-commands.ts";
import { parseHouseholdCommand, runHouseholdCommand } from "./household-commands.ts";
import { parseSpeechCommand, runSpeechCommand } from "./speech-commands.ts";
import { loadAgentRole, parseAgentCommand, saveAgentRole } from "./agent-role.ts";
import { Services, run, serviceRole } from "./services.ts";
import { packagedServiceContext, packagedServiceStatus } from "./packaged-service-status.ts";
import { ServiceLog, failureEvent, serviceLogs } from "./service-logs.ts";
import {
  attentionRecovery,
  holdForServiceAttention,
  serviceCredentialState,
  settleStartupCleanup,
  startupCredential,
  unknownAttentionRecovery,
} from "./service-attention.ts";
import { doctor, doctorService } from "./diagnostics.ts";
import {
  implicitSayTarget,
  nodeIdArgument,
  runServiceTest,
  selectExecutionNode,
  serviceTestOptions,
} from "./self-test.ts";
import { cliErrorMessage, coordinatorResult, privateConfig } from "./errors.ts";
import { createLifeActivationGate, lifeConfigPath, loadLifeHostConfig } from "./life-config.ts";
import { parseLifeAccessCommand, runLifeAccessCommand } from "./life-access.ts";
import { EmbeddedLifeLifecycle } from "./life-lifecycle.ts";
import {
  clearAmbientServiceLifeConfig,
  configureServiceLife,
  selectedServiceLifeConfig,
} from "./service-life-config.ts";
import {
  createDecisionRouting,
  decisionKeyAccount,
  gatewayKeyAccount,
  routingCommand,
} from "./decision-routing.ts";

const args = process.argv.slice(2);
const secrets = new Keychain();
const browserEnvironment = {
  stateDir,
  secrets,
  localHostname: systemLocalHostname,
  generate: (hostname: string) => generateBrowserTlsIdentity(hostname),
  now: Date.now,
};
let serviceLog: ServiceLog | undefined;
let startupCredentialFailure: KeychainFailure | undefined;
let startupCleanupUncertain = false;
let commandOutcomeMayBeUnknown = false;
const lifeConfigGuidance =
  "Life service configuration is unavailable. Review the private Life config or run service configure coordinator --disable-life.";
function serviceLifeConfig(path: string) {
  try {
    return loadLifeHostConfig(path);
  } catch {
    throw new Error(lifeConfigGuidance);
  }
}
async function selectedLifeConfigForService(): Promise<string | undefined> {
  try {
    const selected = await selectedServiceLifeConfig(stateDir);
    if (selected) serviceLifeConfig(selected);
    return selected;
  } catch {
    throw new Error(lifeConfigGuidance);
  }
}
async function exists(name: string): Promise<boolean> {
  try {
    await access(join(stateDir, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function ask(prompt: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Onboarding requires an interactive terminal.");
  const output = secret
    ? new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      })
    : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    if (secret) process.stdout.write(prompt);
    const value = (await rl.question(secret ? "" : prompt)).trim();
    if (secret) process.stdout.write("\n");
    return value;
  } finally {
    rl.close();
  }
}
async function controller(): Promise<Client> {
  const config = serverConfig(await privateConfig("server.json"));
  return new Client(
    `https://127.0.0.1:${config.port}`,
    await readFile(join(stateDir, "server-cert.pem"), "utf8"),
    await secrets.get("server.controller"),
  );
}
async function withController(fn: (client: Client) => Promise<void>): Promise<void> {
  const client = await controller();
  try {
    await fn(client);
  } finally {
    client.close();
  }
}
function interruptSignal(): { signal: AbortSignal; dispose: () => void } {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  return {
    signal: abort.signal,
    dispose: () => {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    },
  };
}
async function main(): Promise<void> {
  if (args[0] === "browser-webmcp" && args[1] === "host") {
    const action = args[2];
    if (
      !["preflight", "install", "uninstall"].includes(action ?? "") ||
      args.length !== 7 ||
      args[3] !== "--browser" ||
      args[4] !== "arc" ||
      args[5] !== "--release" ||
      !args[6]
    )
      throw new Error(
        "Use: ellie browser-webmcp host preflight|install|uninstall --browser arc --release ABSOLUTE_CAPTURED_RELEASE",
      );
    const home = homedir();
    if (action === "preflight") {
      const report = await browserNativeHostPreflight(home, args[6]);
      console.log(JSON.stringify(report));
      if (!report.ready) process.exitCode = 1;
    } else if (action === "install") {
      await installBrowserNativeHost(home, args[6]);
      console.log(JSON.stringify({ version: 1, browser: "arc", status: "installed" }));
    } else {
      await uninstallBrowserNativeHost(home, args[6]);
      console.log(JSON.stringify({ version: 1, browser: "arc", status: "absent" }));
    }
    return;
  }
  if (args[0] === "browser-webmcp" && args[1] === "native-host") {
    if (args.length !== 2) throw new Error("Browser native host invocation rejected.");
    try {
      await runBrowserWebMCPNativeHost({ home: homedir() });
    } catch {
      throw new Error("Browser native host unavailable.");
    }
    return;
  }
  if (args[0] === "life" && args[1] === "settings") {
    if (args.length !== 2) throw new Error("Use: bun run ellie life settings");
    const { openLifeOwnerSettings } = await import("./life-owner-settings.ts");
    await withController(async (client) => console.log(await openLifeOwnerSettings(client)));
    return;
  }
  if (args[0] === "life" && args[1] === "google-client") {
    const usage =
      "Use: bun run ellie life google-client check /absolute/private/google-client.json";
    if (args.length !== 4 || args[2] !== "check" || !isAbsolute(args[3]!)) throw new Error(usage);
    let client: { clientSecret?: string };
    try {
      const { loadGoogleClient } = await import("../../life/src/google-client.ts");
      client = loadGoogleClient(args[3]!);
    } catch {
      throw new Error(
        "Google OAuth client file is unavailable, invalid, or unsafe. Keep the downloaded desktop client outside the Ellie checkout and ~/.ellie as an owned 0600 regular file.",
      );
    }
    console.log("Google OAuth client preflight passed. No account or consent request was opened.");
    console.log(`Client secret: ${client.clientSecret ? "present" : "absent"}.`);
    console.log(
      'Next, reference this file as "googleOAuthClientFile" in the private Life host config. Calendar and Gmail remain separate read-only consent requests.',
    );
    return;
  }
  if (args[0] === "life") {
    const { runLife } = await import("../../life/src/main.ts");
    await runLife(args.slice(1));
    return;
  }
  if (args[0] === "transcribe") {
    const usage = "Use: bun run ellie transcribe --audio WAV --model PATH --executable PATH";
    const option = (name: string): string => {
      const index = args.indexOf(name);
      const value = args[index + 1];
      if (index < 0 || !value) throw new Error(usage);
      return resolve(value);
    };
    if (args.length !== 7) throw new Error(usage);
    const audioPath = option("--audio");
    const model = option("--model");
    const executable = option("--executable");
    const availability = await whisperCliAvailability({ executable, model });
    if (!availability.available)
      throw new Error(
        `Local transcription is unavailable: ${!availability.executable ? "executable path is missing" : "model path is missing"}.`,
      );
    const interrupt = interruptSignal();
    try {
      const input = new WhisperCliSpeechInput({ executable, model });
      for await (const result of input.transcribe(createReadStream(audioPath), interrupt.signal))
        if (result.final) console.log(result.text);
    } finally {
      interrupt.dispose();
    }
    return;
  }
  if (args[0] === "native") {
    const command = parseNativeCommand(args.slice(1));
    await withController(async (client) => {
      for (const line of await runNativeCommand(client, command)) console.log(line);
    });
    return;
  }
  if (args[0] === "life-access") {
    const command = parseLifeAccessCommand(args.slice(1));
    await withController(async (client) =>
      console.log(await runLifeAccessCommand(client, command)),
    );
    return;
  }
  if (args[0] === "household") {
    const command = parseHouseholdCommand(args.slice(1));
    await withController(async (client) => console.log(await runHouseholdCommand(client, command)));
    return;
  }
  if (args[0] === "speech") {
    const command = parseSpeechCommand(args.slice(1));
    await withController(async (client) => console.log(await runSpeechCommand(client, command)));
    return;
  }
  if (args[0] === "browser") {
    const environment = browserEnvironment;
    if (args[1] === "init" && args.length === 2) {
      const config = await initializeBrowser(environment);
      console.log(
        `Browser identity ready for https://${config.hostname}:${config.port}. No listener was started and no trust setting was changed.`,
      );
      return;
    }
    if (args[1] === "status" && args.length === 2) {
      const status = await browserStatus(environment);
      console.log(JSON.stringify(status, null, 2));
      if (!status.ready) process.exitCode = 1;
      return;
    }
    if (args[1] === "export-ca") {
      const force = args[3] === "--force";
      if (!args[2] || args.length !== (force ? 4 : 3))
        throw new Error("Use: bun run ellie browser export-ca PATH [--force]");
      const output = resolve(args[2]);
      await exportBrowserCa(environment, output, force);
      console.log(
        `Public browser CA exported to ${output}. Transfer only this public certificate through an existing trusted local channel; installation does not enable trust automatically.`,
      );
      return;
    }
    if (args[1] === "pursue") {
      const parsed = parsePursueCommand(args.slice(2));
      const interrupt = interruptSignal();
      try {
        await withController(async (client) => {
          const nodeId = selectExecutionNode(
            await client.call("GET", "/v1/nodes"),
            parsed.nodeId,
          ).id;
          const report = await runBrowserPursuit(client, {
            nodeId,
            goal: parsed.goal,
            maxSteps: parsed.maxSteps,
            signal: interrupt.signal,
            onDispatch: () => {
              commandOutcomeMayBeUnknown = true;
            },
            onSettle: () => {
              commandOutcomeMayBeUnknown = false;
            },
          });
          commandOutcomeMayBeUnknown = false;
          for (const line of report.lines) console.log(line);
          if (!(report.outcome === "satisfied_unverified" && report.dispatched === 0))
            process.exitCode = 1;
        });
      } finally {
        interrupt.dispose();
      }
      return;
    }
    const command = parseBrowserCommand(args.slice(1));
    await withController(async (client) => {
      for (const line of await runBrowserCommand(client, command)) console.log(line);
    });
    return;
  }
  if (args[0] === "agent") {
    const command = parseAgentCommand(args);
    if (command.setRole) {
      const saved = await saveAgentRole(command.setRole);
      console.log(
        `This Mac is configured as the ${saved.role}. Start it with: bun run ellie agent`,
      );
      return;
    }
    const configured = await loadAgentRole();
    if (!configured)
      throw new Error(
        "This Mac has no Ellie role yet. Choose one with: bun run ellie agent --set-role coordinator|node",
      );
    // One launch agent runs whichever role this Mac was given, so the installed
    // bundle never needs a per-role service definition.
    args.splice(0, args.length, "service", "run", configured.role);
  }
  if (args[0] === "service") {
    const action = args[1];
    if (action === "test") {
      const options = serviceTestOptions(args.slice(2));
      if (options.desktopApp)
        console.log(
          `Desktop test requested: Ellie will open the allowed app “${options.desktopApp}” on the selected node.`,
        );
      await withController(async (client) => {
        const report = await runServiceTest(client, options, Date.now(), {
          submit: () => {
            commandOutcomeMayBeUnknown = true;
          },
          settle: () => {
            commandOutcomeMayBeUnknown = false;
          },
        });
        commandOutcomeMayBeUnknown = false;
        report.lines.forEach((line) => console.log(line));
      });
      return;
    }
    if (action === "configure") {
      const role = serviceRole(args[2]);
      if (role !== "coordinator") throw new Error("Life can only be configured for coordinator.");
      let selection: string | undefined;
      if (args.length === 5 && args[3] === "--life-config") selection = args[4];
      else if (!(args.length === 4 && args[3] === "--disable-life"))
        throw new Error(
          "Use: bun run ellie service configure coordinator --life-config /absolute/private/config.json | --disable-life",
        );
      const result = await configureServiceLife(stateDir, selection, serviceLifeConfig);
      console.log(
        `Coordinator Life configuration ${result}; changes apply on the next explicit restart.`,
      );
      return;
    }
    const role = serviceRole(args[2]);
    if (args.length !== 3)
      throw new Error(
        "Use: bun run ellie service install|start|stop|status|uninstall|logs coordinator|node",
      );
    const services = new Services();
    if (action === "run") {
      process.umask(0o077);
      serviceLog = await ServiceLog.open(stateDir, role);
      serviceLog.write("starting");
      await services.validate(role);
      clearAmbientServiceLifeConfig(process.env);
      const selectedLife =
        role === "coordinator" ? await selectedLifeConfigForService() : undefined;
      args.splice(
        0,
        args.length,
        role === "coordinator" ? "server" : "node",
        "start",
        ...(selectedLife ? ["--life-config", selectedLife] : []),
      );
    } else {
      if (action === "status") {
        const context = packagedServiceContext();
        const status = context
          ? await packagedServiceStatus(role, context, run)
          : await services.status(role);
        let runtime: Awaited<ReturnType<typeof serviceCredentialState>> = "none";
        if (status.state === "running") {
          try {
            runtime = await serviceCredentialState(stateDir, role);
          } catch {
            throw new Error("Service attention records could not be inspected safely.");
          }
        }
        const selectedLife =
          role === "coordinator" ? await selectedLifeConfigForService() : undefined;
        console.log(
          JSON.stringify(
            role === "coordinator"
              ? {
                  ...status,
                  ...(runtime === "needs_attention"
                    ? { runtime: "needs_attention", recovery: attentionRecovery }
                    : runtime === "starting"
                      ? { runtime: "starting" }
                      : runtime === "unknown"
                        ? { runtime: "unknown", recovery: unknownAttentionRecovery }
                        : {}),
                  lifeOnNextStart: selectedLife ? "enabled" : "disabled",
                }
              : runtime === "needs_attention"
                ? { ...status, runtime: "needs_attention", recovery: attentionRecovery }
                : runtime === "starting"
                  ? { ...status, runtime: "starting" }
                  : runtime === "unknown"
                    ? { ...status, runtime: "unknown", recovery: unknownAttentionRecovery }
                    : status,
            null,
            2,
          ),
        );
      } else if (action === "logs")
        console.log(JSON.stringify(await serviceLogs(stateDir, role), null, 2));
      else if (
        action === "install" ||
        action === "start" ||
        action === "stop" ||
        action === "uninstall"
      ) {
        await services[action](role);
        console.log(
          action === "install"
            ? `Service installed with its Ellie app name and icon. Run service start, then doctor; existing pairing and Keychain credentials were preserved.${role === "node" ? " Enable Ellie Node in Accessibility for window control." : ""}`
            : action === "start"
              ? "Service start requested. Check service status and doctor for readiness."
              : action === "stop"
                ? "Service stopped and disabled for future logins."
                : "Service uninstalled. Private state, logs, and Keychain credentials were preserved.",
        );
      } else
        throw new Error(
          "Use: bun run ellie service install|start|stop|status|uninstall|logs coordinator|node",
        );
      return;
    }
  }
  if (args[0] === "server" && args[1] === "init") {
    if (await exists("server.json"))
      throw new Error("Server is already initialized. Existing identity was preserved.");
    await ensureState();
    const certPath = join(stateDir, "server-cert.pem");
    const { key, cert } = await generateCertificate();
    const token = newToken();
    await secrets.set("server.key", key);
    await secrets.set("server.controller", token);
    await writeFile(certPath, cert, { mode: 0o600 });
    await Auth.initialize(token);
    await save("server.json", {
      version: 1,
      host: args.includes("--lan") ? "0.0.0.0" : "127.0.0.1",
      port: 7437,
      preferences: defaults,
    });
    console.log("Server initialized. Start it with: bun run ellie server start");
    return;
  }
  if (args[0] === "server" && args[1] === "configure") {
    const lan = args.includes("--lan");
    if (args.length !== 3 || (!lan && !args.includes("--local")))
      throw new Error("Use: bun run ellie server configure --lan | --local");
    const config = serverConfig(await privateConfig("server.json"));
    const host = lan ? "0.0.0.0" : "127.0.0.1";
    if (config.host === host) {
      console.log(`Coordinator already listens on ${host}. Nothing was changed.`);
      return;
    }
    // Only the listening address changes. Clients pin the certificate rather than a
    // hostname, so the existing identity, pairings and credentials stay valid.
    await save("server.json", { ...config, host });
    console.log(
      `Coordinator will listen on ${host} after an explicit restart. Existing identity and pairings were preserved.`,
    );
    return;
  }
  if (args[0] === "server" && args[1] === "start") {
    const configuredLifePath = lifeConfigPath(args.slice(2), process.env);
    const lifeConfig = configuredLifePath ? loadLifeHostConfig(configuredLifePath) : undefined;
    const config = serverConfig(await privateConfig("server.json"));
    const cert = await readFile(join(stateDir, "server-cert.pem"), "utf8");
    const jobStore = new JobStore(join(stateDir, "jobs.sqlite"));
    let embeddedLife:
      | Awaited<ReturnType<(typeof import("../../life/src/embedded.ts"))["createLifeApplication"]>>
      | undefined;
    const lifeLifecycle = new EmbeddedLifeLifecycle<NonNullable<typeof embeddedLife>>();
    const lifeGate = lifeConfig ? createLifeActivationGate() : undefined;
    // The coordinator lifetime lock also owns the single browser authorization writer.
    const browser = createBrowserRuntime({
      setup: browserEnvironment,
      bindHost: config.host,
      loadAssets: loadBrowserAssets,
      createRemote: async () => {
        const upstream = new Client(
          `https://127.0.0.1:${config.port}`,
          cert,
          await secrets.get("server.controller"),
        );
        return { remote: createBrowserRemote(upstream), close: () => upstream.close() };
      },
      ...(lifeGate && lifeConfig
        ? { life: { application: lifeGate.application, actorIds: [lifeConfig.actorId] } }
        : {}),
    });
    let app: ReturnType<typeof createEllieServer> | undefined;
    try {
      const key = await startupCredential(
        () => secrets.get("server.key"),
        (error) => {
          startupCredentialFailure = error;
        },
      );
      const auth = await Auth.open();
      let decisionRouting;
      try {
        decisionRouting = await createDecisionRouting(config.decisionRouting, secrets);
      } catch {
        console.error(
          "Optional decision routing could not be initialized. Deterministic commands remain available.",
        );
      }
      const created = createEllieServer({
        key,
        cert,
        auth,
        preferences: config.preferences,
        jobStore,
        browser,
        decisionRouting,
      });
      app = created;
      await new Promise<void>((resolve, reject) => {
        created.server.once("error", reject);
        created.server.listen(config.port, config.host, () => resolve());
      });
    } catch (error) {
      const cleanupUncertain = await settleStartupCleanup([
        () => browser.shutdown(),
        () =>
          lifeLifecycle.shutdown(() => {
            if (app) app.shutdown();
            else jobStore.close();
          }),
      ]);
      if (cleanupUncertain) {
        if (error === startupCredentialFailure) startupCleanupUncertain = true;
        else throw new Error("Coordinator startup cleanup is uncertain.");
      }
      throw error;
    }
    if (!app) throw new Error("Coordinator failed to initialize.");
    let stopPromise: Promise<void> | undefined;
    const stop = () =>
      (stopPromise ??= (async () => {
        try {
          serviceLog?.write("stopping");
        } finally {
          await browser.shutdown();
          await lifeLifecycle.shutdown(() => app!.shutdown());
        }
      })());
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void stop().catch(() => {
          process.exitCode = 1;
        });
      });
    // Agent readiness and signal handlers precede optional browser Keychain access.
    await browser.start();
    if (lifeConfig) {
      const current = browser.current();
      if (current.status !== "ready" || !current.nativeLife) {
        await stop();
        throw new Error(
          "Configured Ellie Life could not start because native Life authority is not ready.",
        );
      }
      try {
        await lifeLifecycle.start(
          async () =>
            (embeddedLife = await (
              await import("../../life/src/embedded.ts")
            ).createLifeApplication({
              stateDir: lifeConfig.stateDir,
              userId: lifeConfig.actorId,
              ...(lifeConfig.modelUrl
                ? { modelUrl: lifeConfig.modelUrl, model: lifeConfig.model }
                : {}),
              ...(lifeConfig.googleOAuth ? { googleOAuth: lifeConfig.googleOAuth } : {}),
            })),
          async (application) => {
            await application.prepareEmbedded();
            if (!stopPromise) lifeGate!.activate(application);
          },
        );
      } catch (error) {
        await stop();
        throw error;
      }
    }
    if (stopPromise) return;
    console.log(`Ellie server ready on port ${config.port}. No model or cloud API is required.`);
    serviceLog?.write("ready");
    const status = browser.current().status;
    if (status === "ready") serviceLog?.write("browser_ready");
    else if (status === "unavailable") serviceLog?.write("browser_unavailable");
    return;
  }
  if (args[0] === "routing") {
    const raw = record(await privateConfig("server.json"));
    const config = serverConfig(raw);
    const command = routingCommand(args.slice(1), config.decisionRouting);
    if (command.kind === "status") {
      console.log(JSON.stringify(config.decisionRouting ?? { mode: "off" }, null, 2));
      console.log("This is the saved configuration; restart the coordinator after changes.");
      return;
    }
    if (command.needsKey) {
      const gateway = command.kind === "save" && command.config?.provider === "gateway";
      console.log(
        `Cloud routing will send unmatched commands, allowed app/site candidates, and the previous successful app context to ${gateway ? "Vercel AI Gateway for TypeSafe Jev" : "TypeSafe"}. Setup starts in shadow mode.`,
      );
      const key = await ask(
        gateway ? "AI Gateway API key (hidden): " : "TypeSafe API key (hidden): ",
        true,
      );
      if (!key || key.length > 4096 || /\s/.test(key))
        throw new Error(`Enter a valid ${gateway ? "AI Gateway" : "TypeSafe"} API key.`);
      await secrets.set(gateway ? gatewayKeyAccount : decisionKeyAccount, key);
    }
    if (command.config) raw.decisionRouting = command.config;
    else delete raw.decisionRouting;
    await save("server.json", raw);
    console.log(
      `Decision routing saved (${command.config?.mode ?? "off"}). Restart the coordinator to apply it.`,
    );
    return;
  }
  if (args[0] === "server" && args[1] === "pair") {
    await withController(async (client) => {
      const invite = record(await client.call("POST", "/v1/invite", {}));
      console.log("Server SHA-256 fingerprint (verify on the node):");
      console.log(fingerprint(await readFile(join(stateDir, "server-cert.pem"), "utf8")));
      console.log(
        "One-time pairing code, valid for 10 minutes. Enter only into your node pairing prompt:",
      );
      console.log(string(invite.code, 64));
    });
    return;
  }
  if (args[0] === "server" && args[1] === "revoke") {
    const id = identifier(args[2]);
    await withController(async (client) => {
      await client.call("POST", "/v1/revoke", { id });
      console.log("Node revoked.");
    });
    return;
  }
  if (args[0] === "node" && args[1] === "pair") {
    if (await exists("node.json"))
      throw new Error("This node is already paired. See docs/security.md for re-pairing.");
    await ensureState();
    // Check Keychain/helper availability before consuming an invitation.
    const id = randomUUID();
    await secrets.set(`node.${id}`, "pending-pairing");
    const origin = serverUrl(await ask("Server URL (https:// plus its LAN address and :7437): "));
    const pin = await ask("Server SHA-256 fingerprint: ");
    const cert = await discoverCertificate(origin, pin);
    const code = await ask("One-time pairing code (hidden): ", true);
    const client = new Client(origin, cert);
    try {
      const response = record(await client.call("POST", "/v1/pair", { id, code }));
      await secrets.set(`node.${id}`, string(response.token, 64));
      await writeFile(join(stateDir, "node-server-cert.pem"), cert, { mode: 0o600 });
      await save("node.json", { version: 1, id, serverUrl: origin, preferences: defaults });
      console.log("Paired. Run bun run ellie doctor, then bun run ellie node start");
    } finally {
      client.close();
    }
    return;
  }
  if (args[0] === "node" && args[1] === "start") {
    const config = nodeConfig(await privateConfig("node.json"));
    const client = new Client(
      config.serverUrl,
      await readFile(join(stateDir, "node-server-cert.pem"), "utf8"),
      await startupCredential(
        () => secrets.get(`node.${config.id}`),
        (error) => {
          startupCredentialFailure = error;
        },
      ),
    );
    const abort = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        try {
          serviceLog?.write("stopping");
        } finally {
          abort.abort();
          client.close();
        }
      });
    const native = new MacOSExecutor();
    let browserBridge: Awaited<ReturnType<typeof startBrowserKernelBridge>> | undefined;
    let browserAccessibility: BrowserAccessibilityRuntime | undefined;
    let nodeFailure: unknown;
    let nodeFailed = false;
    try {
      const browserRegistry = config.executionEnabled
        ? await reviewedBrowserBindings(stateDir)
        : undefined;
      const browserHelpers = browserRegistry ? packagedBrowserHelpers() : undefined;
      browserBridge = browserRegistry
        ? await startBrowserKernelBridge({
            home: dirname(stateDir),
            executable: browserHelpers!.broker,
          })
        : undefined;
      const webmcp = browserBridge
        ? new BrowserWebMCPOperations(browserBridge, browserRegistry!)
        : undefined;
      browserAccessibility = browserBridge
        ? new BrowserAccessibilityRuntime(browserHelpers!.accessibility, () =>
            browserBridge?.connectionContext(),
          )
        : undefined;
      const executor =
        browserBridge && webmcp && browserAccessibility
          ? new BrowserNodeExecutor(
              native,
              new BrowserOperationSelector(
                (signal, refresh) =>
                  refresh ? webmcp.bindingRefresh(signal) : webmcp.bindingStatus(signal),
                webmcp,
                browserAccessibility,
                new BrowserCompanionOperations(browserBridge),
              ),
            )
          : native;
      await runNode({
        client,
        executor: config.executionEnabled ? executor : undefined,
        worker: config.inferenceWorker
          ? new LocalInferenceWorker(config.inferenceWorker)
          : undefined,
        health: () => native.health(),
        preferences: config.preferences,
        signal: abort.signal,
        onStatus: serviceLog ? undefined : console.log,
        onEvent: (event) => serviceLog?.write(event),
      });
    } catch (error) {
      nodeFailed = true;
      nodeFailure = error;
    }
    const browserCleanup = await Promise.allSettled([
      browserAccessibility?.close(),
      browserBridge?.close(),
    ]);
    client.close();
    if (browserCleanup.some((result) => result.status === "rejected"))
      throw new Error("Browser runtime cleanup was incomplete.", {
        cause: nodeFailed ? nodeFailure : undefined,
      });
    if (nodeFailed) throw nodeFailure;
    return;
  }
  if (args[0] === "doctor") {
    const report = args[1] ? await doctorService(serviceRole(args[1])) : await doctor();
    report.lines.forEach((line) => console.log(line));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (args[0] === "nodes") {
    await withController(async (client) => {
      console.log(JSON.stringify(await client.call("GET", "/v1/nodes"), null, 2));
    });
    return;
  }
  if (args[0] === "jobs") {
    await withController(async (client) => {
      console.log(JSON.stringify(await client.call("GET", "/v1/jobs"), null, 2));
    });
    return;
  }
  if (args[0] === "job") {
    const id = identifier(args[1]);
    await withController(async (client) => {
      console.log(JSON.stringify(jobMetadata(await client.call("GET", `/v1/jobs/${id}`)), null, 2));
    });
    return;
  }
  if (args[0] === "cancel") {
    const id = identifier(args[1]);
    await withController(async (client) => {
      console.log(
        JSON.stringify(jobMetadata(await client.call("POST", `/v1/jobs/${id}`, {})), null, 2),
      );
    });
    return;
  }
  if (args[0] === "infer") {
    const model = string(args[1], 200);
    const prompt = string(args.slice(2).join(" "), 4000);
    await withController(async (client) => {
      const interrupt = interruptSignal();
      try {
        commandOutcomeMayBeUnknown = true;
        const response = coordinatorResult(
          await client.call("POST", "/v1/inference", { model, prompt }, interrupt),
        );
        commandOutcomeMayBeUnknown = false;
        console.log(response.message);
        if (!response.ok) process.exitCode = 1;
      } finally {
        interrupt.dispose();
      }
    });
    return;
  }
  if (args[0] === "say") {
    let client: Client;
    let nodeId: string;
    let words: string[];
    if (args[1] === "--node") {
      nodeId = nodeIdArgument(args[2]);
      words = args.slice(3);
      client = await controller();
    } else if (implicitSayTarget(await exists("server.json")) === "node") {
      const config = nodeConfig(await privateConfig("node.json"));
      nodeId = config.id;
      words = args.slice(1);
      client = new Client(
        config.serverUrl,
        await readFile(join(stateDir, "node-server-cert.pem"), "utf8"),
        await secrets.get(`node.${config.id}`),
      );
    } else {
      client = await controller();
      nodeId = selectExecutionNode(await client.call("GET", "/v1/nodes")).id;
      words = args.slice(1);
    }
    const interrupt = interruptSignal();
    try {
      commandOutcomeMayBeUnknown = true;
      const response = coordinatorResult(
        await client.call(
          "POST",
          "/v1/commands",
          { nodeId, text: string(words.join(" "), 500) },
          interrupt,
        ),
      );
      commandOutcomeMayBeUnknown = false;
      console.log(response.message);
      if (!response.ok) process.exitCode = 1;
    } finally {
      interrupt.dispose();
      client.close();
    }
    return;
  }
  console.log(
    `Ellie — local-first personal assistant\n\n  life [OPTIONS]        Start the local life assistant and chat client\n  life settings         Open installed Life account settings on this Mac\n  life google-client check PATH  Validate a private Google OAuth client without consent\n  server init [--lan]   Generate private config and Keychain identity\n  server configure --lan | --local  Change the listening address, preserving identity\n  server start [--life-config PATH]  Start HTTPS coordinator with optional Life account\n  life-access grants    List explicit native Life account grants\n  life-access grant CLIENT ACTOR     Grant explicit Life account access\n  life-access revoke CLIENT          Revoke explicit Life account access\n  server pair           Issue a single-use pairing invitation\n  server revoke ID      Revoke a paired node\n  native invite ...     Issue scoped native app enrollment\n  native clients        List active native app credentials\n  native revoke ID      Revoke a native app credential\n  household grants      List explicit native data grants\n  household grant ...   Grant scoped native household data access\n  household revoke ...  Revoke scoped native household data access\n  browser init          Prepare a separate local browser TLS identity\n  browser status        Inspect browser identity readiness without printing keys\n  browser export-ca P   Export only the public browser CA; --force replaces P\n  browser connection    Inspect the running browser listener\n  browser invite ROLE   phone|tv --label NAME; phone also needs --node ID --allow CAPS\n  browser clients       List paired browser identities\n  browser revoke ID     Revoke a paired browser identity\n  browser pursue --max-steps N --allow-page-content "goal" [--node ID]  Bounded AX click loop\n  node pair             Pair this Mac interactively\n  node start            Run enabled execution and inference roles\n  agent [--set-role R]  Run this Mac's configured role, or record it\n  service ACTION ROLE   install|start|stop|status|uninstall|logs; coordinator|node\n  service test [FLAGS]  Read-only readiness; --desktop --app NAME opts into app opening\n  doctor [ROLE]         Check native tools or role-specific service health\n  nodes                 List capabilities and worker telemetry (server Mac)\n  infer MODEL "..."     Run inference on an eligible Mac (server Mac)\n  routing status|off    Inspect or disable optional semantic routing\n  routing typesafe --allow-cloud  Set up direct Jev in shadow mode\n  routing gateway --allow-cloud   Set up Jev through AI Gateway in shadow mode\n  routing local MODEL --endpoint URL  Use a local decision model\n  routing mode MODE    Select shadow or execute, then restart\n  jobs                   List recent payload-free job metadata\n  job ID                 Inspect payload-free job metadata\n  cancel ID              Request job cancellation\n  say "open Arc"        Send to this Mac, or the only online execution node\n  say --node ID "..."   Target a paired Mac from the server`,
  );
  console.log(
    "  transcribe --audio WAV --model PATH --executable PATH\n" +
      "                         Transcribe one bounded WAV turn with local whisper.cpp",
  );
}
main().catch(async (error) => {
  if (serviceLog) {
    const needsAttention = error === startupCredentialFailure && error instanceof KeychainFailure;
    try {
      serviceLog.write(failureEvent(error));
      if (startupCleanupUncertain) serviceLog.write("service_cleanup_uncertain");
      if (needsAttention) serviceLog.write("needs_attention");
    } catch {
      /* Stderr is discarded by launchd; never fall back to raw errors. */
    }
    if (needsAttention) {
      console.error(
        "Service credentials need attention. Review service logs and stop/start explicitly.",
      );
      await holdForServiceAttention();
      return;
    }
    console.error("Service failed. Run doctor and service logs for diagnostics.");
    process.exitCode = 1;
    return;
  }
  console.error(cliErrorMessage(error, commandOutcomeMayBeUnknown));
  process.exitCode = 1;
});
