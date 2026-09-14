import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  nodeHardeningEntitlements,
  nodeHardeningSigningArguments,
  nodeHardeningVerificationArguments,
  parseNodeHardeningOptions,
  runNodeHardeningCommandFixture,
  runNodeHardeningValidation,
  validateNodeEntitlements,
  validateNodeSignatureMetadata,
  validateDeveloperIdOptions,
  developerIdSigningEnvironment,
  classifyDeveloperIdSigningFailure,
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

test("Developer ID mode requires one strict private selector and independent team ID", () => {
  const sha1 = "A".repeat(40);
  const teamId = "TESTTEAM01";
  assert.deepEqual(
    parseNodeHardeningOptions([
      "--node-archive",
      archive,
      "--node-sha256",
      digest,
      "--developer-id-sha1",
      sha1,
      "--team-id",
      teamId,
    ]),
    { archive, sha256: digest, identitySha1: sha1, teamId },
  );
  for (const extra of [
    ["--developer-id-sha1", sha1],
    ["--developer-id-sha1", "a".repeat(40), "--team-id", teamId],
    ["--developer-id-sha1", sha1, "--team-id", "SHORT"],
  ]) {
    assert.throws(() =>
      parseNodeHardeningOptions(["--node-archive", archive, "--node-sha256", digest, ...extra]),
    );
  }
  assert.throws(() => validateDeveloperIdOptions({ identitySha1: sha1 }));
  assert.throws(() => validateDeveloperIdOptions({ identitySha1: "a".repeat(40), teamId }));
  assert.throws(() => validateDeveloperIdOptions({ identitySha1: `${sha1}\n`, teamId }));
  assert.throws(() => validateDeveloperIdOptions({ identitySha1: sha1, teamId: `${teamId}\n` }));
  assert.throws(() =>
    validateDeveloperIdOptions({ identitySha1: [sha1] as unknown as string, teamId }),
  );
  assert.throws(() =>
    validateDeveloperIdOptions({ identitySha1: sha1, teamId: [teamId] as unknown as string }),
  );
  assert.doesNotThrow(() => validateDeveloperIdOptions({ identitySha1: sha1, teamId }));
});

test("direct validation rejects malformed Developer ID options before creating owned state", async () => {
  const guardRoot = await mkdtemp(join(tmpdir(), "ellie-node-option-test-"));
  const previous = process.env.TMPDIR;
  let safe = false;
  try {
    process.env.TMPDIR = guardRoot;
    await assert.rejects(
      runNodeHardeningValidation({
        archive,
        sha256: digest,
        identitySha1: "A".repeat(40),
        teamId: `TESTTEAM01" or true`,
      }),
      /Developer ID validation inputs are invalid/,
    );
    assert.deepEqual(await readdir(guardRoot), []);
    safe = true;
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    if (safe) await rm(guardRoot, { recursive: true });
  }
});

