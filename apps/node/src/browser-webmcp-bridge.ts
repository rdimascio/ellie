import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  BROWSER_WEBMCP_LIMITS,
  browserWebMCPRequest,
  browserWebMCPResult,
  browserWebMCPResultFor,
  type BrowserWebMCPRequest,
  type BrowserWebMCPResult,
} from "@ellie/protocol";

const SOCKET_NAME = "browser-webmcp-v1.sock";
const HEADER_BYTES = 4;
type Identity = { dev: bigint; ino: bigint; uid: bigint; mode: number };
type FramedReadable = NodeJS.ReadableStream & { destroy(error?: Error): void };

export function browserWebMCPRuntimeDirectory(home: string): string {
  if (!home.startsWith("/") || home.includes("\0")) throw new Error("Invalid home directory.");
  return join(home, "Library", "Application Support", "Ellie", "BrowserBridge");
}
export function browserWebMCPSocketPath(home: string): string {
  return join(browserWebMCPRuntimeDirectory(home), SOCKET_NAME);
}
const identity = (value: Awaited<ReturnType<typeof lstat>>): Identity => ({
  dev: BigInt(value.dev),
  ino: BigInt(value.ino),
  uid: BigInt(value.uid),
  mode: Number(value.mode) & 0o777,
});
const sameIdentity = (left: Identity, right: Identity) =>
  left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;

export async function prepareBrowserWebMCPRuntimeDirectory(home: string): Promise<string> {
  const directory = browserWebMCPRuntimeDirectory(home);
  const parent = await lstat(dirname(directory), { bigint: true });
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== BigInt(process.getuid?.() ?? -1) ||
    (parent.mode & 0o777n) !== 0o700n
  )
    throw new Error("Ellie application directory is not private.");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(directory, { bigint: true });
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== BigInt(process.getuid?.() ?? -1) ||
    (info.mode & 0o777n) !== 0o700n
  )
    throw new Error("Browser bridge directory is not private.");
  return directory;
}

export async function removeOwnedBrowserWebMCPSocket(
  path: string,
  expected: Identity,
): Promise<void> {
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!current.isSocket() || !sameIdentity(identity(current), expected))
    throw new Error("Browser bridge socket changed; it was retained.");
  await unlink(path);
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 1 || payload.length > BROWSER_WEBMCP_LIMITS.maximumMessageBytes)
    throw new Error("Browser bridge message exceeds its bound.");
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}
function acceptFrames(socket: FramedReadable, receive: (value: unknown) => void): () => void {
  let pending = Buffer.alloc(0),
    failed = false;
  const data = (chunk: Buffer | string) => {
    if (failed) return;
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (pending.length >= HEADER_BYTES) {
      const length = pending.readUInt32LE(0);
      if (length < 1 || length > BROWSER_WEBMCP_LIMITS.maximumMessageBytes) {
        failed = true;
        socket.destroy(new Error("Invalid browser bridge frame."));
        return;
      }
      if (pending.length < HEADER_BYTES + length) return;
      const payload = pending.subarray(HEADER_BYTES, HEADER_BYTES + length);
      pending = pending.subarray(HEADER_BYTES + length);
      try {
        receive(JSON.parse(payload.toString("utf8")));
      } catch {
        failed = true;
        socket.destroy(new Error("Invalid browser bridge message."));
        return;
      }
    }
  };
  socket.on("data", data);
  return () => socket.off("data", data);
}

type Pending = {
  request: BrowserWebMCPRequest;
  resolve: (result: BrowserWebMCPResult) => void;
  dispatched: boolean;
  owner: Socket;
};
export type BrowserWebMCPBridge = {
  readonly socketPath: string;
  connected(): boolean;
  request(
    request: Exclude<BrowserWebMCPRequest, { type: "cancel" }>,
    signal: AbortSignal,
  ): Promise<BrowserWebMCPResult>;
  close(): Promise<void>;
};

export async function startBrowserWebMCPBridge(options: {
  home: string;
}): Promise<BrowserWebMCPBridge> {
  await prepareBrowserWebMCPRuntimeDirectory(options.home);
  const socketPath = browserWebMCPSocketPath(options.home);
  try {
    await lstat(socketPath, { bigint: true });
    throw new Error("Browser bridge socket already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let client: Socket | undefined, active: Pending | undefined;
  const server: Server = createServer((candidate) => {
    candidate.on("error", () => {});
    if (client && !client.destroyed) {
      candidate.destroy();
      return;
    }
    client = candidate;
    candidate.once("close", () => {
      if (client === candidate) client = undefined;
      if (active?.owner === candidate) {
        active.resolve(
          browserWebMCPResultFor(active.request.id, active.dispatched ? "unknown" : "unavailable"),
        );
        active = undefined;
      }
    });
    acceptFrames(candidate, (raw) => {
      if (client !== candidate) return;
      let result;
      try {
        result = browserWebMCPResult(raw);
      } catch {
        candidate.destroy(new Error("Invalid browser bridge result."));
        return;
      }
      if (!active || active.owner !== candidate || result.id !== active.request.id) {
        if (!result.id.startsWith("cancel:"))
          candidate.destroy(new Error("Unexpected browser bridge result."));
        return;
      }
      active.resolve(result);
      active = undefined;
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  const socketInfo = await lstat(socketPath, { bigint: true });
  const socketIdentity = identity(socketInfo);
  if (
    !socketInfo.isSocket() ||
    socketIdentity.uid !== BigInt(process.getuid?.() ?? -1) ||
    socketIdentity.mode !== 0o600
  ) {
    server.close();
    throw new Error("Browser bridge socket is not private.");
  }
  let closed = false;
  return {
    socketPath,
    connected: () => Boolean(client && !client.destroyed),
    request: (request, signal) => {
      const checked = browserWebMCPRequest(request) as Exclude<
        BrowserWebMCPRequest,
        { type: "cancel" }
      >;
      if (closed || !client || client.destroyed)
        return Promise.resolve(browserWebMCPResultFor(checked.id, "unavailable"));
      if (signal.aborted) return Promise.resolve(browserWebMCPResultFor(checked.id, "cancelled"));
      if (active) return Promise.resolve(browserWebMCPResultFor(checked.id, "busy"));
      return new Promise<BrowserWebMCPResult>((resolve) => {
        const owner = client!;
        let pending: Pending;
        const abort = () => {
          if (active !== pending || owner.destroyed) return;
          owner.write(
            encodeFrame({
              protocol: checked.protocol,
              id: `cancel:${checked.id}`,
              type: "cancel",
              targetId: checked.id,
            }),
          );
          pending.resolve(browserWebMCPResultFor(checked.id, "unknown"));
        };
        pending = {
          request: checked,
          dispatched: false,
          owner,
          resolve: (result) => {
            signal.removeEventListener("abort", abort);
            resolve(result);
          },
        };
        active = pending;
        signal.addEventListener("abort", abort, { once: true });
        pending.dispatched = true;
        owner.write(encodeFrame(checked), (error) => {
          if (error && active === pending) {
            active = undefined;
            pending.resolve(browserWebMCPResultFor(checked.id, "unknown"));
          }
        });
      });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      client?.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await removeOwnedBrowserWebMCPSocket(socketPath, socketIdentity);
    },
  };
}
export const browserWebMCPFrame = Object.freeze({ encode: encodeFrame, accept: acceptFrames });
