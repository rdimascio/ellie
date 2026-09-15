import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { browserWebMCPHostInstallationPlan } from "../../node/src/browser-native-host.ts";

const RECORD = "arc-native-host.json";
const LOCK = "arc-native-host.lock";
const STAGE = ".arc-native-host.json.stage";
const MAX_FILE = 16 * 1024;
type Phase = "installing" | "installed" | "uninstalling";
type Identity = {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  nlink: number;
  size: number;
};
type LegacyRecordValue = {
  version: 1;
  browser: "arc";
  phase: Phase;
  release: string;
  launcherSha256: string;
  manifestSha256: string;
};
type CurrentRecordValue = {
  version: 2;
  browser: "arc";
  location: "chrome_user";
  phase: Phase;
  release: string;
  launcherSha256: string;
  manifestSha256: string;
};
type RecordValue = LegacyRecordValue | CurrentRecordValue;
export type BrowserNativeHostReport = {
  version: 1;
  browser: "arc";
  status: "absent" | "installed" | "recovery_required" | "conflict" | "invalid_release";
  ready: boolean;
  migrationRequired?: true;
};

const snapshot = (value: Identity): Identity => ({
  dev: value.dev,
  ino: value.ino,
  uid: value.uid,
  mode: value.mode,
  nlink: value.nlink,
  size: value.size,
});
const exact = (a: Identity, b: Identity) => JSON.stringify(a) === JSON.stringify(b);
const sameObject = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const bytesFor = (value: RecordValue) => Buffer.from(`${JSON.stringify(value)}\n`);
function safeDirectory(value: Identity, uid: number): boolean {
  return (value.mode & 0o170000) === 0o040000 && value.uid === uid && (value.mode & 0o022) === 0;
}
function safeFile(value: Identity, uid: number, modes: readonly number[]): boolean {
  return (
    (value.mode & 0o170000) === 0o100000 &&
    value.uid === uid &&
    value.nlink === 1 &&
    modes.includes(value.mode & 0o777)
  );
}
async function openDirectory(
  path: string,
  uid: number,
): Promise<{ handle: FileHandle; id: Identity }> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const id = snapshot(await handle.stat());
    if (!safeDirectory(id, uid) || !exact(id, snapshot(await lstat(path))))
      throw new Error("Browser native host directory is unsafe.");
    return { handle, id };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function openDirectoryIfPresent(
  path: string,
  uid: number,
): Promise<{ handle: FileHandle; id: Identity } | undefined> {
  try {
    return await openDirectory(path, uid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
async function rebindDirectory(
  path: string,
  opened: { handle: FileHandle; id: Identity },
  uid: number,
) {
  const held = snapshot(await opened.handle.stat());
  const named = snapshot(await lstat(path));
  if (
    !safeDirectory(held, uid) ||
    !safeDirectory(named, uid) ||
    !sameObject(held, opened.id) ||
    !sameObject(named, opened.id)
  )
    throw new Error("Browser native host directory changed.");
}
async function readBounded(
  path: string,
  uid: number,
  modes: readonly number[],
  maximum = MAX_FILE,
): Promise<{ bytes: Buffer; id: Identity } | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Browser native host file is unsafe.");
  }
  try {
    const id = snapshot(await handle.stat());
    if (!safeFile(id, uid, modes) || id.size < 1 || id.size > maximum)
      throw new Error("Browser native host file is unsafe.");
    const bytes = Buffer.alloc(id.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const final = snapshot(await handle.stat());
    const named = snapshot(await lstat(path));
    if (bytesRead !== id.size || !exact(id, final) || !exact(id, named))
      throw new Error("Browser native host file changed while reading.");
    return { bytes: bytes.subarray(0, bytesRead), id };
  } finally {
    await handle.close();
  }
}
async function ensurePrivateDirectory(path: string, uid: number): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const opened = await openDirectory(path, uid);
  await opened.handle.close();
}
async function publishExclusive(
  directory: string,
  opened: { handle: FileHandle; id: Identity },
  name: string,
  bytes: Buffer,
  uid: number,
) {
  const destination = join(directory, name);
  await rebindDirectory(directory, opened, uid);
  const output = await open(
    destination,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await output.chmod(0o600);
    await output.writeFile(bytes);
    await output.sync();
  } finally {
    await output.close();
  }
  await rebindDirectory(directory, opened, uid);
  const published = await readBounded(destination, uid, [0o600]);
  if (!published || !published.bytes.equals(bytes))
    throw new Error("Browser native host publication is uncertain.");
  await opened.handle.sync();
}
async function replaceOwned(
  directory: string,
  opened: { handle: FileHandle; id: Identity },
  name: string,
  previous: Identity,
  bytes: Buffer,
  uid: number,
) {
  const current = await readBounded(join(directory, name), uid, [0o600]);
  if (!current || !exact(current.id, previous))
    throw new Error("Browser native host ownership changed.");
  const temporary = join(directory, STAGE);
  const output = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await output.chmod(0o600);
    await output.writeFile(bytes);
    await output.sync();
  } finally {
    await output.close();
  }
  await rebindDirectory(directory, opened, uid);
  const again = await readBounded(join(directory, name), uid, [0o600]);
  if (!again || !exact(again.id, previous))
    throw new Error("Browser native host ownership changed.");
  // If a later operation fails, the exclusively created stage is retained because its name may
  // have been replaced after this rebind.
  await rename(temporary, join(directory, name));
  await opened.handle.sync();
}
async function cleanupLock(
  path: string,
  id: Identity,
  statePath: string,
  state: { handle: FileHandle; id: Identity },
  uid: number,
): Promise<void> {
  await rebindDirectory(statePath, state, uid);
  if (!exact(snapshot(await lstat(path)), id))
    throw new Error("Browser native host lock changed and was preserved.");
  await unlink(path);
  await state.handle.sync();
}
function parseRecord(bytes: Buffer): RecordValue {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Browser native host ownership is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Browser native host ownership is invalid.");
  const record = value as RecordValue;
  const versionFields =
    record.version === 1
      ? Object.keys(record).length === 6
      : record.version === 2 &&
        Object.keys(record).length === 7 &&
        record.location === "chrome_user";
  if (
    !versionFields ||
    record.browser !== "arc" ||
    !["installing", "installed", "uninstalling"].includes(record.phase) ||
    !isAbsolute(record.release) ||
    resolve(record.release) !== record.release ||
    !/^[a-f0-9]{64}$/.test(record.launcherSha256) ||
    !/^[a-f0-9]{64}$/.test(record.manifestSha256) ||
    !bytes.equals(bytesFor(record))
  )
    throw new Error("Browser native host ownership is invalid.");
  return record;
}
async function validateRelease(release: string, uid: number) {
  if (!isAbsolute(release) || resolve(release) !== release || (await realpath(release)) !== release)
    throw new Error("Captured browser host release is invalid.");
  const plan = browserWebMCPHostInstallationPlan(release);
  const launcher = await readBounded(plan.executablePath, uid, [0o555, 0o755]);
  if (!launcher) throw new Error("Captured browser host launcher is unavailable.");
  const root = snapshot(await lstat(release));
  if (!safeDirectory(root, uid) || (root.mode & 0o777) !== 0o555)
    throw new Error("Captured browser host release is not immutable.");
  const manifestFile = await readBounded(
    join(release, "manifest.json"),
    uid,
    [0o444],
    4 * 1024 * 1024,
  );
  const sourceFile = await readBounded(join(release, "SOURCE.txt"), uid, [0o444]);
  if (!manifestFile || !sourceFile)
    throw new Error("Captured browser host release metadata is unavailable.");
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  } catch {
    throw new Error("Captured browser host release metadata is invalid.");
  }
  const value = manifest as Record<string, unknown>;
  const runtime = value.runtime as Record<string, unknown> | undefined;
  const helper = value.helper as Record<string, unknown> | undefined;
  const architecture = value.architecture;
  const expectedLaunchers = [
    {
      role: "coordinator",
      name: "Ellie Coordinator",
      identifier: "org.ellie.assistant.coordinator.app",
      signature: "development-ad-hoc",
      architecture,
      minimumOS: "14.0",
    },
    {
      role: "node",
      name: "Ellie Node",
      identifier: "org.ellie.assistant.node.app",
      signature: "development-ad-hoc",
      architecture,
      minimumOS: "14.0",
    },
  ];
  const expectedSource =
    typeof value.sourceRevision === "string" && runtime
      ? `Ellie service payload\nSource revision: ${value.sourceRevision}\nNode.js: ${String(runtime.version)}\nNode archive SHA-256: ${String(runtime.sha256)}\nMinimum macOS: ${String(value.minimumOS)}\nHelper: ${String(helper?.identifier)} (${String(helper?.signature)})\n`
      : "";
  if (
    value.version !== 1 ||
    typeof value.productVersion !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.productVersion) ||
    typeof value.sourceRevision !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sourceRevision) ||
    value.sourceModified !== false ||
    value.platform !== "darwin" ||
    (architecture !== "arm64" && architecture !== "x64") ||
    value.minimumOS !== "14.0" ||
    typeof value.lockSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.lockSha256) ||
    runtime?.architecture !== architecture ||
    typeof runtime.version !== "string" ||
    typeof runtime.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(runtime.sha256) ||
    helper?.identifier !== "org.ellie.helper" ||
    helper.signature !== "development-ad-hoc" ||
    JSON.stringify(value.launchers) !== JSON.stringify(expectedLaunchers) ||
    sourceFile.bytes.toString("utf8") !== expectedSource
  )
    throw new Error("Captured browser host release metadata is invalid.");
  const files = value.files;
  const entry = Array.isArray(files)
    ? files.filter(
        (value) =>
          value &&
          typeof value === "object" &&
          (value as { path?: unknown }).path === "bin/ellie-browser-webmcp-host",
      )
    : [];
  const declared = entry[0] as { mode?: unknown; size?: unknown; sha256?: unknown } | undefined;
  if (
    entry.length !== 1 ||
    declared?.mode !== 0o755 ||
    declared.size !== launcher.id.size ||
    declared.sha256 !== digest(launcher.bytes)
  )
    throw new Error("Captured browser host launcher does not match its release metadata.");
  return {
    plan,
    launcherSha256: digest(launcher.bytes),
    launcherIdentity: launcher.id,
    rootIdentity: root,
  };
}
async function revalidateRelease(
  release: string,
  uid: number,
  expected: Awaited<ReturnType<typeof validateRelease>>,
): Promise<void> {
  const current = await validateRelease(release, uid);
  if (
    current.launcherSha256 !== expected.launcherSha256 ||
    !exact(current.launcherIdentity, expected.launcherIdentity) ||
    !exact(current.rootIdentity, expected.rootIdentity)
  )
    throw new Error("Captured browser host release changed.");
}
function locations(home: string) {
  if (!isAbsolute(home) || resolve(home) !== home)
    throw new Error("Browser native host home is invalid.");
  return {
    state: join(home, ".ellie", "browser-native-hosts"),
    applicationSupport: join(home, "Library", "Application Support"),
    legacyBrowserParent: join(home, "Library", "Application Support", "Arc", "User Data"),
    legacyManifests: join(
      home,
      "Library",
      "Application Support",
      "Arc",
      "User Data",
      "NativeMessagingHosts",
    ),
    currentVendorParent: join(home, "Library", "Application Support", "Google"),
    currentBrowserParent: join(home, "Library", "Application Support", "Google", "Chrome"),
    currentManifests: join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "NativeMessagingHosts",
    ),
  };
}

