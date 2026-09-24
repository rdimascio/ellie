import { cp, lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Walks a staged tree, refusing anything that is not a plain file or directory. A symbolic
 * link inside the bundle would let the runtime reach content the signature does not cover.
 */
export async function measureTree(root, current = root) {
  let files = 0;
  let bytes = 0;
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const info = await lstat(path);
    if (info.isDirectory()) {
      const nested = await measureTree(root, path);
      files += nested.files;
      bytes += nested.bytes;
      continue;
    }
    if (!info.isFile())
      throw new Error(`Runtime contains something that is not a regular file: ${path}`);
    files += 1;
    bytes += info.size;
  }
  return { files, bytes };
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
  if (staged.files !== expected.files || staged.bytes !== expected.bytes)
    throw new Error("The embedded runtime does not match the payload it came from.");
  return staged;
}

// Mach-O and universal-binary magics, read as a big-endian word.
const MACH_O = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);

/**
 * Lists the executables inside a staged tree. `codesign --deep` walks only the nested code
 * locations macOS recognizes, so a binary under `Contents/Resources` is sealed as a resource
 * and never signed. Unsigned helpers have no Team ID, which is the identity the Keychain
 * access group and every future notarization depend on, so each one is signed on its own.
 */
export async function machOFiles(root, current = root) {
  const found = [];
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const info = await lstat(path);
    if (info.isDirectory()) {
      found.push(...(await machOFiles(root, path)));
      continue;
    }
    if (!info.isFile() || info.size < 4) continue;
    const handle = await open(path, "r");
    try {
      const head = Buffer.alloc(4);
      const { bytesRead } = await handle.read(head, 0, 4, 0);
      if (bytesRead === 4 && MACH_O.has(head.readUInt32BE(0))) found.push(path);
    } finally {
      await handle.close();
    }
  }
  return found;
}
