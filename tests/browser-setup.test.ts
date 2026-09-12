import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { X509Certificate } from "node:crypto";
import type { MutableSecretStore } from "@ellie/config";
import { generateBrowserTlsIdentity } from "../apps/cli/src/certificate.ts";
import {
  BROWSER_CA_CERT,
  BROWSER_CA_KEY,
  BROWSER_CONFIG,
  BROWSER_SERVER_CERT,
  BROWSER_SERVER_KEY,
  browserStatus,
  exportBrowserCa,
  initializeBrowser,
  loadBrowserServerIdentity,
} from "../apps/cli/src/browser-setup.ts";

class MemorySecrets implements MutableSecretStore {
  readonly values = new Map<string, string>();
  fail?: "has" | "server-add" | "delete";
  async get(account: string): Promise<string> {
    const value = this.values.get(account);
    if (value === undefined) throw new Error("missing");
    return value;
  }
  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }
  async has(account: string): Promise<boolean> {
    if (this.fail === "has") throw new Error("private machine detail");
    return this.values.has(account);
  }
  async add(account: string, value: string): Promise<void> {
    if (this.fail === "server-add" && account === BROWSER_SERVER_KEY) throw new Error("denied");
    if (this.values.has(account)) throw new Error("duplicate");
    this.values.set(account, value);
  }
  async delete(account: string): Promise<void> {
    if (this.fail === "delete") throw new Error("private delete detail");
    this.values.delete(account);
  }
}

async function pathMissing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), "ellie-browser-setup-"));
  const secrets = new MemorySecrets();
  let hostname = "living-room.local";
  let generations = 0;
  return {
    stateDir,
    secrets,
    setHostname(value: string) {
      hostname = value;
    },
    generations: () => generations,
    environment: {
      stateDir,
      secrets,
      localHostname: async () => hostname,
      generate: async (name: string) => {
        generations += 1;
        return generateBrowserTlsIdentity(name);
      },
      now: () => Date.now(),
    },
  };
}

