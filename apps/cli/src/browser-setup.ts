import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, link, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
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

const files = [BROWSER_CONFIG, BROWSER_CA_CERT, BROWSER_SERVER_CERT] as const;

export async function systemLocalHostname(): Promise<string> {
  if (process.platform !== "darwin")
    throw new Error("Browser setup requires macOS LocalHostName discovery.");
  try {
    const { stdout } = await promisify(execFile)("/usr/sbin/scutil", ["--get", "LocalHostName"], {
      timeout: 5_000,
      maxBuffer: 1024,
    });
    const label = stdout.trim().toLowerCase();
    return validateLocalHostname(`${label}.local`);
  } catch {
    throw new Error(
      "Could not read the Mac LocalHostName. Set it in System Settings, then retry browser init.",
    );
  }
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

async function inventory(environment: BrowserSetupEnvironment) {
  try {
    const [presentFiles, caKey, serverKey] = await Promise.all([
      Promise.all(files.map((name) => pathExists(join(environment.stateDir, name)))),
      environment.secrets.has(BROWSER_CA_KEY),
      environment.secrets.has(BROWSER_SERVER_KEY),
    ]);
    return { presentFiles, caKey, serverKey };
  } catch {
    throw new Error(
      "Browser setup could not inspect Keychain. Unlock the login keychain and build the current helper with: bun run build:macos",
    );
  }
}

async function exclusiveAtomic(path: string, contents: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: "wx", mode });
    if (await pathExists(path)) throw Object.assign(new Error(), { code: "EEXIST" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function initializeBrowserUnlocked(
  environment: BrowserSetupEnvironment,
): Promise<BrowserConfig> {
  await ensureState(environment.stateDir);
  const found = await inventory(environment);
  const count =
    found.presentFiles.filter(Boolean).length + Number(found.caKey) + Number(found.serverKey);
  if (count === 5) {
    const status = await browserStatus(environment);
    if (!status.ready)
      throw new Error(
        "Browser setup exists but is not usable. Existing state was preserved; review `ellie browser status` before recovery.",
      );
    return browserConfig(
      JSON.parse(await readFile(join(environment.stateDir, BROWSER_CONFIG), "utf8")),
    );
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
    ] as const) {
      const path = join(environment.stateDir, name);
      await exclusiveAtomic(path, contents, 0o600);
      createdFiles.push(path);
    }
    const configPath = join(environment.stateDir, BROWSER_CONFIG);
    await exclusiveAtomic(configPath, JSON.stringify(config, null, 2) + "\n", 0o600);
    createdFiles.push(configPath);
    return config;
  } catch {
    const cleanup = await Promise.allSettled([
      ...createdFiles.map((path) => rm(path, { force: true })),
      ...createdKeys.map((account) => environment.secrets.delete(account)),
    ]);
    if (cleanup.some((result) => result.status === "rejected"))
      throw new Error(
        "Browser initialization failed and cleanup was incomplete. Do not retry until browser setup state is reviewed.",
      );
    throw new Error(
      "Browser initialization failed. New browser setup state was rolled back safely.",
    );
  }
}

export async function initializeBrowser(
  environment: BrowserSetupEnvironment,
): Promise<BrowserConfig> {
  await ensureState(environment.stateDir);
  const lockPath = join(environment.stateDir, BROWSER_SETUP_LOCK);
  let lock: Awaited<ReturnType<typeof open>>;
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
  }
}

