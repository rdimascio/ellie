import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  browserConfig,
  ensureState,
  save,
  load,
  defaults,
  serverConfig,
  nodeConfig,
  Keychain,
  KeychainFailure,
  nativeHelperPath,
} from "@ellie/config";
import { Auth, newToken } from "../apps/server/src/auth.ts";

test("private state has restricted permissions and credentials are stored only as hashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-state-"));
  try {
    await save("sample.json", { version: 1 }, dir);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "sample.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await load("sample.json", dir), { version: 1 });
    const controller = newToken();
    await Auth.initialize(controller, dir);
    const auth = await Auth.open(dir);
    const invite = await auth.invite();
    const nodeToken = await auth.pair(invite.code, "test-node");
    const disk = await readFile(join(dir, "auth.json"), "utf8");
    assert.ok(
      !disk.includes(controller) && !disk.includes(nodeToken) && !disk.includes(invite.code),
    );
    assert.equal(auth.authenticate(`Bearer ${nodeToken}`)?.id, "test-node");
    await auth.revoke("test-node");
    assert.equal(auth.authenticate(`Bearer ${nodeToken}`), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Keychain presence checks reject unknown helper responses", async () => {
  class InvalidPresenceKeychain extends Keychain {
    override async call(): Promise<string> {
      return "unexpected";
    }
  }
  await assert.rejects(new InvalidPresenceKeychain().has("browser-ca-key"), /invalid presence/);
});
test(
  "Keychain classifies missing and rejecting synthetic helpers without exposing their output",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ellie-keychain-helper-"));
    const previous = process.env.ELLIE_MACOS_HELPER;
    try {
      process.env.ELLIE_MACOS_HELPER = join(dir, "missing-helper");
      await assert.rejects(
        new Keychain().get("synthetic.account"),
        (error: unknown) =>
          error instanceof KeychainFailure && error.reason === "helper_unavailable",
      );
      const helper = join(dir, "rejecting-helper");
      await writeFile(helper, "#!/bin/sh\nprintf 'synthetic-private-output'\nexit 1\n", {
        mode: 0o700,
      });
      process.env.ELLIE_MACOS_HELPER = helper;
      await assert.rejects(
        new Keychain().get("synthetic.account"),
        (error: unknown) =>
          error instanceof KeychainFailure &&
          error.reason === "access_unavailable" &&
          !error.message.includes("synthetic-private-output") &&
          !error.message.includes("synthetic.account"),
      );
    } finally {
      if (previous === undefined) delete process.env.ELLIE_MACOS_HELPER;
      else process.env.ELLIE_MACOS_HELPER = previous;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "Keychain caps helper output by bytes and settles only after the owned child closes",
  { skip: process.platform !== "darwin" },
  async () => {
    let closed = false;
    class SyntheticKeychain extends Keychain {
      protected override spawnHelper(): ChildProcessWithoutNullStreams {
        const child = spawn(
          process.execPath,
          [
            "-e",
            'process.stdout.write("é".repeat(40000)); setTimeout(() => process.exit(0), 5000)',
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        child.once("close", () => (closed = true));
        return child;
      }
    }
    await assert.rejects(new SyntheticKeychain().get("synthetic.account"), (error: unknown) => {
      assert.equal(closed, true);
      return error instanceof KeychainFailure && error.reason === "access_unavailable";
    });
  },
);
test(
  "Keychain timeout terminates and reaps the owned helper before a fixed failure",
  { skip: process.platform !== "darwin" },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let child: ChildProcessWithoutNullStreams | undefined;
    let closed = false;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => (ready = resolve));
    let late!: () => void;
    const lateOutput = new Promise<void>((resolve) => (late = resolve));
    let observed = "";
    class SyntheticKeychain extends Keychain {
      protected override spawnHelper(): ChildProcessWithoutNullStreams {
        child = spawn(
          process.execPath,
          [
            "-e",
            'process.on("SIGTERM", () => process.stdout.write(JSON.stringify({value:"late-value"}))); process.stdout.write("ready"); setTimeout(() => process.exit(0), 5000)',
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        child.stdout.once("data", ready);
        child.stdout.on("data", (data: Buffer) => {
          observed = (observed + data.toString("utf8")).slice(-64);
          if (observed.includes("late-value")) late();
        });
        child.once("close", () => (closed = true));
        return child;
      }
    }
    try {
      let settled = false;
      const operation = new SyntheticKeychain().get("synthetic.account");
      operation.finally(() => (settled = true)).catch(() => {});
      await Promise.race([
        started,
        once(child!, "close", { signal: AbortSignal.timeout(6_000) }).then(() => {
          throw new Error("Synthetic helper closed before readiness.");
        }),
      ]);
      t.mock.timers.tick(60_000);
      await Promise.race([
        lateOutput,
        once(child!, "close", { signal: AbortSignal.timeout(3_000) }).then(() => {
          throw new Error("Synthetic helper closed before late output.");
        }),
      ]);
      assert.equal(settled, false);
      assert.equal(closed, false);
      t.mock.timers.tick(250);
      await assert.rejects(operation, (error: unknown) => {
        assert.equal(closed, true);
        assert.equal(child?.signalCode, "SIGKILL");
        return error instanceof KeychainFailure && error.reason === "timeout";
      });
    } finally {
      t.mock.timers.reset();
      if (child && !closed) {
        child.kill("SIGKILL");
        await once(child, "close", { signal: AbortSignal.timeout(3_000) });
      }
    }
  },
);
test("Keychain reports cleanup uncertainty if a synthetic child never confirms close", async (t) => {
  if (process.platform !== "darwin") return;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end() {}, destroy() {} }),
    stdout: new EventEmitter(),
    stderr: { resume() {} },
    exitCode: null,
    signalCode: null,
    pid: 7_777,
    kill(signal: string) {
      signals.push(signal);
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  class NeverClosingKeychain extends Keychain {
    protected override spawnHelper(): ChildProcessWithoutNullStreams {
      return child;
    }
  }
  try {
    const operation = new NeverClosingKeychain().get("synthetic.account");
    t.mock.timers.tick(60_000);
    t.mock.timers.tick(3_000);
    await assert.rejects(
      operation,
      (error: unknown) => error instanceof KeychainFailure && error.reason === "cleanup_uncertain",
    );
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    child.emit("close", 0, null);
  } finally {
    t.mock.timers.reset();
  }
});
test("packaged helper resolution is explicit, absolute, and preserves the developer fallback", () => {
  assert.equal(nativeHelperPath({}, "/synthetic/.ellie"), "/synthetic/.ellie/bin/ellie-macos");
  assert.equal(
    nativeHelperPath({ ELLIE_MACOS_HELPER: "/release/payload/helpers/ellie-macos" }),
    "/release/payload/helpers/ellie-macos",
  );
  assert.throws(() => nativeHelperPath({ ELLIE_MACOS_HELPER: "relative/helper" }), /invalid/);
});
test("private state cannot be written into the checkout or traversed through a file name", async () => {
  await assert.rejects(ensureState(join(process.cwd(), ".ellie")), /outside/);
  await assert.rejects(save("../secret", {}), /identifier/);
});
test("config validates transport and version before use", () => {
  assert.throws(() =>
    serverConfig({ version: 1, host: "localhost", port: 70000, preferences: defaults }),
  );
  assert.throws(() =>
    nodeConfig({ version: 1, id: "test", serverUrl: "http://localhost", preferences: defaults }),
  );
  assert.throws(() =>
    nodeConfig({ version: 2, id: "test", serverUrl: "https://localhost", preferences: defaults }),
  );
  assert.throws(() =>
    browserConfig({
      version: 1,
      hostname: "Other.local",
      port: 8444,
      createdAt: new Date().toISOString(),
      caFingerprint: "AA",
    }),
  );
});
test("pairing is single-use even under concurrency, and invitation replacement invalidates the old code", async () => {
  const auth = new Auth({ identities: [] }, async () => {});
  const stale = await auth.invite();
  const invite = await auth.invite();
  await assert.rejects(auth.pair(stale.code, "stale"));
  const results = await Promise.allSettled([
    auth.pair(invite.code, "first"),
    auth.pair(invite.code, "second"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
test("expired invitation is rejected", async () => {
  const auth = new Auth(
    { identities: [], invitation: { hash: "not-a-valid-hash", expiresAt: Date.now() - 1 } },
    async () => {},
  );
  await assert.rejects(auth.pair("code", "test"));
});
