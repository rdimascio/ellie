import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import { identifier } from "@ellie/protocol";
import { readJson } from "@ellie/transport";
import { canOpenApps, phoneAppCommand } from "./browser-remote.ts";
import type { BrowserRemote, BrowserRemoteNode } from "./browser-remote.ts";
export type { BrowserRemote } from "./browser-remote.ts";
import {
  BrowserAuth,
  browserOrigin,
  browserLabel,
  browserRequestMatchesOrigin,
  browserSessionCookie,
  browserSessionToken,
  clearBrowserSessionCookie,
} from "./browser-auth.ts";

const MAX_BROWSER_BODY_BYTES = 4096;
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(self), microphone=(), geolocation=()",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export type BrowserAssets = ReadonlyMap<string, { contentType: string; body: Buffer }>;

export interface BrowserServerOptions {
  key: string | Buffer;
  cert: string | Buffer;
  origin: string;
  auth: BrowserAuth;
  assets?: BrowserAssets;
  remote?: BrowserRemote;
}

export interface BrowserServer {
  server: HttpsServer;
  shutdown: () => void;
}

function publicNodes(value: BrowserRemoteNode[]): BrowserRemoteNode[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("Nodes unavailable.");
  return value.map((node) => {
    if (typeof node?.online !== "boolean" || !Array.isArray(node.capabilities))
      throw new Error("Nodes unavailable.");
    return {
      id: identifier(node.id),
      label: browserLabel(node.label),
      online: node.online,
      capabilities: node.capabilities.includes("app.open") ? ["app.open"] : [],
    };
  });
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === name)
      values.push(request.rawHeaders[index + 1] ?? "");
  }
  return values;
}

function send(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
  close = false,
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    ...(close ? { connection: "close" } : {}),
    ...extraHeaders,
  });
  response.end(body);
}

