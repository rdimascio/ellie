import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  generateActivationPolicySource,
  inspectActivationPolicyBlob,
  parseActivationPolicyProbe,
  runActivationPolicyBuildCommand,
  unavailableActivationPolicySource,
} from "../scripts/activation-policy-source.mjs";
import { buildPackagedLaunchers, buildServicePayload } from "../scripts/build-service-payload.mjs";

const mac = process.platform === "darwin";
const hostArchitecture = process.arch === "arm64" ? "arm64" : "x64";
const repository = resolve(import.meta.dirname, "..");
const native = (name: string) => join(repository, "packages/macos/native", name);
const loader = native("CompiledActivationPolicyBlob.swift");
const installerSources = [
  "ServicePayloadAuthorization.swift",
  "ServicePayloadAuthenticatedInspection.swift",
  "AuthenticatedActivationPolicy.swift",
  "AuthenticatedCandidateVerifier.swift",
  "ServicePayloadCapture.swift",
  "ServicePayloadSelection.swift",
  "ServicePayloadLifecycle.swift",
  "ServicePayloadMigration.swift",
  "ServicePayloadInstaller.swift",
].map(native);
const canonicalArm =
  '{"authorizationFormatVersion":1,"candidateBindingScope":"authenticated-candidate-capture","candidateBindingVersion":1,"digestAlgorithm":"sha256","envelopePolicyDigest":"4869431c87452a2a378b72ac62e018bca62d60caadef2f65bdfed50d70a16cb5","launcherVerification":"full-candidate-and-installed-role-v1","payloadPolicyDigest":"8018ebd7d746542ef0a42cb70a0a0fad41f8218189c8b44592f0b23029571783","publisherTeamID":"ABCDEFGHIJ","receiptVersion":2,"roles":[{"bundleIdentifier":"org.ellie.assistant.coordinator.app","name":"coordinator"},{"bundleIdentifier":"org.ellie.assistant.node.app","name":"node"}],"scope":"authenticated-service-activation","selectionJournalVersion":2,"version":1}\n';
const armDigest = "3497bc3e451d746bdbc0241fdef8cd93e262448811a96dacd41d8c6b3ddae064";
const validProbe = Buffer.from(`${canonicalArm}${armDigest}\n`);
const loaderProbeSource = `import Foundation
@main struct LoaderProbe { static func main() {
  do {
    guard let policy = try compiledActivationPolicy() else { exit(78) }
    FileHandle.standardOutput.write(policy.data)
    print(policy.trustedPolicyDigest)
  } catch { exit(78) }
} }
`;

async function compile(output: string, sources: string[], definitions: string[] = []) {
  await runActivationPolicyBuildCommand(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-O",
      "-parse-as-library",
      "-suppress-warnings",
      ...definitions.flatMap((value) => ["-D", value]),
      "-Xlinker",
      "-dead_strip",
      "-I",
      native(""),
      ...sources,
      "-o",
      output,
    ],
    { cwd: dirname(output) },
  );
}

async function compileBlob(source: string, output: string, architecture = hostArchitecture) {
  await runActivationPolicyBuildCommand(
    "/usr/bin/xcrun",
    [
      "clang",
      "-c",
      "-Os",
      "-target",
      `${architecture === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`,
      "-I",
      native(""),
      source,
      "-o",
      output,
    ],
    { cwd: dirname(output) },
  );
}

function auditOpcode(binary: string) {
  return spawnSync(binary, ["test-compiled-activation-policy"], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    killSignal: "SIGKILL",
  });
}

