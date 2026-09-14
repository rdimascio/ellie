import assert from "node:assert/strict";
import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
// @ts-expect-error The dependency-free bootstrap stays directly executable JavaScript.
import { launch, stop } from "../scripts/runtime-rollback-owned-process.mjs";
import {
  NEW_REVISION,
  OLD_REVISION,
  assertPreserved,
  exactRevision,
  ownedCommand,
  requireExactSHA256,
  syntheticIdentity,
} from "../scripts/test-runtime-rollback.mjs";

test("rollback source revisions and preservation comparisons are exact", () => {
  assert.equal(exactRevision(OLD_REVISION), OLD_REVISION);
  assert.equal(exactRevision(NEW_REVISION), NEW_REVISION);
  assert.throws(() => exactRevision(`${OLD_REVISION}\n`), /revision is invalid/);
  assert.throws(() => exactRevision(OLD_REVISION.toUpperCase()), /revision is invalid/);
  assert.doesNotThrow(() => assertPreserved({ a: "1" }, { a: "1" }));
  assert.throws(() => assertPreserved({ a: "1" }, { a: "2" }), /changed/);
});

test("owned-process bootstrap imports from an isolated copy without production modules", async () => {
  const owned = await mkdtemp(join(tmpdir(), "ellie-rollback-bootstrap-"));
  let cleanupCertain = false;
  try {
    const source = fileURLToPath(
      new URL("../scripts/runtime-rollback-owned-process.mjs", import.meta.url),
    );
    const selected = join(owned, "selected-owned-process.mjs");
    await copyFile(source, selected);
    await writeFile(
      join(owned, "package.json"),
      '{"type":"module","imports":{"#ellie":"./missing.js"}}',
    );
    const isolated = (await import(pathToFileURL(selected).href)) as {
      launch: typeof launch;
      stop: typeof stop;
    };
    await ownedCommand(isolated, "/usr/bin/true", [], {
      cwd: owned,
      env: { HOME: owned, TMPDIR: owned, PATH: "/usr/bin:/bin" },
    });
    cleanupCertain = true;
  } finally {
    if (cleanupCertain) await rm(owned, { recursive: true });
  }
});

test("selected archived input is isolated from ambient mutation and exact-hash guarded", async () => {
  const owned = await mkdtemp(join(tmpdir(), "ellie-rollback-isolation-"));
  try {
    const selected = join(owned, "selected.ts");
    const ambient = join(owned, "ambient.ts");
    const original = "export const selected = true;\n";
    await Promise.all([writeFile(selected, original), writeFile(ambient, original)]);
    const expected = createHash("sha256")
      .update(await readFile(selected))
      .digest("hex");
    await writeFile(ambient, "export const selected = false;\n");
    await requireExactSHA256(selected, expected);
    await writeFile(selected, "export const selected = false;\n");
    await assert.rejects(requireExactSHA256(selected, expected), /input has changed/);
  } finally {
    await rm(owned, { recursive: true });
  }
});

test("timed-out setup command reaps its direct child and finite descendant", async () => {
  const owned = await mkdtemp(join(tmpdir(), "ellie-rollback-command-"));
  let cleanupCertain = false;
  try {
    await assert.rejects(
      ownedCommand({ launch, stop }, "/bin/sh", ["-c", "/bin/sleep 0.2 & wait"], {
        cwd: owned,
        env: { HOME: owned, TMPDIR: owned, PATH: "/usr/bin:/bin" },
        timeout: 10,
      }),
      /timed out/,
    );
    cleanupCertain = true;
  } finally {
    if (cleanupCertain) await rm(owned, { recursive: true });
  }
});

test("synthetic certificate is created through the owned process boundary", async () => {
  const owned = await mkdtemp(join(tmpdir(), "ellie-rollback-identity-"));
  let cleanupCertain = false;
  try {
    const identity = await syntheticIdentity({ launch, stop }, owned);
    assert.equal(
      new X509Certificate(identity.cert).checkPrivateKey(createPrivateKey(identity.key)),
      true,
    );
    cleanupCertain = true;
  } finally {
    if (cleanupCertain) await rm(owned, { recursive: true });
  }
});
