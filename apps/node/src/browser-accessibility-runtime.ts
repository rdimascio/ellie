import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  browserWebMCPOperationResult,
  type BrowserAction,
  type BrowserWebMCPOperationResult,
} from "@ellie/protocol";

export type BrowserNativeHostContext = {
  browserProcessPid: number;
  browserStartSeconds: number;
  browserStartMicroseconds: number;
  browserCodeHash: string;
  connectionId: string;
  authenticated: boolean;
};
export type BrowserAccessibilityBinding = {
  availability: "accessibility";
  documentId: string;
  url: string;
  revision: string;
};

type Reply = Record<string, unknown>;
type Pending = {
  id: string;
  dispatched: boolean;
  expected: ExpectedReply;
  resolve: (value: Reply) => void;
  reject: (error: Error) => void;
};
type ExpectedReply =
  | { type: "bind"; documentRevision: string }
  | { type: "read"; sessionID: string; documentRevision: string }
  | { type: "perform"; sessionID: string; documentRevision: string; operation: string };
class BrowserAccessibilityRequestFailure extends Error {
  readonly possibleDispatch: boolean;
  constructor(message: string, possibleDispatch: boolean) {
    super(message);
    this.possibleDispatch = possibleDispatch;
  }
}
const requestFailure = (pending: Pending, cleanupCertain: boolean) => {
  const possibleDispatch = pending.dispatched && pending.expected.type === "perform";
  const message = !cleanupCertain
    ? "Browser accessibility cleanup is uncertain."
    : possibleDispatch
      ? "Browser accessibility outcome is unknown."
      : pending.expected.type === "read"
        ? "Browser accessibility read failed."
        : "Browser accessibility helper is unavailable.";
  return new BrowserAccessibilityRequestFailure(message, possibleDispatch);
};
type Generation = {
  child: ChildProcessWithoutNullStreams;
  input: Buffer;
  pending?: Pending;
  stopping?: Promise<boolean>;
};
const identifier = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value))
    throw new Error();
  return value;
};
const exact = (value: unknown, allowed: readonly string[]): Reply => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const record = value as Reply;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error();
  return record;
};
const exactKeys = (value: Reply, expected: readonly string[]) => {
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  )
    throw new Error();
};
const boundedText = (value: unknown, maximum: number): string => {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > maximum ||
    /\p{Cc}/u.test(value)
  )
    throw new Error();
  return value;
};

const checkedReply = (value: unknown, pending: Pending): Reply => {
  const parsed = exact(value, [
    "id",
    "status",
    "sessionID",
    "generation",
    "documentRevision",
    "title",
    "summary",
    "items",
    "operation",
  ]);
  if (parsed.id !== pending.id) throw new Error();
  const expected = pending.expected;
  if (expected.type === "bind") {
    exactKeys(parsed, ["id", "status", "sessionID", "documentRevision"]);
    if (parsed.status !== "bound" || parsed.documentRevision !== expected.documentRevision)
      throw new Error();
    identifier(parsed.sessionID);
    return parsed;
  }
  if (expected.type === "read") {
    const required = [
      "id",
      "status",
      "sessionID",
      "generation",
      "documentRevision",
      "items",
      "operation",
    ];
    const keys = Object.keys(parsed);
    if (
      required.some((key) => !keys.includes(key)) ||
      keys.some((key) => ![...required, "title", "summary"].includes(key)) ||
      parsed.status !== "completed" ||
      parsed.sessionID !== expected.sessionID ||
      parsed.documentRevision !== expected.documentRevision ||
      parsed.operation !== "read" ||
      !Array.isArray(parsed.items) ||
      parsed.items.length > 64
    )
      throw new Error();
    identifier(parsed.generation);
    const seen = new Set<string>();
    for (const raw of parsed.items) {
      const item = exact(raw, ["id", "label"]);
      exactKeys(item, ["id", "label"]);
      const id = identifier(item.id);
      if (seen.has(id)) throw new Error();
      seen.add(id);
      boundedText(item.label, 500);
    }
    if (parsed.title !== undefined) boundedText(parsed.title, 500);
    if (parsed.summary !== undefined) boundedText(parsed.summary, 2_000);
    return parsed;
  }
  exactKeys(parsed, ["id", "status", "sessionID", "documentRevision", "operation"]);
  if (
    (parsed.status !== "dispatchedUnverified" && parsed.status !== "unknown") ||
    parsed.sessionID !== expected.sessionID ||
    parsed.documentRevision !== expected.documentRevision ||
    parsed.operation !== expected.operation
  )
    throw new Error();
  return parsed;
};