type ManifestLocation = { browserParent: string; manifests: string };
function manifestLocation(
  paths: ReturnType<typeof locations>,
  record: RecordValue,
): ManifestLocation {
  return record.version === 1
    ? { browserParent: paths.legacyBrowserParent, manifests: paths.legacyManifests }
    : { browserParent: paths.currentBrowserParent, manifests: paths.currentManifests };
}
function otherManifestLocation(
  paths: ReturnType<typeof locations>,
  record: RecordValue,
): ManifestLocation {
  return record.version === 1
    ? { browserParent: paths.currentBrowserParent, manifests: paths.currentManifests }
    : { browserParent: paths.legacyBrowserParent, manifests: paths.legacyManifests };
}
async function inspectManifestLocation(
  location: ManifestLocation,
  manifestName: string,
  uid: number,
): Promise<{ bytes: Buffer; id: Identity } | undefined> {
  const parent = await openDirectoryIfPresent(location.browserParent, uid);
  if (!parent) return;
  const manifests = await openDirectoryIfPresent(location.manifests, uid);
  try {
    const manifest = manifests
      ? await readBounded(join(location.manifests, manifestName), uid, [0o600])
      : undefined;
    await rebindDirectory(location.browserParent, parent, uid);
    if (manifests) await rebindDirectory(location.manifests, manifests, uid);
    return manifest;
  } finally {
    await parent.handle.close();
    await manifests?.handle.close();
  }
}
async function ensureCurrentManifestDirectory(
  paths: ReturnType<typeof locations>,
  uid: number,
): Promise<void> {
  const applicationSupport = await openDirectory(paths.applicationSupport, uid);
  try {
    await ensurePrivateDirectory(paths.currentVendorParent, uid);
    await rebindDirectory(paths.applicationSupport, applicationSupport, uid);
  } finally {
    await applicationSupport.handle.close();
  }
  const vendor = await openDirectory(paths.currentVendorParent, uid);
  try {
    await ensurePrivateDirectory(paths.currentBrowserParent, uid);
    await rebindDirectory(paths.currentVendorParent, vendor, uid);
  } finally {
    await vendor.handle.close();
  }
  const browser = await openDirectory(paths.currentBrowserParent, uid);
  try {
    await ensurePrivateDirectory(paths.currentManifests, uid);
    await rebindDirectory(paths.currentBrowserParent, browser, uid);
  } finally {
    await browser.handle.close();
  }
}