test(
  "configured and unavailable blobs are the sole policy representation in three optimized binaries",
  { skip: !mac, timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ellie-policy-blob-"));
    let completed = false;
    t.after(async () => {
      if (completed) await rm(root, { recursive: true });
    });
    const first = join(root, "first.c");
    const arm = await generateActivationPolicySource({
      source: repository,
      output: first,
      publisherTeamID: "ABCDEFGHIJ",
      architecture: hostArchitecture,
    });
    if (hostArchitecture === "arm64") {
      assert.deepEqual(arm.data, Buffer.from(canonicalArm));
      assert.equal(arm.digest, armDigest);
    }
    assert.doesNotMatch(arm.source, /publisherTeamID|trustedPolicyDigest/);
    const object = join(root, "policy.o");
    await compileBlob(first, object);
    const installer = join(root, "installer");
    await compile(installer, [object, loader, ...installerSources]);
    const binaries = [installer];
    for (const [role, define] of [
      ["coordinator", "ELLIE_COORDINATOR"],
      ["node", "ELLIE_NODE"],
    ] as const) {
      const binary = join(root, role);
      await compile(
        binary,
        [object, ...installerSources, loader, native("PackagedServiceLauncher.swift")],
        [define, "ELLIE_POLICY_LIBRARY"],
      );
      binaries.push(binary);
    }
    for (const binary of binaries) {
      assert.deepEqual(
        await inspectActivationPolicyBlob(binary, hostArchitecture, arm.data),
        arm.data,
      );
      const bytes = await readFile(binary);
      assert.equal(bytes.indexOf(arm.data), bytes.lastIndexOf(arm.data));
      const result = auditOpcode(binary);
      assert.equal(result.stdout, "");
      assert.ok(result.status === 1 || result.status === 78);
    }
    const loaderMain = join(root, "LoaderMain.swift");
    await writeFile(loaderMain, loaderProbeSource);
    const loaderProbe = join(root, "loader-probe");
    await compile(
      loaderProbe,
      [object, ...installerSources, loader, loaderMain],
      ["ELLIE_POLICY_LIBRARY"],
    );
    assert.deepEqual(
      await runActivationPolicyBuildCommand(loaderProbe, [], { cwd: root }),
      Buffer.from(`${arm.data.toString()}${arm.digest}\n`),
    );
    await assert.rejects(() =>
      inspectActivationPolicyBlob(
        installer,
        hostArchitecture,
        Buffer.concat([Buffer.from("x"), arm.data.subarray(1)]),
      ),
    );
    const tamperedSource = join(root, "tampered-source.c");
    const tamperedText = arm.source.replace("0x7b,", "0x7c,");
    assert.notEqual(tamperedText, arm.source);
    await writeFile(tamperedSource, tamperedText, { mode: 0o600 });
    const tamperedObject = join(root, "tampered-source.o");
    await compileBlob(tamperedSource, tamperedObject);
    const tamperedLoader = join(root, "tampered-loader");
    await compile(
      tamperedLoader,
      [tamperedObject, ...installerSources, loader, loaderMain],
      ["ELLIE_POLICY_LIBRARY"],
    );
    await assert.rejects(() => runActivationPolicyBuildCommand(tamperedLoader, [], { cwd: root }));
    const unavailableSource = join(root, "unavailable.c");
    await writeFile(unavailableSource, unavailableActivationPolicySource(), { mode: 0o600 });
    const unavailableObject = join(root, "unavailable.o");
    await compileBlob(unavailableSource, unavailableObject);
    const unavailable = join(root, "unavailable");
    await compile(
      unavailable,
      [unavailableObject, ...installerSources, loader, native("PackagedServiceLauncher.swift")],
      ["ELLIE_COORDINATOR", "ELLIE_POLICY_LIBRARY"],
    );
    const unavailableBytes = Buffer.from("ELLIE-ACTIVATION-POLICY-UNAVAILABLE-V1\n");
    assert.deepEqual(
      await inspectActivationPolicyBlob(unavailable, hostArchitecture, unavailableBytes),
      unavailableBytes,
    );
    const unavailableProbe = join(root, "unavailable-probe");
    await compile(
      unavailableProbe,
      [unavailableObject, ...installerSources, loader, loaderMain],
      ["ELLIE_POLICY_LIBRARY"],
    );
    await assert.rejects(() =>
      runActivationPolicyBuildCommand(unavailableProbe, [], { cwd: root }),
    );
    assert.equal(auditOpcode(unavailable).status, 78);
    completed = true;
  },
);

test(
  "runtime loader refuses canonical policy bytes for the other architecture",
  { skip: !mac, timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ellie-policy-opposite-"));
    let completed = false;
    t.after(async () => {
      if (completed) await rm(root, { recursive: true });
    });
    const opposite = hostArchitecture === "arm64" ? "x64" : "arm64";
    const policySource = join(root, "opposite.c");
    await generateActivationPolicySource({
      source: repository,
      output: policySource,
      publisherTeamID: "ABCDEFGHIJ",
      architecture: opposite,
    });
    const object = join(root, "opposite.o");
    await compileBlob(policySource, object, hostArchitecture);
    const main = join(root, "LoaderMain.swift");
    await writeFile(main, loaderProbeSource);
    const probe = join(root, "loader-probe");
    await compile(probe, [object, ...installerSources, loader, main], ["ELLIE_POLICY_LIBRARY"]);
    await assert.rejects(() => runActivationPolicyBuildCommand(probe, [], { cwd: root }));
    assert.equal(auditOpcode(probe).status, 78);
    completed = true;
  },
);

