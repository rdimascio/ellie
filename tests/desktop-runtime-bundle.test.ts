import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// @ts-expect-error -- the bundle builders are plain scripts without declarations.
import { machOFiles, measureTree, stageRuntime } from "../scripts/bundle-runtime.mjs";

const members = [
  "bin/node",
  "browser-operations.json",
  "helpers/ellie-browser-accessibility",
  "helpers/ellie-browser-runtime-broker",
  "lib/ellie/apps/cli/src/main.ts",
];

async function payload(root: string, omit?: string): Promise<string> {
  const directory = join(root, "payload");
  for (const member of members) {
    if (member === omit) continue;
    const path = join(directory, member);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o755 });
    await writeFile(path, `${member}\n`, { mode: 0o644 });
  }
  return directory;
}

async function scratch(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ellie-runtime-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a tree measurement counts every regular file and refuses anything else", async (t) => {
  const root = await scratch(t);
  const directory = await payload(root);
  const measured = await measureTree(directory);
  assert.equal(measured.files, members.length);
  assert.equal(
    measured.bytes,
    members.reduce((total, member) => total + member.length + 1, 0),
  );
  assert.match(measured.sha256, /^[0-9a-f]{64}$/);
  await symlink("/etc/passwd", join(directory, "escape"));
  await assert.rejects(measureTree(directory), /not a regular file/);
});

test("a tree digest binds equal-sized content, modes, paths and empty directories", async (t) => {
  const root = await scratch(t);
  const directory = await payload(root);
  const original = await measureTree(directory);
  const registry = join(directory, "browser-operations.json");
  const registryBytes = await readFile(registry);
  registryBytes[0] = registryBytes[0]! ^ 1;
  await writeFile(registry, registryBytes, { mode: 0o644 });
  const changedContent = await measureTree(directory);
  assert.deepEqual(
    { files: changedContent.files, bytes: changedContent.bytes },
    { files: original.files, bytes: original.bytes },
  );
  assert.notEqual(changedContent.sha256, original.sha256);

  await writeFile(registry, `${members[1]}\n`, { mode: 0o644 });
  await chmod(registry, 0o755);
  const changedMode = await measureTree(directory);
  assert.equal(changedMode.bytes, original.bytes);
  assert.notEqual(changedMode.sha256, original.sha256);

  await chmod(registry, 0o644);
  await mkdir(join(directory, "empty"), { mode: 0o755 });
  const changedLayout = await measureTree(directory);
  assert.deepEqual(
    { files: changedLayout.files, bytes: changedLayout.bytes },
    { files: original.files, bytes: original.bytes },
  );
  assert.notEqual(changedLayout.sha256, original.sha256);
});

test("only a complete service payload is embedded in the bundle", async (t) => {
  for (const missing of members) {
    const root = await scratch(t);
    const directory = await payload(root, missing);
    const resources = join(root, "Resources");
    await mkdir(resources, { mode: 0o755 });
    await assert.rejects(stageRuntime(directory, resources), /is not an Ellie service payload/);
  }
});

test("an embedded runtime keeps its layout and reports what it copied", async (t) => {
  const root = await scratch(t);
  const directory = await payload(root);
  const resources = join(root, "Resources");
  await mkdir(resources, { mode: 0o755 });
  const measured = await stageRuntime(directory, resources);
  assert.deepEqual(measured, await measureTree(directory));
  // `installedBrowserRegistry` resolves the registry from the executable's parent, so
  // the payload layout has to survive the copy exactly.
  assert.deepEqual(await measureTree(join(resources, "runtime")), measured);
  await assert.rejects(stageRuntime(directory, resources));
});

test("a payload holding something other than a file is not embedded", async (t) => {
  const root = await scratch(t);
  const directory = await payload(root);
  await symlink("/etc/passwd", join(directory, "escape"));
  const resources = join(root, "Resources");
  await mkdir(resources, { mode: 0o755 });
  await assert.rejects(stageRuntime(directory, resources), /not a regular file/);
  // Nothing was copied, so a later build against a corrected payload is not blocked by
  // half-staged content from the failed one.
  await assert.rejects(lstat(join(resources, "runtime")), /ENOENT/);
});

test("executables inside an embedded runtime are found wherever they sit", async (t) => {
  const root = await scratch(t);
  const directory = await payload(root);
  // `codesign --deep` walks nested code locations, not Resources, so the bundle builder has
  // to find these itself or they ship unsigned and carry no Team ID.
  for (const executable of ["bin/node", "helpers/ellie-browser-runtime-broker"])
    await writeFile(join(directory, executable), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  const found = await machOFiles(directory);
  assert.deepEqual(
    found.map((path: string) => path.slice(directory.length + 1)),
    ["bin/node", "helpers/ellie-browser-runtime-broker"],
  );
  // The reviewed registry and the staged sources are data and must not be signed.
  assert.ok(!found.some((path: string) => path.endsWith(".json") || path.endsWith(".ts")));
});

test("64-bit universal binaries inside an embedded runtime are found for signing", async (t) => {
  const root = await scratch(t);
  const directory = await payload(root);
  const binaries = [
    ["helpers/universal-64", [0xca, 0xfe, 0xba, 0xbf]],
    ["helpers/universal-64-swapped", [0xbf, 0xba, 0xfe, 0xca]],
  ] as const;
  for (const [path, magic] of binaries) await writeFile(join(directory, path), Buffer.from(magic));

  const found = await machOFiles(directory);
  assert.deepEqual(
    found.map((path: string) => path.slice(directory.length + 1)),
    binaries.map(([path]) => path),
  );
});
