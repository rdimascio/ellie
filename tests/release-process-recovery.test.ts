import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Auth, newToken } from "../apps/server/src/auth.ts";
import { generateCertificate } from "../apps/cli/src/certificate.ts";
import { Client } from "@ellie/transport";
import { record } from "@ellie/protocol";

const childSource = new URL("./fixtures/reliability-child.ts", import.meta.url).pathname;
const eventually = async (check: () => Promise<boolean>, timeout = 5000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for synthetic process state.");
};
const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test port unavailable.");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};
function child(
  role: "coordinator" | "node" | "stalled",
  environment: NodeJS.ProcessEnv = {},
): ChildProcess {
  return spawn(process.execPath, [childSource, role], {
    env: { PATH: process.env.PATH, ...environment },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}
async function event(process: ChildProcess, expected: string, timeout = 5000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      process.off("message", receive);
      process.off("error", failed);
      process.off("exit", exited);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected}.`));
    }, timeout);
    const receive = (value: unknown) => {
      if ((value as { event?: string })?.event === expected) {
        cleanup();
        resolve();
      }
    };
    const failed = () => {
      cleanup();
      reject(new Error(`Fixture failed before ${expected}.`));
    };
    const exited = () => {
      cleanup();
      reject(new Error(`Fixture exited before ${expected}.`));
    };
    process.on("message", receive);
    process.once("error", failed);
    process.once("exit", exited);
  });
}
async function stop(process: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!process || process.exitCode !== null || process.signalCode) return;
  await new Promise<void>((resolve, reject) => {
    const grace = setTimeout(
      () => {
        process.kill("SIGKILL");
      },
      signal === "SIGKILL" ? 0 : 1000,
    );
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error("Fixture process could not be reaped."));
    }, 3000);
    const cleanup = () => {
      clearTimeout(grace);
      clearTimeout(deadline);
      process.off("error", failed);
      process.off("exit", exited);
    };
    const failed = () => {
      cleanup();
      reject(new Error("Fixture process termination failed."));
    };
    const exited = () => {
      cleanup();
      resolve();
    };
    process.once("error", failed);
    process.once("exit", exited);
    process.kill(signal);
  });
}

async function stopAll(...processes: Array<ChildProcess | undefined>): Promise<void> {
  const results = await Promise.allSettled(processes.map((process) => stop(process)));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Fixture cleanup failed.",
    );
}

test("stalled shutdown escalates to exact-child kill before owned state cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-release-stalled-"));
  await chmod(directory, 0o700);
  const sentinel = join(directory, "sentinel");
  await writeFile(sentinel, "owned", { mode: 0o600 });
  const stalled = child("stalled");
  let reaped = false;
  try {
    await event(stalled, "ready");
    const term = event(stalled, "term");
    const stopping = stop(stalled);
    await term;
    assert.equal(await readFile(sentinel, "utf8"), "owned");
    await stopping;
    reaped = true;
    assert.equal(stalled.signalCode, "SIGKILL");
  } finally {
    if (!reaped) await stopAll(stalled);
    if (reaped || stalled.exitCode !== null || stalled.signalCode !== null)
      await rm(directory, { recursive: true, force: true });
  }
});

test(
  "process interruption preserves unknown outcome without replay and reconnects for fresh work",
  { timeout: 25_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ellie-release-process-"));
    await chmod(directory, 0o700);
    const effects = join(directory, "effects.jsonl");
    await writeFile(effects, "", { mode: 0o600 });
    const identity = await generateCertificate();
    await writeFile(join(directory, "server-key.pem"), identity.key, { mode: 0o600 });
    await writeFile(join(directory, "server-cert.pem"), identity.cert, { mode: 0o600 });
    const controllerToken = newToken();
    await Auth.initialize(controllerToken, directory);
    const port = await freePort();
    const origin = `https://127.0.0.1:${port}`;
    const coordinatorEnvironment = {
      ELLIE_RELIABILITY_STATE: directory,
      ELLIE_RELIABILITY_PORT: String(port),
    };
    let coordinator: ChildProcess | undefined;
    let node: ChildProcess | undefined;
    let controller: Client | undefined;
    let pairing: Client | undefined;
    try {
      coordinator = child("coordinator", coordinatorEnvironment);
      await event(coordinator, "ready");
      controller = new Client(origin, identity.cert, controllerToken);
      const invitation = record(await controller.call("POST", "/v1/invite", {}));
      pairing = new Client(origin, identity.cert);
      const paired = record(
        await pairing.call("POST", "/v1/pair", { id: "release-node", code: invitation.code }),
      );
      node = child("node", {
        ELLIE_RELIABILITY_ORIGIN: origin,
        ELLIE_RELIABILITY_CERT: join(directory, "server-cert.pem"),
        ELLIE_RELIABILITY_NODE_TOKEN: String(paired.token),
        ELLIE_RELIABILITY_EFFECTS: effects,
      });
      await event(node, "connected");

      const interrupted = controller.call("POST", "/v1/commands", {
        nodeId: "release-node",
        text: "open Arc",
      });
      void interrupted.catch(() => {});
      await event(node, "effect");
      await stop(coordinator, "SIGKILL");
      coordinator = undefined;
      await assert.rejects(interrupted);

      coordinator = child("coordinator", coordinatorEnvironment);
      await event(coordinator, "ready");
      controller.close();
      controller = new Client(origin, identity.cert, controllerToken);
      await eventually(async () => {
        const jobs = (await controller!.call("GET", "/v1/jobs")) as Array<{
          state: string;
          outcomeCode?: string;
        }>;
        return jobs[0]?.state === "unknown" && jobs[0]?.outcomeCode === "unknown_after_restart";
      });
      await eventually(async () => {
        const nodes = (await controller!.call("GET", "/v1/nodes")) as Array<{ id?: string }>;
        return nodes.some((item) => item.id === "release-node");
      });

      const fresh = record(
        await controller.call("POST", "/v1/commands", {
          nodeId: "release-node",
          text: "open Safari",
        }),
      );
      assert.equal(fresh.ok, true);
      const lines = (await readFile(effects, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        lines.map((action) => action.app),
        ["company.thebrowser.Browser", "com.apple.Safari"],
      );

      await stop(node);
      node = undefined;
      const queued = controller.call("POST", "/v1/commands", {
        nodeId: "release-node",
        text: "open Messages",
      });
      void queued.catch(() => {});
      await eventually(
        async () =>
          ((await controller!.call("GET", "/v1/jobs")) as Array<{ state: string }>)[0]?.state ===
          "queued",
      );
      const jobs = (await controller.call("GET", "/v1/jobs")) as Array<{ id: string }>;
      await controller.call("POST", `/v1/jobs/${jobs[0]!.id}`, {});
      assert.equal(record(await queued).ok, false);

      const revoked = controller.call("POST", "/v1/commands", {
        nodeId: "release-node",
        text: "open Messages",
      });
      void revoked.catch(() => {});
      await eventually(
        async () =>
          ((await controller!.call("GET", "/v1/jobs")) as Array<{ state: string }>)[0]?.state ===
          "queued",
      );
      await controller.call("POST", "/v1/revoke", { id: "release-node" });
      assert.equal(record(await revoked).ok, false);
      assert.equal((await readFile(effects, "utf8")).trim().split("\n").filter(Boolean).length, 2);
    } finally {
      controller?.close();
      pairing?.close();
      await stopAll(node, coordinator);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
