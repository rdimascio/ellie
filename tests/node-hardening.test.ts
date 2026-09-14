import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  nodeHardeningEntitlements,
  parseNodeHardeningOptions,
  runNodeHardeningCommandFixture,
  runNodeHardeningValidation,
  validateNodeEntitlements,
} from "../scripts/test-node-hardening.mjs";

const archive = "/private/tmp/node-v24.21.0-darwin-arm64.tar.xz";
const digest = "6".repeat(64);

test("Node hardening inputs require one exact arm64 Node 24 archive and digest", () => {
  assert.deepEqual(
    parseNodeHardeningOptions(["--node-archive", archive, "--node-sha256", digest]),
    { archive, sha256: digest },
  );
  for (const args of [
    [],
    ["--node-archive", "relative.tar.xz", "--node-sha256", digest],
    ["--node-archive", archive, "--node-sha256", "A".repeat(64)],
    ["--node-archive", archive, "--node-sha256", digest, "--node-sha256", digest],
    ["--node-archive", "/private/tmp/node-v25.0.0-darwin-arm64.tar.xz", "--node-sha256", digest],
  ]) {
    assert.throws(() => parseNodeHardeningOptions(args));
  }
});

test("archive member is rejected before extraction when its declared size exceeds the bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-node-archive-test-"));
  let safe = false;
  try {
    const prefix = "node-v24.21.0-darwin-arm64";
    const source = join(root, "source", prefix, "bin");
    await mkdir(source, { recursive: true, mode: 0o700 });
    const member = join(source, "node");
    await writeFile(member, Buffer.alloc(2_048, 0x41), { mode: 0o755 });
    const archivePath = join(root, `${prefix}.tar.xz`);
    const packed = spawnSync(
      "/usr/bin/tar",
      ["-cJf", archivePath, "-C", join(root, "source"), `${prefix}/bin/node`],
      {
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    assert.equal(packed.error, undefined);
    assert.equal(packed.signal, null);
    assert.equal(packed.status, 0);
    const sha256 = createHash("sha256")
      .update(await readFile(archivePath))
      .digest("hex");
    await assert.rejects(
      runNodeHardeningValidation({
        archive: archivePath,
        sha256,
        testMaximumNodeBytes: 1_024,
      }),
      /stage=archive-inspect outcome=failed/,
    );
    safe = true;
  } finally {
    if (safe) await rm(root, { recursive: true });
  }
});

test("archive filename and internal Node version must match before extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-node-version-test-"));
  let safe = false;
  try {
    const internal = "node-v24.22.0-darwin-arm64";
    const source = join(root, "source", internal, "bin");
    await mkdir(source, { recursive: true, mode: 0o700 });
    await writeFile(join(source, "node"), "not used", { mode: 0o755 });
    const archivePath = join(root, "node-v24.21.0-darwin-arm64.tar.xz");
    const packed = spawnSync(
      "/usr/bin/tar",
      ["-cJf", archivePath, "-C", join(root, "source"), `${internal}/bin/node`],
      { encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(packed.status, 0);
    const sha256 = createHash("sha256")
      .update(await readFile(archivePath))
      .digest("hex");
    await assert.rejects(
      runNodeHardeningValidation({ archive: archivePath, sha256 }),
      /stage=archive-inspect outcome=failed/,
    );
    safe = true;
  } finally {
    if (safe) await rm(root, { recursive: true });
  }
});

async function fixtureScript(source: string) {
  const root = await mkdtemp(join(tmpdir(), "ellie-node-command-test-"));
  const executable = join(root, "fixture");
  await writeFile(executable, `#!/bin/sh\n${source}\n`);
  await chmod(executable, 0o700);
  return { executable, root };
}

