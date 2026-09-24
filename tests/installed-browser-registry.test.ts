import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reviewedBrowserBindings } from "../apps/cli/src/browser-registry-source.ts";
import { installedBrowserRegistry } from "../apps/cli/src/browser-runtime-paths.ts";
import {
  canonicalReviewedBrowserRegistry,
  loadInstalledBrowserRegistry,
  loadReviewedBrowserRegistry,
  reviewedBrowserRegistry,
} from "../apps/node/src/browser-operation-registry.ts";

const empty = reviewedBrowserRegistry({ version: 1, bindings: [] });
const shipped = reviewedBrowserRegistry({
  version: 1,
  bindings: [
    {
      id: "summary",
      origin: "https://video.example",
      operation: "read",
      toolName: "read_view",
      inputSchemaSha256: "a".repeat(64),
    },
  ],
});

async function scratch(t: { after(fn: () => unknown): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ellie-installed-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Lays out a runtime the way a built payload or an application bundle carries one. */
async function runtime(root: string, registry = shipped): Promise<string> {
  const directory = join(root, "runtime");
  await mkdir(join(directory, "bin"), { recursive: true, mode: 0o755 });
  await writeFile(
    join(directory, "browser-operations.json"),
    canonicalReviewedBrowserRegistry(registry),
    {
      mode: 0o644,
    },
  );
  await chmod(join(directory, "browser-operations.json"), 0o644);
  return join(directory, "bin", "node");
}

test("an installed registry is trusted when no other account can rewrite it", async (t) => {
  const root = await scratch(t);
  const executable = await runtime(root);
  const path = installedBrowserRegistry(executable);
  assert.equal(path, join(root, "runtime", "browser-operations.json"));
  assert.deepEqual(loadInstalledBrowserRegistry(path!), shipped);

  // The private-state contract is deliberately unchanged: bundle content cannot be 0600.
  assert.throws(() => loadReviewedBrowserRegistry(path!));
});

test("an installed registry any account can rewrite is refused", async (t) => {
  const root = await scratch(t);
  const executable = await runtime(root);
  const path = installedBrowserRegistry(executable)!;
  await chmod(path, 0o666);
  assert.throws(() => loadInstalledBrowserRegistry(path), /writable by other accounts/);
  await chmod(path, 0o644);
  assert.deepEqual(loadInstalledBrowserRegistry(path), shipped);
});

test("a registry below a directory other accounts can rewrite is refused", async (t) => {
  const root = await scratch(t);
  const open = join(root, "open");
  await mkdir(open, { mode: 0o755 });
  const executable = await runtime(open);
  const path = installedBrowserRegistry(executable)!;
  assert.deepEqual(loadInstalledBrowserRegistry(path), shipped);
  await chmod(open, 0o777);
  assert.throws(() => loadInstalledBrowserRegistry(path), /writable by other accounts/);
  // Sticky shared directories cannot be used to replace a file owned by someone else,
  // and every temporary directory in this test already sits below one.
  await chmod(open, 0o1777);
  assert.deepEqual(loadInstalledBrowserRegistry(path), shipped);
});

test("a runtime without a reviewed registry reports none rather than failing", async (t) => {
  const root = await scratch(t);
  await mkdir(join(root, "runtime", "bin"), { recursive: true, mode: 0o755 });
  assert.equal(installedBrowserRegistry(join(root, "runtime", "bin", "node")), undefined);
  const state = join(root, "state");
  await mkdir(state, { mode: 0o700 });
  assert.equal(
    await reviewedBrowserBindings(state, join(root, "runtime", "bin", "node")),
    undefined,
  );
});

test("reviewed bindings prefer private state and fall back to the installation", async (t) => {
  const root = await scratch(t);
  const executable = await runtime(root);
  const state = join(root, "state");
  await mkdir(state, { mode: 0o700 });

  assert.deepEqual(await reviewedBrowserBindings(state, executable), shipped);

  const override = join(state, "browser-operations.json");
  await writeFile(override, canonicalReviewedBrowserRegistry(empty), { mode: 0o600 });
  await chmod(override, 0o600);
  assert.deepEqual(await reviewedBrowserBindings(state, executable), empty);
});

test("the reviewed registry Ellie ships is canonical and parses as reviewed bindings", async () => {
  const path = new URL("../apps/node/reviewed-browser-operations.json", import.meta.url);
  const bytes = await readFile(path);
  const parsed = reviewedBrowserRegistry(JSON.parse(bytes.toString("utf8")));
  assert.ok(canonicalReviewedBrowserRegistry(parsed).equals(bytes));
  // No WebMCP binding has been reviewed yet. Shipping the file anyway is what turns
  // browser capability on for an installation, which is how the accessibility path runs.
  assert.deepEqual(parsed, empty);
});