export class BrowserAccessibilityRuntime {
  private generation?: Generation;
  private uncertainGeneration?: Generation;
  private closed = false;
  private session?: {
    id: string;
    revision: string;
    documentRevision: string;
    generation?: string;
    context: BrowserNativeHostContext;
  };
  private readonly executable: string;
  private readonly context: () => BrowserNativeHostContext | undefined;

  constructor(executable: string, context: () => BrowserNativeHostContext | undefined) {
    if (!executable.startsWith("/") || executable.includes("\0"))
      throw new Error("Invalid browser accessibility helper.");
    this.executable = executable;
    this.context = context;
  }

  private start(): Generation {
    if (this.uncertainGeneration) throw new Error("Browser accessibility cleanup is uncertain.");
    if (this.generation) return this.generation;
    const child = spawn(this.executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    const owner: Generation = { child, input: Buffer.alloc(0) };
    this.generation = owner;
    child.stderr.on("data", () => this.fail(owner));
    child.stdin.on("error", () => this.fail(owner));
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.generation !== owner || owner.stopping) return;
      if (chunk.length > 16_384 - owner.input.length) return this.fail(owner);
      owner.input = Buffer.concat([owner.input, chunk], owner.input.length + chunk.length);
      const newline = owner.input.indexOf(0x0a);
      if (newline < 0) return;
      const frame = owner.input.subarray(0, newline);
      owner.input = owner.input.subarray(newline + 1);
      const pending = owner.pending;
      try {
        if (!pending || owner.input.length || !frame.length) throw new Error();
        const parsed = checkedReply(JSON.parse(frame.toString("utf8")), pending);
        owner.pending = undefined;
        pending.resolve(parsed);
      } catch {
        this.fail(owner);
      }
    });
    child.once("error", () => this.fail(owner));
    child.once("close", () => this.fail(owner));
    return owner;
  }

  private fail(owner: Generation): void {
    if (this.generation !== owner) return;
    const pending = owner.pending;
    owner.pending = undefined;
    if (pending) pending.reject(requestFailure(pending, true));
    this.session = undefined;
    void this.stopChild(owner);
  }

  private stopChild(owner = this.generation): Promise<boolean> {
    this.session = undefined;
    if (!owner) return Promise.resolve(!this.uncertainGeneration);
    if (owner.stopping) return owner.stopping;
    const child = owner.child;
    if (child.exitCode !== null || child.signalCode !== null) {
      if (this.generation === owner) this.generation = undefined;
      return Promise.resolve(true);
    }
    owner.stopping = new Promise<boolean>((resolve) => {
      let settled = false;
      let escalation: NodeJS.Timeout | undefined;
      let reap: NodeJS.Timeout | undefined;
      const finish = (certain: boolean) => {
        if (settled) return;
        settled = true;
        if (escalation) clearTimeout(escalation);
        if (reap) clearTimeout(reap);
        if (certain) {
          if (this.generation === owner) this.generation = undefined;
        } else {
          this.uncertainGeneration = owner;
        }
        resolve(certain);
      };
      child.once("close", () => finish(true));
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        reap = setTimeout(() => finish(false), 2_000);
      }, 2_000);
    });
    return owner.stopping;
  }

  private async request(body: Reply, expected: ExpectedReply, signal: AbortSignal): Promise<Reply> {
    const current = this.generation;
    if (
      this.closed ||
      current?.pending ||
      current?.stopping ||
      this.uncertainGeneration ||
      signal.aborted
    )
      throw new Error("Browser accessibility helper is unavailable.");
    const id = randomUUID();
    const owner = this.start();
    return new Promise<Reply>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abandon);
        fn();
      };
      const abandon = () =>
        finish(() => {
          if (this.generation === owner && owner.pending === pending) owner.pending = undefined;
          void this.stopChild(owner).then((certain) => reject(requestFailure(pending, certain)));
        });
      const timer = setTimeout(abandon, 15_000);
      const pending: Pending = {
        id,
        dispatched: false,
        expected,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      };
      owner.pending = pending;
      signal.addEventListener("abort", abandon, { once: true });
      if (signal.aborted) return abandon();
      pending.dispatched = true;
      try {
        owner.child.stdin.write(`${JSON.stringify({ id, ...body })}\n`, (error) => {
          if (error && this.generation === owner && owner.pending === pending) abandon();
        });
      } catch {
        abandon();
      }
    });
  }

  private sameContext(expected: BrowserNativeHostContext): boolean {
    const current = this.context();
    return Boolean(current && this.contextsEqual(current, expected));
  }

  private contextsEqual(
    current: BrowserNativeHostContext,
    expected: BrowserNativeHostContext,
  ): boolean {
    return (
      current.connectionId === expected.connectionId &&
      current.browserProcessPid === expected.browserProcessPid &&
      current.browserStartSeconds === expected.browserStartSeconds &&
      current.browserStartMicroseconds === expected.browserStartMicroseconds &&
      current.browserCodeHash === expected.browserCodeHash &&
      current.authenticated === true &&
      expected.authenticated === true
    );
  }

  async execute(
    action: BrowserAction,
    binding: BrowserAccessibilityBinding,
    signal: AbortSignal,
  ): Promise<BrowserWebMCPOperationResult> {
    if (action.tool === "browser.refresh")
      throw new Error("Browser refresh requires a fresh selected binding.");
    const context = this.context();
    if (
      !context ||
      context.authenticated !== true ||
      !this.sameContext(context) ||
      (action.tool !== "browser.status" && action.revision !== binding.revision)
    )
      throw new Error("Browser page changed before the requested action.");
    if (
      this.session &&
      (!this.contextsEqual(this.session.context, context) ||
        this.session.revision !== binding.revision)
    ) {
      if (action.tool !== "browser.status")
        throw new Error("Browser page changed before the requested action.");
      if (!(await this.stopChild())) throw new Error("Browser accessibility cleanup is uncertain.");
      if (!this.sameContext(context))
        throw new Error("Browser page changed before the requested action.");
    }
    if (
      !this.session ||
      this.session.revision !== binding.revision ||
      !this.contextsEqual(this.session.context, context)
    ) {
      const reply = await this.request(
        {
          type: "bind",
          nativeHostParentPid: context.browserProcessPid,
          browserStartSeconds: context.browserStartSeconds,
          browserStartMicroseconds: context.browserStartMicroseconds,
          browserCodeHash: context.browserCodeHash,
          exactURL: binding.url,
          documentRevision: binding.documentId,
        },
        { type: "bind", documentRevision: binding.documentId },
        signal,
      );
      if (reply.status !== "bound" || !this.sameContext(context))
        throw new Error("Browser page changed before the requested action.");
      this.session = {
        id: identifier(reply.sessionID),
        revision: binding.revision,
        documentRevision: binding.documentId,
        context: { ...context },
      };
    }
    const session = this.session;
    if (action.tool === "browser.status")
      return browserWebMCPOperationResult({
        ok: true,
        message: "Browser tab connected.",
        browser: {
          source: "accessibility",
          operation: "status",
          status: "connected",
          revision: binding.revision,
          origin: new URL(binding.url).origin,
        },
      });
    let reply: Reply;
    if (action.tool === "browser.read") {
      reply = await this.request(
        { type: "read", sessionID: session.id },
        { type: "read", sessionID: session.id, documentRevision: session.documentRevision },
        signal,
      );
      if (reply.status !== "completed" || !this.sameContext(context))
        throw new Error("Browser page changed before the requested action.");
      session.generation = identifier(reply.generation);
      return browserWebMCPOperationResult({
        ok: true,
        message: "Browser view read.",
        browser: {
          source: "accessibility",
          operation: "read",
          status: "completed",
          revision: binding.revision,
          view: {
            ...(typeof reply.title === "string" ? { title: reply.title } : {}),
            ...(typeof reply.summary === "string" ? { summary: reply.summary } : {}),
            items: reply.items,
          },
        },
      });
    }
    if (!session.generation) throw new Error("Browser selection is stale.");
    if (action.tool === "browser.scrollRow")
      throw new Error("Observed row scrolling requires the Netflix companion.");
    const operation = action.tool.slice("browser.".length);
    const fields =
      action.tool === "browser.scroll"
        ? { direction: action.direction }
        : action.tool === "browser.search"
          ? { query: action.query }
          : action.tool === "browser.select"
            ? { itemID: action.itemId }
            : { action: action.action };
    try {
      reply = await this.request(
        {
          type: "perform",
          sessionID: session.id,
          generation: session.generation,
          documentRevision: binding.documentId,
          operation,
          ...fields,
        },
        {
          type: "perform",
          sessionID: session.id,
          documentRevision: binding.documentId,
          operation,
        },
        signal,
      );
    } catch (error) {
      session.generation = undefined;
      if (!(error instanceof BrowserAccessibilityRequestFailure) || !error.possibleDispatch)
        throw error;
      return browserWebMCPOperationResult({
        ok: false,
        message: "Browser action outcome is unknown. Check the page before retrying.",
        browser: {
          source: "accessibility",
          operation: "command",
          status: "unknown",
          revision: binding.revision,
        },
      });
    }
    session.generation = undefined;
    const status = "unknown";
    return browserWebMCPOperationResult({
      ok: false,
      message: "Browser action was dispatched without independent effect confirmation.",
      browser: {
        source: "accessibility",
        operation: "command",
        status,
        revision: binding.revision,
      },
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const certain = await this.stopChild();
    if (!certain || this.uncertainGeneration)
      throw new Error("Browser accessibility cleanup is uncertain.");
  }
}
