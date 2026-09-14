import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const mac = process.platform === "darwin";
const native = (name: string) =>
  new URL(`../packages/macos/native/${name}`, import.meta.url).pathname;
const sources = [
  native("ServicePayloadAuthorization.swift"),
  native("ServicePayloadAuthenticatedInspection.swift"),
  native("AuthenticatedCandidateVerifier.swift"),
  native("ServicePayloadCapture.swift"),
  native("ServicePayloadSelection.swift"),
  native("ServicePayloadLifecycle.swift"),
  native("ServicePayloadMigration.swift"),
  native("ServicePayloadInstaller.swift"),
];
const expectedFailure =
  "Ellie could not capture this authenticated service candidate; existing candidates were preserved.\n";
const bounded = { timeout: 15_000, maxBuffer: 1024 * 1024, stdio: "pipe" as const };
const teamID = "ABCDEFGHIJ";
const sha256 = (value: NodeJS.ArrayBufferView) => createHash("sha256").update(value).digest("hex");
const canonicalJSON = (value: Record<string, unknown>) =>
  `${JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))}\n`;

function compile(output: string, testing: boolean) {
  const flags = testing
    ? [
        "-D",
        "ELLIE_INSTALLER_TESTING",
        "-D",
        "ELLIE_AUTHORIZATION_TESTING",
        "-D",
        "ELLIE_AUTHENTICATED_PAYLOAD_TESTING",
      ]
    : [];
  execFileSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-parse-as-library",
      ...flags,
      ...sources,
      "-framework",
      "Security",
      "-o",
      output,
    ],
    { timeout: 60_000, stdio: "pipe" },
  );
}

async function payloadFiles(root: string, current = root): Promise<object[]> {
  const result: object[] = [];
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const info = await lstat(path);
    if (info.isDirectory()) result.push(...(await payloadFiles(root, path)));
    else {
      const relative = path.slice(root.length + 1);
      const bytes = await readFile(path);
      result.push({
        path: relative,
        mode: info.mode & 0o111 ? 0o755 : 0o644,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
  }
  return result;
}

async function syncTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory()) for (const name of await readdir(path)) await syncTree(join(path, name));
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeOwned(root: string): Promise<void> {
  async function writable(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isDirectory()) {
      await chmod(path, 0o700);
      for (const name of await readdir(path)) await writable(join(path, name));
    } else if (!info.isSymbolicLink()) await chmod(path, 0o600);
  }
  await writable(root);
  await rm(root, { recursive: true });
}

