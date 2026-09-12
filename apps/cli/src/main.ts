import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
  stateDir,
  ensureState,
  save,
  defaults,
  serverConfig,
  nodeConfig,
  serverUrl,
  Keychain,
} from "@ellie/config";
import { identifier, jobMetadata, record, string } from "@ellie/protocol";
import { Client, discoverCertificate, fingerprint } from "@ellie/transport";
import { MacOSExecutor } from "@ellie/macos";
import { Auth, newToken } from "../../server/src/auth.ts";
import { createEllieServer } from "../../server/src/index.ts";
import { JobStore } from "../../server/src/jobs.ts";
import { loadBrowserAssets } from "../../server/src/browser-assets.ts";
import { LocalInferenceWorker } from "../../node/src/inference.ts";
import { runNode } from "../../node/src/index.ts";

import { generateCertificate } from "./certificate.ts";
import { generateBrowserTlsIdentity } from "./certificate.ts";
import {
  browserStatus,
  exportBrowserCa,
  initializeBrowser,
  systemLocalHostname,
} from "./browser-setup.ts";
import { createBrowserRuntime } from "./browser-runtime.ts";
import { parseBrowserCommand, runBrowserCommand } from "./browser-commands.ts";
import { Services, serviceRole } from "./services.ts";
import { ServiceLog, failureEvent, serviceLogs } from "./service-logs.ts";
import { doctor, doctorService } from "./diagnostics.ts";
import {
  implicitSayTarget,
  nodeIdArgument,
  runServiceTest,
  selectExecutionNode,
  serviceTestOptions,
} from "./self-test.ts";
import { cliErrorMessage, coordinatorResult, privateConfig } from "./errors.ts";

