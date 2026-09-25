import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

function digestField(hash, value) {
  const bytes = Buffer.from(String(value));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length);
  hash.update(bytes);
}

async function measureEntries(root, current, hash) {
  let files = 0;
  let bytes = 0;
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const relativePath = relative(root, path).split(sep).join("/");
    const info = await lstat(path);
    if (info.isDirectory()) {
      hash.update("directory\0");
      digestField(hash, relativePath);
      digestField(hash, (info.mode & 0o777).toString(8));
      const nested = await measureEntries(root, path, hash);
      files += nested.files;
      bytes += nested.bytes;
      continue;
    }
    if (!info.isFile())
      throw new Error(`Runtime contains something that is not a regular file: ${path}`);
    hash.update("file\0");
    digestField(hash, relativePath);
    digestField(hash, (info.mode & 0o777).toString(8));
    digestField(hash, info.size);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== info.dev ||
        opened.ino !== info.ino ||
        opened.size !== info.size ||
        opened.mode !== info.mode
      )
        throw new Error(`Runtime file changed while it was inspected: ${path}`);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await handle.stat();
      if (
        position !== opened.size ||
        after.size !== opened.size ||
        after.mode !== opened.mode ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      )
        throw new Error(`Runtime file changed while it was inspected: ${path}`);
    } finally {
      await handle.close();
    }
    files += 1;
    bytes += info.size;
  }
  return { files, bytes };
}

/**
 * Walks a staged tree, refusing anything that is not a plain file or directory. A symbolic
 * link inside the bundle would let the runtime reach content the signature does not cover.
 */
export async function measureTree(root) {
  const hash = createHash("sha256");
  const measured = await measureEntries(root, root, hash);
  return { ...measured, sha256: hash.digest("hex") };
}

const RUNTIME_REQUIRED = [
  "bin/node",
  "browser-operations.json",
  "helpers/ellie-browser-accessibility",
  "helpers/ellie-browser-runtime-broker",
  "lib/ellie/apps/cli/src/main.ts",
];

/**
 * Copies a service payload into the bundle so an installation carries its own runtime.
 * `packagedBrowserHelpers` and `installedBrowserRegistry` both resolve from the running
 * executable, so the payload keeps its own layout and lands whole under Resources.
 */
export async function stageRuntime(source, resourcesDirectory) {
  for (const required of RUNTIME_REQUIRED) {
    const path = join(source, required);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile())
      throw new Error(`--runtime is not an Ellie service payload: ${required} is missing.`);
  }
  const expected = await measureTree(source);
  const destination = join(resourcesDirectory, "runtime");
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    errorOnExist: true,
    force: false,
  });
  const staged = await measureTree(destination);
  if (
    staged.files !== expected.files ||
    staged.bytes !== expected.bytes ||
    staged.sha256 !== expected.sha256
  )
    throw new Error("The embedded runtime does not match the payload it came from.");
  return staged;
}

// Mach-O and universal-binary magics, read as a big-endian word.
const MACH_O = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);
const BUNDLE = /\.(app|framework|xpc|bundle)$/;

/**
 * Splits the code inside a staged tree into nested bundles and loose executables.
 *
 * `codesign --deep` descends into nested bundles wherever they sit, but skips a plain
 * Mach-O file under `Contents/Resources`, so the two need different treatment. A bundle is
 * a unit: signing or verifying its inner executable on its own says nothing about the seal
 * that actually covers it, so the walk stops at one rather than reaching inside.
 */
export async function embeddedCode(root, current = root) {
  const bundles = [];
  const executables = [];
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const info = await lstat(path);
    if (info.isDirectory()) {
      if (BUNDLE.test(name)) {
        bundles.push(path);
        continue;
      }
      const nested = await embeddedCode(root, path);
      bundles.push(...nested.bundles);
      executables.push(...nested.executables);
      continue;
    }
    if (!info.isFile() || info.size < 4) continue;
    const handle = await open(path, "r");
    try {
      const head = Buffer.alloc(4);
      const { bytesRead } = await handle.read(head, 0, 4, 0);
      if (bytesRead === 4 && MACH_O.has(head.readUInt32BE(0))) executables.push(path);
    } finally {
      await handle.close();
    }
  }
  return { bundles, executables };
}
