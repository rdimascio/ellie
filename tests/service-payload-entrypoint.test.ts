import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const script = resolve(import.meta.dirname, "../scripts/build-service-payload.mjs");

function run(args: string[]) {
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    killSignal: "SIGKILL",
  });
}

test("service payload CLI recognizes a symlink entry while module import stays inert", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ellie-payload-entrypoint-"));
  let completed = false;
  t.after(async () => {
    if (completed) await rm(root, { recursive: true });
    else t.diagnostic(`Retained owned fixture: ${root}`);
  });
  const alias = join(root, "build-service-payload.mjs");
  await symlink(script, alias);

  const direct = run([alias]);
  assert.equal(direct.status, 1);
  assert.equal(direct.signal, null);
  assert.equal(direct.stdout, "");
  assert.match(
    direct.stderr,
    /Error: Use --node-archive, --node-sha256, --bun-cache, and --output\./,
  );

  const imported = run([
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(pathToFileURL(alias).href)})`,
  ]);
  assert.equal(imported.status, 0);
  assert.equal(imported.signal, null);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  completed = true;
});
