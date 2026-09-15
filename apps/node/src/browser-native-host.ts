import { connect } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BROWSER_WEBMCP_LIMITS, browserWebMCPRequest, browserWebMCPResult } from "@ellie/protocol";
import { browserWebMCPFrame, browserWebMCPSocketPath } from "./browser-webmcp-bridge.ts";

export const BROWSER_WEBMCP_NATIVE_HOST = "org.ellie.browser_webmcp";
export const ELLIE_BROWSER_EXTENSION_ID = "lopakiehdeklmlnnnnacepnbjjoaehee";
const extensionIdPattern = /^[a-p]{32}$/;

export function browserWebMCPNativeHostManifest(
  extensionId: string,
  executablePath: string,
): string {
  if (
    !extensionIdPattern.test(extensionId) ||
    !executablePath.startsWith("/") ||
    executablePath.includes("\0")
  )
    throw new Error("Invalid native host manifest input.");
  return `${JSON.stringify({
    name: BROWSER_WEBMCP_NATIVE_HOST,
    description: "Ellie WebMCP bridge",
    path: resolve(executablePath),
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  })}\n`;
}

/** Manifest bytes for the one reviewed Ellie extension identity. Installation remains explicit. */
export function ellieBrowserWebMCPNativeHostManifest(executablePath: string): string {
  return browserWebMCPNativeHostManifest(ELLIE_BROWSER_EXTENSION_ID, executablePath);
}

export type BrowserWebMCPHostInstallationPlan = {
  extensionId: typeof ELLIE_BROWSER_EXTENSION_ID;
  executablePath: string;
  manifestName: `${typeof BROWSER_WEBMCP_NATIVE_HOST}.json`;
  manifest: string;
};

/** Manifest plan for a captured release; authentication remains the caller's prerequisite. */
export function browserWebMCPHostInstallationPlan(
  capturedRelease: string,
): BrowserWebMCPHostInstallationPlan {
  if (
    !capturedRelease.startsWith("/") ||
    capturedRelease.includes("\0") ||
    resolve(capturedRelease) !== capturedRelease
  )
    throw new Error("Invalid captured browser host release.");
  const executablePath = join(capturedRelease, "payload", "bin", "ellie-browser-webmcp-host");
  return {
    extensionId: ELLIE_BROWSER_EXTENSION_ID,
    executablePath,
    manifestName: `${BROWSER_WEBMCP_NATIVE_HOST}.json`,
    manifest: ellieBrowserWebMCPNativeHostManifest(executablePath),
  };
}

export async function runBrowserWebMCPNativeHost(options: {
  home: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const socket = connect(browserWebMCPSocketPath(options.home));
  const opened = new Promise<void>((resolveOpened, reject) => {
    socket.once("connect", resolveOpened);
    socket.once("error", reject);
  });
  await opened;
  const parentPid = process.ppid;
  if (!Number.isInteger(parentPid) || parentPid < 1 || parentPid > 0x7fffffff) {
    socket.destroy();
    throw new Error("Browser native host parent is unavailable.");
  }
  socket.write(browserWebMCPFrame.encode({ type: "native-host.hello", version: 1, parentPid }));
  let stopped = false;
  let removeInputFrames = () => {};
  let removeSocketFrames = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    removeInputFrames();
    removeSocketFrames();
    input.removeListener("end", stop);
    input.removeListener("close", stop);
    input.removeListener("error", stop);
    output.removeListener("error", stop);
    if ("pause" in input && typeof input.pause === "function") input.pause();
    socket.destroy();
  };
  input.once("end", stop);
  input.once("close", stop);
  input.once("error", stop);
  output.once("error", stop);
  socket.once("error", stop);
  socket.once("close", stop);
  removeInputFrames = browserWebMCPFrame.accept(
    input as NodeJS.ReadableStream & { destroy(error?: Error): void },
    (value) => {
      try {
        socket.write(browserWebMCPFrame.encode(browserWebMCPResult(value)));
      } catch {
        stop();
      }
    },
  );
  removeSocketFrames = browserWebMCPFrame.accept(socket, (value) => {
    try {
      output.write(browserWebMCPFrame.encode(browserWebMCPRequest(value)));
    } catch {
      stop();
    }
  });
  await new Promise<void>((resolveFinished) => socket.once("close", resolveFinished));
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const home = process.env.HOME;
  if (!home) process.exitCode = 1;
  else runBrowserWebMCPNativeHost({ home }).catch(() => (process.exitCode = 1));
}
