import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LifeEmbeddedContext } from "./server.ts";
import { LocalModelReadiness, validateLocalModelConfiguration } from "./model-status.ts";
import { loadGoogleClient } from "./google-client.ts";
import { openAuthorizationUrl } from "./authorization-browser.ts";
import {
  ConnectorBroker,
  ConnectorStore,
  GoogleCalendarProvider,
  GmailProvider,
  PlaidProvider,
  HostCredentialVault,
  GoogleLoopbackOAuth,
} from "../../../packages/life-connectors/src/index.ts";
import {
  ConnectorPluginRegistry,
  type ConnectorPluginManifest,
} from "../../../packages/life-plugins/src/connectors.ts";
import type { LifeProviderAdapter } from "../../../packages/life-connectors/src/provider-types.ts";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export interface LifeApplicationOptions {
  stateDir: string;
  port?: number;
  userId?: string;
  modelUrl?: string;
  model?: string;
  assetsDir?: string;
  googleOAuth?: { clientId: string; clientSecret?: string };
  /** Trusted server adapters, never browser widget code or user-supplied module paths. */
  connectorPlugins?: Array<{ manifest: ConnectorPluginManifest; adapter: LifeProviderAdapter }>;
  openAuthorizationUrl?: (url: string) => Promise<boolean>;
}

async function prepareStateDirectory(input: string): Promise<string> {
  const state = resolve(input),
    existingCoreState = resolve(homedir(), ".ellie");
  if (state === existingCoreState || state.startsWith(`${existingCoreState}${sep}`))
    throw new Error("Ellie Life state must not use the existing ~/.ellie service directory.");
  if (state === REPOSITORY_ROOT || state.startsWith(`${REPOSITORY_ROOT}${sep}`))
    throw new Error("Life state must be outside the Ellie source checkout.");
  let ancestor = state;
  for (;;) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) throw new Error("Life state cannot use a symlink target.");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  const canonicalAncestor = await realpath(ancestor),
    canonicalCandidate = resolve(
      canonicalAncestor,
      state.slice(ancestor.length).replace(/^[/\\]+/, ""),
    );
  if (
    canonicalCandidate === REPOSITORY_ROOT ||
    canonicalCandidate.startsWith(`${REPOSITORY_ROOT}${sep}`)
  )
    throw new Error("Life state must be outside the Ellie source checkout.");
  const alreadyExists = ancestor === state;
  if (!alreadyExists) {
    await mkdir(state, { recursive: true, mode: 0o700 });
    await chmod(state, 0o700);
  }
  const info = await lstat(state);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Life state directory failed private ownership checks.");
  return state;
}

