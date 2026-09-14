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
import { join, resolve } from "node:path";
import test from "node:test";
import {
  activationPolicyAuditMatches,
  generateActivationPolicySource,
  parseActivationPolicyProbe,
  runActivationPolicyBuildCommand,
  unavailableActivationPolicySource,
} from "../scripts/activation-policy-source.mjs";
import { buildPackagedLaunchers, buildServicePayload } from "../scripts/build-service-payload.mjs";

const mac = process.platform === "darwin";
const repository = resolve(import.meta.dirname, "..");
const native = (name: string) => join(repository, "packages/macos/native", name);
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

async function compile(output: string, sources: string[], definitions: string[]) {
  await runActivationPolicyBuildCommand(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-parse-as-library",
      "-suppress-warnings",
      ...definitions.flatMap((value) => ["-D", value]),
      ...sources,
      "-o",
      output,
    ],
    { cwd: repository },
  );
}

function audit(binary: string) {
  return spawnSync(binary, ["test-compiled-activation-policy"], {
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
  });
}

test(
  "activation policy source is deterministic, exclusive, and identical in three binaries",
  { skip: !mac, timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ellie-policy-build-"));
    let completed = false;
    t.after(async () => {
      if (completed) await rm(root, { recursive: true });
    });
    const first = join(root, "first.swift");
    const second = join(root, "second.swift");
    const arm = await generateActivationPolicySource({
      source: repository,
      output: first,
      publisherTeamID: "ABCDEFGHIJ",
      architecture: "arm64",
    });
    const raceOutput = join(root, "race.swift");
    const raced = await Promise.allSettled([
      generateActivationPolicySource({
        source: repository,
        output: raceOutput,
        publisherTeamID: "ABCDEFGHIJ",
        architecture: "arm64",
      }),
      generateActivationPolicySource({
        source: repository,
        output: raceOutput,
        publisherTeamID: "ABCDEFGHIJ",
        architecture: "arm64",
      }),
    ]);
    assert.deepEqual(raced.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    const repeated = await generateActivationPolicySource({
      source: repository,
      output: second,
      publisherTeamID: "ABCDEFGHIJ",
      architecture: "arm64",
    });
    assert.equal(arm.source, repeated.source);
    assert.deepEqual(arm.data, repeated.data);
    assert.equal(arm.digest, "3497bc3e451d746bdbc0241fdef8cd93e262448811a96dacd41d8c6b3ddae064");
    assert.equal(
      arm.payloadPolicyDigest,
      "8018ebd7d746542ef0a42cb70a0a0fad41f8218189c8b44592f0b23029571783",
    );
    assert.match(
      arm.source,
      /envelopePolicyDigest = "4869431c87452a2a378b72ac62e018bca62d60caadef2f65bdfed50d70a16cb5"/,
    );
    assert.match(
      arm.source,
      /payloadPolicyDigest = "8018ebd7d746542ef0a42cb70a0a0fad41f8218189c8b44592f0b23029571783"/,
    );
    assert.equal((await stat(first)).mode & 0o7777, 0o600);
    const installer = join(root, "installer");
    await compile(installer, [first, ...installerSources], ["ELLIE_POLICY_AUDIT_TESTING"]);
    const outputs = [audit(installer).stdout];
    for (const [role, definition] of [
      ["coordinator", "ELLIE_COORDINATOR"],
      ["node", "ELLIE_NODE"],
    ] as const) {
      const binary = join(root, role);
      await compile(
        binary,
        [first, native("PackagedServiceLauncher.swift")],
        [definition, "ELLIE_POLICY_AUDIT_TESTING"],
      );
      outputs.push(audit(binary).stdout);
    }
    assert.deepEqual(outputs, [outputs[0], outputs[0], outputs[0]]);
    const header = `ABCDEFGHIJ|arm64|${arm.envelopePolicyDigest}|${arm.payloadPolicyDigest}|${arm.digest}\n`;
    assert.equal(outputs[0], `${header}${arm.data.toString()}${arm.digest}\n`);
    assert.equal(activationPolicyAuditMatches(outputs[0], arm, "ABCDEFGHIJ", "arm64"), true);
    for (const replacement of [
      outputs[0].replace("ABCDEFGHIJ", "ABCDEFGHIK"),
      outputs[0].replace("arm64", "x64"),
      outputs[0].replace(arm.envelopePolicyDigest, "0".repeat(64)),
      outputs[0].replace(arm.payloadPolicyDigest, "0".repeat(64)),
      outputs[0].replace(arm.digest, "0".repeat(64)),
    ])
      assert.equal(activationPolicyAuditMatches(replacement, arm, "ABCDEFGHIJ", "arm64"), false);
    const tamperedSource = join(root, "tampered.swift");
    await writeFile(
      tamperedSource,
      arm.source.replace(arm.data.toString("base64"), Buffer.from("changed\n").toString("base64")),
    );
    const tamperedLauncher = join(root, "tampered-launcher");
    await compile(
      tamperedLauncher,
      [tamperedSource, native("PackagedServiceLauncher.swift")],
      ["ELLIE_COORDINATOR", "ELLIE_POLICY_AUDIT_TESTING"],
    );
    assert.equal(
      activationPolicyAuditMatches(audit(tamperedLauncher).stdout, arm, "ABCDEFGHIJ", "arm64"),
      false,
    );
    const ordinaryInstaller = join(root, "ordinary-installer");
    await compile(ordinaryInstaller, [first, ...installerSources], []);
    const ordinaryInstallerAudit = audit(ordinaryInstaller);
    assert.equal(ordinaryInstallerAudit.status, 1);
    assert.equal(ordinaryInstallerAudit.stdout, "");
    for (const [role, definition] of [
      ["ordinary-coordinator", "ELLIE_COORDINATOR"],
      ["ordinary-node", "ELLIE_NODE"],
    ] as const) {
      const binary = join(root, role);
      await compile(binary, [first, native("PackagedServiceLauncher.swift")], [definition]);
      const result = audit(binary);
      assert.equal(result.status, 78);
      assert.equal(result.stdout, "");
    }
    await assert.rejects(() =>
      generateActivationPolicySource({
        source: repository,
        output: first,
        publisherTeamID: "ABCDEFGHIJ",
        architecture: "arm64",
      }),
    );
    const x64 = await generateActivationPolicySource({
      source: repository,
      output: join(root, "x64.swift"),
      publisherTeamID: "ABCDEFGHIJ",
      architecture: "x64",
    });
    assert.equal(
      x64.payloadPolicyDigest,
      "1e70693bf0d7d7ec7193903287ed19e6dcbcd2499cf9fb57d85f8e3c2a9008dd",
    );
    assert.equal(x64.digest, "d4f01560545cdf7d2f41a008965a8e4c911d0bf67af2ee9ecf9f065171966d9c");
    const changedTeam = await generateActivationPolicySource({
      source: repository,
      output: join(root, "changed-team.swift"),
      publisherTeamID: "ABCDEFGHIK",
      architecture: "arm64",
    });
    assert.equal(
      changedTeam.envelopePolicyDigest,
      "9ed2a28e6efc741943ece3ebf1b0c5f43596aaa62f6e9713dc58c09eac52f6d2",
    );
    assert.equal(
      changedTeam.payloadPolicyDigest,
      "18bc93c91a7a9b1b421a73845a9d3b7b95f7a827916827a95fda91bc25876bd3",
    );
    assert.equal(
      changedTeam.digest,
      "3a6b61ac7577076e46d658ef6fa9d674dde4a01685302cbf40cbb6e062aa7686",
    );
    await writeFile(join(root, "unavailable.swift"), unavailableActivationPolicySource(), {
      mode: 0o600,
    });
    const unavailable = join(root, "unavailable");
    await compile(
      unavailable,
      [join(root, "unavailable.swift"), native("PackagedServiceLauncher.swift")],
      ["ELLIE_COORDINATOR", "ELLIE_POLICY_AUDIT_TESTING"],
    );
    assert.equal(audit(unavailable).status, 78);
    assert.equal(audit(unavailable).stdout, "");
    for (const [name, sources, definitions] of [
      [
        "unavailable-installer",
        [join(root, "unavailable.swift"), ...installerSources],
        ["ELLIE_POLICY_AUDIT_TESTING"],
      ],
      [
        "unavailable-node",
        [join(root, "unavailable.swift"), native("PackagedServiceLauncher.swift")],
        ["ELLIE_NODE", "ELLIE_POLICY_AUDIT_TESTING"],
      ],
    ] as const) {
      const binary = join(root, name);
      await compile(binary, [...sources], [...definitions]);
      const result = audit(binary);
      assert.equal(result.status, 78);
      assert.equal(result.stdout, "");
    }
    completed = true;
  },
);

test("activation policy child runner settles bounded failure modes", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "ellie-policy-child-"));
  let completed = false;
  t.after(async () => {
    if (completed) await rm(fixture, { recursive: true });
  });
  const run = (source: string, options = {}) =>
    runActivationPolicyBuildCommand(process.execPath, ["-e", source], {
      cwd: fixture,
      timeoutMs: 5_000,
      maximumOutputBytes: 32,
      ...options,
    });
  assert.deepEqual(await run('process.stdout.write("ok")'), Buffer.from("ok"));
  await assert.rejects(() => run("process.exit(2)"));
  await assert.rejects(() => run('process.stderr.write("no")'));
  await assert.rejects(() => run('process.stdout.write("x".repeat(33))'));
  const ready = join(fixture, "ready");
  const started = performance.now();
  await assert.rejects(() =>
    run(
      `process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(${JSON.stringify(ready)},"ready",{flag:"wx",mode:0o600});setTimeout(()=>process.exit(0),10000)`,
      { timeoutMs: 1_000 },
    ),
  );
  assert.equal(await readFile(ready, "utf8"), "ready");
  assert.ok(performance.now() - started < 7_000);
  completed = true;
});