function isJson(request: IncomingMessage): boolean {
  const values = rawHeaderValues(request, "content-type");
  return (
    values.length === 1 && /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(values[0]!)
  );
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function requestPath(request: IncomingMessage, origin: string): string | undefined {
  const target = request.url;
  if (!target?.startsWith("/") || target.startsWith("//")) return undefined;
  const url = new URL(target, origin);
  if (url.origin !== origin || url.search || url.hash) return undefined;
  return url.pathname;
}

function invalidRequest(socket: Duplex): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify({ error: "Invalid browser request." }));
  socket.end(
    [
      "HTTP/1.1 400 Bad Request",
      "Connection: close",
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${body.length}`,
      "Cache-Control: no-store",
      `Content-Security-Policy: ${SECURITY_HEADERS["content-security-policy"]}`,
      "Cross-Origin-Resource-Policy: same-origin",
      "Referrer-Policy: no-referrer",
      `Permissions-Policy: ${SECURITY_HEADERS["permissions-policy"]}`,
      "X-Content-Type-Options: nosniff",
      "X-Frame-Options: DENY",
      "",
      body.toString(),
    ].join("\r\n"),
  );
}

export function createBrowserServer(options: BrowserServerOptions): BrowserServer {
  const expected = browserOrigin(options.origin);
  const sockets = new Set<Duplex>();
  const busyNodes = new Set<string>();
  let stopped = false;

  const server = createServer(
    {
      key: options.key,
      cert: options.cert,
      minVersion: "TLSv1.2",
      maxHeaderSize: 8192,
      handshakeTimeout: 5000,
    },
    (request, response) => {
      void (async () => {
        const hosts = rawHeaderValues(request, "host");
        const origins = rawHeaderValues(request, "origin");
        const authorizations = rawHeaderValues(request, "authorization");
        if (hosts.length !== 1 || origins.length > 1 || authorizations.length > 1) {
          send(response, 400, { error: "Invalid browser request." }, {}, true);
          return;
        }
        if (authorizations.length !== 0) {
          send(response, 403, { error: "Authorization header is not accepted." }, {}, true);
          return;
        }
        if (
          !browserRequestMatchesOrigin(expected.origin, {
            method: request.method ?? "",
            host: hosts[0],
            origin: origins[0],
          })
        ) {
          send(response, 403, { error: "Browser origin rejected." }, {}, true);
          return;
        }

        const method = request.method ?? "";
        const path = requestPath(request, expected.origin);
        if (!path) {
          send(response, 400, { error: "Invalid browser request." }, {}, true);
          return;
        }

        if (
          (method === "GET" || method === "HEAD") &&
          (path === "/" || path.startsWith("/assets/"))
        ) {
          const asset = options.assets?.get(path);
          if (asset) {
            response.writeHead(200, {
              ...SECURITY_HEADERS,
              "content-type": asset.contentType,
              "content-length": asset.body.length,
            });
            response.end(method === "HEAD" ? undefined : asset.body);
            return;
          }
        }

        if (method === "GET" && path === "/browser/v1/health") {
          send(response, 200, { ok: true });
          return;
        }

        if (method === "POST" && path === "/browser/v1/pair") {
          if (!isJson(request)) {
            send(response, 415, { error: "JSON request required." }, {}, true);
            return;
          }
          let body: unknown;
          try {
            body = await readJson(request, MAX_BROWSER_BODY_BYTES);
          } catch {
            send(response, 400, { error: "Pairing request rejected." }, {}, true);
            return;
          }
          try {
            const issue = await options.auth.pair(body);
            send(
              response,
              200,
              { client: issue.client },
              { "set-cookie": browserSessionCookie(issue.token) },
            );
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "Browser invitation is invalid or expired."
            )
              send(response, 400, { error: "Pairing request rejected." }, {}, true);
            else send(response, 503, { error: "Browser service unavailable." }, {}, true);
          }
          return;
        }

        if (method === "GET" && path === "/browser/v1/session") {
          const client = options.auth.authenticateCookie(request.headers.cookie);
          if (!client) {
            send(response, 401, { error: "Browser session required." }, {}, true);
            return;
          }
          send(response, 200, { client });
          return;
        }

        if (method === "POST" && path === "/browser/v1/logout") {
          if (!isJson(request)) {
            send(response, 415, { error: "JSON request required." }, {}, true);
            return;
          }
          let body: unknown;
          try {
            body = await readJson(request, MAX_BROWSER_BODY_BYTES);
          } catch {
            send(response, 400, { error: "Invalid logout request." }, {}, true);
            return;
          }
          if (!isEmptyObject(body)) {
            send(response, 400, { error: "Invalid logout request." }, {}, true);
            return;
          }
          const token = browserSessionToken(request.headers.cookie);
          if (!options.auth.authenticate(token) || !(await options.auth.logout(token))) {
            send(response, 401, { error: "Browser session required." }, {}, true);
            return;
          }
          send(response, 200, { ok: true }, { "set-cookie": clearBrowserSessionCookie() });
          return;
        }

        if (
          (method === "GET" && path === "/browser/v1/nodes") ||
          (method === "POST" && path === "/browser/v1/commands")
        ) {
          const token = browserSessionToken(request.headers.cookie);
          const client = options.auth.authenticate(token);
          if (!client) {
            send(response, 401, { error: "Browser session required." }, {}, true);
            return;
          }
          if (client.role !== "phone_controller") {
            send(response, 403, { error: "Phone remote permission required." }, {}, true);
            return;
          }
          if (!options.remote) {
            send(response, 503, { error: "Phone controls are not configured." }, {}, true);
            return;
          }
          if (method === "GET") {
            const nodes = publicNodes(await options.remote.nodes());
            const current = options.auth.authenticateCookie(request.headers.cookie);
            if (!current) {
              send(response, 401, { error: "Browser session required." }, {}, true);
              return;
            }
            send(response, 200, { nodes: nodes.filter((node) => canOpenApps(current, node.id)) });
            return;
          }
          if (!isJson(request)) {
            send(response, 415, { error: "JSON request required." }, {}, true);
            return;
          }
          let command;
          try {
            command = phoneAppCommand(await readJson(request, MAX_BROWSER_BODY_BYTES));
          } catch {
            send(
              response,
              400,
              { error: "Try open Arc, open Safari, or open Messages." },
              {},
              true,
            );
            return;
          }
          if (!canOpenApps(client, command.nodeId)) {
            send(response, 403, { error: "App opening is not allowed on this device." }, {}, true);
            return;
          }
          if (busyNodes.has(command.nodeId)) {
            send(
              response,
              409,
              { error: "This device is busy. Wait for the current command." },
              {},
              true,
            );
            return;
          }
          busyNodes.add(command.nodeId);
          try {
            const nodes = publicNodes(await options.remote.nodes());
            let admitted: boolean;
            try {
              admitted = await options.auth.admitAppOpen(token, command.nodeId);
            } catch {
              send(response, 503, { error: "Browser service unavailable." }, {}, true);
              return;
            }
            if (!admitted) {
              send(response, 401, { error: "Browser session required." }, {}, true);
              return;
            }
            const target = nodes.find((node) => node.id === command.nodeId);
            if (!target?.online || !target.capabilities.includes("app.open")) {
              send(
                response,
                409,
                { error: "This device is offline or cannot open apps." },
                {},
                true,
              );
              return;
            }
            if (response.destroyed || stopped) return;
            response.setTimeout(40_000);
            try {
              send(response, 200, await options.remote.openApp(command.nodeId, command.app));
            } catch {
              send(
                response,
                502,
                { error: "Command outcome is unknown. Check the Mac before sending again." },
                {},
                true,
              );
            }
          } finally {
            busyNodes.delete(command.nodeId);
          }
          return;
        }

        send(response, 404, { error: "Browser route not found." }, {}, true);
      })().catch(() => {
        if (!response.headersSent)
          send(response, 503, { error: "Browser service unavailable." }, {}, true);
        else response.destroy();
      });
    },
  );

  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(10_000, (socket) => socket.destroy());
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => invalidRequest(socket));
  server.on("tlsClientError", (_error, socket) => socket.destroy());

  return {
    server,
    shutdown: () => {
      if (stopped) return;
      stopped = true;
      if (server.listening) server.close();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}
