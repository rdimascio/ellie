import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLifeServer } from "../apps/life/src/server.ts";
import { LocalModelReadiness } from "../apps/life/src/model-status.ts";
import { LifeStore } from "../packages/life-core/src/index.ts";
import {
  createLifeHarness,
  LocalOpenAIModel,
  type LifeModel,
} from "../packages/life-harness/src/index.ts";
import { MLBAdapter, PluginStore } from "../packages/life-plugins/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";

export type BrowserQualityModel =
  | { mode: "synthetic" }
  | { mode: "loopback"; url: string; model: string };

export interface LifeBrowserQualityFixture {
  readonly url: string;
  /** Sensitive one-use browser bootstrap URL. Never include it in reports or artifacts. */
  readonly launchUrl: string;
  readonly actorId: string;
  readonly modelMode: "synthetic" | "loopback";
  readonly source: {
    ui: "real-built";
    http: "real";
    storage: "real";
    taskRuntime: "real";
    model: "synthetic" | "loopback";
    mlb: "synthetic";
  };
  readonly captures: {
    modelMessages: Array<Array<{ role: string; content: string }>>;
  };
  readonly syntheticModelGate?: {
    holdNext(): { entered: Promise<void>; release(): void };
  };
  restart(): Promise<void>;
  close(): Promise<void>;
  stores(): { life: LifeStore; plugins: PluginStore; tasks: TaskRuntime };
}

export interface LifeBrowserQualityFixtureOptions {
  model?: BrowserQualityModel;
  now?: () => number;
  actorId?: string;
}

const syntheticStandings = {
  records: [
    {
      division: { id: 200, name: "Synthetic West" },
      teamRecords: [
        {
          team: { id: 1, name: "Fixture Stars" },
          wins: 81,
          losses: 61,
          winningPercentage: ".570",
          gamesBack: "-",
        },
      ],
    },
  ],
};
const syntheticSchedule = {
  dates: [
    {
      games: [
        {
          gamePk: 9001,
          gameDate: "2026-09-15T02:10:00Z",
          status: { detailedState: "Synthetic final" },
          teams: {
            away: { team: { name: "Fixture Moons" }, score: 2 },
            home: { team: { name: "Fixture Stars" }, score: 4 },
          },
          linescore: { currentInning: 9, inningHalf: "Bottom" },
        },
      ],
    },
  ],
};

function syntheticMlbFetch(url: string | URL | Request): Promise<Response> {
  const target = String(url);
  if (target.startsWith("https://statsapi.mlb.com/api/v1/standings?"))
    return Promise.resolve(Response.json(syntheticStandings));
  if (target.startsWith("https://statsapi.mlb.com/api/v1/schedule?"))
    return Promise.resolve(Response.json(syntheticSchedule));
  return Promise.reject(new Error("Synthetic MLB fixture rejected an unexpected URL."));
}

