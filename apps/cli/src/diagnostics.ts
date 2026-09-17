import { X509Certificate, createPrivateKey } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DESKTOP_CAPABILITIES,
  capabilities as parseCapabilities,
  operationDefinition,
  record,
} from "@ellie/protocol";
import type { Capability } from "@ellie/protocol";
import { Keychain, nativeHelperPath, nodeConfig, serverConfig, stateDir } from "@ellie/config";
import type { InferenceWorkerConfig, NodeConfig, ServerConfig } from "@ellie/config";
import { MacOSExecutor } from "@ellie/macos";
import { Client } from "@ellie/transport";
import { LocalInferenceWorker } from "../../node/src/inference.ts";
import { packagedServiceContext, packagedServiceStatus } from "./packaged-service-status.ts";
import { privatePath, run, Services } from "./services.ts";
import type { Run, ServiceRole, ServiceStatus } from "./services.ts";

export interface DiagnosticReport {
  ok: boolean;
  lines: string[];
}

interface DiagnosticClient {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  close(): void;
}

export interface DiagnosticDependencies {
  stateDir: string;
  uid: number | undefined;
  now: () => number;
  readFile: (path: string) => Promise<string>;
  privatePath: (path: string, directory?: boolean, uid?: number) => Promise<void>;
  access: (path: string, mode?: number) => Promise<void>;
  keychainGet: (account: string) => Promise<string>;
  serviceStatus: (role: ServiceRole) => Promise<ServiceStatus>;
  capabilities: () => Promise<Capability[]>;
  run: Run;
  client: (origin: string, cert: string, token: string) => DiagnosticClient;
  inferenceHealth: (config: InferenceWorkerConfig) => Promise<boolean>;
}

function dependencies(overrides: Partial<DiagnosticDependencies>): DiagnosticDependencies {
  const dir = overrides.stateDir ?? stateDir;
  const keychain = new Keychain();
  const services = new Services({ home: join(dir, "..") });
  return {
    stateDir: dir,
    uid: process.getuid?.(),
    now: Date.now,
    readFile: (path) => readFile(path, "utf8"),
    privatePath,
    access,
    keychainGet: (account) => keychain.get(account),
    serviceStatus: (role) => {
      const context = packagedServiceContext();
      return context ? packagedServiceStatus(role, context, run) : services.status(role);
    },
    capabilities: () => new MacOSExecutor().capabilities(),
    run,
    client: (origin, cert, token) => new Client(origin, cert, token),
    inferenceHealth: async (config) => {
      const models = await new LocalInferenceWorker(config).advertise(AbortSignal.timeout(4_000));
      return models.models.length > 0;
    },
    ...overrides,
  };
}

function availableTools(capabilities: readonly Capability[]): string {
  return `Available tools: ${capabilities.join(", ")}`;
}

/** Preserve the original, lightweight `ellie doctor` behavior. */
export async function doctor(
  deps: Partial<DiagnosticDependencies> = {},
): Promise<DiagnosticReport> {
  const environment = dependencies(deps);
  try {
    const capabilities = await environment.capabilities();
    const ok = capabilities.includes(operationDefinition("window.place").requiredCapability);
    return {
      ok,
      lines: [
        availableTools(capabilities),
        ...(ok
          ? []
          : [
              "Enable your terminal and ~/.ellie/bin/ellie-macos in System Settings > Privacy & Security > Accessibility. Restart the node afterward.",
            ]),
      ],
    };
  } catch {
    return {
      ok: false,
      lines: [
        "Available tools: ",
        "The native helper is unavailable. Build it and check its permissions before restarting the node.",
      ],
    };
  }
}

function certificateIsCurrent(cert: string, now: number): boolean {
  const parsed = new X509Certificate(cert);
  const from = Date.parse(parsed.validFrom);
  const to = Date.parse(parsed.validTo);
  return Number.isFinite(from) && Number.isFinite(to) && from <= now && now < to;
}

function statusHealthy(status: ServiceStatus): boolean {
  return (
    status.installed &&
    status.guiSession &&
    status.loaded &&
    status.enabled === true &&
    status.state === "running"
  );
}