async function groupAbsent(group: number) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const result = spawnSync("/bin/ps", ["-axo", "pgid="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    assert.equal(result.status, 0);
    if (!result.stdout.split("\n").map(Number).includes(group)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("finite fixture group remains observable");
}

test("bounded command runner reaps direct overflow and TERM-ignoring children", async () => {
  const overflow = await fixtureScript(
    `exec awk 'BEGIN { for (i = 0; i < 1100000; i++) printf "x" }'`,
  );
  const ignoring = await fixtureScript("trap '' TERM\nexec /bin/sleep 5");
  let overflowSafe = false;
  let ignoringSafe = false;
  try {
    const output = await runNodeHardeningCommandFixture(overflow.executable, [], {
      root: overflow.root,
      timeout: 2_000,
      killAfter: 100,
      reapAfter: 1_000,
    });
    assert.match(output.outcome, /output exceeded/);
    assert.equal(output.cleanupCertain, true);
    overflowSafe = true;
    const killed = await runNodeHardeningCommandFixture(ignoring.executable, [], {
      root: ignoring.root,
      timeout: 100,
      killAfter: 100,
      reapAfter: 1_000,
    });
    assert.match(killed.outcome, /deadline/);
    assert.equal(killed.cleanupCertain, true);
    ignoringSafe = true;
  } finally {
    if (overflowSafe) await rm(overflow.root, { recursive: true });
    if (ignoringSafe) await rm(ignoring.root, { recursive: true });
  }
});

test("streaming extraction stops at its write bound and reaps its direct producer", async () => {
  const producer = await fixtureScript(
    `exec awk 'BEGIN { for (i = 0; i < 4096; i++) printf "x" }'`,
  );
  const destination = join(producer.root, "captured");
  let safe = false;
  try {
    const result = await runNodeHardeningCommandFixture(producer.executable, [], {
      root: producer.root,
      timeout: 2_000,
      killAfter: 100,
      reapAfter: 1_000,
      outputFile: destination,
      maximumFile: 1_024,
    });
    assert.match(result.outcome, /exceeded its bound/);
    assert.equal(result.cleanupCertain, true);
    assert.ok((await readFile(destination)).byteLength <= 1_024);
    safe = true;
  } finally {
    if (safe) await rm(producer.root, { recursive: true });
  }
});

test("bounded command runner retains descendant uncertainty and blocks work after interruption", async () => {
  const descendant = await fixtureScript(
    `printf '%s\\n' "$$" > "$TMPDIR/group"\n(/bin/sleep 0.3) >/dev/null 2>&1 &\nexit 0`,
  );
  const interrupted = await fixtureScript("exec /bin/sleep 5");
  let descendantSafe = false;
  let interruptedSafe = false;
  try {
    const uncertain = await runNodeHardeningCommandFixture(descendant.executable, [], {
      root: descendant.root,
      timeout: 2_000,
      cleanupOnSettlement: true,
    });
    assert.equal(uncertain.cleanupCertain, false);
    assert.match(uncertain.outcome, /process-group members/);
    const group = Number(await readFile(join(descendant.root, "group"), "utf8"));
    await groupAbsent(group);
    descendantSafe = true;

    const stopped = await runNodeHardeningCommandFixture(interrupted.executable, [], {
      root: interrupted.root,
      timeout: 2_000,
      interruptAfter: 50,
      killAfter: 100,
      reapAfter: 1_000,
    });
    assert.match(stopped.outcome, /interrupted/);
    assert.equal(stopped.cleanupCertain, true);
    assert.equal(stopped.laterBlocked, true);
    interruptedSafe = true;
  } finally {
    if (descendantSafe) await rm(descendant.root, { recursive: true });
    if (interruptedSafe) await rm(interrupted.root, { recursive: true });
  }
});

test("Node hardening entitlement validation accepts only the two explicit JIT exceptions", () => {
  assert.deepEqual(Object.keys(nodeHardeningEntitlements).sort(), [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
  ]);
  const value = {
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true,
  };
  assert.doesNotThrow(() => validateNodeEntitlements(value));
  assert.throws(() => validateNodeEntitlements({ ...value, nested: {} }));
  assert.throws(() =>
    validateNodeEntitlements({
      "com.apple.security.cs.allow-jit": { nested: true },
      "com.apple.security.cs.allow-unsigned-executable-memory": true,
    }),
  );
  assert.throws(() =>
    validateNodeEntitlements(`<!-- <key>com.apple.security.cs.allow-jit</key><true/> -->`),
  );
});

test(
  "macOS plist decoding rejects nested and commented entitlement lookalikes",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ellie-entitlements-test-"));
    let safe = false;
    try {
      const plist = join(root, "nested.plist");
      await writeFile(
        plist,
        `<?xml version="1.0"?><plist><dict>
      <!-- <key>com.apple.security.cs.allow-jit</key><true/> -->
      <key>nested</key><dict>
      <key>com.apple.security.cs.allow-jit</key><true/>
      <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
      </dict></dict></plist>`,
      );
      const converted = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], {
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(converted.status, 0);
      assert.throws(() => validateNodeEntitlements(JSON.parse(converted.stdout)));
      safe = true;
    } finally {
      if (safe) await rm(root, { recursive: true });
    }
  },
);