export async function browserNativeHostPreflight(
  home: string,
  release: string,
  uid = process.getuid?.() ?? -1,
): Promise<BrowserNativeHostReport> {
  let validated: Awaited<ReturnType<typeof validateRelease>>;
  try {
    validated = await validateRelease(release, uid);
  } catch {
    return { version: 1, browser: "arc", status: "invalid_release", ready: false };
  }
  try {
    const paths = locations(home);
    const state = await openDirectoryIfPresent(paths.state, uid);
    let recordFile, lockFile, stageFile;
    try {
      recordFile = state ? await readBounded(join(paths.state, RECORD), uid, [0o600]) : undefined;
      lockFile = state ? await readBounded(join(paths.state, LOCK), uid, [0o600]) : undefined;
      stageFile = state ? await readBounded(join(paths.state, STAGE), uid, [0o600]) : undefined;
      if (state) await rebindDirectory(paths.state, state, uid);
    } finally {
      await state?.handle.close();
    }
    if (lockFile || stageFile)
      return { version: 1, browser: "arc", status: "recovery_required", ready: false };
    if (!recordFile) {
      const [legacy, current] = await Promise.all([
        inspectManifestLocation(
          { browserParent: paths.legacyBrowserParent, manifests: paths.legacyManifests },
          validated.plan.manifestName,
          uid,
        ),
        inspectManifestLocation(
          { browserParent: paths.currentBrowserParent, manifests: paths.currentManifests },
          validated.plan.manifestName,
          uid,
        ),
      ]);
      return legacy || current
        ? { version: 1, browser: "arc", status: "conflict", ready: false }
        : { version: 1, browser: "arc", status: "absent", ready: true };
    }
    const record = parseRecord(recordFile.bytes),
      location = manifestLocation(paths, record),
      [manifest, otherManifest] = await Promise.all([
        inspectManifestLocation(location, validated.plan.manifestName, uid),
        inspectManifestLocation(
          otherManifestLocation(paths, record),
          validated.plan.manifestName,
          uid,
        ),
      ]);
    if (otherManifest) return { version: 1, browser: "arc", status: "conflict", ready: false };
    if (!manifest)
      return {
        version: 1,
        browser: "arc",
        status: "recovery_required",
        ready: false,
        ...(record.version === 1 ? { migrationRequired: true as const } : {}),
      };
    const matching =
      record.release === release &&
      record.launcherSha256 === validated.launcherSha256 &&
      record.manifestSha256 === digest(validated.plan.manifest) &&
      manifest.bytes.equals(Buffer.from(validated.plan.manifest));
    const installed = matching && record.phase === "installed";
    return {
      version: 1,
      browser: "arc",
      status: installed ? "installed" : matching ? "recovery_required" : "conflict",
      ready: installed && record.version === 2,
      ...(record.version === 1 ? { migrationRequired: true as const } : {}),
    };
  } catch {
    return { version: 1, browser: "arc", status: "conflict", ready: false };
  }
}

