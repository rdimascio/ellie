import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  browserWebMCPRequest,
  browserWebMCPResult,
  browserWebMCPResultFor,
  type BrowserWebMCPRequest,
  type BrowserWebMCPResult,
} from "@ellie/protocol";
import { browserWebMCPFrame } from "./browser-webmcp-bridge.ts";

type Request = Exclude<BrowserWebMCPRequest, { type: "cancel" }>;
type Pending = {
  request: Request;
  resolve: (result: BrowserWebMCPResult) => void;
  dispatched: boolean;
  timer: NodeJS.Timeout;
  removeAbort: () => void;
};
type Generation = {
  child: ChildProcessWithoutNullStreams;
  context?: BrowserKernelContext;
  active?: Pending;
  removeFrames: () => void;
  retiring?: Promise<boolean>;
};
export type BrowserKernelContext = {
  browserProcessPid: number;
  browserStartSeconds: number;
  browserStartMicroseconds: number;
  browserCodeHash: string;
  connectionId: string;
  authenticated: true;
};
export type BrowserKernelBridge = {
  connected(): boolean;
  connectionContext(): BrowserKernelContext | undefined;
  request(request: Request, signal: AbortSignal): Promise<BrowserWebMCPResult>;
  close(): Promise<void>;
};

const requestDeadlineMs = 15_000;
const retryDelaysMs = [100, 250, 500] as const;