function freshNode(value: unknown, id: string, now: number): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    try {
      const node = record(item);
      if (
        node.id === id &&
        typeof node.lastSeen === "number" &&
        Number.isFinite(node.lastSeen) &&
        Math.abs(now - node.lastSeen) <= 60_000
      )
        return node;
    } catch {
      /* Ignore malformed registrations without exposing their contents. */
    }
  }
  return undefined;
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("diagnostic timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run role-specific service diagnostics. Messages are deliberately fixed: dependency
 * errors can contain credentials, private paths, node IDs, URLs, or model names.
 */
export async function doctorService(
  role: ServiceRole,
  deps: Partial<DiagnosticDependencies> = {},
): Promise<DiagnosticReport> {
  const environment = dependencies(deps);
  const lines: string[] = [];
  let ok = true;
  const pass = (message: string): void => {
    lines.push(`PASS ${message}`);
  };
  const fail = (message: string): void => {
    ok = false;
    lines.push(`FAIL ${message}`);
  };
  const warn = (message: string): void => {
    lines.push(`WARN ${message}`);
  };

  const coordinator = role === "coordinator";
  const configName = coordinator ? "server.json" : "node.json";
  const certificateName = coordinator ? "server-cert.pem" : "node-server-cert.pem";
  let config: ServerConfig | NodeConfig | undefined;
  let cert: string | undefined;
  let secrets: string[] | undefined;

  try {
    await environment.privatePath(environment.stateDir, true, environment.uid);
    const required = [configName, certificateName, ...(coordinator ? ["auth.json"] : [])];
    await Promise.all(
      required.map((name) =>
        environment.privatePath(join(environment.stateDir, name), false, environment.uid),
      ),
    );
    const raw = JSON.parse(await environment.readFile(join(environment.stateDir, configName)));
    config = coordinator ? serverConfig(raw) : nodeConfig(raw);
    cert = await environment.readFile(join(environment.stateDir, certificateName));
    pass(`${coordinator ? "Coordinator" : "Node"} configuration and file permissions are safe.`);
  } catch {
    fail(
      `${coordinator ? "Coordinator" : "Node"} configuration is missing, invalid, or has unsafe permissions.`,
    );
  }

  if (config && cert) {
    try {
      if (!certificateIsCurrent(cert, environment.now())) throw new Error("invalid certificate");
      pass("The pinned TLS certificate is currently valid.");
    } catch {
      fail("The pinned TLS certificate is invalid, expired, or not yet valid.");
    }
  } else {
    fail("The pinned TLS certificate could not be checked.");
  }

  if (config) {
    const accounts = coordinator
      ? ["server.key", "server.controller"]
      : [`node.${(config as NodeConfig).id}`];
    try {
      secrets = await Promise.all(accounts.map((account) => environment.keychainGet(account)));
      if (secrets.some((value) => !value)) throw new Error("empty credential");
      if (coordinator && cert) {
        const parsed = new X509Certificate(cert);
        if (!parsed.checkPrivateKey(createPrivateKey(secrets[0]!)))
          throw new Error("certificate mismatch");
      }
      pass(`${coordinator ? "Coordinator" : "Node"} credentials are available in Keychain.`);
    } catch {
      secrets = undefined;
      fail(
        `${coordinator ? "Coordinator" : "Node"} credentials are unavailable or do not match this identity.`,
      );
    }
  } else {
    fail(`${coordinator ? "Coordinator" : "Node"} credentials could not be checked.`);
  }

  const helper = nativeHelperPath(process.env, environment.stateDir);
  try {
    await environment.access(helper, constants.X_OK);
    const signature = await environment.run("/usr/bin/codesign", ["--verify", "--strict", helper]);
    if (signature.code !== 0) throw new Error("invalid signature");
    pass("The native helper is executable and its code signature verifies.");
  } catch {
    fail("The native helper is missing, not executable, or has an invalid code signature.");
  }

  let capabilities: Capability[] | undefined;
  let terminalMissing = false;
  try {
    capabilities = await environment.capabilities();
    lines.push(`Terminal helper tools: ${capabilities.join(", ")}`);
    terminalMissing = DESKTOP_CAPABILITIES.some(
      (capability) => !capabilities!.includes(capability),
    );
    if (
      !coordinator &&
      (config as NodeConfig | undefined)?.executionEnabled !== false &&
      terminalMissing
    )
      warn(
        "The terminal-launched helper lacks some desktop tools; the running node service is checked separately.",
      );
    else if (terminalMissing)
      warn("Accessibility is incomplete; this role does not require every desktop tool.");
    else pass("The terminal-launched helper reports every desktop capability.");
  } catch {
    fail("Native helper capabilities could not be checked.");
  }

  try {
    const status = await environment.serviceStatus(role);
    if (!status.guiSession) fail("No logged-in graphical session is available for this service.");
    else pass("A logged-in graphical session is available.");
    if (statusHealthy(status))
      pass(`${coordinator ? "Coordinator" : "Node"} LaunchAgent is installed and running.`);
    else
      fail(
        `${coordinator ? "Coordinator" : "Node"} LaunchAgent is not installed, enabled, loaded, and running.`,
      );
  } catch {
    fail(`${coordinator ? "Coordinator" : "Node"} LaunchAgent status could not be inspected.`);
  }

  if (config && cert && secrets) {
    const origin = coordinator
      ? `https://127.0.0.1:${(config as ServerConfig).port}`
      : (config as NodeConfig).serverUrl;
    const token = coordinator ? secrets[1]! : secrets[0]!;
    let client: DiagnosticClient | undefined;
    try {
      client = environment.client(origin, cert, token);
      const nodes = await within(client.call("GET", "/v1/nodes"), 5_000);
      const registered = coordinator
        ? undefined
        : freshNode(nodes, (config as NodeConfig).id, environment.now());
      if (!coordinator && !registered) throw new Error("node is stale");
      pass(
        coordinator
          ? "The coordinator's pinned authenticated endpoint is reachable."
          : "The coordinator is reachable and this node's registration is fresh.",
      );
      if (registered) {
        try {
          // This is the helper result reported by the node process. A helper
          // spawned from this terminal can have different Accessibility trust.
          const advertised = parseCapabilities(
            registered.executionCapabilities ?? registered.capabilities,
          );
          lines.push(`Registered node tools: ${advertised.join(", ")}`);
          const registeredMissing = DESKTOP_CAPABILITIES.some(
            (capability) => !advertised.includes(capability),
          );
          if ((config as NodeConfig).executionEnabled && registeredMissing)
            fail(
              "The running node has not advertised every desktop tool. Check Accessibility for the service and restart the node; terminal permissions alone do not establish service permissions.",
            );
          else if ((config as NodeConfig).executionEnabled)
            pass("The running node advertises every desktop capability.");
          if ((config as NodeConfig).executionEnabled && terminalMissing && !registeredMissing)
            warn(
              "Terminal and service Accessibility differ; the healthy running service registration is authoritative for background commands.",
            );
        } catch {
          fail("The running node's advertised capabilities are invalid or unavailable.");
        }
      }
    } catch {
      fail(
        coordinator
          ? "The coordinator's pinned authenticated endpoint is unavailable."
          : "The coordinator is unavailable or this node's registration is stale.",
      );
    } finally {
      client?.close();
    }
  } else {
    fail("Authenticated service reachability could not be checked.");
  }

  const inference = !coordinator ? (config as NodeConfig | undefined)?.inferenceWorker : undefined;
  if (inference) {
    try {
      if (!(await environment.inferenceHealth(inference))) throw new Error("unavailable");
      pass("The optional local inference worker is reachable and has an enabled model.");
    } catch {
      warn("The optional local inference worker is unavailable; desktop commands are unaffected.");
    }
  } else if (!coordinator && config) {
    warn("Optional local inference is not configured; desktop commands are unaffected.");
  }

  return { ok, lines };
}
