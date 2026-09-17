import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { defaults } from "@ellie/config";
import { Auth } from "../apps/server/src/auth.ts";
import { generateCertificate } from "../apps/cli/src/certificate.ts";

const node = process.execPath;
const main = new URL("../apps/cli/src/main.ts", import.meta.url).pathname;
type Role = "node" | "coordinator";
type Owned = {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  bytes: () => number;
};

async function within<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function launch(home: string, helper: string, attempts: string, args: string[]): Owned {
  const child = spawn(node, [main, ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      NODE_OPTIONS: "",
      ELLIE_MACOS_HELPER: helper,
      ELLIE_TEST_HELPER_ATTEMPTS: attempts,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  let outputBytes = 0;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (value: Buffer) => {
      outputBytes += value.length;
      if (outputBytes > 16_384) child.kill("SIGTERM");
    });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  void closed.catch(() => {});
  return { child, closed, bytes: () => outputBytes };
}

async function stop(owned: Owned): Promise<boolean> {
  if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
    await within(owned.closed, 3_000, "Owned CLI child did not close after exit.");
    return false;
  }
  assert.equal(owned.child.kill("SIGTERM"), true, "Could not signal the retained CLI child.");
  try {
    await within(owned.closed, 3_000, "Owned CLI child ignored SIGTERM.");
    return false;
  } catch {
    if (owned.child.exitCode === null && owned.child.signalCode === null)
      owned.child.kill("SIGKILL");
    await within(owned.closed, 3_000, "Owned CLI child cleanup is uncertain.");
    return true;
  }
}

async function events(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { event: string }).event);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function attemptCount(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function attention(owned: Owned, log: string, expected: number): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    const observed = await events(log);
    if (observed.filter((event) => event === "needs_attention").length === expected) return;
    if (owned.child.exitCode !== null || owned.child.signalCode !== null)
      throw new Error("Service exited before reporting credential attention.");
    await delay(20);
  }
  throw new Error("Service did not report credential attention.");
}

test(
  "service startup credential failure pauses once until explicit restart; foreground remains failed",
  { skip: process.platform !== "darwin", timeout: 30_000 },
  async (t) => {
    assert.match(process.version, /^v24\./, "The service process fixture requires Node 24.");
    const fixtures: string[] = [];
    const children: Owned[] = [];
    let completed = false;
    let cleanupCertain = true;
    try {
      for (const role of ["node", "coordinator"] as Role[]) {
        const home = await mkdtemp(join(tmpdir(), `ellie-${role}-attention-`));
        fixtures.push(home);
        const state = join(home, ".ellie");
        const bin = join(state, "bin");
        await mkdir(bin, { recursive: true, mode: 0o700 });
        await chmod(state, 0o700);
        const helper = join(bin, "ellie-macos");
        const attempts = join(home, "helper-attempts.txt");
        await writeFile(
          helper,
          '#!/bin/sh\nprintf "attempt\\n" >> "$ELLIE_TEST_HELPER_ATTEMPTS"\nexit 1\n',
          { mode: 0o700 },
        );
        const { cert } = await generateCertificate();
        if (role === "node") {
          await writeFile(
            join(state, "node.json"),
            JSON.stringify({
              version: 1,
              id: "synthetic-node",
              serverUrl: "https://127.0.0.1:17437",
              preferences: defaults,
              executionEnabled: false,
            }),
            { mode: 0o600 },
          );
          await writeFile(join(state, "node-server-cert.pem"), cert, { mode: 0o600 });
        } else {
          await writeFile(
            join(state, "server.json"),
            JSON.stringify({ version: 1, host: "127.0.0.1", port: 17437, preferences: defaults }),
            { mode: 0o600 },
          );
          await writeFile(join(state, "server-cert.pem"), cert, { mode: 0o600 });
          await Auth.initialize("a".repeat(64), state);
        }
        const log = join(state, "logs", `${role}.jsonl`);
        for (const generation of [1, 2]) {
          const owned = launch(home, helper, attempts, ["service", "run", role]);
          children.push(owned);
          await attention(owned, log, generation);
          assert.equal(owned.child.exitCode, null, "Attention must retain the service process.");
          assert.equal(owned.child.signalCode, null);
          await delay(250);
          assert.equal(await attemptCount(attempts), generation, "No helper retry is allowed.");
          assert.equal(owned.bytes() <= 16_384, true);
          assert.deepEqual(
            await events(log),
            Array.from({ length: generation }, () => [
              "starting",
              "keychain_access_unavailable",
              "needs_attention",
            ]).flat(),
          );
          assert.equal(await stop(owned), false, "SIGTERM should close without escalation.");
        }
        const foreground = launch(
          home,
          helper,
          attempts,
          role === "node" ? ["node", "start"] : ["server", "start"],
        );
        children.push(foreground);
        assert.equal(
          (await within(foreground.closed, 5_000, "Foreground CLI did not exit.")).code,
          1,
        );
        assert.equal(await attemptCount(attempts), 3);
        assert.deepEqual(
          await events(log),
          Array.from({ length: 2 }, () => [
            "starting",
            "keychain_access_unavailable",
            "needs_attention",
          ]).flat(),
          "Foreground failure must not enter service attention state.",
        );
      }
      completed = true;
    } finally {
      for (const owned of children)
        try {
          if (await stop(owned)) cleanupCertain = false;
        } catch {
          cleanupCertain = false;
        }
      if (completed && cleanupCertain)
        for (const home of fixtures) await rm(home, { recursive: true });
      else for (const home of fixtures) t.diagnostic(`Retained credential fixture: ${home}`);
    }
    assert.equal(cleanupCertain, true, "Owned CLI child cleanup is uncertain.");
  },
);