async function signedFixture(root: string, installer: string) {
  const release = join(root, "release");
  const payload = join(release, "payload");
  await mkdir(join(payload, "bin"), { recursive: true, mode: 0o755 });
  await mkdir(join(payload, "helpers"), { mode: 0o755 });
  await mkdir(join(payload, "lib/ellie/apps/cli/src"), { recursive: true, mode: 0o755 });
  const tinySource = join(root, "tiny.swift");
  const tiny = join(root, "tiny");
  await writeFile(tinySource, "@main struct Tiny { static func main() {} }\n", { mode: 0o600 });
  execFileSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", tinySource, "-o", tiny], bounded);
  await cp(installer, join(payload, "bin/ellie-service-installer"));
  await cp(tiny, join(payload, "bin/node"));
  await cp(tiny, join(payload, "helpers/ellie-macos"));
  await writeFile(join(payload, "lib/ellie/apps/cli/src/main.ts"), "export {};\n", { mode: 0o644 });
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const nodeEntitlements = join(root, "node-entitlements.plist");
  await writeFile(
    nodeEntitlements,
    '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>',
  );
  for (const [path, identifier, entitlements] of [
    ["bin/node", "org.ellie.runtime.node", nodeEntitlements],
    ["bin/ellie-service-installer", "org.ellie.installer", ""],
    ["helpers/ellie-macos", "org.ellie.helper", ""],
  ] as const) {
    const args = ["--force", "--sign", "-", "--options", "runtime", "--identifier", identifier];
    if (entitlements) args.push("--entitlements", entitlements);
    args.push(join(payload, path));
    execFileSync("/usr/bin/codesign", args, bounded);
  }
  const nativeCode: object[] = [
    {
      path: "bin/node",
      kind: "executable",
      identifier: "org.ellie.runtime.node",
      machOPaths: ["bin/node"],
      entitlements: {
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.cs.allow-unsigned-executable-memory": true,
      },
    },
    {
      path: "bin/ellie-service-installer",
      kind: "executable",
      identifier: "org.ellie.installer",
      machOPaths: ["bin/ellie-service-installer"],
      entitlements: {},
    },
    {
      path: "helpers/ellie-macos",
      kind: "executable",
      identifier: "org.ellie.helper",
      machOPaths: ["helpers/ellie-macos"],
      entitlements: {},
    },
  ];
  for (const [name, identifier] of [
    ["Ellie Coordinator", "org.ellie.assistant.coordinator.app"],
    ["Ellie Node", "org.ellie.assistant.node.app"],
  ] as const) {
    const app = join(payload, "launchers", `${name}.app`);
    await mkdir(join(app, "Contents/MacOS"), { recursive: true, mode: 0o755 });
    await cp(tiny, join(app, "Contents/MacOS/EllieService"));
    await writeFile(
      join(app, "Contents/Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>EllieService</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
    execFileSync(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--options", "runtime", "--identifier", identifier, app],
      bounded,
    );
    nativeCode.push({
      path: `launchers/${name}.app`,
      kind: "bundle",
      identifier,
      machOPaths: [`launchers/${name}.app/Contents/MacOS/EllieService`],
      entitlements: {},
    });
  }
  const revision = "a".repeat(40);
  const runtimeHash = "b".repeat(64);
  const manifest: Record<string, unknown> = {
    version: 2,
    productVersion: "0.1.0",
    sourceRevision: revision,
    sourceModified: false,
    platform: "darwin",
    architecture,
    minimumOS: "14.0",
    lockSha256: "c".repeat(64),
    buildTools: { node: "24.21.0", bun: "1.4.2" },
    runtime: {
      version: "v24.21.0",
      architecture,
      archive: `node-v24.21.0-darwin-${architecture}.tar.xz`,
      sha256: runtimeHash,
      source: `https://nodejs.org/download/release/v24.21.0/node-v24.21.0-darwin-${architecture}.tar.xz`,
      checksums: "https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt",
      license: "https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE",
    },
    helper: {
      identifier: "org.ellie.helper",
      signature: "developer-id",
      architecture,
      minimumOS: "14.0",
    },
    launchers: ["coordinator", "node"].map((role, index) => ({
      role,
      name: index ? "Ellie Node" : "Ellie Coordinator",
      identifier: index ? "org.ellie.assistant.node.app" : "org.ellie.assistant.coordinator.app",
      signature: "developer-id",
      architecture,
      minimumOS: "14.0",
    })),
    components: [{ name: "example-package", version: "1.0.0", license: "MIT", files: ["LICENSE"] }],
    nativeCode,
    files: await payloadFiles(payload),
  };
  const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const sourceData = Buffer.from(
    `Ellie service payload\nSource revision: ${revision}\nNode.js: v24.21.0\nNode archive SHA-256: ${runtimeHash}\nMinimum macOS: 14.0\nPolicy: authenticated-payload-v1\n`,
  );
  await writeFile(join(release, "manifest.json"), manifestData, { mode: 0o644 });
  await writeFile(join(release, "SOURCE.txt"), sourceData, { mode: 0o644 });
  const app = join(root, "Ellie Service Authorization.app");
  const resources = join(app, "Contents/Resources");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true, mode: 0o755 });
  await mkdir(resources, { mode: 0o755 });
  await cp(tiny, join(app, "Contents/MacOS/EllieServiceAuthorization"));
  await writeFile(
    join(app, "Contents/Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.ellie.service.authorization</string><key>CFBundleExecutable</key><string>EllieServiceAuthorization</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
  );
  const requirement = `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamID}" and identifier "org.ellie.service.authorization"`;
  const policyDigest = sha256(
    Buffer.from(
      canonicalJSON({
        authorizationIdentifier: "org.ellie.service.authorization",
        authorizationVersion: 1,
        digestAlgorithm: "sha256",
        payloadVerification: "not-performed",
        requiredResources: ["SOURCE.txt", "authorization.json", "manifest.json"],
        requirement,
        scope: "manifest-envelope",
        signatureSemantics: "security-framework-strict-all-architectures",
        teamID,
      }),
    ),
  );
  await writeFile(join(resources, "manifest.json"), manifestData);
  await writeFile(join(resources, "SOURCE.txt"), sourceData);
  await writeFile(
    join(resources, "authorization.json"),
    canonicalJSON({
      manifestSHA256: sha256(manifestData),
      policyDigest,
      sourceSHA256: sha256(sourceData),
      version: 1,
    }),
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--sign", "-", "--identifier", "org.ellie.service.authorization", app],
    bounded,
  );
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", app], bounded);
  await syncTree(release);
  await syncTree(app);
  return { release, authorization: app };
}

test("capture grammar is closed before the services root is accessed", { skip: !mac }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-capture-grammar-"));
  let complete = false;
  try {
    const installer = join(root, "installer");
    const services = join(root, "Services-that-must-not-exist");
    compile(installer, true);
    const cases = [
      [
        "capture-authenticated-payload",
        "relative",
        "/authorization",
        "--publisher-team-id",
        "ABCDEFGHIJ",
        "--test-services-root",
        services,
      ],
      [
        "capture-authenticated-payload",
        "/release",
        "/authorization",
        "--publisher-team-id",
        "abcdefghij",
        "--test-services-root",
        services,
      ],
      [
        "capture-authenticated-payload",
        "/release",
        "/authorization",
        "--publisher-team-id",
        "ABCDEFGHIJ",
        "--publisher-team-id",
        "ABCDEFGHIJ",
        "--test-services-root",
        services,
      ],
      [
        "recover-authenticated-capture",
        ".capture-AAAAAAAA-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "--publisher-team-id",
        "ABCDEFGHIJ",
        "--test-services-root",
        services,
      ],
      [
        "recover-authenticated-capture",
        "A".repeat(64),
        "--publisher-team-id",
        "ABCDEFGHIJ",
        "--test-services-root",
        services,
      ],
    ];
    for (const args of cases) {
      const result = spawnSync(installer, args, { encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 1);
      assert.equal(result.signal, null);
      assert.match(
        result.stderr,
        new RegExp(
          `^${expectedFailure.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}Ellie capture test diagnostic: category=argument-validation\\n$`,
        ),
      );
      await assert.rejects(lstat(services), { code: "ENOENT" });
    }
    await mkdir(services, { mode: 0o700 });
    const missing = spawnSync(
      installer,
      [
        "recover-authenticated-capture",
        "0".repeat(64),
        "--publisher-team-id",
        teamID,
        "--test-services-root",
        services,
      ],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(missing.status, 1);
    assert.equal(missing.signal, null);
    await assert.rejects(lstat(join(services, "authenticated-candidates")), { code: "ENOENT" });
    complete = true;
  } finally {
    if (complete) await rm(root, { recursive: true });
  }
});

test("shipping capture rejects test-only services-root authority", { skip: !mac }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-capture-shipping-"));
  let complete = false;
  try {
    const installer = join(root, "installer");
    const services = join(root, "Services-that-must-not-exist");
    compile(installer, false);
    for (const selector of [
      ["--test-services-root", services],
      ["--test-capture-fault", "after-stage-creation"],
      ["--test-hold-capture-lock-ms", "100"],
      ["--test-mutate-release-after-inspection"],
      ["--test-mutate-authorization-after-inspection"],
    ]) {
      const result = spawnSync(
        installer,
        [
          "recover-authenticated-capture",
          "0".repeat(64),
          "--publisher-team-id",
          "ABCDEFGHIJ",
          ...selector,
        ],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(result.status, 1);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, expectedFailure);
    }
    await assert.rejects(lstat(services), { code: "ENOENT" });
    complete = true;
  } finally {
    if (complete) await rm(root, { recursive: true });
  }
});

test(
  "authenticated capture publishes exact immutable topology, is idempotent, and recovers named states",
  { skip: !mac, timeout: 60_000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-capture-success-")));
    let complete = false;
    try {
      const installer = join(root, "installer");
      compile(installer, true);
      const services = join(root, "Services");
      await mkdir(services, { mode: 0o700 });
      const fixture = await signedFixture(root, installer);
      const captureArgs = [
        "capture-authenticated-payload",
        fixture.release,
        fixture.authorization,
        "--publisher-team-id",
        teamID,
        "--test-services-root",
        services,
      ];
      const inspected = spawnSync(
        installer,
        [
          "inspect-authenticated-payload",
          fixture.release,
          fixture.authorization,
          "--publisher-team-id",
          teamID,
          "--test-allow-sealed-adhoc",
        ],
        { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(inspected.status, 0, inspected.stderr);
      const first = spawnSync(installer, captureArgs, {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.signal, null);
      const candidateID = first.stdout.match(/Authenticated candidate ([a-f0-9]{64})/)?.[1];
      assert.ok(candidateID);
      const namespace = join(services, "authenticated-candidates");
      const candidate = join(namespace, candidateID);
      assert.equal((await stat(namespace)).mode & 0o7777, 0o700);
      assert.deepEqual((await readdir(candidate)).sort(), [
        "authorization",
        "binding.json",
        "release",
      ]);
      assert.equal((await stat(candidate)).mode & 0o7777, 0o555);
      assert.equal((await stat(join(candidate, "binding.json"))).mode & 0o7777, 0o444);
      assert.equal((await stat(join(candidate, "release/payload/bin/node"))).mode & 0o7777, 0o555);
      assert.equal((await stat(join(candidate, "release/manifest.json"))).mode & 0o7777, 0o444);
      assert.equal(
        (
          await stat(
            join(
              candidate,
              "authorization/Ellie Service Authorization.app/Contents/MacOS/EllieServiceAuthorization",
            ),
          )
        ).mode & 0o7777,
        0o555,
      );
      const second = spawnSync(installer, captureArgs, {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(second.status, 0, second.stderr);
      assert.equal(
        (await readdir(namespace)).filter((name) => name.startsWith(".capture-")).length,
        0,
      );
      for (let index = 0; index < 32; index += 1)
        await mkdir(join(namespace, `.capture-${randomUUID()}`), { mode: 0o700 });
      const fullCapacity = spawnSync(installer, captureArgs, {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(fullCapacity.status, 0, fullCapacity.stderr);
      assert.equal(
        (await readdir(namespace)).filter((name) => name.startsWith(".capture-")).length,
        32,
      );
      for (const name of await readdir(namespace))
        if (name.startsWith(".capture-")) await rm(join(namespace, name), { recursive: true });

      await chmod(candidate, 0o700);
      const postRename = spawnSync(
        installer,
        [
          "recover-authenticated-capture",
          candidateID,
          "--publisher-team-id",
          teamID,
          "--test-services-root",
          services,
        ],
        { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(postRename.status, 0, postRename.stderr);
      assert.equal((await stat(candidate)).mode & 0o7777, 0o555);

      const stage = `.capture-${randomUUID()}`;
      await chmod(candidate, 0o700);
      await import("node:fs/promises").then(({ rename }) =>
        rename(candidate, join(namespace, stage)),
      );
      const preRename = spawnSync(
        installer,
        [
          "recover-authenticated-capture",
          stage,
          "--publisher-team-id",
          teamID,
          "--test-services-root",
          services,
        ],
        { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(preRename.status, 0, preRename.stderr);
      assert.equal((await stat(candidate)).mode & 0o7777, 0o555);

      const bindingPath = join(candidate, "binding.json");
      const canonicalBinding = await readFile(bindingPath);
      const binding = JSON.parse(canonicalBinding.toString()) as Record<string, unknown>;
      const mutations: Buffer[] = [
        Buffer.from(`${JSON.stringify({ ...binding, scope: "wrong" })}\n`),
        Buffer.from(`${JSON.stringify({ unknown: true, ...binding })}\n`),
        Buffer.from(`{"version":1,"version":1}\n`),
        Buffer.from(JSON.stringify(binding)),
      ];
      for (const mutation of mutations) {
        await chmod(candidate, 0o700);
        await chmod(bindingPath, 0o600);
        await writeFile(bindingPath, mutation);
        await chmod(bindingPath, 0o444);
        await chmod(candidate, 0o555);
        const rejected = spawnSync(installer, captureArgs, {
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        });
        assert.equal(rejected.status, 1);
        assert.equal(rejected.signal, null);
        assert.match(rejected.stderr, /^Ellie authenticated candidate capture requires recovery/);
        await chmod(candidate, 0o700);
        await chmod(bindingPath, 0o600);
        await writeFile(bindingPath, canonicalBinding);
        await chmod(bindingPath, 0o444);
        await chmod(candidate, 0o555);
      }

      const home = join(root, "selection-home");
      await mkdir(join(home, "Library/Application Support/Ellie/Services"), {
        recursive: true,
        mode: 0o700,
      });
      for (const releaseID of [
        candidateID,
        "0.1.0-" + "a".repeat(40) + `-${process.arch === "arm64" ? "arm64" : "x64"}`,
      ]) {
        const refused = spawnSync(
          installer,
          ["select", releaseID, "--roles", "node", "--test-home-root", home],
          { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
        );
        assert.equal(refused.status, 1);
        assert.equal(refused.signal, null);
      }
      complete = true;
    } finally {
      if (complete) await removeOwned(root);
    }
  },
);

test(
  "capture fault states retain exact evidence and support only named complete recovery",
  { skip: !mac, timeout: 60_000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-capture-faults-")));
    let complete = false;
    try {
      const installer = join(root, "installer");
      compile(installer, true);
      const fixture = await signedFixture(root, installer);
      const points = [
        "after-stage-creation",
        "after-child-sealing",
        "after-binding-fsync",
        "before-rename",
        "after-rename",
        "after-root-seal",
        "after-final-namespace-fsync",
      ];
      for (const point of points) {
        const services = join(root, point, "Services");
        await mkdir(services, { recursive: true, mode: 0o700 });
        const crashed = spawnSync(
          installer,
          [
            "capture-authenticated-payload",
            fixture.release,
            fixture.authorization,
            "--publisher-team-id",
            teamID,
            "--test-capture-fault",
            point,
            "--test-services-root",
            services,
          ],
          { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
        );
        assert.equal(crashed.status, 86, `${point}: ${crashed.stderr}`);
        assert.equal(crashed.signal, null);
        const namespace = join(services, "authenticated-candidates");
        const retained = (await readdir(namespace)).filter((name) => name !== ".capture.lock");
        assert.equal(retained.length, 1);
        const target = retained[0]!;
        const recovery = spawnSync(
          installer,
          [
            "recover-authenticated-capture",
            target,
            "--publisher-team-id",
            teamID,
            "--test-services-root",
            services,
          ],
          { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
        );
        if (point === "after-stage-creation" || point === "after-child-sealing") {
          assert.equal(recovery.status, 1);
          assert.ok((await readdir(namespace)).includes(target));
        } else {
          assert.equal(recovery.status, 0, `${point}: ${recovery.stderr}`);
          assert.equal(
            (await readdir(namespace)).filter((name) => /^[a-f0-9]{64}$/.test(name)).length,
            1,
          );
        }
      }
      complete = true;
    } finally {
      if (complete) await removeOwned(root);
    }
  },
);

test(
  "namespace scan rejects authorization type inversions and oversized retained evidence",
  { skip: !mac },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-capture-namespace-")));
    let complete = false;
    try {
      const installer = join(root, "installer");
      compile(installer, true);
      const target = "0".repeat(64);
      const runRecovery = (services: string) =>
        spawnSync(
          installer,
          [
            "recover-authenticated-capture",
            target,
            "--publisher-team-id",
            teamID,
            "--test-services-root",
            services,
          ],
          { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
        );
      for (const inversion of ["directory-as-file", "file-as-directory"] as const) {
        const services = join(root, inversion, "Services");
        const stage = join(services, "authenticated-candidates", `.capture-${randomUUID()}`);
        const contents = join(stage, "authorization/Ellie Service Authorization.app/Contents");
        await mkdir(contents, { recursive: true, mode: 0o700 });
        if (inversion === "directory-as-file")
          await writeFile(join(contents, "MacOS"), "x", { mode: 0o400 });
        else await mkdir(join(contents, "Info.plist"), { mode: 0o700 });
        const before = (await readdir(join(services, "authenticated-candidates"))).sort();
        const result = runRecovery(services);
        assert.equal(result.status, 1);
        assert.equal(result.signal, null);
        assert.match(result.stderr, /^Ellie could not capture/);
        assert.deepEqual(
          (await readdir(join(services, "authenticated-candidates"))).sort(),
          [".capture.lock", ...before].sort(),
        );
      }
      const services = join(root, "oversized", "Services");
      const stage = join(
        services,
        "authenticated-candidates",
        `.capture-${randomUUID()}`,
        "release",
      );
      await mkdir(stage, { recursive: true, mode: 0o700 });
      const large = join(stage, "manifest.json");
      await writeFile(large, "x", { mode: 0o600 });
      await truncate(large, 8 * 1024 * 1024 * 1024 + 1);
      await chmod(large, 0o400);
      const oversized = runRecovery(services);
      assert.equal(oversized.status, 1);
      assert.equal(oversized.signal, null);
      assert.equal((await stat(large)).size, 8 * 1024 * 1024 * 1024 + 1);
      complete = true;
    } finally {
      if (complete) await removeOwned(root);
    }
  },
);

test(
  "capture lock contention signals and reaps only the retained finite child",
  { skip: !mac },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-capture-lock-")));
    let complete = false;
    try {
      const installer = join(root, "installer");
      compile(installer, true);
      const services = join(root, "Services");
      await mkdir(services, { mode: 0o700 });
      await mkdir(join(services, "authenticated-candidates"), { mode: 0o700 });
      const base = ["recover-authenticated-capture", "0".repeat(64), "--publisher-team-id", teamID];
      const holder = spawn(
        installer,
        [...base, "--test-hold-capture-lock-ms", "1000", "--test-services-root", services],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const lockPath = join(services, "authenticated-candidates/.capture.lock");
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          await lstat(lockPath);
          break;
        } catch {
          if (attempt === 49) assert.fail("finite holder did not create its capture lock");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      const busy = spawnSync(installer, [...base, "--test-services-root", services], {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(busy.status, 1);
      assert.equal(busy.signal, null);
      assert.match(busy.stderr, /^Ellie authenticated candidate capture is busy/);
      const holderExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => holder.once("exit", (code, signal) => resolve({ code, signal })),
      );
      assert.equal(holderExit.code, 1);
      assert.equal(holderExit.signal, null);
      complete = true;
    } finally {
      if (complete) await removeOwned(root);
    }
  },
);

test(
  "capture rejects release and authorization changes after external authentication",
  { skip: !mac, timeout: 60_000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-capture-mutation-")));
    let complete = false;
    try {
      const installer = join(root, "installer");
      compile(installer, true);
      for (const flag of [
        "--test-mutate-release-after-inspection",
        "--test-mutate-authorization-after-inspection",
      ]) {
        const scenario = join(root, flag.slice(7));
        await mkdir(scenario, { mode: 0o700 });
        const fixture = await signedFixture(scenario, installer);
        const services = join(scenario, "Services");
        await mkdir(services, { mode: 0o700 });
        const result = spawnSync(
          installer,
          [
            "capture-authenticated-payload",
            fixture.release,
            fixture.authorization,
            "--publisher-team-id",
            teamID,
            flag,
            "--test-services-root",
            services,
          ],
          { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
        );
        assert.equal(result.status, 1);
        assert.equal(result.signal, null);
        const namespace = join(services, "authenticated-candidates");
        let missing = false;
        try {
          assert.equal(
            (await readdir(namespace)).filter((name) => name.startsWith(".capture-")).length,
            0,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true;
          else throw error;
        }
        assert.equal(
          missing || (await readdir(namespace)).every((name) => !name.startsWith(".capture-")),
          true,
        );
      }
      complete = true;
    } finally {
      if (complete) await removeOwned(root);
    }
  },
);
