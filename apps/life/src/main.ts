import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export interface LifeApplicationOptions {
  stateDir: string;
  port?: number;
  userId?: string;
  modelUrl?: string;
  model?: string;
  assetsDir?: string;
}

function validateModelEndpoint(value: string): void {
  const url = new URL(value),
    host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "::1"].includes(host) ||
    url.username ||
    url.password
  )
    throw new Error("--model-url must be an unauthenticated HTTP loopback URL.");
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
  if (options.modelUrl) validateModelEndpoint(options.modelUrl);
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
    plugins: InstanceType<typeof pluginPackage.PluginStore> | undefined;
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
        return authorized ? ["life.records.read", "life.records.write"] : [];
      },
    });
    plugins = new pluginPackage.PluginStore(join(stateDir, "plugins.sqlite"));
  } catch (error) {
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
    pluginStore = plugins;
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
      server = serverPackage.createLifeServer({
        stateDir,
        assetsDir:
          options.assetsDir ??
          resolve(fileURLToPath(new URL("../../life-ui/dist", import.meta.url))),
        store: lifeStore,
        tasks: taskRuntime,
        plugins: pluginStore,
        harness,
        mlb,
        context,
        port: options.port,
        userId: options.userId,
        extractor: (input) => ingestPackage.extractDocument(input, { signal: input.signal }),
      });
    let closed = false;
    return {
      server,
      async listen() {
        try {
          const ready = await server.listen();
          taskRuntime.start();
          return ready;
        } catch (error) {
          await this.close();
          throw error;
        }
      },
      async close() {
        if (closed) return;
        await server.close();
        await taskRuntime.close();
        pluginStore.close();
        lifeStore.close();
        closed = true;
      },
    };
  } catch (error) {
    await taskRuntime.close().catch(() => {});
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
    if (!key || !value || !["--state-dir", "--port", "--model-url", "--model"].includes(key))
      throw new Error(
        "Use: node apps/life/src/main.ts [--state-dir DIR] [--port N] [--model-url URL --model NAME]",
      );
    values.set(key, value);
  }
  const port = Number(values.get("--port") ?? 7440);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("--port must be 0 through 65535.");
  return {
    stateDir: resolve(values.get("--state-dir") ?? join(homedir(), ".ellie-life")),
    port,
    ...(values.has("--model-url") ? { modelUrl: values.get("--model-url")! } : {}),
    ...(values.has("--model") ? { model: values.get("--model")! } : {}),
  };
}

export async function runLife(args: string[]): Promise<void> {
  const application = await createLifeApplication(parseArguments(args));
  const ready = await application.listen();
  console.log(`Ellie Life ready at ${ready.launchUrl}`);
  const shutdown = () => void application.close().then(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runLife(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Ellie Life failed to start.");
    process.exitCode = 1;
  });