test("browser init is private, idempotent, and status detects hostname drift", async () => {
  const setup = await fixture();
  try {
    const created = await initializeBrowser(setup.environment);
    assert.equal(created.hostname, "living-room.local");
    assert.equal(created.port, 8444);
    assert.equal(setup.generations(), 1);
    assert.deepEqual(await initializeBrowser(setup.environment), created);
    assert.equal(setup.generations(), 1);
    for (const name of [BROWSER_CONFIG, BROWSER_CA_CERT, BROWSER_SERVER_CERT])
      assert.equal((await stat(join(setup.stateDir, name))).mode & 0o777, 0o600);
    assert.deepEqual(
      [...setup.secrets.values.keys()].sort(),
      [BROWSER_CA_KEY, BROWSER_SERVER_KEY].sort(),
    );
    assert.deepEqual(await browserStatus(setup.environment), {
      initialized: true,
      ready: true,
      hostname: "living-room.local",
      port: 8444,
      caFingerprint: created.caFingerprint,
      issues: [],
    });
    const listener = await loadBrowserServerIdentity(setup.environment);
    assert.deepEqual(listener.config, created);
    assert.equal(listener.cert, await readFile(join(setup.stateDir, BROWSER_SERVER_CERT), "utf8"));
    assert.equal(listener.caCert, await readFile(join(setup.stateDir, BROWSER_CA_CERT), "utf8"));
    assert.equal(listener.key, setup.secrets.values.get(BROWSER_SERVER_KEY));
    assert.equal("rootKey" in listener, false);
    const get = setup.secrets.get.bind(setup.secrets);
    setup.secrets.get = async (account) => {
      if (account === BROWSER_CA_KEY) throw new Error("CA key must remain sealed");
      return get(account);
    };
    assert.equal((await loadBrowserServerIdentity(setup.environment)).key, listener.key);
    setup.secrets.get = get;
    setup.setHostname("new-name.local");
    const drifted = await browserStatus(setup.environment);
    assert.equal(drifted.ready, false);
    assert.match(drifted.issues.join(" "), /LocalHostName changed/);
    assert.equal(setup.generations(), 1);
    setup.setHostname("living-room.local");
    setup.environment.now = () => Date.now() + 500 * 86_400_000;
    const expired = await browserStatus(setup.environment);
    assert.equal(expired.ready, false);
    assert.match(expired.issues.join(" "), /server certificate is not currently valid/);
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test("CA export writes only the public root and does not overwrite by default", async () => {
  const setup = await fixture();
  const outputDir = await mkdtemp(join(tmpdir(), "ellie-browser-export-"));
  const output = join(outputDir, "ellie-ca.pem");
  try {
    await initializeBrowser(setup.environment);
    await exportBrowserCa(setup.environment, output);
    const exported = await readFile(output, "utf8");
    assert.equal(exported, await readFile(join(setup.stateDir, BROWSER_CA_CERT), "utf8"));
    assert.equal((await stat(output)).mode & 0o777, 0o644);
    assert.equal(new X509Certificate(exported).ca, true);
    assert.ok(!exported.includes("PRIVATE KEY"));
    await assert.rejects(exportBrowserCa(setup.environment, output), /already exists/);
    await writeFile(output, "replace me");
    await exportBrowserCa(setup.environment, output, true);
    assert.equal(new X509Certificate(await readFile(output, "utf8")).ca, true);
  } finally {
    await Promise.all([
      rm(setup.stateDir, { recursive: true, force: true }),
      rm(outputDir, { recursive: true, force: true }),
    ]);
  }
});

test("CA export canonicalizes the certificate and rejects protected destinations", async () => {
  const setup = await fixture();
  const outputDir = await mkdtemp(join(tmpdir(), "ellie-browser-safe-export-"));
  try {
    await initializeBrowser(setup.environment);
    const caPath = join(setup.stateDir, BROWSER_CA_CERT);
    const ca = await readFile(caPath, "utf8");
    await writeFile(caPath, ca + setup.secrets.values.get(BROWSER_CA_KEY));
    const output = join(outputDir, "public.pem");
    await exportBrowserCa(setup.environment, output);
    assert.equal(await readFile(output, "utf8"), new X509Certificate(ca).toString());
    assert.ok(!(await readFile(output, "utf8")).includes("PRIVATE KEY"));
    const listener = await loadBrowserServerIdentity(setup.environment);
    assert.equal(listener.caCert, new X509Certificate(ca).toString());
    assert.ok(!listener.caCert.includes("PRIVATE KEY"));
    await assert.rejects(
      exportBrowserCa(setup.environment, join(setup.stateDir, "server-cert.pem"), true),
      /outside Ellie private state/,
    );
    const hidden = join(setup.stateDir, "..export");
    await mkdir(hidden, { mode: 0o700 });
    await assert.rejects(
      exportBrowserCa(setup.environment, join(hidden, "ca.pem"), true),
      /outside Ellie private state/,
    );
    await assert.rejects(
      exportBrowserCa(setup.environment, join(process.cwd(), "should-not-exist.pem"), true),
      /outside Ellie private state and the source checkout/,
    );
    const linkedState = join(outputDir, "linked-state");
    await symlink(setup.stateDir, linkedState);
    await assert.rejects(
      exportBrowserCa(setup.environment, join(linkedState, "server-cert.pem"), true),
      /outside Ellie private state/,
    );
  } finally {
    await Promise.all([
      rm(setup.stateDir, { recursive: true, force: true }),
      rm(outputDir, { recursive: true, force: true }),
    ]);
  }
});

test("status rejects unsafe private directories and files before accepting their contents", async () => {
  const setup = await fixture();
  try {
    await initializeBrowser(setup.environment);
    await chmod(setup.stateDir, 0o755);
    await assert.rejects(initializeBrowser(setup.environment), /mode 0700/);
    assert.equal((await stat(setup.stateDir)).mode & 0o777, 0o755);
    await chmod(setup.stateDir, 0o700);

    const configPath = join(setup.stateDir, BROWSER_CONFIG);
    const extraLink = join(setup.stateDir, "browser-config-link");
    await link(configPath, extraLink);
    assert.equal((await browserStatus(setup.environment)).ready, false);
    await unlink(extraLink);

    const caPath = join(setup.stateDir, BROWSER_CA_CERT);
    const savedCa = join(setup.stateDir, "saved-ca.pem");
    await rename(caPath, savedCa);
    await symlink(savedCa, caPath);
    assert.equal((await browserStatus(setup.environment)).ready, false);
    await unlink(caPath);
    await rename(savedCa, caPath);

    const originalConfig = await readFile(configPath, "utf8");
    await writeFile(configPath, "x".repeat(17 * 1024), { mode: 0o600 });
    assert.equal((await browserStatus(setup.environment)).ready, false);
    await writeFile(configPath, originalConfig, { mode: 0o600 });

    const savedConfig = join(setup.stateDir, "saved-config.json");
    await rename(configPath, savedConfig);
    await promisify(execFile)("/usr/bin/mkfifo", [configPath]);
    assert.equal((await browserStatus(setup.environment)).ready, false);
    await unlink(configPath);
    await rename(savedConfig, configPath);
    assert.equal((await browserStatus(setup.environment)).ready, true);
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test("partial state and unavailable Keychain fail closed without generation", async () => {
  const setup = await fixture();
  try {
    setup.secrets.values.set(BROWSER_CA_KEY, "existing");
    await assert.rejects(initializeBrowser(setup.environment), /incomplete.*preserved/);
    assert.equal(setup.generations(), 0);
    setup.secrets.values.clear();
    setup.secrets.fail = "has";
    await assert.rejects(initializeBrowser(setup.environment), (error) => {
      assert.match(String(error), /could not inspect Keychain.*build/);
      assert.doesNotMatch(String(error), /private machine detail/);
      return true;
    });
    assert.equal(setup.generations(), 0);
    assert.deepEqual(await readdir(setup.stateDir), []);
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test("a rollback failure reports partial state without touching an agent credential", async () => {
  const setup = await fixture();
  try {
    setup.secrets.values.set("server.key", "agent identity");
    const originalAdd = setup.secrets.add.bind(setup.secrets);
    setup.secrets.add = async (account, value) => {
      await originalAdd(account, value);
      if (account === BROWSER_CA_KEY) setup.secrets.fail = "server-add";
    };
    setup.secrets.delete = async () => {
      throw new Error("private delete detail");
    };
    await assert.rejects(initializeBrowser(setup.environment), (error) => {
      assert.match(String(error), /cleanup was incomplete.*Do not retry/);
      assert.doesNotMatch(String(error), /private delete detail/);
      return true;
    });
    assert.equal(setup.secrets.values.get("server.key"), "agent identity");
    assert.equal(setup.secrets.values.has(BROWSER_CA_KEY), true);
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test("an ambiguous Keychain add and a publication race fail closed", async () => {
  const ambiguous = await fixture();
  try {
    ambiguous.secrets.values.set("server.key", "agent identity");
    ambiguous.secrets.add = async (account, value) => {
      ambiguous.secrets.values.set(account, value);
      throw new Error("timeout after write");
    };
    await assert.rejects(initializeBrowser(ambiguous.environment), /incomplete or uncertain/);
    assert.equal(ambiguous.secrets.values.get("server.key"), "agent identity");
    assert.equal(ambiguous.secrets.values.has(BROWSER_CA_KEY), true);
  } finally {
    await rm(ambiguous.stateDir, { recursive: true, force: true });
  }

  const raced = await fixture();
  try {
    raced.secrets.values.set("server.key", "agent identity");
    const add = raced.secrets.add.bind(raced.secrets);
    raced.secrets.add = async (account, value) => {
      await add(account, value);
      if (account === BROWSER_SERVER_KEY)
        await writeFile(join(raced.stateDir, BROWSER_SERVER_CERT), "competing file", {
          flag: "wx",
          mode: 0o600,
        });
    };
    await assert.rejects(initializeBrowser(raced.environment), /incomplete or uncertain/);
    assert.equal(
      await readFile(join(raced.stateDir, BROWSER_SERVER_CERT), "utf8"),
      "competing file",
    );
    assert.equal(await pathMissing(join(raced.stateDir, BROWSER_CA_CERT)), true);
    assert.deepEqual([...raced.secrets.values.entries()], [["server.key", "agent identity"]]);
  } finally {
    await rm(raced.stateDir, { recursive: true, force: true });
  }
});

test("failed initialization deletes only keys and files added by that invocation", async () => {
  const setup = await fixture();
  try {
    setup.secrets.values.set("server.key", "agent identity");
    setup.secrets.fail = "server-add";
    await assert.rejects(initializeBrowser(setup.environment), /rolled back safely/);
    assert.deepEqual([...setup.secrets.values.entries()], [["server.key", "agent identity"]]);
    assert.deepEqual(await readdir(setup.stateDir), []);
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test("an exclusive setup lock rejects concurrent initialization without removing the lock", async () => {
  const setup = await fixture();
  const lock = join(setup.stateDir, "browser-setup.lock");
  try {
    await writeFile(lock, "", { flag: "wx", mode: 0o600 });
    await assert.rejects(initializeBrowser(setup.environment), /Another browser initialization/);
    assert.equal((await stat(lock)).mode & 0o777, 0o600);
    assert.equal(setup.generations(), 0);
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