export async function startBrowserKernelBridge(options: {
  home: string;
  executable: string;
}): Promise<BrowserKernelBridge> {
  if (
    !options.home.startsWith("/") ||
    options.home.includes("\0") ||
    !options.executable.startsWith("/") ||
    options.executable.includes("\0")
  )
    throw new Error("Invalid browser broker configuration.");

  let generation: Generation | undefined;
  let retry: NodeJS.Timeout | undefined;
  let retryCount = 0;
  let closed = false;
  let cleanupUncertain = false;
  const retirements = new Set<Promise<boolean>>();
  const uncertainGenerations = new Set<Generation>();

  const settle = (owner: Generation, status: "cancelled" | "unavailable" | "unknown") => {
    const pending = owner.active;
    if (!pending) return;
    owner.active = undefined;
    clearTimeout(pending.timer);
    pending.removeAbort();
    pending.resolve(browserWebMCPResultFor(pending.request.id, status));
  };

  const retire = (owner: Generation): Promise<boolean> => {
    if (owner.retiring) return owner.retiring;
    owner.context = undefined;
    owner.removeFrames();
    const child = owner.child;
    owner.retiring = new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      let finished = false;
      let terminate: NodeJS.Timeout | undefined;
      let kill: NodeJS.Timeout | undefined;
      let reap: NodeJS.Timeout | undefined;
      const finish = (certain: boolean) => {
        if (finished) return;
        finished = true;
        if (terminate) clearTimeout(terminate);
        if (kill) clearTimeout(kill);
        if (reap) clearTimeout(reap);
        resolve(certain);
      };
      child.once("close", () => finish(true));
      child.stdin.end();
      terminate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }, 250);
      kill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      reap = setTimeout(() => finish(false), 3_000);
    })
      .then((certain) => {
        if (!certain) {
          cleanupUncertain = true;
          uncertainGenerations.add(owner);
        }
        return certain;
      })
      .finally(() => retirements.delete(owner.retiring!));
    retirements.add(owner.retiring);
    return owner.retiring;
  };

  const scheduleReplacement = () => {
    if (closed || cleanupUncertain || generation || retry) return;
    const delay = retryDelaysMs[retryCount];
    if (delay === undefined) return;
    retryCount += 1;
    retry = setTimeout(() => {
      retry = undefined;
      if (!closed && !cleanupUncertain && !generation) startGeneration();
    }, delay);
  };

  const fail = (owner: Generation) => {
    if (generation !== owner) return;
    settle(owner, owner.active?.dispatched ? "unknown" : "unavailable");
    generation = undefined;
    void retire(owner).then((certain) => {
      if (!certain) cleanupUncertain = true;
      else scheduleReplacement();
    });
  };

  const startGeneration = () => {
    if (closed || cleanupUncertain || generation) return;
    const child: ChildProcessWithoutNullStreams = spawn(options.executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: options.home, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    const owner: Generation = { child, removeFrames: () => {} };
    generation = owner;
    child.stderr.on("data", () => fail(owner));
    child.stdin.on("error", () => fail(owner));
    child.once("error", () => fail(owner));
    child.once("close", () => fail(owner));
    owner.removeFrames = browserWebMCPFrame.accept(child.stdout, (raw) => {
      if (generation !== owner) return;
      if (
        owner.context &&
        raw &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        Object.keys(raw).sort().join() === "connectionId,type,version" &&
        (raw as Record<string, unknown>).type === "broker.disconnected" &&
        (raw as Record<string, unknown>).version === 1 &&
        (raw as Record<string, unknown>).connectionId === owner.context.connectionId
      ) {
        if (owner.active) return fail(owner);
        owner.context = undefined;
        return;
      }
      if (!owner.context) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(owner);
        const value = raw as Record<string, unknown>;
        if (
          Object.keys(value).sort().join() !==
            "authenticated,browserCodeHash,browserPid,browserStartMicroseconds,browserStartSeconds,connectionId,nativeHostPid,pidVersion,type,version" ||
          value.type !== "broker.context" ||
          value.version !== 1 ||
          value.authenticated !== true ||
          !Number.isInteger(value.browserPid) ||
          Number(value.browserPid) < 1 ||
          !Number.isInteger(value.nativeHostPid) ||
          Number(value.nativeHostPid) < 1 ||
          !Number.isInteger(value.pidVersion) ||
          !Number.isInteger(value.browserStartSeconds) ||
          Number(value.browserStartSeconds) < 1 ||
          !Number.isInteger(value.browserStartMicroseconds) ||
          Number(value.browserStartMicroseconds) < 0 ||
          Number(value.browserStartMicroseconds) > 999_999 ||
          typeof value.browserCodeHash !== "string" ||
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.browserCodeHash) ||
          typeof value.connectionId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            value.connectionId,
          )
        )
          return fail(owner);
        owner.context = {
          browserProcessPid: Number(value.browserPid),
          browserStartSeconds: Number(value.browserStartSeconds),
          browserStartMicroseconds: Number(value.browserStartMicroseconds),
          browserCodeHash: value.browserCodeHash,
          connectionId: value.connectionId,
          authenticated: true,
        };
        return;
      }
      let result: BrowserWebMCPResult;
      try {
        result = browserWebMCPResult(raw);
      } catch {
        return fail(owner);
      }
      if (!owner.active || result.id !== owner.active.request.id) {
        if (!result.id.startsWith("cancel:")) fail(owner);
        return;
      }
      const pending = owner.active;
      owner.active = undefined;
      clearTimeout(pending.timer);
      pending.removeAbort();
      pending.resolve(result);
      retryCount = 0;
    });
  };

  startGeneration();

  const request = (raw: Request, signal: AbortSignal): Promise<BrowserWebMCPResult> => {
    const checked = browserWebMCPRequest(raw) as Request;
    const owner = generation;
    if (
      closed ||
      cleanupUncertain ||
      !owner?.context ||
      owner.child.exitCode !== null ||
      owner.child.signalCode !== null
    )
      return Promise.resolve(browserWebMCPResultFor(checked.id, "unavailable"));
    if (signal.aborted) return Promise.resolve(browserWebMCPResultFor(checked.id, "cancelled"));
    if (owner.active) return Promise.resolve(browserWebMCPResultFor(checked.id, "busy"));
    return new Promise((resolve) => {
      let abort = () => {};
      const abandon = () => {
        if (generation !== owner || owner.active !== pending) return;
        if (!pending.dispatched) {
          settle(owner, "cancelled");
          return;
        }
        settle(owner, "unknown");
        generation = undefined;
        void retire(owner).then((certain) => {
          if (!certain) cleanupUncertain = true;
          else scheduleReplacement();
        });
      };
      const pending: Pending = {
        request: checked,
        dispatched: false,
        resolve,
        timer: setTimeout(abandon, requestDeadlineMs),
        removeAbort: () => signal.removeEventListener("abort", abort),
      };
      abort = abandon;
      owner.active = pending;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abandon();
      pending.dispatched = true;
      owner.child.stdin.write(browserWebMCPFrame.encode(checked), (error) => {
        if (error && generation === owner && owner.active === pending) abandon();
      });
    });
  };

  return {
    connected: () => Boolean(generation?.context && !cleanupUncertain),
    connectionContext: () =>
      generation?.context && !cleanupUncertain ? { ...generation.context } : undefined,
    request,
    close: async () => {
      if (closed) {
        if (cleanupUncertain || uncertainGenerations.size)
          throw new Error("Browser broker cleanup is uncertain.");
        return;
      }
      closed = true;
      if (retry) clearTimeout(retry);
      retry = undefined;
      const owner = generation;
      generation = undefined;
      if (owner) {
        settle(owner, owner.active?.dispatched ? "unknown" : "unavailable");
        void retire(owner);
      }
      const certain = await Promise.all(retirements);
      if (certain.some((value) => !value)) cleanupUncertain = true;
      if (cleanupUncertain || uncertainGenerations.size)
        throw new Error("Browser broker cleanup is uncertain.");
    },
  };
}
