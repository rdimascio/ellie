import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const FILE = "service-life-config.json";
const LOCK = "service-life-config.lock";
const MAX = 4096;
type Selection = { version: 1; lifeConfig: string };
type Identity = {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export function clearAmbientServiceLifeConfig(environment: NodeJS.ProcessEnv): void {
  delete environment.ELLIE_LIFE_CONFIG;
}
const identity = (v: Identity): Identity => ({
  dev: v.dev,
  ino: v.ino,
  uid: v.uid,
  mode: v.mode,
  nlink: v.nlink,
  size: v.size,
  mtimeMs: v.mtimeMs,
  ctimeMs: v.ctimeMs,
});
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const exactIdentity = (a: Identity, b: Identity) => JSON.stringify(a) === JSON.stringify(b);
async function rebindLock(
  path: string,
  expected: Identity | undefined,
  handle?: FileHandle,
): Promise<void> {
  const held = handle ? identity(await handle.stat()) : expected;
  if (
    !expected ||
    !held ||
    !exactIdentity(held, expected) ||
    !exactIdentity(identity(await lstat(path)), expected)
  )
    throw new Error("Life configuration lock changed; it was preserved.");
}
async function recheckPointer(
  path: string,
  previous: { file: Identity } | undefined,
): Promise<void> {
  try {
    const current = identity(await lstat(path));
    if (!previous || !exactIdentity(current, previous.file))
      throw new Error("Saved Life configuration changed before publication.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !previous) return;
    throw error;
  }
}
function safeDirectory(v: Identity, uid: number | undefined): void {
  if (
    (v.mode & 0o170000) !== 0o040000 ||
    (v.mode & 0o077) !== 0 ||
    (uid !== undefined && v.uid !== uid)
  )
    throw new Error("Private service configuration directory is unsafe.");
}
async function rebindDirectory(
  path: string,
  expected: Identity,
  fd: FileHandle,
  uid: number | undefined,
): Promise<void> {
  const held = identity(await fd.stat()),
    named = identity(await lstat(path));
  safeDirectory(held, uid);
  safeDirectory(named, uid);
  if (!same(held, expected) || !same(named, expected))
    throw new Error("Private service configuration directory changed.");
}
async function openDirectory(
  path: string,
  uid: number | undefined,
): Promise<{ handle: FileHandle; value: Identity }> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const value = identity(await handle.stat());
    safeDirectory(value, uid);
    if (!same(value, identity(await lstat(path))))
      throw new Error("Private service configuration directory changed.");
    return { handle, value };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function readSelection(
  directory: string,
  directoryIdentity: Identity,
  directoryHandle: FileHandle,
  uid: number | undefined,
): Promise<{ value: Selection; file: Identity } | undefined> {
  await rebindDirectory(directory, directoryIdentity, directoryHandle, uid);
  const path = join(directory, FILE);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Saved Life configuration is unsafe.");
  }
  try {
    const stat = identity(await handle.stat());
    if (
      (stat.mode & 0o170000) !== 0o100000 ||
      stat.nlink !== 1 ||
      stat.size < 2 ||
      stat.size > MAX ||
      (stat.mode & 0o777) !== 0o600 ||
      (uid !== undefined && stat.uid !== uid)
    )
      throw new Error("Saved Life configuration is unsafe.");
    const buffer = Buffer.alloc(MAX + 1),
      { bytesRead } = await handle.read(buffer, 0, buffer.length, 0),
      final = identity(await handle.stat()),
      named = identity(await lstat(path));
    if (
      bytesRead !== stat.size ||
      JSON.stringify(final) !== JSON.stringify(stat) ||
      JSON.stringify(named) !== JSON.stringify(stat)
    )
      throw new Error("Saved Life configuration changed while reading.");
    await rebindDirectory(directory, directoryIdentity, directoryHandle, uid);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.at(-1) !== 0x0a) throw new Error("Saved Life configuration is invalid.");
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("Saved Life configuration is invalid.");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      (value as Selection).version !== 1 ||
      typeof (value as Selection).lifeConfig !== "string"
    )
      throw new Error("Saved Life configuration is invalid.");
    const selected = (value as Selection).lifeConfig;
    if (!isAbsolute(selected) || resolve(selected) !== selected)
      throw new Error("Saved Life configuration path is invalid.");
    if (!bytes.equals(Buffer.from(`${JSON.stringify({ version: 1, lifeConfig: selected })}\n`)))
      throw new Error("Saved Life configuration is not canonical.");
    return { value: { version: 1, lifeConfig: selected }, file: stat };
  } finally {
    await handle.close();
  }
}
export async function selectedServiceLifeConfig(
  directory: string,
  uid = process.getuid?.(),
): Promise<string | undefined> {
  let opened;
  try {
    opened = await openDirectory(directory, uid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const selected = (await readSelection(directory, opened.value, opened.handle, uid))?.value
      .lifeConfig;
    if (selected !== undefined) {
      try {
        if ((await realpath(selected)) !== selected) throw new Error();
      } catch {
        throw new Error("Saved Life configuration target is unavailable.");
      }
    }
    return selected;
  } finally {
    await opened.handle.close();
  }
}
export async function configureServiceLife(
  directory: string,
  selection: string | undefined,
  validate: (path: string) => unknown,
  uid = process.getuid?.(),
): Promise<"enabled" | "disabled"> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const opened = await openDirectory(directory, uid),
    lockPath = join(directory, LOCK);
  let lock: FileHandle | undefined, lockIdentity: Identity | undefined;
  try {
    await rebindDirectory(directory, opened.value, opened.handle, uid);
    try {
      lock = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("Another Life configuration update is active.");
      throw error;
    }
    await lock.chmod(0o600);
    await lock.writeFile(`${process.pid}\n`);
    await lock.sync();
    lockIdentity = identity(await lock.stat());
    const previous = await readSelection(directory, opened.value, opened.handle, uid),
      path = join(directory, FILE);
    if (selection === undefined) {
      await rebindDirectory(directory, opened.value, opened.handle, uid);
      await rebindLock(lockPath, lockIdentity, lock);
      await recheckPointer(path, previous);
      if (previous) {
        await unlink(path);
      }
      await rebindDirectory(directory, opened.value, opened.handle, uid);
      await opened.handle.sync();
      return "disabled";
    }
    if (!isAbsolute(selection) || resolve(selection) !== selection)
      throw new Error("Life config path must be canonical and absolute.");
    let canonical: string;
    try {
      canonical = await realpath(selection);
    } catch {
      throw new Error("Life config file is unavailable. Review the selected private Life config.");
    }
    if (canonical !== selection)
      throw new Error("Life config path must be canonical and absolute.");
    validate(selection);
    await rebindDirectory(directory, opened.value, opened.handle, uid);
    await rebindLock(lockPath, lockIdentity, lock);
    const serialized = Buffer.from(`${JSON.stringify({ version: 1, lifeConfig: selection })}\n`);
    if (serialized.length > MAX) throw new Error("Life config path is too long.");
    const temporary = join(directory, `.service-life-config-${randomBytes(8).toString("hex")}.tmp`),
      output = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    let outputIdentity: Identity;
    try {
      await output.chmod(0o600);
      await output.writeFile(serialized);
      await output.sync();
      outputIdentity = identity(await output.stat());
    } finally {
      await output.close();
    }
    try {
      await rebindDirectory(directory, opened.value, opened.handle, uid);
      await rebindLock(lockPath, lockIdentity, lock);
      await recheckPointer(path, previous);
      if (!same(identity(await lstat(temporary)), outputIdentity!))
        throw new Error("Life configuration stage changed.");
      await rename(temporary, path);
      await rebindDirectory(directory, opened.value, opened.handle, uid);
      await opened.handle.sync();
      const published = await readSelection(directory, opened.value, opened.handle, uid);
      if (!published || published.value.lifeConfig !== selection)
        throw new Error("Life configuration publication is uncertain.");
    } catch (error) {
      try {
        if (same(identity(await lstat(temporary)), outputIdentity!)) await unlink(temporary);
      } catch {}
      throw error;
    }
    return "enabled";
  } finally {
    try {
      if (lock) {
        try {
          await rebindDirectory(directory, opened.value, opened.handle, uid);
          await rebindLock(lockPath, lockIdentity, lock);
          await unlink(lockPath);
          await opened.handle.sync();
        } finally {
          await lock.close();
        }
      }
    } finally {
      await opened.handle.close();
    }
  }
}