export async function createLifeApplication(options: LifeApplicationOptions) {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error(
      "Ellie Life requires Node.js 24. Run it with the repository's Node 24 toolchain.",
    );
  if ((options.modelUrl && !options.model) || (!options.modelUrl && options.model))
    throw new Error("--model-url and --model must be provided together.");
  const modelConfiguration =
    options.modelUrl && options.model
      ? { endpoint: options.modelUrl, model: options.model }
      : undefined;
  if (modelConfiguration) validateLocalModelConfiguration(modelConfiguration);
  const stateDir = await prepareStateDirectory(options.stateDir);
  const [
    core,
    contextPackage,
    taskPackage,
    pluginPackage,
    harnessPackage,
    ingestPackage,
    serverPackage,
  ] = await Promise.all([
    import("../../../packages/life-core/src/index.ts"),
    import("../../../packages/life-context/src/index.ts"),
    import("../../../packages/task-runtime/src/index.ts"),
    import("../../../packages/life-plugins/src/index.ts"),
    import("../../../packages/life-harness/src/index.ts"),
    import("../../../packages/life-ingest/src/index.ts"),
    import("./server.ts"),
  ]);
  let store: InstanceType<typeof core.LifeStore> | undefined,
    tasks: InstanceType<typeof taskPackage.TaskRuntime> | undefined,
    plugins: InstanceType<typeof pluginPackage.PluginStore> | undefined,
    connectorStore: ConnectorStore | undefined,
    vault: HostCredentialVault | undefined,
    connectors: ConnectorBroker | undefined;
  try {
    store = new core.LifeStore(join(stateDir, "life.sqlite"));
    const trustedActor = { userId: options.userId ?? "local" };
    tasks = new taskPackage.TaskRuntime({
      directory: join(stateDir, "tasks"),
      capabilityResolver: (owner) => {
        const authorized =
          owner === `user:${trustedActor.userId}` ||
          (owner.startsWith("group:") &&
            store!.listGroups(trustedActor).some((group) => owner === `group:${group.id}`));
        return authorized
          ? [
              "life.records.read",
              "life.records.write",
              ...(owner === `user:${trustedActor.userId}`
                ? ["life.connections.read", "life.connections.write"]
                : []),
            ]
          : [];
      },
    });
    plugins = new pluginPackage.PluginStore(join(stateDir, "plugins.sqlite"));
    connectorStore = new ConnectorStore(join(stateDir, "connectors.sqlite"));
    vault = new HostCredentialVault(join(stateDir, "credentials"));
    const connectorRegistry = new ConnectorPluginRegistry();
    connectorRegistry.register(
      {
        id: "google-calendar",
        label: "Google Calendar",
        kind: "connector",
        version: 1,
        observationKinds: ["event"],
        auth: "google-oauth",
        scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        origins: ["https://www.googleapis.com"],
      },
      new GoogleCalendarProvider(),
    );
    connectorRegistry.register(
      {
        id: "gmail",
        label: "Gmail",
        kind: "connector",
        version: 1,
        observationKinds: ["message"],
        auth: "google-oauth",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        origins: ["https://gmail.googleapis.com"],
      },
      new GmailProvider(),
    );
    connectorRegistry.register(
      {
        id: "plaid",
        label: "Financial accounts",
        kind: "connector",
        version: 1,
        observationKinds: ["transaction"],
        auth: "host-provisioned",
        scopes: ["transactions"],
        origins: ["https://production.plaid.com"],
      },
      new PlaidProvider(),
    );
    for (const plugin of options.connectorPlugins ?? [])
      connectorRegistry.register(plugin.manifest, plugin.adapter);
    connectors = new ConnectorBroker({
      store: connectorStore,
      life: store,
      vault,
      tasks,
      providers: connectorRegistry.adapters(),
      ...(options.googleOAuth
        ? { oauth: new GoogleLoopbackOAuth({ vault, ...options.googleOAuth }) }
        : {}),
    });
  } catch (error) {
    await connectors?.close().catch(() => {});
    try {
      vault?.close();
    } catch {}
    try {
      connectorStore?.close();
    } catch {}
    if (tasks) await tasks.close().catch(() => {});
    try {
      plugins?.close();
    } catch {}
    try {
      store?.close();
    } catch {}
    throw error;
  }
  const lifeStore = store,
    taskRuntime = tasks,
    pluginStore = plugins,
    readiness = new LocalModelReadiness(modelConfiguration);
  try {
    const mlb = new pluginPackage.MLBAdapter(),
      model =
        options.modelUrl && options.model
          ? new harnessPackage.LocalOpenAIModel(options.modelUrl, options.model)
          : undefined,
      context = new contextPackage.ProactivityEngine(lifeStore),
      harness = harnessPackage.createLifeHarness({
        store: lifeStore,
        tasks: taskRuntime,
        plugins: pluginStore,
        mlb,
        model,
        context,
      }),
      trustedActor = { userId: options.userId ?? "local" };
    let server: ReturnType<typeof serverPackage.createLifeServer>;
    const preparationMonitor = new contextPackage.PreparationMonitor({
      engine: context,
      actor: trustedActor,
      scopes: () => [
        { type: "user" as const, id: trustedActor.userId },
        ...lifeStore
          .listGroups(trustedActor)
          .map((group) => ({ type: "group" as const, id: group.id })),
      ],
      canEvaluate: () => Boolean(server?.canEvaluateBackground()),
    });
    server = serverPackage.createLifeServer({
      stateDir,
      assetsDir:
        options.assetsDir ?? resolve(fileURLToPath(new URL("../../life-ui/dist", import.meta.url))),
      store: lifeStore,
      tasks: taskRuntime,
      plugins: pluginStore,
      harness,
      mlb,
      context,
      preparationMonitor,
      connectors,
      openAuthorizationUrl: options.openAuthorizationUrl ?? openAuthorizationUrl,
      modelStatus: () => readiness.status(),
      port: options.port,
      userId: options.userId,
      extractor: (input) => ingestPackage.extractDocument(input, { signal: input.signal }),
    });
    let closed = false,
      closeInFlight: Promise<void> | undefined,
      pluginsClosed = false,
      storeClosed = false,
      vaultClosed = false,
      connectorStoreClosed = false;
    return {
      server,
      async prepareEmbedded() {
        try {
          await server.prepareEmbedded();
          taskRuntime.start();
          if (server.canEvaluateBackground()) await connectors!.resume(trustedActor.userId);
        } catch (error) {
          await this.close();
          throw error;
        }
      },
      handle(request: IncomingMessage, response: ServerResponse, context: LifeEmbeddedContext) {
        return server.handleEmbedded(request, response, context);
      },
      async listen() {
        try {
          const ready = await server.listen();
          taskRuntime.start();
          if (server.canEvaluateBackground()) await connectors!.resume(trustedActor.userId);
          return ready;
        } catch (error) {
          await this.close();
          throw error;
        }
      },
      async close() {
        if (closed) return;
        if (closeInFlight) return closeInFlight;
        closeInFlight = (async () => {
          readiness.close();
          await connectors!.close();
          await server.close();
          await taskRuntime.close();
          if (!vaultClosed) {
            vault!.close();
            vaultClosed = true;
          }
          if (!connectorStoreClosed) {
            connectorStore!.close();
            connectorStoreClosed = true;
          }
          if (!pluginsClosed) {
            pluginStore.close();
            pluginsClosed = true;
          }
          if (!storeClosed) {
            lifeStore.close();
            storeClosed = true;
          }
          closed = true;
        })();
        try {
          await closeInFlight;
        } finally {
          if (!closed) closeInFlight = undefined;
        }
      },
    };
  } catch (error) {
    readiness.close();
    await connectors!.close().catch(() => {});
    await taskRuntime.close().catch(() => {});
    try {
      vault!.close();
    } catch {}
    try {
      connectorStore!.close();
    } catch {}
    try {
      pluginStore.close();
    } catch {}
    try {
      lifeStore.close();
    } catch {}
    throw error;
  }
}