test("Developer ID signing policy adds timestamp and verifies exact chain metadata", () => {
  const sha1 = "A".repeat(40);
  const teamId = "TESTTEAM01";
  const signed = nodeHardeningSigningArguments(
    { archive, sha256: digest, identitySha1: sha1, teamId },
    "/owned/node",
    "/owned/entitlements",
  );
  assert.deepEqual(signed, [
    "--force",
    "--sign",
    sha1,
    "--identifier",
    "org.ellie.validation.node",
    "--options",
    "runtime",
    "--timestamp",
    "--entitlements",
    "/owned/entitlements",
    "/owned/node",
  ]);
  assert.deepEqual(nodeHardeningVerificationArguments({ archive, sha256: digest }, "/owned/node"), [
    "--verify",
    "--strict",
    "--all-architectures",
    "/owned/node",
  ]);
  assert.deepEqual(
    nodeHardeningVerificationArguments(
      { archive, sha256: digest, identitySha1: sha1, teamId },
      "/owned/node",
    ),
    [
      "--verify",
      "--strict",
      "--all-architectures",
      `-R=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamId}" and identifier "org.ellie.validation.node"`,
      "/owned/node",
    ],
  );
  const metadata = `Identifier=org.ellie.validation.node
TeamIdentifier=${teamId}
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=1 flags=0x10000(runtime)
Signature size=9000
Authority=Developer ID Application: Example (${teamId})
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Sep 14, 2026 at 1:00:00 PM`;
  assert.doesNotThrow(() => validateNodeSignatureMetadata(metadata, teamId));
  assert.throws(() =>
    validateNodeSignatureMetadata(metadata.replace(/^Timestamp=.*$/m, ""), teamId),
  );
  assert.throws(() =>
    validateNodeSignatureMetadata(metadata.replace("Apple Root CA", "Other"), teamId),
  );
  assert.throws(() =>
    validateNodeSignatureMetadata(metadata.replace(teamId, "AAAAAAAAAA"), teamId),
  );
  assert.throws(() =>
    validateNodeSignatureMetadata(metadata + "\nAuthority=Apple Root CA", teamId),
  );
  assert.throws(() => validateNodeSignatureMetadata(metadata, `${teamId}\n`));
  assert.throws(() => validateNodeSignatureMetadata(metadata, [teamId] as unknown as string));

  const adHoc = `Identifier=org.ellie.validation.node
CodeDirectory v=20500 size=1 flags=0x10000(runtime)
Signature=adhoc`;
  assert.doesNotThrow(() => validateNodeSignatureMetadata(adHoc));
  assert.throws(() => validateNodeSignatureMetadata(`${adHoc}\nTimestamp=now`));
  assert.throws(() => validateNodeSignatureMetadata(adHoc, teamId));
  assert.ok(
    !nodeHardeningSigningArguments({ archive, sha256: digest }, "n", "e").includes("--timestamp"),
  );
});

test("only Developer ID signing receives validated caller HOME and fixed failure classes", () => {
  const isolated = {
    HOME: "/private/tmp/owned/home",
    TMPDIR: "/private/tmp/owned",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
  };
  const signed = { archive, sha256: digest, identitySha1: "A".repeat(40), teamId: "TESTTEAM01" };
  assert.deepEqual(developerIdSigningEnvironment(signed, isolated, "/Users/synthetic"), {
    ...isolated,
    HOME: "/Users/synthetic",
  });
  assert.deepEqual(
    developerIdSigningEnvironment({ archive, sha256: digest }, isolated, undefined),
    {
      ...isolated,
    },
  );
  for (const home of [undefined, "relative", "/Users/a\0b", `/Users/${"x".repeat(1_025)}`])
    assert.throws(() => developerIdSigningEnvironment(signed, isolated, home));
  assert.equal(
    classifyDeveloperIdSigningFailure("The specified item could not be found in the keychain."),
    "signing-identity-unavailable",
  );
  assert.equal(
    classifyDeveloperIdSigningFailure("no identity found"),
    "signing-identity-unavailable",
  );
  assert.equal(
    classifyDeveloperIdSigningFailure("User interaction is not allowed."),
    "signing-interaction-not-allowed",
  );
  assert.equal(
    classifyDeveloperIdSigningFailure("timestamp service is unavailable"),
    "signing-timestamp-unavailable",
  );
  assert.equal(classifyDeveloperIdSigningFailure("The operation timed out."), "signing-timeout");
});

test(
  "macOS codesign accepts the generated Developer ID requirement grammar",
  { skip: process.platform !== "darwin" },
  () => {
    const options = {
      archive,
      sha256: digest,
      identitySha1: "A".repeat(40),
      teamId: "TESTTEAM01",
    };
    const requirement = nodeHardeningVerificationArguments(options, "/usr/bin/true").find(
      (argument) => argument.startsWith("-R="),
    );
    assert.ok(requirement);
    const checked = spawnSync(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--all-architectures", requirement, "/usr/bin/true"],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1_024 },
    );
    assert.equal(checked.error, undefined);
    assert.equal(checked.signal, null);
    assert.equal(checked.status, 3);
    assert.match(checked.stderr, /code failed to satisfy specified code requirement\(s\)/);
  },
);

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