const args = process.argv.slice(2);
const secrets = new Keychain();
const browserEnvironment = {
  stateDir,
  secrets,
  localHostname: systemLocalHostname,
  generate: (hostname: string) => generateBrowserTlsIdentity(hostname),
  now: Date.now,
};
let serviceLog: ServiceLog | undefined;
let commandOutcomeMayBeUnknown = false;
async function exists(name: string): Promise<boolean> {
  try {
    await access(join(stateDir, name));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
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
  const config = serverConfig(await privateConfig("server.json"));
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
  if (args[0] === "browser") {
    const environment = browserEnvironment;
    if (args[1] === "init" && args.length === 2) {
      const config = await initializeBrowser(environment);
      console.log(
        `Browser identity ready for https://${config.hostname}:${config.port}. No listener was started and no trust setting was changed.`,
      );
      return;
    }
    if (args[1] === "status" && args.length === 2) {
      const status = await browserStatus(environment);
      console.log(JSON.stringify(status, null, 2));
      if (!status.ready) process.exitCode = 1;
      return;
    }
    if (args[1] === "export-ca") {
      const force = args[3] === "--force";
      if (!args[2] || args.length !== (force ? 4 : 3))
        throw new Error("Use: bun run ellie browser export-ca PATH [--force]");
      const output = resolve(args[2]);
      await exportBrowserCa(environment, output, force);
      console.log(
        `Public browser CA exported to ${output}. Transfer only this public certificate through an existing trusted local channel; installation does not enable trust automatically.`,
      );
      return;
    }
    const command = parseBrowserCommand(args.slice(1));
    await withController(async (client) => {
      for (const line of await runBrowserCommand(client, command)) console.log(line);
    });
    return;
  }
  if (args[0] === "service") {
    const action = args[1];
    if (action === "test") {
      const options = serviceTestOptions(args.slice(2));
      if (options.desktopApp)
        console.log(
          `Desktop test requested: Ellie will open the allowed app “${options.desktopApp}” on the selected node.`,
        );
      await withController(async (client) => {
        const report = await runServiceTest(client, options, Date.now(), {
          submit: () => {
            commandOutcomeMayBeUnknown = true;
          },
          settle: () => {
            commandOutcomeMayBeUnknown = false;
          },
        });
        commandOutcomeMayBeUnknown = false;
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
            ? `Service installed with its Ellie app name and icon. Run service start, then doctor; existing pairing and Keychain credentials were preserved.${role === "node" ? " Enable Ellie Node in Accessibility for window control." : ""}`
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
    const config = serverConfig(await privateConfig("server.json"));
    const cert = await readFile(join(stateDir, "server-cert.pem"), "utf8");
    const jobStore = new JobStore(join(stateDir, "jobs.sqlite"));
    // The coordinator lifetime lock also owns the single browser authorization writer.
    const browser = createBrowserRuntime({
      setup: browserEnvironment,
      bindHost: config.host,
      loadAssets: loadBrowserAssets,
    });
    let app: ReturnType<typeof createEllieServer> | undefined;
    try {
      const created = createEllieServer({
        key: await secrets.get("server.key"),
        cert,
        auth: await Auth.open(),
        preferences: config.preferences,
        jobStore,
        browser,
      });
      app = created;
      await new Promise<void>((resolve, reject) => {
        created.server.once("error", reject);
        created.server.listen(config.port, config.host, () => resolve());
      });
    } catch (error) {
      await browser.shutdown();
      if (app) app.shutdown();
      else jobStore.close();
      throw error;
    }
    if (!app) throw new Error("Coordinator failed to initialize.");
    console.log(`Ellie server ready on port ${config.port}. No model or cloud API is required.`);
    serviceLog?.write("ready");
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        serviceLog?.write("stopping");
      } finally {
        // Stop accepting browser mutations and drain persistence before releasing the lock.
        try {
          await browser.shutdown();
        } finally {
          app!.shutdown();
        }
      }
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void stop().catch(() => {
          process.exitCode = 1;
        });
      });
    // Agent readiness and signal handlers precede optional browser Keychain access.
    await browser.start();
    if (!stopping) {
      const status = browser.current().status;
      if (status === "ready") serviceLog?.write("browser_ready");
      else if (status === "unavailable") serviceLog?.write("browser_unavailable");
    }
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
    const config = nodeConfig(await privateConfig("node.json"));
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
        commandOutcomeMayBeUnknown = true;
        const response = coordinatorResult(
          await client.call("POST", "/v1/inference", { model, prompt }, interrupt),
        );
        commandOutcomeMayBeUnknown = false;
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
    } else if (implicitSayTarget(await exists("server.json")) === "node") {
      const config = nodeConfig(await privateConfig("node.json"));
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
      commandOutcomeMayBeUnknown = true;
      const response = coordinatorResult(
        await client.call(
          "POST",
          "/v1/commands",
          { nodeId, text: string(words.join(" "), 500) },
          interrupt,
        ),
      );
      commandOutcomeMayBeUnknown = false;
      console.log(response.message);
      if (!response.ok) process.exitCode = 1;
    } finally {
      interrupt.dispose();
      client.close();
    }
    return;
  }
  console.log(
    `Ellie — local-first personal assistant\n\n  server init [--lan]   Generate private config and Keychain identity\n  server start          Start the HTTPS coordinator\n  server pair           Issue a single-use pairing invitation\n  server revoke ID      Revoke a paired node\n  browser init          Prepare a separate local browser TLS identity\n  browser status        Inspect browser identity readiness without printing keys\n  browser export-ca P   Export only the public browser CA; --force replaces P\n  browser connection    Inspect the running browser listener\n  browser invite ROLE   phone|tv --label NAME; phone also needs --node ID --allow CAPS\n  browser clients       List paired browser identities\n  browser revoke ID     Revoke a paired browser identity\n  node pair             Pair this Mac interactively\n  node start            Run enabled execution and inference roles\n  service ACTION ROLE   install|start|stop|status|uninstall|logs; coordinator|node\n  service test [FLAGS]  Read-only readiness; --desktop --app NAME opts into app opening\n  doctor [ROLE]         Check native tools or role-specific service health\n  nodes                 List capabilities and worker telemetry (server Mac)\n  infer MODEL "..."     Run inference on an eligible Mac (server Mac)\n  jobs                   List recent payload-free job metadata\n  job ID                 Inspect payload-free job metadata\n  cancel ID              Request job cancellation\n  say "open Arc"        Send to this Mac, or the only online execution node\n  say --node ID "..."   Target a paired Mac from the server`,
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
  console.error(cliErrorMessage(error, commandOutcomeMayBeUnknown));
  process.exitCode = 1;
});