function parseArguments(args: string[]): LifeApplicationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !key ||
      !value ||
      ![
        "--state-dir",
        "--port",
        "--model-url",
        "--model",
        "--google-client-id",
        "--google-oauth-client",
      ].includes(key)
    )
      throw new Error(
        "Use: node apps/life/src/main.ts [--state-dir DIR] [--port N] [--model-url URL --model NAME] [--google-client-id ID | --google-oauth-client PRIVATE_JSON_PATH]",
      );
    values.set(key, value);
  }
  const port = Number(values.get("--port") ?? 7440);
  if (values.has("--google-client-id") && values.has("--google-oauth-client"))
    throw new Error("Use one Google client configuration option.");
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("--port must be 0 through 65535.");
  return {
    stateDir: resolve(values.get("--state-dir") ?? join(homedir(), ".ellie-life")),
    port,
    ...(values.has("--model-url") ? { modelUrl: values.get("--model-url")! } : {}),
    ...(values.has("--model") ? { model: values.get("--model")! } : {}),
    ...(values.has("--google-client-id")
      ? { googleOAuth: { clientId: values.get("--google-client-id")! } }
      : {}),
    ...(values.has("--google-oauth-client")
      ? { googleOAuth: loadGoogleClient(values.get("--google-oauth-client")!) }
      : {}),
  };
}

export async function runLife(args: string[]): Promise<void> {
  const application = await createLifeApplication(parseArguments(args));
  const ready = await application.listen();
  console.log(`Ellie Life ready at ${ready.launchUrl}`);
  let shutdownInFlight: Promise<void> | undefined;
  const shutdown = () => {
    if (shutdownInFlight) return;
    shutdownInFlight = application
      .close()
      .then(() => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        process.exit(0);
      })
      .catch(() => {
        shutdownInFlight = undefined;
        console.error("Ellie Life is still finishing active work; send the shutdown signal again.");
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runLife(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Ellie Life failed to start.");
    process.exitCode = 1;
  });
