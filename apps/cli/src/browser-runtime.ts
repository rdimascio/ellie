import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserSetupEnvironment } from "./browser-setup.ts";
import { BROWSER_CONFIG, loadBrowserServerIdentity } from "./browser-setup.ts";
import { BrowserAuth } from "../../server/src/browser-auth.ts";
import type { BrowserControl } from "../../server/src/browser-management.ts";
import { createBrowserServer } from "../../server/src/browser-server.ts";
import type {
  BrowserAssets,
  BrowserServer,
  BrowserServerOptions,
} from "../../server/src/browser-server.ts";

type BrowserUnavailableReason = Extract<
  ReturnType<BrowserControl["current"]>,
  { status: "unavailable" }
>["reason"];

export interface BrowserRuntimeOptions {
  setup: BrowserSetupEnvironment;
  bindHost: string;
  loadAssets: () => Promise<BrowserAssets>;
  createServer?: (options: BrowserServerOptions) => BrowserServer;
}

export interface BrowserRuntime extends BrowserControl {
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

function waitForListening(
  server: BrowserServer["server"],
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      server.off("error", onError);
      server.off("listening", onListening);
      reject(error);
    }
  });
}

async function browserConfigExists(environment: BrowserSetupEnvironment): Promise<boolean> {
  try {
    await lstat(join(environment.stateDir, BROWSER_CONFIG));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function createBrowserRuntime(options: BrowserRuntimeOptions): BrowserRuntime {
  let snapshot: ReturnType<BrowserControl["current"]> = { status: "disabled" };
  let listener: BrowserServer | undefined;
  let auth: BrowserAuth | undefined;
  let stopped = false;
  let started: Promise<void> | undefined;
  let phase: "identity" | "assets" | "auth" | "listener" = "identity";

  const closeListener = (target = listener): void => {
    try {
      target?.shutdown();
    } catch {
      // Runtime teardown remains isolated from the coordinator.
    }
  };
  const unavailable = (reason: BrowserUnavailableReason): void => {
    if (!stopped) snapshot = { status: "unavailable", reason };
  };

  const run = async (): Promise<void> => {
    let identity;
    phase = "identity";
    try {
      if (!(await browserConfigExists(options.setup))) return;
      if (stopped) return;
      identity = await loadBrowserServerIdentity(options.setup);
    } catch {
      unavailable("identity_unavailable");
      return;
    }
    if (stopped) return;

    let assets: BrowserAssets;
    phase = "assets";
    try {
      assets = await options.loadAssets();
    } catch {
      unavailable("assets_unavailable");
      return;
    }
    if (stopped) return;

    phase = "auth";
    try {
      auth = await BrowserAuth.openOrInitialize(options.setup.stateDir);
    } catch {
      unavailable("auth_unavailable");
      return;
    }
    if (stopped) return;

    const origin = `https://${identity.config.hostname}:${identity.config.port}`;
    phase = "listener";
    try {
      const activeListener = (options.createServer ?? createBrowserServer)({
        key: identity.key,
        cert: identity.cert,
        origin,
        auth,
        assets,
      });
      listener = activeListener;
      activeListener.server.on("error", () => {
        if (stopped || listener !== activeListener) return;
        closeListener(activeListener);
        unavailable("listener_unavailable");
      });
      await waitForListening(activeListener.server, identity.config.port, options.bindHost);
      if (stopped) {
        closeListener(activeListener);
        return;
      }
      snapshot = { status: "ready", origin, auth };
    } catch {
      closeListener();
      unavailable("listener_unavailable");
    }
  };

  return {
    current: () => snapshot,
    start: () => {
      if (stopped) return Promise.resolve();
      started ??= run();
      return started;
    },
    shutdown: async () => {
      stopped = true;
      snapshot = { status: "disabled" };
      closeListener();
      if (phase === "identity" || phase === "assets") return;
      await started;
      closeListener();
      await auth?.close();
    },
  };
}
