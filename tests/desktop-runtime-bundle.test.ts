import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// @ts-expect-error -- the bundle builders are plain scripts without declarations.
import { embeddedCode, measureTree, stageRuntime } from "../scripts/bundle-runtime.mjs";

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
  await symlink("/etc/passwd", join(directory, "escape"));
  await assert.rejects(measureTree(directory), /not a regular file/);
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

test("embedded code is split into nested bundles and loose executables", async (t) => {
  const root = await scratch(t);
  const directory = await payload(root);
  // `codesign --deep` descends into nested bundles wherever they sit but skips a plain
  // Mach-O under Resources, so the bundle builder has to tell the two apart.
  for (const executable of ["bin/node", "helpers/ellie-browser-runtime-broker"])
    await copyFile("/usr/bin/true", join(directory, executable));
  const launcher = join(directory, "launchers/Ellie Coordinator.app/Contents/MacOS");
  await mkdir(launcher, { recursive: true, mode: 0o755 });
  await copyFile("/usr/bin/true", join(launcher, "EllieService"));

  const code = await embeddedCode(directory);
  const relative = (path: string) => path.slice(directory.length + 1);
  assert.deepEqual(code.bundles.map(relative), ["launchers/Ellie Coordinator.app"]);
  // The walk stops at a bundle: its executable is covered by the bundle's own seal, and
  // verifying or signing that file on its own says nothing about the seal.
  assert.deepEqual(code.executables.map(relative), [
    "bin/node",
    "helpers/ellie-browser-runtime-broker",
  ]);
  // The reviewed registry and the staged sources are data, not code.
  assert.ok(!code.executables.some((path: string) => /\.(json|ts)$/.test(path)));
});