test(
  "blob generation is deterministic, exclusive, and bound to Team ID and architecture",
  { skip: !mac, timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ellie-policy-generate-"));
    let completed = false;
    t.after(async () => {
      if (completed) await rm(root, { recursive: true });
    });
    const first = await generateActivationPolicySource({
      source: repository,
      output: join(root, "first.c"),
      publisherTeamID: "ABCDEFGHIJ",
      architecture: hostArchitecture,
    });
    const second = await generateActivationPolicySource({
      source: repository,
      output: join(root, "second.c"),
      publisherTeamID: "ABCDEFGHIJ",
      architecture: hostArchitecture,
    });
    assert.equal(first.source, second.source);
    const x64 = await generateActivationPolicySource({
      source: repository,
      output: join(root, "x64.c"),
      publisherTeamID: "ABCDEFGHIJ",
      architecture: "x64",
    });
    assert.equal(
      x64.payloadPolicyDigest,
      "1e70693bf0d7d7ec7193903287ed19e6dcbcd2499cf9fb57d85f8e3c2a9008dd",
    );
    assert.equal(x64.digest, "d4f01560545cdf7d2f41a008965a8e4c911d0bf67af2ee9ecf9f065171966d9c");
    const changed = await generateActivationPolicySource({
      source: repository,
      output: join(root, "changed.c"),
      publisherTeamID: "ABCDEFGHIK",
      architecture: "arm64",
    });
    assert.equal(
      changed.envelopePolicyDigest,
      "9ed2a28e6efc741943ece3ebf1b0c5f43596aaa62f6e9713dc58c09eac52f6d2",
    );
    assert.equal(
      changed.digest,
      "3a6b61ac7577076e46d658ef6fa9d674dde4a01685302cbf40cbb6e062aa7686",
    );
    const race = join(root, "race.c");
    const outcomes = await Promise.allSettled([
      generateActivationPolicySource({
        source: repository,
        output: race,
        publisherTeamID: "ABCDEFGHIJ",
        architecture: hostArchitecture,
      }),
      generateActivationPolicySource({
        source: repository,
        output: race,
        publisherTeamID: "ABCDEFGHIJ",
        architecture: hostArchitecture,
      }),
    ]);
    assert.deepEqual(outcomes.map((value) => value.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(await readFile(race, "utf8"), first.source);
    completed = true;
  },
);

test(
  "Mach-O policy audit rejects malformed binary structure and wrong architecture",
  { skip: !mac, timeout: 120_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ellie-policy-macho-"));
    let completed = false;
    t.after(async () => {
      if (completed) await rm(root, { recursive: true });
    });
    const source = join(root, "policy.c");
    const policy = await generateActivationPolicySource({
      source: repository,
      output: source,
      publisherTeamID: "ABCDEFGHIJ",
      architecture: hostArchitecture,
    });
    const object = join(root, "policy.o");
    await compileBlob(source, object);
    const binary = join(root, "binary");
    await compile(
      binary,
      [object, ...installerSources, loader, native("PackagedServiceLauncher.swift")],
      ["ELLIE_COORDINATOR", "ELLIE_POLICY_LIBRARY"],
    );
    await assert.rejects(() =>
      inspectActivationPolicyBlob(
        binary,
        hostArchitecture === "arm64" ? "x64" : "arm64",
        policy.data,
      ),
    );
    const bytes = await readFile(binary);
    const policyOffset = bytes.indexOf(policy.data);
    assert.ok(policyOffset > 0);
    for (const [name, mutate] of [
      ["truncated", (value: Buffer) => value.subarray(0, policyOffset + 4)],
      [
        "wrong-cpu",
        (value: Buffer) => {
          const copy = Buffer.from(value);
          copy.writeUInt32LE(hostArchitecture === "arm64" ? 0x01000007 : 0x0100000c, 4);
          return copy;
        },
      ],
      [
        "tampered",
        (value: Buffer) => {
          const copy = Buffer.from(value);
          copy[policyOffset] = copy[policyOffset]! ^ 1;
          return copy;
        },
      ],
      [
        "duplicate",
        (value: Buffer) => {
          const copy = Buffer.from(value);
          const at = copy.indexOf(Buffer.from("__cstring\0"));
          assert.ok(at > 0);
          Buffer.from("__ellie_policy\0").copy(copy, at);
          return copy;
        },
      ],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, mutate(bytes), { mode: 0o700 });
      await assert.rejects(() => inspectActivationPolicyBlob(path, hostArchitecture, policy.data));
    }
    completed = true;
  },
);

test(
  "parser, child bounds, unsafe sources, and development builder authority fail closed",
  { timeout: 30_000 },
  async (t) => {
    for (const value of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), validProbe]),
      Buffer.concat([validProbe, Buffer.from("\n")]),
      Buffer.from(validProbe.toString().replace("\n", "\r\n")),
      Buffer.from(validProbe.toString().replace(armDigest, "g".repeat(64))),
      Buffer.from(validProbe.toString().replace('"version":1', '"version":1,"version":1')),
      Buffer.from(validProbe.toString().replace('"version":1', '"unknown":1,"version":1')),
      Buffer.from(validProbe.toString().replace('"roles":', '"roles" :')),
    ])
      assert.throws(() => parseActivationPolicyProbe(value, "ABCDEFGHIJ"));
    const root = await mkdtemp(join(tmpdir(), "ellie-policy-refuse-"));
    let completed = false;
    t.after(async () => {
      if (completed) await rm(root, { recursive: true });
    });
    for (const [team, architecture] of [
      ["", "arm64"],
      ["ABCDEFGHI", "arm64"],
      ["ABCDEFGHIJ\n", "arm64"],
      ["ABCDEFGHIJ\r\n", "arm64"],
      ["ABCDEFGHÉJ", "arm64"],
      ["ABCDEFGHIJ", "ARM64"],
    ] as const)
      await assert.rejects(() =>
        generateActivationPolicySource({
          source: repository,
          output: join(root, `${team.length}-${architecture}.c`),
          publisherTeamID: team,
          architecture: architecture as "arm64",
        }),
      );
    assert.deepEqual(await readdir(root), []);
    const preexisting = join(root, "preexisting.c");
    await writeFile(preexisting, "foreign");
    await assert.rejects(() =>
      generateActivationPolicySource({
        source: repository,
        output: preexisting,
        publisherTeamID: "ABCDEFGHIJ",
        architecture: "arm64",
      }),
    );
    assert.equal(await readFile(preexisting, "utf8"), "foreign");
    const linked = join(root, "linked.c");
    await symlink(join(root, "target"), linked);
    await assert.rejects(() =>
      generateActivationPolicySource({
        source: repository,
        output: linked,
        publisherTeamID: "ABCDEFGHIJ",
        architecture: "arm64",
      }),
    );
    await rm(linked);
    const run = (code: string, options = {}) =>
      runActivationPolicyBuildCommand(process.execPath, ["-e", code], {
        cwd: root,
        timeoutMs: 5_000,
        maximumOutputBytes: 32,
        ...options,
      });
    assert.deepEqual(await run('process.stdout.write("ok")'), Buffer.from("ok"));
    await assert.rejects(() => run("process.exit(2)"));
    await assert.rejects(() => run('process.stderr.write("no")'));
    await assert.rejects(() => run('process.stdout.write("x".repeat(33))'));
    const ready = join(root, "ready"),
      started = performance.now();
    await assert.rejects(() =>
      run(
        `process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(${JSON.stringify(ready)},"ready",{flag:"wx",mode:0o600});setTimeout(()=>process.exit(0),10000)`,
        { timeoutMs: 1_000 },
      ),
    );
    assert.equal(await readFile(ready, "utf8"), "ready");
    assert.ok(performance.now() - started < 7_000);
    const hostile = join(root, "hostile/packages/macos/native");
    await mkdir(hostile, { recursive: true });
    for (const path of installerSources)
      await copyFile(path, join(hostile, path.split("/").at(-1)!));
    const first = join(hostile, "ServicePayloadAuthorization.swift");
    await rm(first);
    await symlink(native("ServicePayloadAuthorization.swift"), first);
    await assert.rejects(() =>
      generateActivationPolicySource({
        source: join(root, "hostile"),
        output: join(root, "bad.c"),
        publisherTeamID: "ABCDEFGHIJ",
        architecture: "arm64",
      }),
    );
    await rm(first);
    await writeFile(first, "x");
    await truncate(first, 2 * 1024 * 1024 + 1);
    await assert.rejects(() =>
      generateActivationPolicySource({
        source: join(root, "hostile"),
        output: join(root, "large.c"),
        publisherTeamID: "ABCDEFGHIJ",
        architecture: "arm64",
      }),
    );
    await assert.rejects(() => buildServicePayload({ publisherTeamID: "ABCDEFGHIJ" } as never));
    await assert.rejects(() => buildPackagedLaunchers({ policySource: "foreign.c" } as never));
    assert.ok((await stat(root)).isDirectory());
    completed = true;
  },
);
