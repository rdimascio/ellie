import { request, Agent } from "node:https";
import { connect } from "node:tls";
import { X509Certificate, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { OPERATION_REGISTRY, VERSION } from "@ellie/protocol";

export function fingerprint(cert: string | Buffer): string {
  return new X509Certificate(cert).fingerprint256;
}
export function sameFingerprint(a: string, b: string): boolean {
  const normalize = (s: string) => s.replaceAll(":", "").toUpperCase();
  const x = normalize(a);
  const y = normalize(b);
  return (
    /^[0-9A-F]{64}$/.test(x) &&
    /^[0-9A-F]{64}$/.test(y) &&
    timingSafeEqual(Buffer.from(x), Buffer.from(y))
  );
}
/** Certificate-only bootstrap: sends no HTTP request, pairing code, or credentials. */
export async function discoverCertificate(
  origin: string,
  expectedFingerprint: string,
): Promise<string> {
  const url = new URL(origin);
  if (url.protocol !== "https:") throw new Error("HTTPS required.");
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: url.hostname,
      port: Number(url.port || 443),
      servername: "ellie.local",
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    });
    socket.setTimeout(5000, () => socket.destroy(new Error("Certificate lookup timed out.")));
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      try {
        const cert = new X509Certificate(socket.getPeerCertificate().raw);
        if (!sameFingerprint(cert.fingerprint256, expectedFingerprint))
          throw new Error("Server fingerprint does not match. No credentials were sent.");
        resolve(cert.toString());
      } catch (error) {
        reject(error);
      } finally {
        socket.end();
      }
    });
  });
}
export async function readJson(
  stream: IncomingMessage,
  maxBytes: number = OPERATION_REGISTRY.limits.maxRequestBodyBytes,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("Request body too large.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export class Client {
  private agent: Agent;
  private origin: string;
  private token: string;
  constructor(origin: string, cert: string, token = "") {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("HTTPS origin required.");
    this.origin = url.origin;
    this.token = token;
    const pin = fingerprint(cert);
    this.agent = new Agent({
      keepAlive: true,
      maxSockets: 4,
      ca: cert,
      servername: "ellie.local",
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      // The operator-verified certificate is the authority, independent of LAN hostname/IP.
      checkServerIdentity: (_host, peer) =>
        sameFingerprint(peer.fingerprint256, pin)
          ? undefined
          : new Error("Server certificate changed. Pair again."),
    });
  }
  close(): void {
    this.agent.destroy();
  }
  async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const deadline = new AbortController();
      const signal = options.signal
        ? AbortSignal.any([options.signal, deadline.signal])
        : deadline.signal;
      const timer = setTimeout(
        () => deadline.abort(new Error("Server request exceeded its absolute deadline.")),
        options.timeoutMs ?? 40_000,
      );
      const settle = <T>(callback: (value: T) => void, value: T): void => {
        clearTimeout(timer);
        callback(value);
      };
      const req = request(
        new URL(path, this.origin),
        {
          method,
          agent: this.agent,
          signal,
          headers: {
            "x-ellie-version": String(VERSION),
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            ...(data
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
              : {}),
          },
        },
        (res) => {
          void readJson(res).then(
            (value) => {
              if (res.statusCode !== 200)
                settle(
                  reject,
                  new Error(
                    typeof (value as { error?: unknown })?.error === "string"
                      ? (value as { error: string }).error
                      : "Server request failed.",
                  ),
                );
              else settle(resolve, value);
            },
            (error) => settle(reject, error),
          );
        },
      );
      req.setTimeout(options.timeoutMs ?? 40_000, () =>
        req.destroy(new Error("Server request timed out. Check job status before repeating it.")),
      );
      req.on("error", (error) =>
        settle(
          reject,
          options.signal?.aborted
            ? new Error(
                "Request cancelled. A native side effect that already started may still finish; cancellation does not undo it.",
              )
            : deadline.signal.aborted
              ? new Error(
                  "Server request exceeded its absolute deadline. Check job status before repeating it.",
                )
              : error,
        ),
      );
      req.end(data);
    });
  }
}
