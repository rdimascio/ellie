import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
  stateDir,
  ensureState,
  save,
  load,
  defaults,
  serverConfig,
  nodeConfig,
  serverUrl,
  Keychain,
} from "@ellie/config";
import { identifier, jobMetadata, record, string, result } from "@ellie/protocol";
import { Client, discoverCertificate, fingerprint } from "@ellie/transport";
import { MacOSExecutor } from "@ellie/macos";
import { Auth, newToken } from "../../server/src/auth.ts";
import { createEllieServer } from "../../server/src/index.ts";
import { JobStore } from "../../server/src/jobs.ts";
import { LocalInferenceWorker } from "../../node/src/inference.ts";
import { runNode } from "../../node/src/index.ts";

import { generateCertificate } from "./certificate.ts";
import { Services, serviceRole } from "./services.ts";
import { ServiceLog, failureEvent, serviceLogs } from "./service-logs.ts";
import { doctor, doctorService } from "./diagnostics.ts";
import {
  nodeIdArgument,
  runServiceTest,
  selectExecutionNode,
  serviceTestOptions,
} from "./self-test.ts";

const args = process.argv.slice(2);
const secrets = new Keychain();
let serviceLog: ServiceLog | undefined;
async function exists(name: string): Promise<boolean> {
  try {
    await access(join(stateDir, name));
    return true;
  } catch {
    return false;
  }
}
async function ask(prompt: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Onboarding requires an interactive terminal.");
  const output = secret
    ? new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      })
    : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    if (secret) process.stdout.write(prompt);
    const value = (await rl.question(secret ? "" : prompt)).trim();
    if (secret) process.stdout.write("\n");
    return value;
  } finally {
    rl.close();
  }
}
async function controller(): Promise<Client> {
  const config = serverConfig(await load("server.json"));
  return new Client(
    `https://127.0.0.1:${config.port}`,
    await readFile(join(stateDir, "server-cert.pem"), "utf8"),
    await secrets.get("server.controller"),
  );
}
async function withController(fn: (client: Client) => Promise<void>): Promise<void> {
  const client = await controller();
  try {
    await fn(client);
  } finally {
    client.close();
  }
}
function interruptSignal(): { signal: AbortSignal; dispose: () => void } {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  return {
    signal: abort.signal,
    dispose: () => {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    },
  };
}
async function main(): Promise<void> {
  if (args[0] === "service") {
    const action = args[1];
    if (action === "test") {
      const options = serviceTestOptions(args.slice(2));
      if (options.desktopApp)
        console.log(
          `Desktop test requested: Ellie will open the allowed app “${options.desktopApp}” on the selected node.`,
        );
      await withController(async (client) => {
        const report = await runServiceTest(client, options);
        report.lines.forEach((line) => console.log(line));
      });
      return;
    }
    const role = serviceRole(args[2]);
    if (args.length !== 3)
      throw new Error(
        "Use: bun run ellie service install|start|stop|status|uninstall|logs coordinator|node",
      );
    const services = new Services();
    if (action === "run") {
      process.umask(0o077);
      serviceLog = await ServiceLog.open(stateDir, role);
      serviceLog.write("starting");
      await services.validate(role);
      args.splice(0, args.length, role === "coordinator" ? "server" : "node", "start");
    } else {
      if (action === "status") console.log(JSON.stringify(await services.status(role), null, 2));
      else if (action === "logs")
        console.log(JSON.stringify(await serviceLogs(stateDir, role), null, 2));
      else if (
        action === "install" ||
        action === "start" ||
        action === "stop" ||
        action === "uninstall"
      ) {
        await services[action](role);
        console.log(
          action === "install"
            ? "Service installed. Run service start to enable it now; installation uses the existing identity."
            : action === "start"
              ? "Service start requested. Check service status and doctor for readiness."
              : action === "stop"
                ? "Service stopped and disabled for future logins."
                : "Service uninstalled. Private state, logs, and Keychain credentials were preserved.",
        );
      } else
        throw new Error(
          "Use: bun run ellie service install|start|stop|status|uninstall|logs coordinator|node",
        );
      return;
    }
  }
  if (args[0] === "server" && args[1] === "init") {
    if (await exists("server.json"))
      throw new Error("Server is already initialized. Existing identity was preserved.");
    await ensureState();
    const certPath = join(stateDir, "server-cert.pem");
    const { key, cert } = await generateCertificate();
    const token = newToken();
    await secrets.set("server.key", key);
    await secrets.set("server.controller", token);
    await writeFile(certPath, cert, { mode: 0o600 });
    await Auth.initialize(token);
    await save("server.json", {
      version: 1,
      host: args.includes("--lan") ? "0.0.0.0" : "127.0.0.1",
      port: 7437,
      preferences: defaults,
    });
    console.log("Server initialized. Start it with: bun run ellie server start");
    return;
  }
  if (args[0] === "server" && args[1] === "start") {
    const config = serverConfig(await load("server.json"));
    const cert = await readFile(join(stateDir, "server-cert.pem"), "utf8");
    const jobStore = new JobStore(join(stateDir, "jobs.sqlite"));
    let app: ReturnType<typeof createEllieServer> | undefined;
    try {
      const created = createEllieServer({
        key: await secrets.get("server.key"),
        cert,
        auth: await Auth.open(),
        preferences: config.preferences,
        jobStore,
      });
      app = created;
      await new Promise<void>((resolve, reject) => {
        created.server.once("error", reject);
        created.server.listen(config.port, config.host, () => resolve());
      });
    } catch (error) {
      if (app) app.shutdown();
      else jobStore.close();
      throw error;
    }
    if (!app) throw new Error("Coordinator failed to initialize.");
    console.log(`Ellie server ready on port ${config.port}. No model or cloud API is required.`);
    serviceLog?.write("ready");
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        try {
          serviceLog?.write("stopping");
        } finally {
          app.shutdown();
        }
      });
    return;
  }
  if (args[0] === "server" && args[1] === "pair") {
    await withController(async (client) => {
      const invite = record(await client.call("POST", "/v1/invite", {}));
      console.log("Server SHA-256 fingerprint (verify on the node):");
      console.log(fingerprint(await readFile(join(stateDir, "server-cert.pem"), "utf8")));
      console.log(
        "One-time pairing code, valid for 10 minutes. Enter only into your node pairing prompt:",
      );
      console.log(string(invite.code, 64));
    });
    return;
  }
  if (args[0] === "server" && args[1] === "revoke") {
    const id = identifier(args[2]);
    await withController(async (client) => {
      await client.call("POST", "/v1/revoke", { id });
      console.log("Node revoked.");
    });
    return;
  }
  if (args[0] === "node" && args[1] === "pair") {
    if (await exists("node.json"))
      throw new Error("This node is already paired. See docs/security.md for re-pairing.");
    await ensureState();
    // Check Keychain/helper availability before consuming an invitation.
    const id = randomUUID();
    await secrets.set(`node.${id}`, "pending-pairing");
    const origin = serverUrl(await ask("Server URL (https:// plus its LAN address and :7437): "));
    const pin = await ask("Server SHA-256 fingerprint: ");
    const cert = await discoverCertificate(origin, pin);
    const code = await ask("One-time pairing code (hidden): ", true);
    const client = new Client(origin, cert);
    try {
      const response = record(await client.call("POST", "/v1/pair", { id, code }));
      await secrets.set(`node.${id}`, string(response.token, 64));
      await writeFile(join(stateDir, "node-server-cert.pem"), cert, { mode: 0o600 });
      await save("node.json", { version: 1, id, serverUrl: origin, preferences: defaults });
      console.log("Paired. Run bun run ellie doctor, then bun run ellie node start");
    } finally {
      client.close();
    }
    return;
  }
  if (args[0] === "node" && args[1] === "start") {
    const config = nodeConfig(await load("node.json"));
    const client = new Client(
      config.serverUrl,
      await readFile(join(stateDir, "node-server-cert.pem"), "utf8"),
      await secrets.get(`node.${config.id}`),
    );
    const abort = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        try {
          serviceLog?.write("stopping");
        } finally {
          abort.abort();
          client.close();
        }
      });
    const native = new MacOSExecutor();
    try {
      await runNode({
        client,
        executor: config.executionEnabled ? native : undefined,
        worker: config.inferenceWorker
          ? new LocalInferenceWorker(config.inferenceWorker)
          : undefined,
        health: () => native.health(),
        preferences: config.preferences,
        signal: abort.signal,
        onStatus: serviceLog ? undefined : console.log,
        onEvent: (event) => serviceLog?.write(event),
      });
    } finally {
      client.close();
    }
    return;
  }
  if (args[0] === "doctor") {
    const report = args[1] ? await doctorService(serviceRole(args[1])) : await doctor();
    report.lines.forEach((line) => console.log(line));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (args[0] === "nodes") {
    await withController(async (client) => {
      console.log(JSON.stringify(await client.call("GET", "/v1/nodes"), null, 2));
    });
    return;
  }
  if (args[0] === "jobs") {
    await withController(async (client) => {
      console.log(JSON.stringify(await client.call("GET", "/v1/jobs"), null, 2));
    });
    return;
  }
  if (args[0] === "job") {
    const id = identifier(args[1]);
    await withController(async (client) => {
      console.log(JSON.stringify(jobMetadata(await client.call("GET", `/v1/jobs/${id}`)), null, 2));
    });
    return;
  }
  if (args[0] === "cancel") {
    const id = identifier(args[1]);
    await withController(async (client) => {
      console.log(
        JSON.stringify(jobMetadata(await client.call("POST", `/v1/jobs/${id}`, {})), null, 2),
      );
    });
    return;
  }
  if (args[0] === "infer") {
    const model = string(args[1], 200);
    const prompt = string(args.slice(2).join(" "), 4000);
    await withController(async (client) => {
      const interrupt = interruptSignal();
      try {
        const response = result(
          await client.call("POST", "/v1/inference", { model, prompt }, interrupt),
        );
        console.log(response.message);
        if (!response.ok) process.exitCode = 1;
      } finally {
        interrupt.dispose();
      }
    });
    return;
  }
  if (args[0] === "say") {
    let client: Client;
    let nodeId: string;
    let words: string[];
    if (args[1] === "--node") {
      nodeId = nodeIdArgument(args[2]);
      words = args.slice(3);
      client = await controller();
    } else if (await exists("node.json")) {
      const config = nodeConfig(await load("node.json"));
      nodeId = config.id;
      words = args.slice(1);
      client = new Client(
        config.serverUrl,
        await readFile(join(stateDir, "node-server-cert.pem"), "utf8"),
        await secrets.get(`node.${config.id}`),
      );
    } else {
      client = await controller();
      nodeId = selectExecutionNode(await client.call("GET", "/v1/nodes")).id;
      words = args.slice(1);
    }
    const interrupt = interruptSignal();
    try {
      const response = result(
        await client.call(
          "POST",
          "/v1/commands",
          { nodeId, text: string(words.join(" "), 500) },
          interrupt,
        ),
      );
      console.log(response.message);
      if (!response.ok) process.exitCode = 1;
    } finally {
      interrupt.dispose();
      client.close();
    }
    return;
  }
  console.log(
    `Ellie — local-first personal assistant\n\n  server init [--lan]   Generate private config and Keychain identity\n  server start          Start the HTTPS coordinator\n  server pair           Issue a single-use pairing invitation\n  server revoke ID      Revoke a paired node\n  node pair             Pair this Mac interactively\n  node start            Run enabled execution and inference roles\n  service ACTION ROLE   install|start|stop|status|uninstall|logs; coordinator|node\n  service test [FLAGS]  Read-only readiness; --desktop --app NAME opts into app opening\n  doctor [ROLE]         Check native tools or role-specific service health\n  nodes                 List capabilities and worker telemetry (server Mac)\n  infer MODEL "..."     Run inference on an eligible Mac (server Mac)\n  jobs                   List recent payload-free job metadata\n  job ID                 Inspect payload-free job metadata\n  cancel ID              Request job cancellation\n  say "open Arc"        Send to this Mac, or the only online execution node\n  say --node ID "..."   Target a paired Mac from the server`,
  );
}
main().catch((error) => {
  if (serviceLog) {
    try {
      serviceLog.write(failureEvent(error));
    } catch {
      /* Stderr is discarded by launchd; never fall back to raw errors. */
    }
    console.error("Service failed. Run doctor and service logs for diagnostics.");
    process.exitCode = 1;
    return;
  }
  const code = (error as NodeJS.ErrnoException).code;
  console.error(
    code === "ENOENT"
      ? "Private configuration is missing. Run server init or node pair first."
      : error instanceof SyntaxError
        ? "Private configuration is invalid JSON. Review the local configuration file."
        : code
          ? "Could not access a required local resource. Run doctor for diagnostics."
          : error instanceof Error
            ? error.message
            : "Ellie could not complete the request.",
  );
  process.exitCode = 1;
});