test("activation policy probe parser and audit reject malformed records", () => {
  const expected = parseActivationPolicyProbe(validProbe, "ABCDEFGHIJ");
  assert.equal(expected.digest, armDigest);
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
});

test(
  "activation policy generation rejects invalid input before compiler or output",
  { skip: !mac },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ellie-policy-invalid-"));
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
    ] as const) {
      await assert.rejects(() =>
        generateActivationPolicySource({
          source: repository,
          output: join(root, `${team.length}-${architecture}.swift`),
          publisherTeamID: team,
          architecture: architecture as "arm64",
        }),
      );
    }
    assert.deepEqual(await readdir(root), []);
    await assert.rejects(() =>
      generateActivationPolicySource({
        source: repository,
        output: join(root, "extra.swift"),
        publisherTeamID: "ABCDEFGHIJ",
        architecture: "arm64",
        extra: true,
      } as never),
    );
    await symlink(join(root, "target"), join(root, "linked.swift"));
    await assert.rejects(() =>
      generateActivationPolicySource({
        source: repository,
        output: join(root, "linked.swift"),
        publisherTeamID: "ABCDEFGHIJ",
        architecture: "arm64",
      }),
    );
    await rm(join(root, "linked.swift"));
    await assert.rejects(() => buildServicePayload({ publisherTeamID: "ABCDEFGHIJ" } as never));
    await assert.rejects(() => buildPackagedLaunchers({ policySource: "foreign.swift" } as never));
    const preexisting = join(root, "preexisting.swift");
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

    const hostile = join(root, "hostile");
    const hostileNative = join(hostile, "packages/macos/native");
    await mkdir(hostileNative, { recursive: true });
    for (const path of installerSources)
      await copyFile(path, join(hostileNative, path.split("/").at(-1)!));
    const firstSource = join(hostileNative, "ServicePayloadAuthorization.swift");
    await rm(firstSource);
    await symlink(native("ServicePayloadAuthorization.swift"), firstSource);
    await assert.rejects(() =>
      generateActivationPolicySource({
        source: hostile,
        output: join(root, "hostile.swift"),
        publisherTeamID: "ABCDEFGHIJ",
        architecture: "arm64",
      }),
    );
    await rm(firstSource);
    await writeFile(firstSource, "x");
    await truncate(firstSource, 2 * 1024 * 1024 + 1);
    await assert.rejects(() =>
      generateActivationPolicySource({
        source: hostile,
        output: join(root, "oversize.swift"),
        publisherTeamID: "ABCDEFGHIJ",
        architecture: "arm64",
      }),
    );
    completed = true;
  },
);