export async function startLifeBrowserQualityFixture(
  options: LifeBrowserQualityFixtureOptions = {},
): Promise<LifeBrowserQualityFixture> {
  const actorId = options.actorId ?? "browser-quality-user";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(actorId))
    throw new TypeError("Quality fixture actor ID is invalid.");
  const assetsDir = resolve("apps/life-ui/dist");
  const assets = await stat(join(assetsDir, "index.html"));
  if (!assets.isFile()) throw new Error("Build apps/life-ui before starting the quality fixture.");
  const captures: LifeBrowserQualityFixture["captures"] = { modelMessages: [] };
  const configuredModel = options.model ?? { mode: "synthetic" as const };
  let pendingGate:
    | { entered(): void; released: Promise<void>; release(): void; consumed: boolean }
    | undefined;
  const syntheticModelGate =
    configuredModel.mode === "synthetic"
      ? {
          holdNext() {
            if (pendingGate) throw new Error("A synthetic model gate is already pending.");
            let enter!: () => void;
            let release!: () => void;
            const entered = new Promise<void>((resolve) => (enter = resolve));
            const released = new Promise<void>((resolve) => (release = resolve));
            pendingGate = { entered: enter, released, release, consumed: false };
            return { entered, release };
          },
        }
      : undefined;
  const captureFetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    captures.modelMessages.push(structuredClone(body.messages));
    if (configuredModel.mode === "loopback") return fetch(input, init);
    const gate = pendingGate;
    if (gate && !gate.consumed) {
      gate.consumed = true;
      gate.entered();
      const signal = init?.signal;
      let abort: (() => void) | undefined;
      try {
        await Promise.race([
          gate.released,
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal?.reason);
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          }),
        ]);
      } finally {
        if (abort) signal?.removeEventListener("abort", abort);
        if (pendingGate === gate) pendingGate = undefined;
      }
    }
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reply:
                "Synthetic contextual reply. Inspect captures.modelMessages for host context evidence.",
              actions: [],
            }),
          },
        },
      ],
    });
  };
  const model: LifeModel =
    configuredModel.mode === "loopback"
      ? new LocalOpenAIModel(configuredModel.url, configuredModel.model, captureFetch)
      : new LocalOpenAIModel("http://127.0.0.1:8080/v1", "synthetic-browser-quality", captureFetch);
  const readiness = new LocalModelReadiness(
    configuredModel.mode === "loopback"
      ? { endpoint: configuredModel.url, model: configuredModel.model }
      : undefined,
    { now: options.now },
  );
  const root = await mkdtemp(join(tmpdir(), "ellie-browser-quality-"));
  await chmod(root, 0o700);
  const stateDir = join(root, "life");
  await mkdir(stateDir, { mode: 0o700 });
  let life!: LifeStore,
    plugins!: PluginStore,
    tasks!: TaskRuntime,
    server: ReturnType<typeof createLifeServer> | undefined,
    currentUrl = "",
    currentLaunchUrl = "",
    closed = false;
  const openStores = () => {
    life = new LifeStore(join(stateDir, "life.sqlite"), { now: options.now });
    plugins = new PluginStore(join(stateDir, "plugins.sqlite"), options.now ?? Date.now);
    tasks = new TaskRuntime({
      directory: join(stateDir, "tasks"),
      tickMs: 20,
      now: options.now,
      capabilityResolver: () => ["life.records.read", "life.records.write"],
    });
  };
  const stop = async () => {
    const failures: unknown[] = [];
    const gate = pendingGate;
    pendingGate = undefined;
    gate?.release();
    if (server) await server.close().catch((error) => failures.push(error));
    server = undefined;
    if (tasks) await tasks.close().catch((error) => failures.push(error));
    try {
      plugins?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      life?.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Quality fixture teardown failed.");
  };
  const start = async () => {
    openStores();
    const mlb = new MLBAdapter(syntheticMlbFetch as typeof fetch, options.now ?? Date.now);
    // Keep construction explicit so every browser route exercises production stores and handlers.
    const actualHarness = createLifeHarness({
      store: life,
      plugins,
      tasks,
      mlb,
      model,
      now: options.now,
    });
    server = createLifeServer({
      stateDir,
      assetsDir,
      store: life,
      plugins,
      tasks,
      harness: actualHarness,
      mlb,
      modelStatus:
        configuredModel.mode === "loopback"
          ? () => readiness.status()
          : async () => ({
              mode: "local",
              configured: true,
              available: true,
              model: "synthetic-browser-quality",
              checkedAt: (options.now ?? Date.now)(),
              capabilities: { chat: true, customApps: false },
              reason: "ready",
            }),
      port: 0,
      userId: actorId,
      userName: "Browser Quality",
      timeZone: "America/Los_Angeles",
      now: options.now,
      token: randomUUID().replaceAll("-", "") + randomUUID(),
    });
    tasks.start();
    const listening = await server.listen();
    currentUrl = listening.url;
    currentLaunchUrl = listening.launchUrl;
  };
  try {
    await start();
  } catch (error) {
    const failures: unknown[] = [error];
    readiness.close();
    await stop().catch((caught) => failures.push(caught));
    await rm(root, { recursive: true, force: true }).catch((caught) => failures.push(caught));
    if (failures.length > 1)
      throw new AggregateError(failures, "Quality fixture setup and cleanup failed.");
    throw error;
  }
  return {
    get url() {
      return currentUrl;
    },
    get launchUrl() {
      return currentLaunchUrl;
    },
    actorId,
    modelMode: configuredModel.mode,
    source: {
      ui: "real-built",
      http: "real",
      storage: "real",
      taskRuntime: "real",
      model: configuredModel.mode,
      mlb: "synthetic",
    },
    captures,
    ...(syntheticModelGate ? { syntheticModelGate } : {}),
    stores: () => ({ life, plugins, tasks }),
    async restart() {
      if (closed) throw new Error("Quality fixture is closed.");
      await stop();
      await start();
    },
    async close() {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      readiness.close();
      await stop().catch((error) => failures.push(error));
      await rm(root, { recursive: true, force: true }).catch((error) => failures.push(error));
      if (failures.length) throw new AggregateError(failures, "Quality fixture close failed.");
    },
  };
}