export async function installBrowserNativeHost(
  home: string,
  release: string,
  uid = process.getuid?.() ?? -1,
): Promise<void> {
  const validated = await validateRelease(release, uid),
    paths = locations(home);
  await ensurePrivateDirectory(join(home, ".ellie"), uid);
  await ensurePrivateDirectory(paths.state, uid);
  const state = await openDirectory(paths.state, uid);
  const lockPath = join(paths.state, LOCK);
  let lock: FileHandle | undefined,
    lockId: Identity | undefined,
    manifests: { handle: FileHandle; id: Identity } | undefined;
  try {
    try {
      lock = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new Error("Browser native host update is blocked by retained lock evidence.");
    }
    await lock.chmod(0o600);
    await lock.writeFile(`${process.pid}\n`);
    await lock.sync();
    lockId = snapshot(await lock.stat());
    const recordPath = join(paths.state, RECORD),
      manifestPath = join(paths.currentManifests, validated.plan.manifestName);
    await revalidateRelease(release, uid, validated);
    if (await readBounded(join(paths.state, STAGE), uid, [0o600]))
      throw new Error("Browser native host update has retained stage evidence.");
    let recordFile = await readBounded(recordPath, uid, [0o600]);
    if (recordFile && parseRecord(recordFile.bytes).version === 1)
      throw new Error(
        "Legacy Arc native host ownership must be explicitly uninstalled before installing the current location.",
      );
    const [legacyEvidence, currentEvidence] = await Promise.all([
      inspectManifestLocation(
        { browserParent: paths.legacyBrowserParent, manifests: paths.legacyManifests },
        validated.plan.manifestName,
        uid,
      ),
      inspectManifestLocation(
        { browserParent: paths.currentBrowserParent, manifests: paths.currentManifests },
        validated.plan.manifestName,
        uid,
      ),
    ]);
    if (legacyEvidence)
      throw new Error("A legacy Arc native host manifest was preserved; reconcile it explicitly.");
    if (!recordFile && currentEvidence)
      throw new Error("An unowned browser native host manifest already exists.");
    await ensureCurrentManifestDirectory(paths, uid);
    manifests = await openDirectory(paths.currentManifests, uid);
    if (
      await inspectManifestLocation(
        { browserParent: paths.legacyBrowserParent, manifests: paths.legacyManifests },
        validated.plan.manifestName,
        uid,
      )
    )
      throw new Error("A legacy Arc native host manifest was preserved; reconcile it explicitly.");
    const manifest = await readBounded(manifestPath, uid, [0o600]);
    const base: Omit<CurrentRecordValue, "phase"> = {
      version: 2,
      browser: "arc",
      location: "chrome_user",
      release,
      launcherSha256: validated.launcherSha256,
      manifestSha256: digest(validated.plan.manifest),
    };
    if (recordFile) {
      const old = parseRecord(recordFile.bytes);
      if (
        old.release !== release ||
        old.launcherSha256 !== base.launcherSha256 ||
        old.manifestSha256 !== base.manifestSha256 ||
        old.phase === "uninstalling"
      )
        throw new Error("Browser native host ownership conflicts with this release.");
      if (manifest && !manifest.bytes.equals(Buffer.from(validated.plan.manifest)))
        throw new Error("Browser native host manifest conflicts with this release.");
      if (old.phase === "installed" && manifest) return;
    } else {
      if (manifest) throw new Error("An unowned browser native host manifest already exists.");
      await publishExclusive(
        paths.state,
        state,
        RECORD,
        bytesFor({ ...base, phase: "installing" }),
        uid,
      );
      recordFile = await readBounded(recordPath, uid, [0o600]);
    }
    if (!manifest) {
      await revalidateRelease(release, uid, validated);
      await publishExclusive(
        paths.currentManifests,
        manifests,
        validated.plan.manifestName,
        Buffer.from(validated.plan.manifest),
        uid,
      );
    }
    await replaceOwned(
      paths.state,
      state,
      RECORD,
      recordFile!.id,
      bytesFor({ ...base, phase: "installed" }),
      uid,
    );
    await revalidateRelease(release, uid, validated);
  } finally {
    await lock?.close();
    if (lockId) {
      await cleanupLock(lockPath, lockId, paths.state, state, uid);
    }
    await state.handle.close();
    await manifests?.handle.close();
  }
}