export async function browserStatus(environment: BrowserSetupEnvironment): Promise<BrowserStatus> {
  const found = await inventory(environment);
  const count =
    found.presentFiles.filter(Boolean).length + Number(found.caKey) + Number(found.serverKey);
  if (count === 0)
    return { initialized: false, ready: false, issues: ["Browser setup is not initialized."] };
  const issues: string[] = [];
  try {
    const state = await lstat(environment.stateDir);
    if (state.isSymbolicLink() || !state.isDirectory() || (state.mode & 0o777) !== 0o700)
      issues.push("Ellie private state must be a non-symlink directory with mode 0700.");
  } catch {
    issues.push("Ellie private state directory is unavailable.");
  }
  if (count !== 5) issues.push("Browser setup is incomplete; preserve state before recovery.");
  let config: BrowserConfig | undefined;
  let root: X509Certificate | undefined;
  let leaf: X509Certificate | undefined;
  try {
    config = browserConfig(
      JSON.parse(await readFile(join(environment.stateDir, BROWSER_CONFIG), "utf8")),
    );
  } catch {
    issues.push("Browser configuration is missing or invalid.");
  }
  try {
    root = new X509Certificate(await readFile(join(environment.stateDir, BROWSER_CA_CERT), "utf8"));
    leaf = new X509Certificate(
      await readFile(join(environment.stateDir, BROWSER_SERVER_CERT), "utf8"),
    );
  } catch {
    issues.push("Browser public certificates are missing or invalid.");
  }
  for (const name of files) {
    try {
      const info = await lstat(join(environment.stateDir, name));
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600)
        issues.push(`${name} must be a regular private file with mode 0600.`);
    } catch {
      // Missing files are summarized above.
    }
  }
  if (!found.caKey || !found.serverKey)
    issues.push("One or more browser private keys are unavailable.");
  if (found.caKey && found.serverKey && root && leaf) {
    try {
      const [caKey, serverKey] = await Promise.all([
        environment.secrets.get(BROWSER_CA_KEY),
        environment.secrets.get(BROWSER_SERVER_KEY),
      ]);
      if (
        !root.checkPrivateKey(createPrivateKey(caKey)) ||
        !leaf.checkPrivateKey(createPrivateKey(serverKey))
      )
        throw new Error();
    } catch {
      issues.push("Browser private keys could not be validated against the public certificates.");
    }
  }
  if (config && root && leaf) {
    const now = environment.now();
    if (root.fingerprint256 !== config.caFingerprint)
      issues.push("Browser CA fingerprint does not match configuration.");
    if (
      !root.ca ||
      !root.verify(root.publicKey) ||
      root.validFromDate.getTime() > now ||
      root.validToDate.getTime() <= now
    )
      issues.push("Browser CA certificate is not a valid self-signed root.");
    if (
      !leaf.verify(root.publicKey) ||
      leaf.ca ||
      leaf.subjectAltName !== `DNS:${config.hostname}` ||
      leaf.checkHost(config.hostname) !== config.hostname ||
      !leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1")
    )
      issues.push("Browser server certificate does not match its configured CA and hostname.");
    if (
      leaf.validFromDate.getTime() > now ||
      leaf.validToDate.getTime() <= now ||
      leaf.validToDate.getTime() - leaf.validFromDate.getTime() > 397 * 86_400_000
    )
      issues.push("Browser server certificate is not currently valid.");
    try {
      if ((await environment.localHostname()) !== config.hostname)
        issues.push(
          "This Mac LocalHostName changed; the browser identity was preserved and no longer matches it.",
        );
    } catch {
      issues.push("The current Mac LocalHostName could not be checked.");
    }
  }
  return {
    initialized: true,
    ready: issues.length === 0,
    ...(config
      ? { hostname: config.hostname, port: config.port, caFingerprint: config.caFingerprint }
      : {}),
    issues,
  };
}

/** Loads listener material after the same validation used by browser status. */
export async function loadBrowserServerIdentity(
  environment: BrowserSetupEnvironment,
): Promise<BrowserServerIdentity> {
  const status = await browserStatus(environment);
  if (!status.ready)
    throw new Error("Browser setup is not ready. Run `ellie browser status` first.");
  try {
    const [rawConfig, caCert, cert, key] = await Promise.all([
      readFile(join(environment.stateDir, BROWSER_CONFIG), "utf8"),
      readFile(join(environment.stateDir, BROWSER_CA_CERT), "utf8"),
      readFile(join(environment.stateDir, BROWSER_SERVER_CERT), "utf8"),
      environment.secrets.get(BROWSER_SERVER_KEY),
    ]);
    const config = browserConfig(JSON.parse(rawConfig));
    const root = new X509Certificate(caCert);
    const leaf = new X509Certificate(cert);
    if (
      root.fingerprint256 !== config.caFingerprint ||
      !root.ca ||
      !root.verify(root.publicKey) ||
      !leaf.verify(root.publicKey) ||
      leaf.ca ||
      leaf.subjectAltName !== `DNS:${config.hostname}` ||
      !leaf.checkPrivateKey(createPrivateKey(key))
    )
      throw new Error();
    return { config, caCert, cert, key };
  } catch {
    throw new Error("Browser server identity became unavailable after validation.");
  }
}

export async function exportBrowserCa(
  environment: BrowserSetupEnvironment,
  outputPath: string,
  force = false,
): Promise<void> {
  if (!isAbsolute(outputPath)) throw new Error("CA export path must be absolute.");
  const status = await browserStatus(environment);
  if (!status.ready)
    throw new Error("Browser setup is not ready. Run `ellie browser status` first.");
  const cert = await readFile(join(environment.stateDir, BROWSER_CA_CERT), "utf8");
  const root = new X509Certificate(cert);
  if (!root.ca || !root.verify(root.publicKey) || root.fingerprint256 !== status.caFingerprint)
    throw new Error("Browser CA changed after validation. Run `ellie browser status` again.");
  if (!force && (await pathExists(outputPath)))
    throw new Error("CA export target already exists. Choose another path or pass --force.");
  const temporary = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, cert, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o644);
    if (force) await rename(temporary, outputPath);
    else {
      try {
        await link(temporary, outputPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("CA export target already exists. Choose another path or pass --force.");
        throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
