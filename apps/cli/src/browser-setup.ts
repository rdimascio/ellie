import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { chmod, link, lstat, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { BrowserConfig, MutableSecretStore } from "@ellie/config";
import { browserConfig, ensureState } from "@ellie/config";
import { generateBrowserTlsIdentity, validateLocalHostname } from "./certificate.ts";
import type { BrowserTlsIdentity } from "./certificate.ts";

export const BROWSER_CA_KEY = "browser-ca-key";
export const BROWSER_SERVER_KEY = "browser-server-key";
export const BROWSER_CONFIG = "browser.json";
export const BROWSER_CA_CERT = "browser-ca-cert.pem";
export const BROWSER_SERVER_CERT = "browser-server-cert.pem";
const BROWSER_SETUP_LOCK = "browser-setup.lock";
const CHECKOUT = fileURLToPath(new URL("../../../", import.meta.url));
const files = [BROWSER_CONFIG, BROWSER_CA_CERT, BROWSER_SERVER_CERT] as const;

export interface BrowserSetupEnvironment {
  stateDir: string;
  secrets: MutableSecretStore;
  localHostname: () => Promise<string>;
  generate: (hostname: string) => Promise<BrowserTlsIdentity>;
  now: () => number;
}
export interface BrowserStatus {
  initialized: boolean;
  ready: boolean;
  hostname?: string;
  port?: number;
  caFingerprint?: string;
  issues: string[];
}
export interface BrowserServerIdentity {
  config: BrowserConfig;
  caCert: string;
  cert: string;
  key: string;
}
interface BrowserIdentitySnapshot extends BrowserServerIdentity {
  caKey?: string;
}
class BrowserSnapshotError extends Error {
  readonly issue: string;
  constructor(issue: string) {
    super(issue);
    this.issue = issue;
  }
}

export async function systemLocalHostname(): Promise<string> {
  if (process.platform !== "darwin")
    throw new Error("Browser setup requires macOS LocalHostName discovery.");
  try {
    const { stdout } = await promisify(execFile)("/usr/sbin/scutil", ["--get", "LocalHostName"], {
      timeout: 5_000,
      maxBuffer: 1024,
    });
    return validateLocalHostname(`${stdout.trim().toLowerCase()}.local`);
  } catch {
    throw new Error(
      "Could not read the Mac LocalHostName. Set it in System Settings, then retry browser init.",
    );
  }
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function ownedByCurrentUser(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid();
}
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function validateStateDirectory(path: string): Promise<void> {
  const first = await lstat(path);
  if (
    first.isSymbolicLink() ||
    !first.isDirectory() ||
    (first.mode & 0o777) !== 0o700 ||
    !ownedByCurrentUser(first.uid)
  )
    throw new Error("Browser setup requires private state owned by this user with mode 0700.");
  const canonical = await realpath(path);
  if (within(await realpath(CHECKOUT), canonical))
    throw new Error("Browser setup state must live outside the source checkout.");
  const second = await lstat(path);
  if (first.dev !== second.dev || first.ino !== second.ino)
    throw new Error("Browser setup state changed while it was being inspected.");
}
async function prepareStateDirectory(path: string): Promise<void> {
  if (!(await pathExists(path))) await ensureState(path);
  await validateStateDirectory(path);
}

async function secureRead(path: string, maximum: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const [opened, named] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      !ownedByCurrentUser(opened.uid) ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size > maximum ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    )
      throw new Error();
    const contents = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < contents.length) {
      const { bytesRead } = await handle.read(contents, length, contents.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error();
    const after = await lstat(path);
    if (opened.dev !== after.dev || opened.ino !== after.ino) throw new Error();
    return contents.subarray(0, length).toString("utf8");
  } catch {
    throw new Error("Browser private files are missing, unsafe, or invalid.");
  } finally {
    await handle?.close();
  }
}

async function inspectKeychain(environment: BrowserSetupEnvironment) {
  try {
    const [caKey, serverKey] = await Promise.all([
      environment.secrets.has(BROWSER_CA_KEY),
      environment.secrets.has(BROWSER_SERVER_KEY),
    ]);
    return { caKey, serverKey };
  } catch {
    throw new Error(
      "Browser setup could not inspect Keychain. Unlock the login keychain and build the current helper with: bun run build:macos",
    );
  }
}
async function inventory(environment: BrowserSetupEnvironment) {
  const [presentFiles, keys] = await Promise.all([
    Promise.all(files.map((name) => pathExists(join(environment.stateDir, name)))),
    inspectKeychain(environment),
  ]);
  return { presentFiles, ...keys };
}
function inventoryCount(found: Awaited<ReturnType<typeof inventory>>): number {
  return found.presentFiles.filter(Boolean).length + Number(found.caKey) + Number(found.serverKey);
}

async function readSnapshot(
  environment: BrowserSetupEnvironment,
  includeCaKey = true,
): Promise<BrowserIdentitySnapshot> {
  await validateStateDirectory(environment.stateDir);
  let values: [string, string, string, string] | [string, string, string, string, string];
  try {
    const publicAndServer = [
      secureRead(join(environment.stateDir, BROWSER_CONFIG), 16 * 1024),
      secureRead(join(environment.stateDir, BROWSER_CA_CERT), 64 * 1024),
      secureRead(join(environment.stateDir, BROWSER_SERVER_CERT), 64 * 1024),
      environment.secrets.get(BROWSER_SERVER_KEY),
    ] as const;
    values = includeCaKey
      ? await Promise.all([...publicAndServer, environment.secrets.get(BROWSER_CA_KEY)])
      : await Promise.all(publicAndServer);
  } catch {
    throw new BrowserSnapshotError("Browser identity material is unavailable or unsafe.");
  }
  const [rawConfig, caCert, cert, key, caKey] = values;
  let config: BrowserConfig;
  let root: X509Certificate;
  let leaf: X509Certificate;
  try {
    config = browserConfig(JSON.parse(rawConfig));
  } catch {
    throw new BrowserSnapshotError("Browser configuration is invalid.");
  }
  try {
    root = new X509Certificate(caCert);
    leaf = new X509Certificate(cert);
  } catch {
    throw new BrowserSnapshotError("Browser public certificates are invalid.");
  }
  const now = environment.now();
  if (
    root.fingerprint256 !== config.caFingerprint ||
    !root.ca ||
    !root.verify(root.publicKey) ||
    root.validFromDate.getTime() > now ||
    root.validToDate.getTime() <= now
  )
    throw new BrowserSnapshotError("Browser CA certificate is invalid or expired.");
  if (
    !leaf.verify(root.publicKey) ||
    leaf.ca ||
    leaf.subjectAltName !== `DNS:${config.hostname}` ||
    leaf.checkHost(config.hostname) !== config.hostname ||
    !leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1")
  )
    throw new BrowserSnapshotError(
      "Browser server certificate does not match its configured CA and hostname.",
    );
  if (
    leaf.validFromDate.getTime() > now ||
    leaf.validToDate.getTime() <= now ||
    leaf.validToDate.getTime() - leaf.validFromDate.getTime() > 397 * 86_400_000
  )
    throw new BrowserSnapshotError("Browser server certificate is not currently valid.");
  try {
    if (
      (caKey !== undefined && !root.checkPrivateKey(createPrivateKey(caKey))) ||
      !leaf.checkPrivateKey(createPrivateKey(key))
    )
      throw new Error();
  } catch {
    throw new BrowserSnapshotError(
      "Browser private keys do not match the configured public certificates.",
    );
  }
  return { config, caCert: root.toString(), cert: leaf.toString(), caKey, key };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function exclusiveAtomic(
  path: string,
  contents: string,
  published: () => void,
): Promise<void> {
  const parent = dirname(path);
  const temporary = join(parent, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
    published();
    await syncDirectory(parent);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}
async function removePublished(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

async function initializeBrowserUnlocked(
  environment: BrowserSetupEnvironment,
): Promise<BrowserConfig> {
  const found = await inventory(environment);
  const count = inventoryCount(found);
  if (count === 5) {
    const snapshot = await readSnapshot(environment);
    if ((await environment.localHostname()) !== snapshot.config.hostname)
      throw new Error(
        "Browser setup exists for an earlier LocalHostName. Existing identity was preserved; run `ellie browser status`.",
      );
    return snapshot.config;
  }
  if (count !== 0)
    throw new Error(
      "Browser setup is incomplete. Existing browser files and Keychain items were preserved; review `ellie browser status` before recovery.",
    );
  const hostname = await environment.localHostname();
  const identity = await environment.generate(hostname);
  const config: BrowserConfig = {
    version: 1,
    hostname,
    port: 8444,
    createdAt: new Date(environment.now()).toISOString(),
    caFingerprint: new X509Certificate(identity.rootCert).fingerprint256,
  };
  const createdFiles: string[] = [];
  const createdKeys: string[] = [];
  try {
    await environment.secrets.add(BROWSER_CA_KEY, identity.rootKey);
    createdKeys.push(BROWSER_CA_KEY);
    await environment.secrets.add(BROWSER_SERVER_KEY, identity.leafKey);
    createdKeys.push(BROWSER_SERVER_KEY);
    for (const [name, contents] of [
      [BROWSER_CA_CERT, identity.rootCert],
      [BROWSER_SERVER_CERT, identity.leafCert],
      [BROWSER_CONFIG, JSON.stringify(config, null, 2) + "\n"],
    ] as const) {
      const path = join(environment.stateDir, name);
      await exclusiveAtomic(path, contents, () => createdFiles.push(path));
    }
    return config;
  } catch {
    const cleanup = await Promise.allSettled([
      ...createdFiles.map(removePublished),
      ...createdKeys.map((account) => environment.secrets.delete(account)),
    ]);
    let empty = false;
    try {
      empty = inventoryCount(await inventory(environment)) === 0;
    } catch {
      // An uncertain cleanup must never be reported as successful.
    }
    if (cleanup.some((result) => result.status === "rejected") || !empty)
      throw new Error(
        "Browser initialization failed and cleanup was incomplete or uncertain. Do not retry until browser setup state is reviewed.",
      );
    throw new Error(
      "Browser initialization failed. New browser setup state was rolled back safely.",
    );
  }
}

export async function initializeBrowser(
  environment: BrowserSetupEnvironment,
): Promise<BrowserConfig> {
  await prepareStateDirectory(environment.stateDir);
  const lockPath = join(environment.stateDir, BROWSER_SETUP_LOCK);
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Another browser initialization is in progress. Wait for it to finish; if no init process is running, inspect and remove ~/.ellie/browser-setup.lock before retrying.",
      );
    throw error;
  }
  try {
    return await initializeBrowserUnlocked(environment);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
    await syncDirectory(environment.stateDir);
  }
}

export async function browserStatus(environment: BrowserSetupEnvironment): Promise<BrowserStatus> {
  if (await pathExists(environment.stateDir)) {
    try {
      await validateStateDirectory(environment.stateDir);
    } catch {
      return {
        initialized: true,
        ready: false,
        issues: ["Ellie private state ownership, type, or mode is unsafe."],
      };
    }
  }
  const found = await inventory(environment);
  const count = inventoryCount(found);
  if (count === 0)
    return { initialized: false, ready: false, issues: ["Browser setup is not initialized."] };
  if (count !== 5)
    return {
      initialized: true,
      ready: false,
      issues: ["Browser setup is incomplete; preserve state before recovery."],
    };
  try {
    const snapshot = await readSnapshot(environment);
    const issues: string[] = [];
    try {
      if ((await environment.localHostname()) !== snapshot.config.hostname)
        issues.push(
          "This Mac LocalHostName changed; the browser identity was preserved and no longer matches it.",
        );
    } catch {
      issues.push("The current Mac LocalHostName could not be checked.");
    }
    return {
      initialized: true,
      ready: issues.length === 0,
      hostname: snapshot.config.hostname,
      port: snapshot.config.port,
      caFingerprint: snapshot.config.caFingerprint,
      issues,
    };
  } catch (error) {
    return {
      initialized: true,
      ready: false,
      issues: [
        error instanceof BrowserSnapshotError
          ? error.issue
          : "Browser identity files, permissions, certificates, or Keychain items are invalid.",
      ],
    };
  }
}

export async function loadBrowserServerIdentity(
  environment: BrowserSetupEnvironment,
): Promise<BrowserServerIdentity> {
  const snapshot = await readSnapshot(environment, false);
  if ((await environment.localHostname()) !== snapshot.config.hostname)
    throw new Error("Browser identity no longer matches this Mac LocalHostName.");
  return {
    config: snapshot.config,
    caCert: snapshot.caCert,
    cert: snapshot.cert,
    key: snapshot.key,
  };
}

async function safeExportPath(
  environment: BrowserSetupEnvironment,
  outputPath: string,
): Promise<string> {
  if (!isAbsolute(outputPath)) throw new Error("CA export path must be absolute.");
  let parent: string;
  try {
    parent = await realpath(dirname(outputPath));
  } catch {
    throw new Error("CA export directory does not exist or is unavailable.");
  }
  const target = join(parent, basename(outputPath));
  const [state, checkout] = await Promise.all([realpath(environment.stateDir), realpath(CHECKOUT)]);
  if (within(state, target) || within(checkout, target))
    throw new Error(
      "CA export target must be outside Ellie private state and the source checkout.",
    );
  return target;
}
export async function exportBrowserCa(
  environment: BrowserSetupEnvironment,
  outputPath: string,
  force = false,
): Promise<void> {
  const target = await safeExportPath(environment, outputPath);
  const snapshot = await readSnapshot(environment);
  if ((await environment.localHostname()) !== snapshot.config.hostname)
    throw new Error("Browser identity no longer matches this Mac LocalHostName.");
  const cert = new X509Certificate(snapshot.caCert).toString();
  if (!force && (await pathExists(target)))
    throw new Error("CA export target already exists. Choose another path or pass --force.");
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(cert);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o644);
    if (force) await rename(temporary, target);
    else {
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("CA export target already exists. Choose another path or pass --force.");
        throw error;
      }
    }
    await syncDirectory(dirname(target));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}