export async function uninstallBrowserNativeHost(
  home: string,
  release: string,
  uid = process.getuid?.() ?? -1,
): Promise<void> {
  const validated = await validateRelease(release, uid),
    paths = locations(home);
  const state = await openDirectory(paths.state, uid);
  const lockPath = join(paths.state, LOCK);
  let lock: FileHandle | undefined,
    lockId: Identity | undefined,
    manifests: { handle: FileHandle; id: Identity } | undefined;
  try {
    try {
      lock = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new Error("Browser native host update is blocked by retained lock evidence.");
    }
    await lock.chmod(0o600);
    await lock.writeFile(`${process.pid}\n`);
    await lock.sync();
    lockId = snapshot(await lock.stat());
    const recordPath = join(paths.state, RECORD);
    await revalidateRelease(release, uid, validated);
    if (await readBounded(join(paths.state, STAGE), uid, [0o600]))
      throw new Error("Browser native host update has retained stage evidence.");
    const recordFile = await readBounded(recordPath, uid, [0o600]);
    if (!recordFile) {
      const [legacy, current] = await Promise.all([
        inspectManifestLocation(
          { browserParent: paths.legacyBrowserParent, manifests: paths.legacyManifests },
          validated.plan.manifestName,
          uid,
        ),
        inspectManifestLocation(
          { browserParent: paths.currentBrowserParent, manifests: paths.currentManifests },
          validated.plan.manifestName,
          uid,
        ),
      ]);
      if (legacy || current)
        throw new Error("An unowned browser native host manifest was preserved.");
      return;
    }
    const record = parseRecord(recordFile.bytes),
      location = manifestLocation(paths, record),
      otherLocation = otherManifestLocation(paths, record);
    if (
      record.release !== release ||
      record.launcherSha256 !== validated.launcherSha256 ||
      record.manifestSha256 !== digest(validated.plan.manifest)
    )
      throw new Error("Browser native host ownership conflicts with this release.");
    if (await inspectManifestLocation(otherLocation, validated.plan.manifestName, uid))
      throw new Error("An unowned browser native host manifest was preserved.");
    const manifestPath = join(location.manifests, validated.plan.manifestName);
    const parent = await openDirectoryIfPresent(location.browserParent, uid);
    if (parent) {
      try {
        manifests = await openDirectoryIfPresent(location.manifests, uid);
        await rebindDirectory(location.browserParent, parent, uid);
      } finally {
        await parent.handle.close();
      }
    }
    const manifest = manifests ? await readBounded(manifestPath, uid, [0o600]) : undefined;
    if (manifest && !manifest.bytes.equals(Buffer.from(validated.plan.manifest)))
      throw new Error("Browser native host manifest changed and was preserved.");
    if (record.phase !== "uninstalling")
      await replaceOwned(
        paths.state,
        state,
        RECORD,
        recordFile.id,
        bytesFor({ ...record, phase: "uninstalling" }),
        uid,
      );
    const transitioned = await readBounded(recordPath, uid, [0o600]);
    const transitionedBytes = bytesFor({ ...record, phase: "uninstalling" });
    if (!transitioned || !transitioned.bytes.equals(transitionedBytes))
      throw new Error("Browser native host ownership changed.");
    if (manifest) {
      await revalidateRelease(release, uid, validated);
      await rebindDirectory(location.manifests, manifests!, uid);
      const final = await readBounded(manifestPath, uid, [0o600]);
      if (
        !final ||
        !exact(final.id, manifest.id) ||
        !final.bytes.equals(Buffer.from(validated.plan.manifest))
      )
        throw new Error("Browser native host manifest changed and was preserved.");
      await unlink(manifestPath);
      await manifests!.handle.sync();
    }
    await revalidateRelease(release, uid, validated);
    await rebindDirectory(paths.state, state, uid);
    const finalRecord = await readBounded(recordPath, uid, [0o600]);
    if (
      !finalRecord ||
      !exact(finalRecord.id, transitioned.id) ||
      !finalRecord.bytes.equals(transitionedBytes)
    )
      throw new Error("Browser native host ownership changed.");
    await unlink(recordPath);
    await state.handle.sync();
  } finally {
    await lock?.close();
    if (lockId) {
      await cleanupLock(lockPath, lockId, paths.state, state, uid);
    }
    await state.handle.close();
    await manifests?.handle.close();
  }
}
