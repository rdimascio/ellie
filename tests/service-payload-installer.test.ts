import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  readdir,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { MacOSServiceApplication } from "../apps/cli/src/service-application.ts";
import { servicePlist } from "../apps/cli/src/services.ts";

const mac = process.platform === "darwin";
const source = new URL("../packages/macos/native/ServicePayloadInstaller.swift", import.meta.url)
  .pathname;
const authorizationSource = new URL(
  "../packages/macos/native/ServicePayloadAuthorization.swift",
  import.meta.url,
).pathname;
const authenticatedPayloadSource = new URL(
  "../packages/macos/native/ServicePayloadAuthenticatedInspection.swift",
  import.meta.url,
).pathname;
const activationPolicySource = new URL(
  "../packages/macos/native/AuthenticatedActivationPolicy.swift",
  import.meta.url,
).pathname;
const candidateVerifierSource = new URL(
  "../packages/macos/native/AuthenticatedCandidateVerifier.swift",
  import.meta.url,
).pathname;
const captureSource = new URL(
  "../packages/macos/native/ServicePayloadCapture.swift",
  import.meta.url,
).pathname;
const selectionSource = new URL(
  "../packages/macos/native/ServicePayloadSelection.swift",
  import.meta.url,
).pathname;
const lifecycleSource = new URL(
  "../packages/macos/native/ServicePayloadLifecycle.swift",
  import.meta.url,
).pathname;
const migrationSource = new URL(
  "../packages/macos/native/ServicePayloadMigration.swift",
  import.meta.url,
).pathname;
const launcherSource = new URL(
  "../packages/macos/native/PackagedServiceLauncher.swift",
  import.meta.url,
).pathname;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const boundedCommand = { timeout: 15_000, stdio: "pipe" as const };
const sharedSetupTimeout = 120_000;
const sharedTemplateNames = [
  "build-key.json",
  "coordinator-launcher",
  "installer",
  "node-launcher",
  "tiny",
] as const;
type TemplateArtifact = {
  path: string;
  dev: bigint;
  ino: bigint;
  uid: number;
  mode: number;
  size: number;
  sha256: string;
};
type SharedTemplate = {
  root: string;
  rootDev: bigint;
  rootIno: bigint;
  rootUID: number;
  artifacts: Readonly<Record<string, Readonly<TemplateArtifact>>>;
};
type OwnedDirectoryIdentity = {
  dev: bigint;
  ino: bigint;
  uid: number;
};
let sharedTemplate: SharedTemplate | undefined;
let sharedSetupCertain = false;
function authorizationRequirement(teamID: string) {
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamID}" and identifier "org.ellie.service.authorization"`;
}
function mutateCodeResources(path: string, mode: "optional" | "unknown" | "hash2") {
  execFileSync(
    "/usr/bin/python3",
    [
      "-c",
      "import plistlib,sys\np=sys.argv[1];m=sys.argv[2]\nwith open(p,'rb') as f: v=plistlib.load(f)\ne=v['files2']['Resources/manifest.json']\nif m=='optional': e['optional']=True\nelif m=='unknown': v['files2']['Resources/unknown']=dict(e)\nelif m=='hash2': e['hash2']=bytes(32)\nwith open(p,'wb') as f: plistlib.dump(v,f)",
      path,
      mode,
    ],
    boundedCommand,
  );
}
function canonicalJSON(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, sorted(child)]),
      );
    return item;
  };
  return `${JSON.stringify(sorted(value))}\n`;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
async function templateArtifact(root: string, name: string): Promise<TemplateArtifact> {
  const path = join(root, name);
  const info = await lstat(path, { bigint: true });
  assert.equal(info.isFile(), true);
  assert.equal(info.nlink, 1n);
  assert.equal(Number(info.uid), process.getuid?.());
  return Object.freeze({
    path: name,
    dev: info.dev,
    ino: info.ino,
    uid: Number(info.uid),
    mode: Number(info.mode & 0o7777n),
    size: Number(info.size),
    sha256: digest(await readFile(path)),
  });
}
async function captureOwnedDirectory(path: string): Promise<OwnedDirectoryIdentity> {
  const info = await lstat(path, { bigint: true });
  assert.equal(info.isDirectory(), true);
  assert.equal(Number(info.uid), process.getuid?.());
  assert.equal(Number(info.mode & 0o7777n), 0o700);
  return Object.freeze({ dev: info.dev, ino: info.ino, uid: Number(info.uid) });
}
async function verifyOwnedDirectory(
  path: string,
  expected: OwnedDirectoryIdentity,
  mode: number,
  names: readonly string[],
) {
  const info = await lstat(path, { bigint: true });
  assert.equal(info.isDirectory(), true);
  assert.equal(info.dev, expected.dev);
  assert.equal(info.ino, expected.ino);
  assert.equal(Number(info.uid), expected.uid);
  assert.equal(Number(info.uid), process.getuid?.());
  assert.equal(Number(info.mode & 0o7777n), mode);
  assert.deepEqual((await readdir(path)).sort(), [...names].sort());
}
async function verifySharedTemplate(): Promise<SharedTemplate> {
  assert.ok(sharedTemplate);
  const expected = sharedTemplate;
  const root = await lstat(expected.root, { bigint: true });
  assert.equal(root.isDirectory(), true);
  assert.equal(root.dev, expected.rootDev);
  assert.equal(root.ino, expected.rootIno);
  assert.equal(Number(root.uid), expected.rootUID);
  assert.equal(Number(root.mode & 0o7777n), 0o500);
  assert.deepEqual((await readdir(expected.root)).sort(), [...sharedTemplateNames]);
  for (const name of sharedTemplateNames) {
    const actual = await templateArtifact(expected.root, name);
    const recorded = expected.artifacts[name];
    assert.ok(recorded);
    assert.deepEqual(actual, recorded);
  }
  return expected;
}
async function copyTemplateArtifact(name: string, destination: string) {
  const template = await verifySharedTemplate();
  const expected = template.artifacts[name];
  assert.ok(expected);
  await copyFile(join(template.root, name), destination);
  await chmod(destination, 0o755);
  const copied = await lstat(destination, { bigint: true });
  assert.equal(copied.isFile(), true);
  assert.equal(copied.nlink, 1n);
  assert.equal(Number(copied.uid), expected.uid);
  assert.equal(Number(copied.mode & 0o7777n), 0o755);
  assert.equal(Number(copied.size), expected.size);
  assert.notEqual(copied.dev === expected.dev && copied.ino === expected.ino, true);
  assert.equal(digest(await readFile(destination)), expected.sha256);
  await verifySharedTemplate();
}
const run = (file: string, args: string[]) =>
  spawnSync(file, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
function assertAuthorizationRejected(result: ReturnType<typeof run>) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^Ellie could not authenticate this service manifest envelope; no payload was installed or changed\.\n/,
  );
}
function assertAuthenticatedPayloadRejected(result: ReturnType<typeof run>) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "Ellie could not authenticate and inspect this service payload; no payload was installed or changed.\n",
  );
}
const runWithUmask = (mask: "027" | "077", file: string, args: string[]) =>
  spawnSync("/bin/sh", ["-c", `umask ${mask}; exec "$@"`, "ellie-test", file, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });

async function files(root: string, current = root): Promise<object[]> {
  const result: object[] = [];
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const info = await lstat(path);
    const item = relative(root, path).split(sep).join("/");
    if (info.isDirectory()) result.push(...(await files(root, path)));
    else
      result.push({
        path: item,
        mode: info.mode & 0o7777,
        size: info.size,
        sha256: digest(await readFile(path)),
      });
  }
  return result;
}
async function exactTree(root: string, current = root): Promise<object[]> {
  const result: object[] = [];
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const info = await lstat(path, { bigint: true });
    const relativePath = relative(root, path).split(sep).join("/");
    result.push({
      path: relativePath,
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      dev: info.dev.toString(),
      ino: info.ino.toString(),
      uid: info.uid.toString(),
      mode: Number(info.mode & 0o7777n),
      size: info.size.toString(),
      sha256: info.isFile() ? digest(await readFile(path)) : undefined,
    });
    if (info.isDirectory()) result.push(...(await exactTree(root, path)));
  }
  return result;
}
async function removeOwned(root: string) {
  const makeWritable = async (path: string) => {
    const info = await lstat(path);
    if (info.isDirectory()) {
      await chmod(path, 0o700);
      for (const name of await readdir(path)) await makeWritable(join(path, name));
    } else if (!info.isSymbolicLink()) await chmod(path, 0o600);
  };
  await makeWritable(root);
  await rm(root, { recursive: true });
}
test.before(
  async () => {
    if (!mac) return;
    const templateRoot = await realpath(await mkdtemp(join(tmpdir(), "ellie-installer-template-")));
    const templateIdentity = await captureOwnedDirectory(templateRoot);
    const buildRoot = await realpath(await mkdtemp(join(tmpdir(), "ellie-installer-build-")));
    const buildIdentity = await captureOwnedDirectory(buildRoot);
    try {
      const compilerVersion = execFileSync("/usr/bin/xcrun", ["swiftc", "--version"], {
        ...boundedCommand,
        encoding: "utf8",
      }).trim();
      const tinySource = join(buildRoot, "tiny.swift");
      const tinySourceBytes = Buffer.from("@main struct Tiny { static func main() {} }\n");
      await writeFile(tinySource, tinySourceBytes, { mode: 0o600 });
      const tinySourceRecord = await templateArtifact(buildRoot, "tiny.swift");
      const sources = [
        authorizationSource,
        authenticatedPayloadSource,
        activationPolicySource,
        candidateVerifierSource,
        captureSource,
        selectionSource,
        lifecycleSource,
        migrationSource,
        source,
        launcherSource,
      ];
      const sourceRecords = await Promise.all(
        sources.map(async (path) => ({
          path,
          name: path.split("/").at(-1),
          sha256: digest(await readFile(path)),
        })),
      );
      const installerArguments = [
        "swiftc",
        "-swift-version",
        "5",
        "-parse-as-library",
        "-D",
        "ELLIE_INSTALLER_TESTING",
        "-D",
        "ELLIE_AUTHORIZATION_TESTING",
        "-D",
        "ELLIE_AUTHENTICATED_PAYLOAD_TESTING",
        "-D",
        "ELLIE_ACTIVATION_POLICY_TESTING",
        authorizationSource,
        authenticatedPayloadSource,
        activationPolicySource,
        candidateVerifierSource,
        captureSource,
        selectionSource,
        lifecycleSource,
        migrationSource,
        source,
        "-o",
        join(templateRoot, "installer"),
      ];
      execFileSync("/usr/bin/xcrun", installerArguments, boundedCommand);
      execFileSync(
        "/usr/bin/codesign",
        [
          "--force",
          "--sign",
          "-",
          "--identifier",
          "org.ellie.installer",
          join(templateRoot, "installer"),
        ],
        boundedCommand,
      );
      const tinyArguments = [
        "swiftc",
        "-parse-as-library",
        tinySource,
        "-o",
        join(templateRoot, "tiny"),
      ];
      execFileSync("/usr/bin/xcrun", tinyArguments, boundedCommand);
      const launcherArguments: Record<"coordinator-launcher" | "node-launcher", string[]> = {
        "coordinator-launcher": [
          "swiftc",
          "-swift-version",
          "5",
          "-parse-as-library",
          "-D",
          "ELLIE_COORDINATOR",
          launcherSource,
          "-o",
          join(templateRoot, "coordinator-launcher"),
        ],
        "node-launcher": [
          "swiftc",
          "-swift-version",
          "5",
          "-parse-as-library",
          "-D",
          "ELLIE_NODE",
          launcherSource,
          "-o",
          join(templateRoot, "node-launcher"),
        ],
      };
      for (const arguments_ of Object.values(launcherArguments))
        execFileSync("/usr/bin/xcrun", arguments_, boundedCommand);
      for (const name of ["installer", "tiny", "coordinator-launcher", "node-launcher"])
        await chmod(join(templateRoot, name), 0o500);
      for (const record of sourceRecords)
        assert.equal(digest(await readFile(record.path)), record.sha256);
      assert.deepEqual(await templateArtifact(buildRoot, "tiny.swift"), tinySourceRecord);
      const buildKey = deepFreeze({
        version: 1,
        architecture: process.arch,
        compilerVersion,
        sources: [
          ...sourceRecords.map(({ name, sha256 }) => ({ name, sha256 })),
          { name: "tiny.swift", sha256: digest(tinySourceBytes) },
        ],
        commands: {
          installer: [
            "swiftc",
            "-swift-version",
            "5",
            "-parse-as-library",
            "-D",
            "ELLIE_INSTALLER_TESTING",
            "-D",
            "ELLIE_AUTHORIZATION_TESTING",
            "-D",
            "ELLIE_AUTHENTICATED_PAYLOAD_TESTING",
            "-D",
            "ELLIE_ACTIVATION_POLICY_TESTING",
            ...sources.slice(0, 8).map((path) => path.split("/").at(-1)),
            "-o",
            "installer",
          ],
          installerSignature: [
            "codesign",
            "--force",
            "--sign",
            "-",
            "--identifier",
            "org.ellie.installer",
            "installer",
          ],
          tiny: ["swiftc", "-parse-as-library", "tiny.swift", "-o", "tiny"],
          launchers: {
            coordinator: [
              "swiftc",
              "-swift-version",
              "5",
              "-parse-as-library",
              "-D",
              "ELLIE_COORDINATOR",
              "PackagedServiceLauncher.swift",
              "-o",
              "coordinator-launcher",
            ],
            node: [
              "swiftc",
              "-swift-version",
              "5",
              "-parse-as-library",
              "-D",
              "ELLIE_NODE",
              "PackagedServiceLauncher.swift",
              "-o",
              "node-launcher",
            ],
          },
        },
        outputs: await Promise.all(
          ["installer", "tiny", "coordinator-launcher", "node-launcher"].map(async (name) => ({
            name,
            sha256: digest(await readFile(join(templateRoot, name))),
          })),
        ),
      });
      const buildKeyBytes = Buffer.from(canonicalJSON(buildKey));
      await writeFile(join(templateRoot, "build-key.json"), buildKeyBytes, {
        mode: 0o400,
      });
      await verifyOwnedDirectory(templateRoot, templateIdentity, 0o700, sharedTemplateNames);
      const artifacts: Record<string, Readonly<TemplateArtifact>> = {};
      for (const name of sharedTemplateNames)
        artifacts[name] = await templateArtifact(templateRoot, name);
      for (const name of sharedTemplateNames)
        assert.equal(artifacts[name]?.mode, name === "build-key.json" ? 0o400 : 0o500);
      assert.equal(artifacts["build-key.json"]?.sha256, digest(buildKeyBytes));
      for (const output of buildKey.outputs)
        assert.equal(artifacts[output.name]?.sha256, output.sha256);
      await chmod(templateRoot, 0o500);
      sharedTemplate = Object.freeze({
        root: templateRoot,
        rootDev: templateIdentity.dev,
        rootIno: templateIdentity.ino,
        rootUID: templateIdentity.uid,
        artifacts: Object.freeze(artifacts),
      });
      await verifySharedTemplate();
      await verifyOwnedDirectory(buildRoot, buildIdentity, 0o700, ["tiny.swift"]);
      assert.deepEqual(await templateArtifact(buildRoot, "tiny.swift"), tinySourceRecord);
      await removeOwned(buildRoot);
      sharedSetupCertain = true;
    } catch (error) {
      console.error(`Native fixture setup retained owned roots: ${templateRoot} ${buildRoot}`);
      throw error;
    }
  },
  { timeout: sharedSetupTimeout },
);

test.after(async () => {
  if (sharedSetupCertain && sharedTemplate) {
    await verifySharedTemplate();
    await removeOwned(sharedTemplate.root);
  }
});
async function fixture(
  root: string,
  installer: string,
  tiny: string,
  launcherTemplates?: { coordinator: string; node: string },
) {
  const release = join(root, "source");
  const payload = join(release, "payload");
  await mkdir(join(payload, "bin"), { recursive: true, mode: 0o755 });
  await mkdir(join(payload, "helpers"), { mode: 0o755 });
  await cp(installer, join(payload, "bin/ellie-service-installer"));
  await chmod(join(payload, "bin/ellie-service-installer"), 0o755);
  await cp(tiny, join(payload, "bin/node"));
  await chmod(join(payload, "bin/node"), 0o755);
  await mkdir(join(payload, "lib/ellie/apps/cli/src"), { recursive: true, mode: 0o755 });
  await writeFile(join(payload, "lib/ellie/apps/cli/src/main.ts"), "export {};\n", {
    mode: 0o644,
  });
  await cp(tiny, join(payload, "helpers/ellie-macos"));
  await chmod(join(payload, "helpers/ellie-macos"), 0o755);
  execFileSync(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      "-",
      "--identifier",
      "org.ellie.helper",
      join(payload, "helpers/ellie-macos"),
    ],
    boundedCommand,
  );
  for (const [name, identifier, define] of [
    ["Ellie Coordinator", "org.ellie.assistant.coordinator.app", "ELLIE_COORDINATOR"],
    ["Ellie Node", "org.ellie.assistant.node.app", "ELLIE_NODE"],
  ] as const) {
    const app = join(payload, "launchers", `${name}.app`);
    await mkdir(join(app, "Contents/MacOS"), { recursive: true, mode: 0o755 });
    const executable = join(app, "Contents/MacOS/EllieService");
    if (launcherTemplates) {
      await copyFile(
        define === "ELLIE_COORDINATOR" ? launcherTemplates.coordinator : launcherTemplates.node,
        executable,
      );
      await chmod(executable, 0o755);
    } else {
      execFileSync(
        "/usr/bin/xcrun",
        [
          "swiftc",
          "-swift-version",
          "5",
          "-parse-as-library",
          "-D",
          define,
          launcherSource,
          "-o",
          executable,
        ],
        boundedCommand,
      );
    }
    await writeFile(
      join(app, "Contents/Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>EllieService</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
      { mode: 0o644 },
    );
    execFileSync(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--identifier", identifier, app],
      boundedCommand,
    );
  }
  const revision = "a".repeat(40);
  const nodeHash = "b".repeat(64);
  const manifest = {
    version: 1,
    productVersion: "0.1.0",
    sourceRevision: revision,
    sourceModified: false,
    platform: "darwin",
    architecture: process.arch === "arm64" ? "arm64" : "x64",
    minimumOS: "14.0",
    lockSha256: "c".repeat(64),
    buildTools: { node: "24.22.0", bun: "1.4.2" },
    runtime: {
      version: "v24.21.0",
      architecture: process.arch === "arm64" ? "arm64" : "x64",
      archive: `node-v24.21.0-darwin-${process.arch === "arm64" ? "arm64" : "x64"}.tar.xz`,
      sha256: nodeHash,
      source: `https://nodejs.org/download/release/v24.21.0/node-v24.21.0-darwin-${process.arch === "arm64" ? "arm64" : "x64"}.tar.xz`,
      checksums: "https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt",
      license: "https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE",
    },
    helper: {
      identifier: "org.ellie.helper",
      signature: "development-ad-hoc",
      architecture: process.arch === "arm64" ? "arm64" : "x64",
      minimumOS: "14.0",
    },
    launchers: [
      {
        role: "coordinator",
        name: "Ellie Coordinator",
        identifier: "org.ellie.assistant.coordinator.app",
        signature: "development-ad-hoc",
        architecture: process.arch === "arm64" ? "arm64" : "x64",
        minimumOS: "14.0",
      },
      {
        role: "node",
        name: "Ellie Node",
        identifier: "org.ellie.assistant.node.app",
        signature: "development-ad-hoc",
        architecture: process.arch === "arm64" ? "arm64" : "x64",
        minimumOS: "14.0",
      },
    ],
    components: [{ name: "example-package", version: "1.0.0", license: "MIT", files: ["LICENSE"] }],
    files: await files(payload),
  };
  await writeFile(join(release, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  await writeFile(
    join(release, "SOURCE.txt"),
    `Ellie service payload\nSource revision: ${revision}\nNode.js: v24.21.0\nNode archive SHA-256: ${nodeHash}\nMinimum macOS: 14.0\nHelper: org.ellie.helper (development-ad-hoc)\n`,
    { mode: 0o644 },
  );
  return { release, id: `0.1.0-${revision}-${manifest.architecture}` };
}
async function refreshManifestFiles(release: string) {
  const path = join(release, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.files = await files(join(release, "payload"));
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
}

const productionNativeCode = [
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
  {
    path: "launchers/Ellie Coordinator.app",
    kind: "bundle",
    identifier: "org.ellie.assistant.coordinator.app",
    machOPaths: ["launchers/Ellie Coordinator.app/Contents/MacOS/EllieService"],
    entitlements: {},
  },
  {
    path: "launchers/Ellie Node.app",
    kind: "bundle",
    identifier: "org.ellie.assistant.node.app",
    machOPaths: ["launchers/Ellie Node.app/Contents/MacOS/EllieService"],
    entitlements: {},
  },
];

async function productionFixture(root: string, release: string) {
  const payload = join(release, "payload");
  const entitlements = join(root, "node-entitlements.plist");
  await writeFile(
    entitlements,
    '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>',
    { mode: 0o600 },
  );
  execFileSync(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      "-",
      "--identifier",
      "org.ellie.runtime.node",
      "--options",
      "runtime",
      "--entitlements",
      entitlements,
      join(payload, "bin/node"),
    ],
    boundedCommand,
  );
  for (const [path, identifier] of [
    ["bin/ellie-service-installer", "org.ellie.installer"],
    ["helpers/ellie-macos", "org.ellie.helper"],
    ["launchers/Ellie Coordinator.app", "org.ellie.assistant.coordinator.app"],
    ["launchers/Ellie Node.app", "org.ellie.assistant.node.app"],
  ] as const) {
    execFileSync(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--identifier",
        identifier,
        join(payload, path),
      ],
      boundedCommand,
    );
  }
  const manifestPath = join(release, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = 2;
  manifest.helper.signature = "developer-id";
  for (const launcher of manifest.launchers) launcher.signature = "developer-id";
  manifest.nativeCode = productionNativeCode;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await refreshManifestFiles(release);
  await writeFile(
    join(release, "SOURCE.txt"),
    `Ellie service payload\nSource revision: ${manifest.sourceRevision}\nNode.js: ${manifest.runtime.version}\nNode archive SHA-256: ${manifest.runtime.sha256}\nMinimum macOS: ${manifest.minimumOS}\nPolicy: authenticated-payload-v1\n`,
    { mode: 0o644 },
  );
}

async function authorizationBundle(
  root: string,
  release: string,
  executable: string,
  teamID = "ABCDEFGHIJ",
) {
  const app = join(root, "Ellie Service Authorization.app");
  const contents = join(app, "Contents");
  const resources = join(contents, "Resources");
  await mkdir(join(contents, "MacOS"), { recursive: true, mode: 0o755 });
  await mkdir(resources, { mode: 0o755 });
  await cp(executable, join(contents, "MacOS/EllieServiceAuthorization"));
  await chmod(join(contents, "MacOS/EllieServiceAuthorization"), 0o755);
  await writeFile(
    join(contents, "Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.ellie.service.authorization</string><key>CFBundleExecutable</key><string>EllieServiceAuthorization</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
    { mode: 0o644 },
  );
  const manifest = await readFile(join(release, "manifest.json"));
  const sourceRecord = await readFile(join(release, "SOURCE.txt"));
  const policyDigest = digest(
    Buffer.from(
      canonicalJSON({
        authorizationIdentifier: "org.ellie.service.authorization",
        authorizationVersion: 1,
        digestAlgorithm: "sha256",
        payloadVerification: "not-performed",
        requiredResources: ["SOURCE.txt", "authorization.json", "manifest.json"],
        requirement: authorizationRequirement(teamID),
        scope: "manifest-envelope",
        signatureSemantics: "security-framework-strict-all-architectures",
        teamID,
      }),
    ),
  );
  await writeFile(join(resources, "manifest.json"), manifest, { mode: 0o644 });
  await writeFile(join(resources, "SOURCE.txt"), sourceRecord, { mode: 0o644 });
  await writeFile(
    join(resources, "authorization.json"),
    canonicalJSON({
      manifestSHA256: digest(manifest),
      policyDigest,
      sourceSHA256: digest(sourceRecord),
      version: 1,
    }),
    { mode: 0o644 },
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--sign", "-", "--identifier", "org.ellie.service.authorization", app],
    boundedCommand,
  );
  return app;
}

async function withFixture(
  t: test.TestContext,
  action: (value: {
    root: string;
    release: string;
    installer: string;
    services: string;
    id: string;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-native-installer-")));
  let completed = false;
  t.after(async () => {
    if (completed) await removeOwned(root);
  });
  const installer = join(root, "installer");
  const tiny = join(root, "tiny");
  const coordinator = join(root, "coordinator-launcher");
  const node = join(root, "node-launcher");
  await copyTemplateArtifact("installer", installer);
  await copyTemplateArtifact("tiny", tiny);
  await copyTemplateArtifact("coordinator-launcher", coordinator);
  await copyTemplateArtifact("node-launcher", node);
  const { release, id } = await fixture(root, installer, tiny, { coordinator, node });
  const services = join(root, "Services");
  await mkdir(services, { mode: 0o700 });
  await action({ root, release, installer, services, id });
  completed = true;
}

const options = { skip: !mac };
test(
  "native inspector accepts its test file boundary and rejects one more declared file",
  options,
  async (t) => {
    await withFixture(t, async ({ release, installer, id }) => {
      const manifestPath = join(release, "manifest.json");
      const initial = JSON.parse(await readFile(manifestPath, "utf8"));
      const extra = join(release, "payload/lib/ellie/limit-fixture");
      await mkdir(extra);
      for (let index = initial.files.length; index < 100; index++)
        await writeFile(join(extra, `f${String(index).padStart(3, "0")}`), "x", { mode: 0o644 });
      await refreshManifestFiles(release);
      const atBoundary = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(atBoundary.files.length, 100);
      const accepted = run(installer, ["inspect", release]);
      assert.equal(accepted.error, undefined);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(accepted.stdout, `${id}\n`);

      await writeFile(join(extra, "f101"), "x", { mode: 0o644 });
      await refreshManifestFiles(release);
      const overBoundary = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(overBoundary.files.length, 101);
      const rejected = run(installer, ["inspect", release]);
      assert.equal(rejected.error, undefined);
      assert.equal(rejected.status, 1);
    });
  },
);
test(
  "compiled installer templates copy into isolated mutable fixture roots",
  options,
  async (t) => {
    const first = await realpath(await mkdtemp(join(tmpdir(), "ellie-template-copy-a-")));
    const second = await realpath(await mkdtemp(join(tmpdir(), "ellie-template-copy-b-")));
    let completed = false;
    t.after(async () => {
      if (completed) {
        await removeOwned(first);
        await removeOwned(second);
      }
    });
    const firstInstaller = join(first, "installer");
    const secondInstaller = join(second, "installer");
    await copyTemplateArtifact("installer", firstInstaller);
    await copyTemplateArtifact("installer", secondInstaller);
    const template = await verifySharedTemplate();
    const expected = template.artifacts.installer;
    assert.ok(expected);
    const firstInfo = await lstat(firstInstaller, { bigint: true });
    const secondInfo = await lstat(secondInstaller, { bigint: true });
    assert.notEqual(firstInfo.dev === secondInfo.dev && firstInfo.ino === secondInfo.ino, true);
    await writeFile(firstInstaller, "owned mutation", { mode: 0o755 });
    assert.notEqual(digest(await readFile(firstInstaller)), expected.sha256);
    assert.equal(digest(await readFile(secondInstaller)), expected.sha256);
    await verifySharedTemplate();
    completed = true;
  },
);
test(
  "authenticated activation policy is canonical and derives closed policy digests",
  options,
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-activation-policy-")));
    let completed = false;
    t.after(async () => {
      if (completed) await removeOwned(root);
    });
    const installer = join(root, "installer");
    await copyTemplateArtifact("installer", installer);
    const readPolicy = (teamID: string, architecture: string) => {
      const result = run(installer, ["test-authenticated-activation-policy", teamID, architecture]);
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout.trimEnd().split("\n");
      assert.equal(lines.length, 2);
      const [json, policyDigest] = lines;
      assert.ok(json);
      assert.ok(policyDigest);
      const data = Buffer.from(`${json}\n`);
      assert.equal(digest(data), policyDigest);
      return { value: JSON.parse(json) as Record<string, unknown>, data, digest: policyDigest };
    };
    const teamID = "ABCDEFGHIJ";
    const arm = readPolicy(teamID, "arm64");
    assert.deepEqual(arm.value, {
      authorizationFormatVersion: 1,
      candidateBindingScope: "authenticated-candidate-capture",
      candidateBindingVersion: 1,
      digestAlgorithm: "sha256",
      envelopePolicyDigest: arm.value.envelopePolicyDigest,
      launcherVerification: "full-candidate-and-installed-role-v1",
      payloadPolicyDigest: arm.value.payloadPolicyDigest,
      publisherTeamID: teamID,
      receiptVersion: 2,
      roles: [
        { bundleIdentifier: "org.ellie.assistant.coordinator.app", name: "coordinator" },
        { bundleIdentifier: "org.ellie.assistant.node.app", name: "node" },
      ],
      scope: "authenticated-service-activation",
      selectionJournalVersion: 2,
      version: 1,
    });
    assert.deepEqual(arm.data, Buffer.from(canonicalJSON(arm.value)));
    const envelope = run(installer, [
      "test-authorization-policy",
      teamID,
      authorizationRequirement(teamID),
    ]);
    assert.equal(envelope.status, 0, envelope.stderr);
    assert.equal(arm.value.envelopePolicyDigest, envelope.stdout.trim());
    const changedRequirement = run(installer, [
      "test-authorization-policy",
      teamID,
      `${authorizationRequirement(teamID)} and true`,
    ]);
    assert.equal(changedRequirement.status, 0, changedRequirement.stderr);
    assert.notEqual(arm.value.envelopePolicyDigest, changedRequirement.stdout.trim());
    const x64 = readPolicy(teamID, "x64");
    const changedTeam = readPolicy("KLMNOPQRST", "arm64");
    assert.equal(
      arm.value.envelopePolicyDigest,
      "4869431c87452a2a378b72ac62e018bca62d60caadef2f65bdfed50d70a16cb5",
    );
    assert.equal(
      arm.value.payloadPolicyDigest,
      "44768d525fb878543e723f7c41c93db5738837907cbb7d9bffd9e3861a8a3850",
    );
    assert.equal(arm.digest, "6430090b1b6c58f4888d16347e5d6cc511d97469d849e663d3e3f1621d98bdfd");
    assert.equal(
      x64.value.payloadPolicyDigest,
      "08c4a1a060f69bc57eddcbee97f4fc48bed6799dac7dce6b874d61088bf26333",
    );
    assert.equal(x64.digest, "32f71a3ee92bea2fab4a01cfcc6b7fbff6c157f9dec4485d616a78ce3b7ab534");
    assert.notEqual(arm.value.payloadPolicyDigest, x64.value.payloadPolicyDigest);
    assert.notEqual(arm.digest, x64.digest);
    assert.notEqual(arm.value.envelopePolicyDigest, changedTeam.value.envelopePolicyDigest);
    assert.notEqual(arm.digest, changedTeam.digest);
    for (const arguments_ of [
      ["test-authenticated-activation-policy"],
      ["test-authenticated-activation-policy", "ABCDEFGHI", "arm64"],
      ["test-authenticated-activation-policy", "abcdefghiJ", "arm64"],
      ["test-authenticated-activation-policy", "ABCDEFGHIJ\n", "arm64"],
      ["test-authenticated-activation-policy", "ABCDEFGHÉJ", "arm64"],
      ["test-authenticated-activation-policy", "ABCDEFGHIJ", ""],
      ["test-authenticated-activation-policy", "ABCDEFGHIJ", "ARM64"],
      ["test-authenticated-activation-policy", "ABCDEFGHIJ", "arm64", "extra"],
    ]) {
      const rejected = run(installer, arguments_);
      assert.equal(rejected.error, undefined);
      assert.equal(rejected.signal, null);
      assert.equal(rejected.status, 1);
    }
    completed = true;
  },
);
test("installer stage diagnostics are compiled into test builds only", options, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-installer-diagnostic-")));
  t.after(() => removeOwned(root));
  const testing = join(root, "testing-installer");
  const policyTesting = join(root, "policy-testing-installer");
  const production = join(root, "production-installer");
  execFileSync("/usr/bin/xcrun", [
    "swiftc",
    "-swift-version",
    "5",
    "-parse-as-library",
    "-D",
    "ELLIE_INSTALLER_TESTING",
    authorizationSource,
    authenticatedPayloadSource,
    activationPolicySource,
    candidateVerifierSource,
    captureSource,
    selectionSource,
    lifecycleSource,
    migrationSource,
    source,
    "-o",
    testing,
  ]);
  execFileSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-parse-as-library",
      "-D",
      "ELLIE_ACTIVATION_POLICY_TESTING",
      authorizationSource,
      authenticatedPayloadSource,
      activationPolicySource,
      candidateVerifierSource,
      captureSource,
      selectionSource,
      lifecycleSource,
      migrationSource,
      source,
      "-o",
      policyTesting,
    ],
    boundedCommand,
  );
  execFileSync("/usr/bin/xcrun", [
    "swiftc",
    "-swift-version",
    "5",
    "-parse-as-library",
    authorizationSource,
    authenticatedPayloadSource,
    activationPolicySource,
    candidateVerifierSource,
    captureSource,
    selectionSource,
    lifecycleSource,
    migrationSource,
    source,
    "-o",
    production,
  ]);

  const testingFailure = run(testing, []);
  assert.notEqual(testingFailure.status, 0);
  assert.match(
    testingFailure.stderr,
    /Ellie installer test diagnostic: stage=argument-validation category=validation/,
  );
  const productionFailure = run(production, []);
  assert.notEqual(productionFailure.status, 0);
  assert.equal(
    productionFailure.stderr,
    "Ellie service payload inspection or staging failed; existing installations were preserved.\n",
  );
  assert.doesNotMatch(productionFailure.stderr, /diagnostic|stage=|category=/);
  const productionActivation = run(production, [
    "test-authenticated-activation-policy",
    "ABCDEFGHIJ",
    "arm64",
  ]);
  assert.equal(productionActivation.status, 1);
  assert.equal(productionActivation.stdout, "");
  assert.equal(productionActivation.stderr, productionFailure.stderr);
  for (const [architecture, payloadDigest, trustedDigest] of [
    [
      "arm64",
      "0dff1b03a67c5213ead9dcc4b8c05a0327847f99ef6f7202ceb466401dcf3eae",
      "8c87fc9f9b6dc2439e9fab1fea8dc951472155fb93a2c2db80a79000df402582",
    ],
    [
      "x64",
      "41abb344d41dd8d08232dcee11810488171ffb8beac16c329b57e0c2ac4f17ef",
      "d2ac2dcef599662315aac9a4ca9bddc1cdec44b98b4b67a3039a1de11ee1e753",
    ],
  ] as const) {
    const policy = run(policyTesting, [
      "test-authenticated-activation-policy",
      "ABCDEFGHIJ",
      architecture,
    ]);
    assert.equal(policy.status, 0, policy.stderr);
    const lines = policy.stdout.trimEnd().split("\n");
    assert.equal(lines.length, 2);
    const [json, policyDigest] = lines;
    assert.ok(json);
    assert.ok(policyDigest);
    assert.equal((JSON.parse(json) as Record<string, unknown>).payloadPolicyDigest, payloadDigest);
    assert.equal(policyDigest, trustedDigest);
  }
});

test("production inspector accepts 3072 declared files and rejects 3073", options, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-production-file-limit-")));
  let completed = false;
  t.after(async () => {
    if (completed) await removeOwned(root);
  });
  const installer = join(root, "installer");
  const tiny = join(root, "tiny");
  const coordinator = join(root, "coordinator-launcher");
  const node = join(root, "node-launcher");
  execFileSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      "-parse-as-library",
      authorizationSource,
      authenticatedPayloadSource,
      activationPolicySource,
      candidateVerifierSource,
      captureSource,
      selectionSource,
      lifecycleSource,
      migrationSource,
      source,
      "-o",
      installer,
    ],
    boundedCommand,
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--sign", "-", "--identifier", "org.ellie.installer", installer],
    boundedCommand,
  );
  await copyTemplateArtifact("tiny", tiny);
  await copyTemplateArtifact("coordinator-launcher", coordinator);
  await copyTemplateArtifact("node-launcher", node);
  const { release, id } = await fixture(root, installer, tiny, { coordinator, node });
  const extra = join(release, "payload/lib/ellie/limit-fixture");
  await mkdir(extra);
  const original = JSON.parse(await readFile(join(release, "manifest.json"), "utf8"));
  for (let index = original.files.length; index < 3_072; index++)
    await writeFile(join(extra, `f${String(index).padStart(4, "0")}`), "x", { mode: 0o644 });
  await refreshManifestFiles(release);
  const atBoundary = JSON.parse(await readFile(join(release, "manifest.json"), "utf8"));
  assert.equal(atBoundary.files.length, 3_072);
  const accepted = run(installer, ["inspect", release]);
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, `${id}\n`);

  await writeFile(join(extra, "f3073"), "x", { mode: 0o644 });
  await refreshManifestFiles(release);
  const overBoundary = JSON.parse(await readFile(join(release, "manifest.json"), "utf8"));
  assert.equal(overBoundary.files.length, 3_073);
  const rejected = run(installer, ["inspect", release]);
  assert.equal(rejected.error, undefined);
  assert.equal(rejected.status, 1);
  completed = true;
});

test(
  "authenticated manifest envelope is sealed, exact, and never a payload approval",
  options,
  async (t) => {
    await withFixture(t, async ({ root, release, installer }) => {
      const app = await authorizationBundle(root, release, installer);
      const args = [
        "inspect-authorization",
        release,
        app,
        "--publisher-team-id",
        "ABCDEFGHIJ",
        "--test-allow-sealed-adhoc",
      ];
      const accepted = run(installer, args);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.match(
        accepted.stdout,
        /^Authenticated copies manifestBytes \d+ manifestSHA256 [a-f0-9]{64} sourceBytes \d+ sourceSHA256 [a-f0-9]{64}\.\nAuthenticated manifest envelope version 1, policy [a-f0-9]{64}, manifest [a-f0-9]{64}; payload inventory was not verified and nothing was installed\.\n$/,
      );
      const manifestBytes = (await readFile(join(release, "manifest.json"))).length;
      const sourceBytes = (await readFile(join(release, "SOURCE.txt"))).length;
      assert.match(
        accepted.stdout,
        new RegExp(
          `manifestBytes ${manifestBytes} manifestSHA256 ${digest(await readFile(join(release, "manifest.json")))} sourceBytes ${sourceBytes} sourceSHA256 ${digest(await readFile(join(release, "SOURCE.txt")))}`,
        ),
      );

      const policyA = run(installer, ["test-authorization-policy", "ABCDEFGHIJ", "requirement-a"]);
      const policyB = run(installer, ["test-authorization-policy", "ABCDEFGHIJ", "requirement-b"]);
      assert.equal(policyA.status, 0, policyA.stderr);
      assert.equal(policyB.status, 0, policyB.stderr);
      assert.notEqual(policyA.stdout, policyB.stdout);

      for (const invalidRelease of [
        `${release}/.`,
        `${release}//payload`,
        `${release}/../source`,
      ]) {
        assertAuthorizationRejected(run(installer, [args[0]!, invalidRelease, ...args.slice(2)]));
      }

      const replacement = join(root, "Replacement Authorization.app");
      await cp(app, replacement, { recursive: true });
      assertAuthorizationRejected(run(installer, [...args, "--test-rebind-path", replacement]));

      const production = join(root, "production-authorization-installer");
      execFileSync(
        "/usr/bin/xcrun",
        [
          "swiftc",
          "-swift-version",
          "5",
          "-parse-as-library",
          authorizationSource,
          authenticatedPayloadSource,
          activationPolicySource,
          candidateVerifierSource,
          captureSource,
          selectionSource,
          lifecycleSource,
          migrationSource,
          source,
          "-o",
          production,
        ],
        boundedCommand,
      );
      const productionRejection = run(production, args.slice(0, 5));
      assertAuthorizationRejected(productionRejection);
      assert.equal(
        productionRejection.stderr,
        "Ellie could not authenticate this service manifest envelope; no payload was installed or changed.\n",
      );
      assertAuthorizationRejected(run(production, args));

      const externalManifest = join(release, "manifest.json");
      const originalManifest = await readFile(externalManifest);
      await writeFile(externalManifest, Buffer.concat([originalManifest, Buffer.from(" ")]));
      assertAuthorizationRejected(run(installer, args));
      await writeFile(externalManifest, originalManifest);

      const recordPath = join(app, "Contents/Resources/authorization.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      record.extra = true;
      await writeFile(recordPath, canonicalJSON(record));
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], boundedCommand);
      assertAuthorizationRejected(run(installer, args));
      delete record.extra;
      await writeFile(recordPath, canonicalJSON(record));
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], boundedCommand);

      const infoPath = join(app, "Contents/Info.plist");
      const originalInfo = await readFile(infoPath);
      await writeFile(
        infoPath,
        originalInfo.toString().replace("<string>APPL</string>", "<string>BNDL</string>"),
      );
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], boundedCommand);
      assertAuthorizationRejected(run(installer, args));
      await writeFile(infoPath, originalInfo);
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], boundedCommand);

      const parserArgs = [
        "test-authorization-resources",
        join(app, "Contents/_CodeSignature"),
        join(app, "Contents/Resources"),
      ];
      assert.equal(run(installer, parserArgs).status, 0);
      const codeResourcesPath = join(app, "Contents/_CodeSignature/CodeResources");
      const originalCodeResources = await readFile(codeResourcesPath);
      mutateCodeResources(codeResourcesPath, "optional");
      assertAuthorizationRejected(run(installer, parserArgs));
      await writeFile(codeResourcesPath, originalCodeResources);
      mutateCodeResources(codeResourcesPath, "unknown");
      assertAuthorizationRejected(run(installer, parserArgs));
      await writeFile(codeResourcesPath, originalCodeResources);
      mutateCodeResources(codeResourcesPath, "hash2");
      assertAuthorizationRejected(run(installer, parserArgs));
      await writeFile(codeResourcesPath, originalCodeResources);

      const wrongPolicy = [...args];
      wrongPolicy[4] = "KLMNOPQRST";
      assertAuthorizationRejected(run(installer, wrongPolicy));
      const malformedPolicy = [...args];
      malformedPolicy[4] = "ABCDEFGHI";
      assertAuthorizationRejected(run(installer, malformedPolicy));

      const sourcePath = join(release, "SOURCE.txt");
      const originalSource = await readFile(sourcePath);
      await rename(sourcePath, `${sourcePath}.owned`);
      await symlink(`${sourcePath}.owned`, sourcePath);
      assertAuthorizationRejected(run(installer, args));
      await rm(sourcePath);
      await rename(`${sourcePath}.owned`, sourcePath);
      assert.deepEqual(await readFile(sourcePath), originalSource);

      const sealedManifest = join(app, "Contents/Resources/manifest.json");
      await writeFile(sealedManifest, Buffer.concat([originalManifest, Buffer.from(" ")]));
      assertAuthorizationRejected(run(installer, args));
    });
  },
);

test(
  "authenticated payload inspection binds manifest v2 to the complete native inventory",
  options,
  async (t) => {
    await withFixture(t, async ({ root, release, installer, id }) => {
      await productionFixture(root, release);
      const app = await authorizationBundle(root, release, installer);
      const args = [
        "inspect-authenticated-payload",
        release,
        app,
        "--publisher-team-id",
        "ABCDEFGHIJ",
        "--test-allow-sealed-adhoc",
      ];
      const accepted = run(installer, args);
      assert.equal(accepted.error, undefined);
      assert.equal(accepted.signal, null);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.match(
        accepted.stdout,
        new RegExp(
          `^Authenticated payload ${id}, envelope policy [a-f0-9]{64}, payload policy [a-f0-9]{64}, manifest [a-f0-9]{64}; installation was not authorized and nothing was changed\\.\\n$`,
        ),
      );
      assert.notEqual(run(installer, ["inspect", release]).status, 0);
      const reboundRelease = join(root, "rebound-release");
      await cp(release, reboundRelease, { recursive: true });
      assertAuthenticatedPayloadRejected(
        run(installer, [...args, "--test-rebind-path", reboundRelease]),
      );

      const thin = await readFile(join(release, "payload/bin/node"));
      const fatOffset = 4096;
      const fat = Buffer.alloc(fatOffset + thin.length);
      fat.writeUInt32BE(0xcafebabe, 0);
      fat.writeUInt32BE(1, 4);
      fat.writeUInt32BE(thin.readUInt32LE(4), 8);
      fat.writeUInt32BE(thin.readUInt32LE(8), 12);
      fat.writeUInt32BE(fatOffset, 16);
      fat.writeUInt32BE(thin.length, 20);
      fat.writeUInt32BE(12, 24);
      thin.copy(fat, fatOffset);
      const fatPath = join(root, "synthetic-fat");
      await writeFile(fatPath, fat, { mode: 0o600 });
      const parsedFat = run(installer, [
        "test-authenticated-macho",
        root,
        "synthetic-fat",
        process.arch === "arm64" ? "arm64" : "x64",
      ]);
      assert.equal(parsedFat.status, 0, parsedFat.stderr);
      assert.equal(parsedFat.stdout, "native\n");
      assertAuthenticatedPayloadRejected(
        run(installer, [
          "test-authenticated-macho",
          root,
          "synthetic-fat",
          process.arch === "arm64" ? "x64" : "arm64",
        ]),
      );
      await writeFile(join(root, "short-data"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), {
        mode: 0o600,
      });
      assertAuthenticatedPayloadRejected(
        run(installer, [
          "test-authenticated-macho",
          root,
          "short-data",
          process.arch === "arm64" ? "arm64" : "x64",
        ]),
      );

      const rejectedCandidate = async (
        name: string,
        mutate: (candidate: string) => Promise<void>,
      ) => {
        const candidateRoot = join(root, name);
        await mkdir(candidateRoot, { mode: 0o700 });
        const candidate = join(candidateRoot, "release");
        await cp(release, candidate, { recursive: true });
        await mutate(candidate);
        const candidateAuthorization = await authorizationBundle(
          candidateRoot,
          candidate,
          installer,
        );
        assertAuthenticatedPayloadRejected(
          run(installer, [
            "inspect-authenticated-payload",
            candidate,
            candidateAuthorization,
            "--publisher-team-id",
            "ABCDEFGHIJ",
            "--test-allow-sealed-adhoc",
          ]),
        );
      };

      await rejectedCandidate("undeclared-file", async (candidate) => {
        await writeFile(join(candidate, "payload/undeclared.txt"), "bounded", { mode: 0o644 });
      });
      await rejectedCandidate("undeclared-native", async (candidate) => {
        await cp(join(candidate, "payload/bin/node"), join(candidate, "payload/undeclared-native"));
        await chmod(join(candidate, "payload/undeclared-native"), 0o755);
        await refreshManifestFiles(candidate);
      });
      await rejectedCandidate("wrong-native-identifier", async (candidate) => {
        const helper = join(candidate, "payload/helpers/ellie-macos");
        execFileSync(
          "/usr/bin/codesign",
          [
            "--force",
            "--sign",
            "-",
            "--options",
            "runtime",
            "--identifier",
            "org.ellie.other",
            helper,
          ],
          boundedCommand,
        );
        await refreshManifestFiles(candidate);
      });
      await rejectedCandidate("unexpected-native-entitlement", async (candidate) => {
        const helper = join(candidate, "payload/helpers/ellie-macos");
        const entitlements = join(root, "unexpected-helper-entitlements.plist");
        await writeFile(
          entitlements,
          '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',
          { mode: 0o600 },
        );
        execFileSync(
          "/usr/bin/codesign",
          [
            "--force",
            "--sign",
            "-",
            "--options",
            "runtime",
            "--identifier",
            "org.ellie.helper",
            "--entitlements",
            entitlements,
            helper,
          ],
          boundedCommand,
        );
        await refreshManifestFiles(candidate);
      });
      await rejectedCandidate("integer-signed-entitlement", async (candidate) => {
        const node = join(candidate, "payload/bin/node");
        const entitlements = join(root, "integer-node-entitlements.plist");
        await writeFile(
          entitlements,
          '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><integer>1</integer><key>com.apple.security.cs.allow-unsigned-executable-memory</key><integer>1</integer></dict></plist>',
          { mode: 0o600 },
        );
        execFileSync(
          "/usr/bin/codesign",
          [
            "--force",
            "--sign",
            "-",
            "--options",
            "runtime",
            "--identifier",
            "org.ellie.runtime.node",
            "--entitlements",
            entitlements,
            node,
          ],
          boundedCommand,
        );
        await refreshManifestFiles(candidate);
      });
      await rejectedCandidate("altered-nested-launcher", async (candidate) => {
        const executable = join(
          candidate,
          "payload/launchers/Ellie Node.app/Contents/MacOS/EllieService",
        );
        await writeFile(executable, Buffer.concat([await readFile(executable), Buffer.from([0])]));
        await refreshManifestFiles(candidate);
      });
      await rejectedCandidate("malformed-mach", async (candidate) => {
        const node = join(candidate, "payload/bin/node");
        await writeFile(node, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
        await refreshManifestFiles(candidate);
      });
      await rejectedCandidate("wrong-mode", async (candidate) => {
        await chmod(join(candidate, "payload/bin/node"), 0o744);
      });
      await rejectedCandidate("duplicate-json-key", async (candidate) => {
        const path = join(candidate, "manifest.json");
        const value = await readFile(path, "utf8");
        await writeFile(
          path,
          value.replace('{\n  "version": 2,', '{\n  "version": 2,\n  "version": 2,'),
        );
      });
      await rejectedCandidate("boolean-manifest-version", async (candidate) => {
        const path = join(candidate, "manifest.json");
        const value = await readFile(path, "utf8");
        await writeFile(path, value.replace('{\n  "version": 2,', '{\n  "version": true,'));
      });
      await rejectedCandidate("unknown-native-key", async (candidate) => {
        const path = join(candidate, "manifest.json");
        const value = JSON.parse(await readFile(path, "utf8"));
        value.nativeCode[0].unknown = false;
        await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
      });
      for (const [name, entitlements] of [
        ["array-entitlements", ["com.apple.security.cs.allow-jit"]],
        [
          "false-entitlement",
          {
            "com.apple.security.cs.allow-jit": false,
            "com.apple.security.cs.allow-unsigned-executable-memory": true,
          },
        ],
        [
          "nonboolean-entitlement",
          {
            "com.apple.security.cs.allow-jit": 1,
            "com.apple.security.cs.allow-unsigned-executable-memory": true,
          },
        ],
        [
          "unknown-entitlement",
          {
            "com.apple.security.cs.allow-jit": true,
            "com.apple.security.cs.allow-unsigned-executable-memory": true,
            "com.apple.security.cs.disable-library-validation": true,
          },
        ],
      ] as const) {
        await rejectedCandidate(name, async (candidate) => {
          const path = join(candidate, "manifest.json");
          const value = JSON.parse(await readFile(path, "utf8"));
          value.nativeCode[0].entitlements = entitlements;
          await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
        });
      }

      const v1Root = join(root, "v1");
      await mkdir(v1Root, { mode: 0o700 });
      const v1 = await fixture(v1Root, installer, join(release, "payload/bin/node"));
      const v1App = await authorizationBundle(v1Root, v1.release, installer);
      assertAuthenticatedPayloadRejected(
        run(installer, [
          "inspect-authenticated-payload",
          v1.release,
          v1App,
          "--publisher-team-id",
          "ABCDEFGHIJ",
          "--test-allow-sealed-adhoc",
        ]),
      );

      const changedNode = join(release, "payload/bin/node");
      const originalNode = await readFile(changedNode);
      await writeFile(changedNode, Buffer.concat([originalNode, Buffer.from([0])]));
      assertAuthenticatedPayloadRejected(run(installer, args));
      await writeFile(changedNode, originalNode);

      const manifestPath = join(release, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.nativeCode[0].identifier = "org.ellie.runtime.other";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
      const changedAppRoot = join(root, "changed-authorization");
      await mkdir(changedAppRoot, { mode: 0o700 });
      const changedApp = await authorizationBundle(changedAppRoot, release, installer);
      assertAuthenticatedPayloadRejected(
        run(installer, [
          "inspect-authenticated-payload",
          release,
          changedApp,
          "--publisher-team-id",
          "ABCDEFGHIJ",
          "--test-allow-sealed-adhoc",
        ]),
      );
    });
  },
);

test(
  "native installer inspects and publishes one immutable unselected release",
  options,
  async (t) => {
    await withFixture(t, async ({ release, installer, services, id }) => {
      const manifestPath = join(release, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.files.reverse();
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
      const inspected = run(installer, ["inspect", release]);
      assert.equal(inspected.status, 0, inspected.stderr);
      assert.equal(inspected.stdout.trim(), id);
      const unrelated = join(dirname(services), "unrelated");
      await writeFile(unrelated, "preserved", { mode: 0o600 });
      const priorUmask = process.umask(0o077);
      const staged = run(installer, ["stage", release, "--test-services-root", services]);
      process.umask(priorUmask);
      assert.equal(staged.status, 0, staged.stderr);
      assert.equal(staged.stdout.trim(), id);
      assert.equal(await readFile(unrelated, "utf8"), "preserved");
      const destination = join(services, "releases", id);
      assert.equal((await lstat(destination)).mode & 0o7777, 0o555);
      assert.equal((await lstat(join(destination, "manifest.json"))).mode & 0o7777, 0o444);
      assert.deepEqual((await readdir(services)).sort(), ["releases"]);
      const launched = spawnSync(
        join(destination, "payload/launchers/Ellie Coordinator.app/Contents/MacOS/EllieService"),
        ["--launch-agent"],
        { cwd: destination, encoding: "utf8", timeout: 15_000 },
      );
      assert.equal(launched.status, 0, launched.stderr);
      const restaged = run(installer, ["stage", release, "--test-services-root", services]);
      assert.equal(restaged.status, 0, restaged.stderr);
    });
  },
);

test(
  "native installer rejects linked, corrupt, extra, hardlinked and unsafe payloads",
  options,
  async (t) => {
    await withFixture(t, async ({ root, release, installer, services }) => {
      const rejectCopy = async (name: string, mutate: (copy: string) => Promise<void>) => {
        const copy = join(root, name);
        await cp(release, copy, { recursive: true, preserveTimestamps: true });
        await mutate(copy);
        assert.notEqual(run(installer, ["inspect", copy]).status, 0, name);
        assert.deepEqual(await readdir(services), []);
      };
      await rejectCopy("corrupt", (copy) => writeFile(join(copy, "payload/bin/node"), "changed"));
      await rejectCopy("extra", (copy) => writeFile(join(copy, "payload/extra"), "extra"));
      await rejectCopy("mode", (copy) => chmod(join(copy, "payload/bin/node"), 0o777));
      await rejectCopy("terminal-lf", async (copy) => {
        const path = join(copy, "manifest.json");
        const manifest = JSON.parse(await readFile(path, "utf8"));
        manifest.productVersion += "\n";
        await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
      });
      await rejectCopy("unknown-manifest-field", async (copy) => {
        const path = join(copy, "manifest.json");
        const manifest = JSON.parse(await readFile(path, "utf8"));
        manifest.releaseID = "untrusted";
        await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
      });
      await rejectCopy("missing-cli-entrypoint", async (copy) => {
        await rm(join(copy, "payload/lib/ellie/apps/cli/src/main.ts"));
        await refreshManifestFiles(copy);
      });
      for (const suffix of ["\n", "\r", "\r\n", "x"]) {
        await rejectCopy(`revision-${JSON.stringify(suffix)}`, async (copy) => {
          const path = join(copy, "manifest.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          manifest.sourceRevision += suffix;
          await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
        });
      }
      await rejectCopy("excess-directories", async (copy) => {
        for (let index = 0; index < 129; index += 1)
          await mkdir(join(copy, "payload", `extra-${index}`));
      });
      await rejectCopy("undeclared-empty-directory", (copy) => mkdir(join(copy, "payload/empty")));
      await rejectCopy("excess-depth", async (copy) => {
        await mkdir(join(copy, "payload", ...Array.from({ length: 18 }, (_, i) => `d${i}`)), {
          recursive: true,
        });
      });
      await rejectCopy("symlink", async (copy) => {
        await rm(join(copy, "payload/bin/node"));
        await symlink("/bin/sh", join(copy, "payload/bin/node"));
      });
      await rejectCopy("hardlink", async (copy) => {
        await rm(join(copy, "payload/bin/node"));
        await link(join(copy, "SOURCE.txt"), join(copy, "payload/bin/node"));
      });
      await rejectCopy("fifo", async (copy) => {
        await rm(join(copy, "payload/bin/node"));
        execFileSync("/usr/bin/mkfifo", [join(copy, "payload/bin/node")]);
      });
      await rejectCopy("wrong-signing-identity", async (copy) => {
        const helper = join(copy, "payload/helpers/ellie-macos");
        execFileSync("/usr/bin/codesign", [
          "--force",
          "--sign",
          "-",
          "--identifier",
          "org.ellie.wrong",
          helper,
        ]);
        await refreshManifestFiles(copy);
      });
      const linkedParent = join(root, "linked-parent");
      await symlink(root, linkedParent);
      assert.notEqual(run(installer, ["inspect", join(linkedParent, "source")]).status, 0);
      const linkedServices = join(root, "linked-services");
      await symlink(services, linkedServices);
      assert.notEqual(
        run(installer, ["stage", release, "--test-services-root", linkedServices]).status,
        0,
      );
    });
  },
);

test("copy failure and same-ID mismatch preserve prior and unrelated state", options, async (t) => {
  await withFixture(t, async ({ root, release, installer, services, id }) => {
    const unrelated = join(root, "private-state");
    await writeFile(unrelated, "unchanged", { mode: 0o600 });
    const growing = join(root, "growing-source");
    await cp(release, growing, { recursive: true, preserveTimestamps: true });
    const grew = run(installer, [
      "stage",
      growing,
      "--test-services-root",
      services,
      "--test-grow-source",
      "true",
    ]);
    assert.notEqual(grew.status, 0);
    assert.deepEqual(await readdir(join(services, "releases")).catch(() => []), []);
    const failed = run(installer, [
      "stage",
      release,
      "--test-services-root",
      services,
      "--test-fail-after",
      "3",
    ]);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /stage=copy-payload category=validation/);
    assert.deepEqual(await readdir(join(services, "releases")).catch(() => []), []);
    assert.equal(await readFile(unrelated, "utf8"), "unchanged");
    assert.equal(run(installer, ["stage", release, "--test-services-root", services]).status, 0);
    const installedManifest = join(services, "releases", id, "manifest.json");
    await chmod(installedManifest, 0o644);
    await writeFile(installedManifest, "mismatch");
    await chmod(installedManifest, 0o444);
    assert.notEqual(run(installer, ["stage", release, "--test-services-root", services]).status, 0);
    assert.equal(await readFile(installedManifest, "utf8"), "mismatch");
    assert.equal(await readFile(unrelated, "utf8"), "unchanged");
  });
});

test(
  "publication races and post-rename failure preserve unselected releases",
  options,
  async (t) => {
    await withFixture(t, async ({ release, installer, services, id }) => {
      const incomplete = run(installer, [
        "stage",
        release,
        "--test-services-root",
        services,
        "--test-fail-cleanup",
        "true",
      ]);
      assert.notEqual(incomplete.status, 0);
      assert.match(incomplete.stderr, /could not be fully removed/);
      const releases = join(services, "releases");
      const evidence = (await readdir(releases)).filter((name) => name.startsWith(".stage-"));
      assert.equal(evidence.length, 1);
      const evidenceName = evidence[0];
      assert.ok(evidenceName);
      await rm(join(releases, evidenceName), { recursive: true });

      const competing = run(installer, [
        "stage",
        release,
        "--test-services-root",
        services,
        "--test-create-competing-release",
        "true",
      ]);
      assert.notEqual(competing.status, 0);
      const final = join(services, "releases", id);
      assert.deepEqual(await readdir(final), []);
      assert.deepEqual(await readdir(join(services, "releases")), [id]);
      await rm(final, { recursive: true });

      const uncertain = run(installer, [
        "stage",
        release,
        "--test-services-root",
        services,
        "--test-fail-after-rename",
        "true",
      ]);
      assert.notEqual(uncertain.status, 0);
      assert.match(uncertain.stderr, /may have staged an unselected service release/);
      const incompleteRelease = join(services, "releases", id);
      assert.equal((await lstat(incompleteRelease)).mode & 0o7777, 0o700);
      const refusedLaunch = spawnSync(
        join(
          incompleteRelease,
          "payload/launchers/Ellie Coordinator.app/Contents/MacOS/EllieService",
        ),
        ["--launch-agent"],
        { cwd: incompleteRelease, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
      );
      assert.notEqual(refusedLaunch.status, 0);

      const mismatched = join(dirname(release), "mismatched-retry");
      await cp(release, mismatched, { recursive: true, preserveTimestamps: true });
      const mismatchedManifestPath = join(mismatched, "manifest.json");
      const mismatchedManifest = JSON.parse(await readFile(mismatchedManifestPath, "utf8"));
      mismatchedManifest.files.reverse();
      await writeFile(mismatchedManifestPath, `${JSON.stringify(mismatchedManifest, null, 2)}\n`, {
        mode: 0o644,
      });
      assert.notEqual(
        run(installer, ["stage", mismatched, "--test-services-root", services]).status,
        0,
      );
      assert.equal((await lstat(incompleteRelease)).mode & 0o7777, 0o700);

      const staged = run(installer, ["stage", release, "--test-services-root", services]);
      assert.equal(staged.status, 0, staged.stderr);
      assert.equal((await lstat(incompleteRelease)).mode & 0o7777, 0o555);
    });
  },
);

test(
  "selection preflight reports readiness without changing synthetic homes",
  { ...options, timeout: 30_000 },
  async (t) => {
    await withFixture(t, async ({ root, release, installer, id }) => {
      const prepareHome = async (name: string, destinations = false) => {
        const home = join(root, name);
        const services = join(home, "Library/Application Support/Ellie/Services");
        await mkdir(services, { recursive: true, mode: 0o700 });
        await chmod(join(home, "Library"), 0o700);
        await chmod(join(home, "Library/Application Support"), 0o700);
        await chmod(join(home, "Library/Application Support/Ellie"), 0o700);
        if (destinations) {
          await mkdir(join(home, "Applications"), { mode: 0o700 });
          await mkdir(join(home, "Library/LaunchAgents"), { mode: 0o700 });
        }
        assert.equal(
          run(installer, ["stage", release, "--test-services-root", services]).status,
          0,
        );
        return { home, services };
      };
      const preflight = (
        home: string,
        roles: "coordinator" | "node" | "coordinator,node",
        status:
          | "ready"
          | "loaded"
          | "busy"
          | "recovery_required"
          | "destination_conflict"
          | "candidate_invalid"
          | "unavailable",
        extra: string[] = [],
        releaseID = id,
      ) => {
        const result = run(installer, [
          "preflight-select",
          releaseID,
          "--roles",
          roles,
          "--test-home-root",
          home,
          ...extra,
        ]);
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, status === "ready" ? 0 : 1, result.stderr);
        const expected = {
          command: "preflight-select",
          ready: status === "ready",
          releaseID,
          roles: roles.split(","),
          status,
          version: 1,
        };
        assert.equal(result.stdout, canonicalJSON(expected));
        assert.deepEqual(JSON.parse(result.stdout), expected);
      };

      const fresh = await prepareHome("preflight-fresh");
      const freshBefore = await exactTree(fresh.home);
      preflight(fresh.home, "coordinator,node", "ready");
      assert.deepEqual(await exactTree(fresh.home), freshBefore);
      assert.equal(
        await lstat(join(fresh.home, "Applications"))
          .then(() => true)
          .catch(() => false),
        false,
      );
      assert.equal(
        await lstat(join(fresh.home, "Library/LaunchAgents"))
          .then(() => true)
          .catch(() => false),
        false,
      );
      assert.equal(
        await lstat(join(fresh.services, "selection.lock"))
          .then(() => true)
          .catch(() => false),
        false,
      );

      const recoveredFresh = await prepareHome("preflight-recovered-fresh");
      assert.equal(run(installer, ["recover", "--test-home-root", recoveredFresh.home]).status, 0);
      const recoveredFreshBefore = await exactTree(recoveredFresh.home);
      preflight(recoveredFresh.home, "coordinator", "ready");
      assert.deepEqual(await exactTree(recoveredFresh.home), recoveredFreshBefore);
      assert.deepEqual(await readdir(join(recoveredFresh.services, "receipts")), []);

      const lockOnly = await prepareHome("preflight-lock-only");
      await writeFile(join(lockOnly.services, "selection.lock"), "", { mode: 0o600 });
      preflight(lockOnly.home, "coordinator", "recovery_required");

      const receiptsOnly = await prepareHome("preflight-receipts-only");
      await mkdir(join(receiptsOnly.services, "receipts"), { mode: 0o700 });
      preflight(receiptsOnly.home, "coordinator", "recovery_required");

      const selected = await prepareHome("preflight-selected", true);
      assert.equal(
        run(installer, ["select", id, "--roles", "coordinator", "--test-home-root", selected.home])
          .status,
        0,
      );
      const selectedBefore = await exactTree(selected.home);
      preflight(selected.home, "coordinator", "ready");
      assert.deepEqual(await exactTree(selected.home), selectedBefore);
      preflight(selected.home, "coordinator", "loaded", ["--test-loaded", "coordinator"]);
      assert.deepEqual(await exactTree(selected.home), selectedBefore);
      preflight(selected.home, "coordinator", "unavailable", [
        "--test-preflight-launchctl-unavailable",
      ]);
      assert.deepEqual(await exactTree(selected.home), selectedBefore);

      const selectedLock = join(selected.services, "selection.lock");
      const selectedReceipts = join(selected.services, "receipts");
      await rm(selectedLock);
      preflight(selected.home, "coordinator", "recovery_required");
      await writeFile(selectedLock, "", { mode: 0o600 });
      await chmod(selectedReceipts, 0o755);
      preflight(selected.home, "coordinator", "recovery_required");
      await chmod(selectedReceipts, 0o700);

      for (const target of ["services-mode", "receipts-mode", "lock-mode"]) {
        preflight(selected.home, "coordinator", "recovery_required", [
          "--test-preflight-before-final",
          target,
        ]);
        await chmod(
          target === "services-mode"
            ? selected.services
            : target === "receipts-mode"
              ? selectedReceipts
              : selectedLock,
          target === "lock-mode" ? 0o600 : 0o700,
        );
      }

      const unsafeCandidate = join(fresh.services, "releases", id, "manifest.json");
      await chmod(unsafeCandidate, 0o600);
      const candidateBefore = await exactTree(fresh.home);
      preflight(fresh.home, "coordinator", "candidate_invalid");
      assert.deepEqual(await exactTree(fresh.home), candidateBefore);
      await chmod(unsafeCandidate, 0o444);

      const receipt = join(selected.services, "receipts/installed.json");
      const receiptBytes = await readFile(receipt);
      await chmod(receipt, 0o600);
      await writeFile(receipt, "malformed\n");
      const receiptBefore = await exactTree(selected.home);
      preflight(selected.home, "coordinator", "recovery_required");
      assert.deepEqual(await exactTree(selected.home), receiptBefore);
      await writeFile(receipt, receiptBytes);

      const collision = await prepareHome("preflight-collision", true);
      await mkdir(join(collision.home, "Applications/Ellie Coordinator.app"), { mode: 0o700 });
      const collisionBefore = await exactTree(collision.home);
      preflight(collision.home, "coordinator", "destination_conflict");
      assert.deepEqual(await exactTree(collision.home), collisionBefore);

      const pending = await prepareHome("preflight-pending");
      for (const relativeName of [
        "selection-journal.json",
        "migration-switch-journal.json",
        "legacy-restore-journal.json",
        "migrations/migration-preparation.json",
      ]) {
        const path = join(pending.services, relativeName);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, "malformed\n", { mode: 0o600 });
        const before = await exactTree(pending.home);
        preflight(pending.home, "coordinator", "recovery_required");
        assert.deepEqual(await exactTree(pending.home), before);
        await rm(path);
      }
      await writeFile(join(pending.services, "selection-journal.json"), "malformed\n", {
        mode: 0o600,
      });
      preflight(pending.home, "coordinator", "recovery_required", [], `${id}-missing`);
      await rm(join(pending.services, "selection-journal.json"));

      const contention = await prepareHome("preflight-contention");
      const holder = spawn(
        installer,
        ["recover", "--test-home-root", contention.home, "--test-hold-lock-ms", "500"],
        { stdio: "ignore" },
      );
      const holderExit = new Promise<number | null>((resolve) => holder.once("exit", resolve));
      const ready = join(contention.services, ".test-selection-lock-ready");
      const deadline = performance.now() + 2_000;
      while (
        !(await lstat(ready)
          .then(() => true)
          .catch(() => false))
      ) {
        assert.ok(performance.now() < deadline, "selection lock holder did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const contentionBefore = await exactTree(contention.home);
      preflight(contention.home, "coordinator", "busy");
      assert.deepEqual(await exactTree(contention.home), contentionBefore);
      assert.equal(await holderExit, 0);

      const malformedHome = join(root, "preflight-malformed");
      for (const args of [
        ["preflight-select"],
        ["preflight-select", id, "--roles", "node,coordinator"],
        ["preflight-select", `${id}\n`, "--roles", "coordinator"],
        ["preflight-select", id, "--roles", "coordinator", "extra"],
      ]) {
        const result = run(installer, [...args, "--test-home-root", malformedHome]);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, "");
        assert.equal(
          await lstat(malformedHome)
            .then(() => true)
            .catch(() => false),
          false,
        );
      }
    });
  },
);

test(
  "native selection publishes fixed stopped roles and preserves unselected role state",
  { ...options, timeout: 20_000 },
  async (t) => {
    await withFixture(t, async ({ root, release, installer, id }) => {
      const prepareSelectionHome = async (name: string) => {
        const candidate = join(root, name);
        const candidateServices = join(candidate, "Library/Application Support/Ellie/Services");
        await mkdir(candidateServices, { recursive: true, mode: 0o700 });
        await chmod(join(candidate, "Library"), 0o700);
        await chmod(join(candidate, "Library/Application Support"), 0o700);
        await chmod(join(candidate, "Library/Application Support/Ellie"), 0o700);
        await mkdir(join(candidate, "Applications"), { mode: 0o700 });
        await mkdir(join(candidate, "Library/LaunchAgents"), { mode: 0o700 });
        assert.equal(
          run(installer, ["stage", release, "--test-services-root", candidateServices]).status,
          0,
        );
        return { home: candidate, services: candidateServices };
      };
      const home = join(root, "selection-home");
      const services = join(home, "Library/Application Support/Ellie/Services");
      await mkdir(services, { recursive: true, mode: 0o700 });
      await chmod(join(home, "Library"), 0o700);
      await chmod(join(home, "Library/Application Support"), 0o700);
      await chmod(join(home, "Library/Application Support/Ellie"), 0o700);
      await mkdir(join(home, "Applications"), { mode: 0o700 });
      await mkdir(join(home, "Library/LaunchAgents"), { mode: 0o700 });
      assert.equal(run(installer, ["stage", release, "--test-services-root", services]).status, 0);

      const selectCoordinator = run(installer, [
        "select",
        id,
        "--roles",
        "coordinator",
        "--test-home-root",
        home,
      ]);
      assert.equal(selectCoordinator.status, 0, selectCoordinator.stderr);
      assert.equal(
        await lstat(join(home, "Applications/Ellie Coordinator.app")).then(() => true),
        true,
      );
      assert.equal(
        await lstat(join(home, "Applications/Ellie Node.app"))
          .then(() => true)
          .catch(() => false),
        false,
      );
      const firstReceipt = await readFile(join(services, "receipts/installed.json"), "utf8");
      assert.match(firstReceipt, /"coordinator"/);
      assert.match(firstReceipt, /"node":null/);

      const selectNode = run(installer, [
        "select",
        id,
        "--roles",
        "node",
        "--test-home-root",
        home,
      ]);
      assert.equal(selectNode.status, 0, selectNode.stderr);
      const secondReceipt = await readFile(join(services, "receipts/installed.json"), "utf8");
      assert.match(secondReceipt, /"coordinator"/);
      assert.doesNotMatch(secondReceipt, /"node":null/);
      assert.equal(
        run(installer, ["select", id, "--roles", "node", "--test-home-root", home]).status,
        0,
      );

      const upgradeRelease = join(root, "upgrade-source");
      await cp(release, upgradeRelease, { recursive: true });
      const upgradeRevision = "d".repeat(40);
      const upgradeManifestPath = join(upgradeRelease, "manifest.json");
      const upgradeManifest = JSON.parse(await readFile(upgradeManifestPath, "utf8"));
      upgradeManifest.productVersion = "0.1.1";
      upgradeManifest.sourceRevision = upgradeRevision;
      await writeFile(upgradeManifestPath, `${JSON.stringify(upgradeManifest, null, 2)}\n`, {
        mode: 0o644,
      });
      await writeFile(
        join(upgradeRelease, "SOURCE.txt"),
        `Ellie service payload\nSource revision: ${upgradeRevision}\nNode.js: v24.21.0\nNode archive SHA-256: ${"b".repeat(64)}\nMinimum macOS: 14.0\nHelper: org.ellie.helper (development-ad-hoc)\n`,
        { mode: 0o644 },
      );
      const upgradeID = `0.1.1-${upgradeRevision}-${upgradeManifest.architecture}`;
      assert.equal(
        run(installer, ["stage", upgradeRelease, "--test-services-root", services]).status,
        0,
      );
      const upgraded = run(installer, [
        "select",
        upgradeID,
        "--roles",
        "coordinator",
        "--test-home-root",
        home,
      ]);
      assert.equal(upgraded.status, 0, upgraded.stderr);
      assert.equal(
        (await lstat(join(home, "Applications/Ellie Coordinator.app"))).mode & 0o7777,
        0o555,
      );
      const upgradedReceipt = await readFile(join(services, "receipts/installed.json"), "utf8");

      for (const point of [
        "after-old-app-unseal-coordinator",
        "after-old-app-backup-coordinator",
      ]) {
        const crashed = run(installer, [
          "select",
          id,
          "--roles",
          "coordinator",
          "--test-home-root",
          home,
          "--test-fault",
          point,
        ]);
        assert.equal(crashed.status, 86, `${point}: ${crashed.stderr}`);
        const recovered = run(installer, ["recover", "--test-home-root", home]);
        assert.equal(recovered.status, 0, `${point}: ${recovered.stderr}`);
        assert.equal(
          await readFile(join(services, "receipts/installed.json"), "utf8"),
          upgradedReceipt,
        );
        assert.equal(
          (await lstat(join(home, "Applications/Ellie Coordinator.app"))).mode & 0o7777,
          0o555,
        );
      }

      for (const point of ["after-old-app-unseal-coordinator", "after-app-seal-coordinator"]) {
        const rejected = run(installer, [
          "select",
          id,
          "--roles",
          "coordinator",
          "--test-home-root",
          home,
          "--test-reject-at",
          point,
        ]);
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /requires recovery/);
        assert.equal(run(installer, ["recover", "--test-home-root", home]).status, 0);
        assert.equal(
          await readFile(join(services, "receipts/installed.json"), "utf8"),
          upgradedReceipt,
        );
      }

      for (const point of [
        "after-old-app-unseal-coordinator",
        "after-old-app-backup-coordinator",
        "after-app-move-coordinator",
        "after-plist-move-coordinator",
        "after-receipt",
      ]) {
        const update = await prepareSelectionHome(`update-${point}`);
        assert.equal(
          run(installer, ["stage", upgradeRelease, "--test-services-root", update.services]).status,
          0,
        );
        assert.equal(
          run(installer, [
            "select",
            id,
            "--roles",
            "coordinator,node",
            "--test-home-root",
            update.home,
          ]).status,
          0,
        );
        const crashed = run(installer, [
          "select",
          upgradeID,
          "--roles",
          "coordinator",
          "--test-home-root",
          update.home,
          "--test-fault",
          point,
        ]);
        assert.equal(crashed.status, 86, `${point}: ${crashed.stderr}`);
        const recovered = run(installer, ["recover", "--test-home-root", update.home]);
        assert.equal(recovered.status, 0, `${point}: ${recovered.stderr}`);
        const receipt = JSON.parse(
          await readFile(join(update.services, "receipts/installed.json"), "utf8"),
        );
        assert.equal(receipt.coordinator.releaseID, point === "after-receipt" ? upgradeID : id);
        assert.equal(receipt.node.releaseID, id);
        assert.equal(
          (await lstat(join(update.home, "Applications/Ellie Coordinator.app"))).mode & 0o7777,
          0o555,
        );
      }

      const loaded = run(installer, [
        "select",
        id,
        "--roles",
        "coordinator",
        "--test-home-root",
        home,
        "--test-loaded",
        "coordinator",
      ]);
      assert.notEqual(loaded.status, 0);
      assert.equal(
        await readFile(join(services, "receipts/installed.json"), "utf8"),
        upgradedReceipt,
      );

      await chmod(join(home, "Applications/Ellie Node.app"), 0o700);
      const tamperedNoop = run(installer, [
        "select",
        id,
        "--roles",
        "node",
        "--test-home-root",
        home,
      ]);
      assert.notEqual(tamperedNoop.status, 0);
      await chmod(join(home, "Applications/Ellie Node.app"), 0o555);

      const invalidHome = join(root, "invalid-selection-home");
      for (const roles of ["coordinator,bogus", "coordinator,", "node,coordinator"]) {
        assert.notEqual(
          run(installer, ["select", id, "--roles", roles, "--test-home-root", invalidHome]).status,
          0,
        );
      }
      assert.equal(
        await lstat(invalidHome)
          .then(() => true)
          .catch(() => false),
        false,
      );

      const unsafeParent = await prepareSelectionHome("unsafe-parent");
      await rm(join(unsafeParent.home, "Applications"), { recursive: true });
      await rm(join(unsafeParent.home, "Library/LaunchAgents"), { recursive: true });
      await chmod(join(unsafeParent.home, "Library/Application Support"), 0o777);
      assert.notEqual(
        run(installer, [
          "select",
          id,
          "--roles",
          "coordinator",
          "--test-home-root",
          unsafeParent.home,
        ]).status,
        0,
      );
      assert.equal(
        await lstat(join(unsafeParent.home, "Applications"))
          .then(() => true)
          .catch(() => false),
        false,
      );
      assert.equal(
        await lstat(join(unsafeParent.home, "Library/LaunchAgents"))
          .then(() => true)
          .catch(() => false),
        false,
      );
      await chmod(join(unsafeParent.home, "Library/Application Support"), 0o700);

      const symlinkHome = join(root, "symlink-ancestor-home");
      const symlinkLibrary = join(root, "symlink-ancestor-target");
      const symlinkServices = join(symlinkLibrary, "Application Support/Ellie/Services");
      await mkdir(symlinkHome, { mode: 0o700 });
      await mkdir(symlinkServices, { recursive: true, mode: 0o700 });
      await chmod(join(symlinkLibrary, "Application Support"), 0o700);
      await chmod(join(symlinkLibrary, "Application Support/Ellie"), 0o700);
      assert.equal(
        run(installer, ["stage", release, "--test-services-root", symlinkServices]).status,
        0,
      );
      await symlink(symlinkLibrary, join(symlinkHome, "Library"));
      assert.notEqual(
        run(installer, ["select", id, "--roles", "coordinator", "--test-home-root", symlinkHome])
          .status,
        0,
      );
      assert.equal(
        await lstat(join(symlinkHome, "Applications"))
          .then(() => true)
          .catch(() => false),
        false,
      );

      const postJournalFailure = await prepareSelectionHome("post-journal-failure");
      const failedAfterIntent = run(installer, [
        "select",
        id,
        "--roles",
        "coordinator",
        "--test-home-root",
        postJournalFailure.home,
        "--test-fail-after-journal",
      ]);
      assert.notEqual(failedAfterIntent.status, 0);
      assert.match(failedAfterIntent.stderr, /requires recovery/);
      assert.equal(
        await lstat(join(postJournalFailure.services, "selection-journal.json")).then(() => true),
        true,
      );
      assert.equal(
        run(installer, ["recover", "--test-home-root", postJournalFailure.home]).status,
        0,
      );

      for (const point of [
        "before-journal-fsync",
        "after-journal-fsync",
        "after-journal",
        "after-app-coordinator",
        "after-plist-coordinator",
        "after-app-move-coordinator",
        "after-plist-move-coordinator",
        "after-receipt",
      ]) {
        const { home: crashHome, services: crashServices } = await prepareSelectionHome(
          `crash-${point}`,
        );
        const crashed = run(installer, [
          "select",
          id,
          "--roles",
          "coordinator",
          "--test-home-root",
          crashHome,
          "--test-fault",
          point,
        ]);
        assert.equal(crashed.status, 86, `${point}: ${crashed.stderr}`);
        const recovered = run(installer, ["recover", "--test-home-root", crashHome]);
        assert.equal(recovered.status, 0, `${point}: ${recovered.stderr}`);
        assert.equal(
          await lstat(join(crashServices, "selection-journal.json"))
            .then(() => true)
            .catch(() => false),
          false,
        );
        assert.equal(
          await lstat(join(crashHome, "Applications/Ellie Coordinator.app"))
            .then(() => true)
            .catch(() => false),
          point === "after-receipt",
          point,
        );
      }

      const finalRace = await prepareSelectionHome("final-loaded-race");
      const stoppedLate = run(installer, [
        "select",
        id,
        "--roles",
        "coordinator",
        "--test-home-root",
        finalRace.home,
        "--test-load-after-preflight",
      ]);
      assert.notEqual(stoppedLate.status, 0);
      assert.match(stoppedLate.stderr, /requires every selected role to be unloaded/);
      assert.equal(run(installer, ["recover", "--test-home-root", finalRace.home]).status, 0);
      assert.equal(
        await lstat(join(finalRace.home, "Applications/Ellie Coordinator.app"))
          .then(() => true)
          .catch(() => false),
        false,
      );

      const contention = await prepareSelectionHome("selector-contention");
      const holder = spawn(
        installer,
        ["recover", "--test-home-root", contention.home, "--test-hold-lock-ms", "500"],
        { stdio: "ignore" },
      );
      const holderExit = new Promise<number | null>((resolve) => holder.once("exit", resolve));
      const ready = join(contention.services, ".test-selection-lock-ready");
      const deadline = Date.now() + 2_000;
      while (
        !(await lstat(ready)
          .then(() => true)
          .catch(() => false))
      ) {
        assert.ok(Date.now() < deadline, "selection lock holder did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.notEqual(run(installer, ["recover", "--test-home-root", contention.home]).status, 0);
      assert.equal(await holderExit, 0);

      const collision = await prepareSelectionHome("developer-collision");
      const developerApp = join(collision.home, "Applications/Ellie Coordinator.app");
      await mkdir(developerApp, { mode: 0o700 });
      await writeFile(join(developerApp, "ellie-build.json"), "developer\n", { mode: 0o600 });
      const developerBytes = await readFile(join(developerApp, "ellie-build.json"));
      assert.notEqual(
        run(installer, ["select", id, "--roles", "coordinator", "--test-home-root", collision.home])
          .status,
        0,
      );
      assert.deepEqual(await readFile(join(developerApp, "ellie-build.json")), developerBytes);
    });
  },
);

test(
  "native lifecycle validates selection and sends only fixed bounded launchctl operations",
  // This aggregate includes native fixture compilation/signing and intentionally slow lifecycle probes.
  { ...options, timeout: 30_000 },
  async (t) => {
    await withFixture(t, async ({ root, release, installer, id }) => {
      const fresh = join(root, "fresh-lifecycle-home");
      await mkdir(fresh, { mode: 0o700 });
      const freshStatus = run(installer, [
        "status",
        "coordinator",
        "--test-home-root",
        fresh,
        "--test-launchctl",
        join(root, "unused-launchctl"),
      ]);
      assert.equal(freshStatus.status, 0, freshStatus.stderr);
      assert.deepEqual(JSON.parse(freshStatus.stdout), {
        role: "coordinator",
        selected: false,
        state: "unselected",
      });
      assert.equal(
        await lstat(join(fresh, "Library"))
          .then(() => true)
          .catch(() => false),
        false,
      );

      const home = join(root, "lifecycle-home");
      const services = join(home, "Library/Application Support/Ellie/Services");
      await mkdir(services, { recursive: true, mode: 0o700 });
      await chmod(join(home, "Library"), 0o700);
      await chmod(join(home, "Library/Application Support"), 0o700);
      await chmod(join(home, "Library/Application Support/Ellie"), 0o700);
      await mkdir(join(home, "Applications"), { mode: 0o700 });
      await mkdir(join(home, "Library/LaunchAgents"), { mode: 0o700 });
      assert.equal(run(installer, ["stage", release, "--test-services-root", services]).status, 0);
      assert.equal(
        run(installer, ["select", id, "--roles", "coordinator", "--test-home-root", home]).status,
        0,
      );

      const launchctl = join(root, "fake-launchctl.sh");
      const state = join(root, "fake-launchctl-state");
      const enabled = join(root, "fake-launchctl-enabled");
      const foreign = join(root, "fake-launchctl-foreign");
      const malformed = join(root, "fake-launchctl-malformed");
      const nestedSpoof = join(root, "fake-launchctl-nested-spoof");
      const loadedOutput = join(root, "fake-launchctl-loaded-output");
      const duplicateBlock = join(root, "fake-launchctl-duplicate-block");
      const oversized = join(root, "fake-launchctl-oversized");
      const unknownDisabled = join(root, "fake-launchctl-unknown-disabled");
      const disabledValue = join(root, "fake-launchctl-disabled-value");
      const disabledOutput = join(root, "fake-launchctl-disabled-output");
      const guiUnavailable = join(root, "fake-launchctl-gui-unavailable");
      const failAfterMutation = join(root, "fake-launchctl-fail-after-mutation");
      const failAfterBootout = join(root, "fake-launchctl-fail-after-bootout");
      const disableLeavesEnabledUnloads = join(root, "fake-launchctl-disable-leaves-enabled");
      const queryFailed = join(root, "fake-launchctl-query-failed");
      const swapAncestor = join(root, "fake-launchctl-swap-ancestor");
      const swapCount = join(root, "fake-launchctl-swap-count");
      const launchAgents = join(home, "Library/LaunchAgents");
      const launchAgentsBackup = join(home, "Library/LaunchAgents.acceptance-backup");
      const slow = join(root, "fake-launchctl-slow");
      const log = join(root, "fake-launchctl.log");
      const uid = process.getuid!();
      const label = "org.ellie.assistant.coordinator";
      const target = `gui/${uid}/${label}`;
      const plist = join(home, `Library/LaunchAgents/${label}.plist`);
      const executable = join(
        home,
        "Applications/Ellie Coordinator.app/Contents/MacOS/EllieService",
      );
      const shell = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
      await writeFile(
        launchctl,
        `#!/bin/sh\n{ printf 'CALL\\n'; for arg in "$@"; do printf 'ARG:%s\\n' "$arg"; done; printf 'END\\n'; } >> ${shell(log)}\nif [ "$1" = print ] && [ "$2" = gui/${uid} ] && [ "$#" = 2 ]; then [ -f ${shell(guiUnavailable)} ] && exit 64; exit 0; fi\nif [ "$1" = print-disabled ] && [ "$2" = gui/${uid} ] && [ "$#" = 2 ]; then\n  if [ -f ${shell(unknownDisabled)} ]; then value=mystery; elif [ -f ${shell(disabledValue)} ]; then value=$(/bin/cat ${shell(disabledValue)}); elif [ -f ${shell(enabled)} ]; then value=enabled; else value=disabled; fi\n  if [ -f ${shell(disabledOutput)} ]; then /bin/cat ${shell(disabledOutput)}; exit 0; fi\n  printf '\\ndisabled services = {\\n\\t\\t"${label}" => %s\\n}\\n' "$value"; exit 0\nfi\nif [ "$1" = print ] && [ "$2" = ${target} ] && [ "$#" = 2 ]; then\n  [ -f ${shell(queryFailed)} ] && exit 64\n  if [ -f ${shell(swapAncestor)} ]; then count=0; [ -f ${shell(swapCount)} ] && count=$(/bin/cat ${shell(swapCount)}); count=$((count + 1)); printf '%s\\n' "$count" > ${shell(swapCount)}; if [ "$count" = 2 ]; then /bin/mv ${shell(launchAgents)} ${shell(launchAgentsBackup)}; /bin/mkdir -m 700 ${shell(launchAgents)}; /bin/cp ${shell(join(home, `Library/LaunchAgents/${label}.plist`))} 2>/dev/null || /bin/cp ${shell(join(home, `Library/LaunchAgents.acceptance-backup/${label}.plist`))} ${shell(plist)}; fi; fi\n  [ -f ${shell(state)} ] || exit 113\n  if [ -f ${shell(loadedOutput)} ]; then /bin/cat ${shell(loadedOutput)}; exit 0; fi\n  if [ -f ${shell(slow)} ]; then /bin/sleep 3; fi\n  if [ -f ${shell(oversized)} ]; then i=0; while [ "$i" -lt 70000 ]; do printf x; i=$((i + 1)); done; exit 0; fi\n  if [ -f ${shell(malformed)} ]; then printf '${target} = {\\n\\tpath = ${plist}\\n\\tpath = /tmp/duplicate.plist\\n}\\n'; exit 0; fi\n  if [ -f ${shell(nestedSpoof)} ]; then printf '${target} = {\\n\\tpath = ${plist}\\n\\targuments = {\\n\\t\\tpath = /tmp/spoof\\n\\t}\\n}\\n'; exit 0; fi\n  if [ -f ${shell(duplicateBlock)} ]; then printf '${target} = {\\n\\targuments = {\\n\\t}\\n\\targuments = {\\n\\t}\\n}\\n'; exit 0; fi\n  if [ -f ${shell(foreign)} ]; then path=/tmp/unmanaged.plist; else path=${shell(plist)}; fi\n  printf '${target} = {\\n\\tactive count = 1\\n\\tpath = %s\\n\\ttype = LaunchAgent\\n\\tstate = running\\n\\tprogram = ${executable}\\n\\targuments = {\\n\\t\\t${executable}\\n\\t\\t--launch-agent\\n\\t}\\n\\tenvironment = {\\n\\t\\tHOME => /redacted\\n\\t}\\n\\tpid = 123\\n}\\n' "$path"; exit 0\nfi\nif [ "$1" = enable ] && [ "$2" = ${target} ] && [ "$#" = 2 ]; then /usr/bin/touch ${shell(enabled)}; [ -f ${shell(failAfterMutation)} ] && /usr/bin/touch ${shell(queryFailed)}; exit 0; fi\nif [ "$1" = disable ] && [ "$2" = ${target} ] && [ "$#" = 2 ]; then if [ -f ${shell(disableLeavesEnabledUnloads)} ]; then /bin/rm -f ${shell(state)}; else /bin/rm -f ${shell(enabled)}; fi; [ -f ${shell(failAfterMutation)} ] && /usr/bin/touch ${shell(queryFailed)}; exit 0; fi\nif [ "$1" = bootstrap ] && [ "$2" = gui/${uid} ] && [ "$3" = ${shell(plist)} ] && [ "$#" = 3 ]; then /usr/bin/touch ${shell(state)}; [ -f ${shell(failAfterMutation)} ] && /usr/bin/touch ${shell(queryFailed)}; exit 0; fi\nif [ "$1" = bootout ] && [ "$2" = gui/${uid} ] && [ "$3" = ${shell(plist)} ] && [ "$#" = 3 ]; then /bin/rm -f ${shell(state)}; [ -f ${shell(failAfterBootout)} ] && /usr/bin/touch ${shell(queryFailed)}; exit 0; fi\nexit 64\n`,
        { mode: 0o700 },
      );
      await chmod(launchctl, 0o700);
      const lifecycle = (command: string) =>
        run(installer, [
          command,
          "coordinator",
          "--test-home-root",
          home,
          "--test-launchctl",
          launchctl,
        ]);

      const start = lifecycle("start");
      assert.equal(start.status, 0, start.stderr);
      assert.equal(JSON.parse(start.stdout).state, "running");
      const running = lifecycle("status");
      assert.equal(running.status, 0, running.stderr);
      assert.deepEqual(JSON.parse(running.stdout), {
        enabled: true,
        loadedFromSelectedPlist: true,
        releaseID: id,
        role: "coordinator",
        selected: true,
        state: "running",
      });
      const coalitionPrint =
        `${target} = {\n\tactive count = 1\n\tpath = ${plist}\n\ttype = LaunchAgent\n` +
        `\tstate = running\n\tprogram = ${executable}\n\targuments = {\n` +
        `\t\t${executable}\n\t\t--launch-agent\n\t}\n\tpid = 123\n` +
        `\tresource coalition = {\n\t\tID = 1\n\t\ttype = resource\n` +
        `\t\tstate = active\n\t\tactive count = 1\n\t}\n` +
        `\tjetsam coalition = {\n\t\tID = 2\n\t\ttype = jetsam\n` +
        `\t\tstate = active\n\t\tactive count = 1\n\t}\n` +
        `\tresource limits = {\n\t\tcore (soft) => 0\n\t\tcore (hard) => 0\n\t}\n}\n`;
      await writeFile(loadedOutput, coalitionPrint);
      const coalitionStatus = lifecycle("status");
      assert.equal(coalitionStatus.status, 0, coalitionStatus.stderr);
      assert.deepEqual(JSON.parse(coalitionStatus.stdout), JSON.parse(running.stdout));
      for (const malformedOutput of [
        coalitionPrint.replace("\t\ttype = resource", "\t\tpath = /tmp/spoof"),
        coalitionPrint.replace("\t\ttype = resource", "\t\ttype = {\n\t\t}"),
        coalitionPrint.replace(
          "\t\ttype = resource",
          "\t\textra = {\n\t\t\ttype = resource\n\t\t}",
        ),
        coalitionPrint
          .replace("\t\ttype = resource", "\t\tID = 1")
          .replace("\t\tcore (soft) => 0", "\t\ttype = resource"),
      ]) {
        await writeFile(loadedOutput, malformedOutput);
        const malformedStatus = lifecycle("status");
        assert.notEqual(malformedStatus.status, 0);
        assert.match(malformedStatus.stderr, /could not verify/);
      }
      await writeFile(
        loadedOutput,
        coalitionPrint.replace(`\tpath = ${plist}`, "\tpath = /tmp/foreign.plist"),
      );
      const foreignCoalitionStatus = lifecycle("status");
      assert.equal(foreignCoalitionStatus.status, 0, foreignCoalitionStatus.stderr);
      assert.equal(JSON.parse(foreignCoalitionStatus.stdout).loadedFromSelectedPlist, false);
      await rm(loadedOutput);
      const stop = lifecycle("stop");
      assert.equal(stop.status, 0, stop.stderr);
      assert.deepEqual(JSON.parse(stop.stdout), {
        enabled: false,
        loadedFromSelectedPlist: false,
        releaseID: id,
        role: "coordinator",
        selected: true,
        state: "stopped",
      });
      // Sanitized host print-disabled output: one-tab wrappers, two-tab entries.
      const hostDisabledOutput =
        `\n\tdisabled services = {\n\t\t"${label}" => disabled\n` +
        `\t\t"com.example.unrelated" => enabled\n\t}\n`;
      await writeFile(disabledOutput, hostDisabledOutput);
      const hostStatus = lifecycle("status");
      assert.equal(hostStatus.status, 0, hostStatus.stderr);
      assert.deepEqual(JSON.parse(hostStatus.stdout), JSON.parse(stop.stdout));
      for (const malformedOutput of [
        hostDisabledOutput.replace("\n\t}\n", "\n}\n"),
        hostDisabledOutput.replace("\n\tdisabled services = {", "\ndisabled services = {"),
        hostDisabledOutput
          .replace("\n\tdisabled services = {", "\n\t\tdisabled services = {")
          .replace("\n\t}\n", "\n\t\t}\n"),
        hostDisabledOutput.replace(`\t\t"${label}"`, `\t"${label}"`),
        hostDisabledOutput.replace("\n\t}\n", `\n\t\t"${label}" => disabled\n\t}\n`),
      ]) {
        await writeFile(disabledOutput, malformedOutput);
        const malformedStatus = lifecycle("status");
        assert.notEqual(malformedStatus.status, 0);
        assert.match(malformedStatus.stderr, /could not verify/);
      }
      await rm(disabledOutput);
      const invocations = (await readFile(log, "utf8"))
        .split("CALL\n")
        .slice(1)
        .map((block) =>
          block
            .split("END\n")[0]!
            .split("\n")
            .filter(Boolean)
            .map((line) => line.replace(/^ARG:/, "")),
        );
      assert.equal(
        invocations.some((args) => args.join("\0") === ["enable", target].join("\0")),
        true,
      );
      assert.equal(
        invocations.some(
          (args) => args.join("\0") === ["bootstrap", `gui/${uid}`, plist].join("\0"),
        ),
        true,
      );
      assert.equal(
        invocations.some((args) => args.join("\0") === ["disable", target].join("\0")),
        true,
      );
      assert.equal(
        invocations.some((args) => args.join("\0") === ["bootout", `gui/${uid}`, plist].join("\0")),
        true,
      );
      assert.equal(
        invocations.some((args) => args.includes("kickstart")),
        false,
      );

      await writeFile(failAfterMutation, "fail after enable\n");
      const enableCallCount = (await readFile(log, "utf8")).split("CALL\n").length;
      const enablePartial = lifecycle("start");
      assert.notEqual(enablePartial.status, 0);
      assert.match(enablePartial.stderr, /enabled, but start was not confirmed/);
      const enableTail = (await readFile(log, "utf8")).split("CALL\n").slice(enableCallCount);
      assert.equal(
        enableTail.some((value) => value.includes("ARG:bootstrap\n")),
        false,
      );
      await rm(failAfterMutation);
      await rm(queryFailed);
      await rm(enabled);

      await writeFile(enabled, "enabled\n");
      await writeFile(failAfterMutation, "fail after bootstrap\n");
      const bootstrapUnknown = lifecycle("start");
      assert.notEqual(bootstrapUnknown.status, 0);
      assert.match(bootstrapUnknown.stderr, /start request may have taken effect/);
      await rm(failAfterMutation);
      await rm(queryFailed);
      await rm(state);

      await writeFile(state, "loaded\n");
      await writeFile(enabled, "enabled\n");
      await writeFile(failAfterMutation, "fail after disable\n");
      const disablePartial = lifecycle("stop");
      assert.notEqual(disablePartial.status, 0);
      assert.match(disablePartial.stderr, /disabled, but stop was not confirmed/);
      await rm(failAfterMutation);
      await rm(queryFailed);
      await writeFile(enabled, "enabled\n");

      await writeFile(disableLeavesEnabledUnloads, "race\n");
      const falseDisable = lifecycle("stop");
      assert.notEqual(falseDisable.status, 0);
      assert.match(falseDisable.stderr, /disabled, but stop was not confirmed/);
      await rm(disableLeavesEnabledUnloads);

      await writeFile(state, "loaded\n");
      await writeFile(failAfterBootout, "fail after bootout\n");
      const bootoutUnknown = lifecycle("stop");
      assert.notEqual(bootoutUnknown.status, 0);
      assert.match(bootoutUnknown.stderr, /stop request may have taken effect/);
      await rm(failAfterBootout);
      await rm(queryFailed);

      await writeFile(swapAncestor, "swap\n");
      const callsBeforeSwap = (await readFile(log, "utf8")).split("CALL\n").length;
      const swappedAncestor = lifecycle("start");
      assert.notEqual(swappedAncestor.status, 0);
      assert.match(swappedAncestor.stderr, /enabled, but start was not confirmed/);
      const swapCalls = (await readFile(log, "utf8")).split("CALL\n").slice(callsBeforeSwap);
      assert.equal(
        swapCalls.some((value) => value.includes("ARG:bootstrap\n")),
        false,
      );
      await rm(launchAgents, { recursive: true });
      await rename(launchAgentsBackup, launchAgents);
      await rm(swapAncestor);
      await rm(swapCount);
      await rm(enabled);

      await writeFile(state, "loaded\n");
      await writeFile(foreign, "foreign\n");
      const beforeForeign = (await readFile(log, "utf8")).split("CALL\n").length;
      const unmanaged = lifecycle("stop");
      assert.notEqual(unmanaged.status, 0);
      assert.match(unmanaged.stderr, /not the selected managed service/);
      const foreignCalls = (await readFile(log, "utf8")).split("CALL\n").slice(beforeForeign);
      assert.equal(
        foreignCalls.some((value) => value.includes("ARG:disable\n")),
        false,
      );
      assert.equal(
        foreignCalls.some((value) => value.includes("ARG:bootout\n")),
        false,
      );

      await rm(foreign);
      await writeFile(malformed, "malformed\n");
      const malformedStatus = lifecycle("status");
      assert.notEqual(malformedStatus.status, 0);
      assert.match(malformedStatus.stderr, /could not verify/);
      await rm(malformed);
      await writeFile(nestedSpoof, "nested\n");
      const spoofedStatus = lifecycle("status");
      assert.notEqual(spoofedStatus.status, 0);
      assert.match(spoofedStatus.stderr, /could not verify/);
      await rm(nestedSpoof);
      await writeFile(duplicateBlock, "duplicate\n");
      const duplicateBlockStatus = lifecycle("status");
      assert.notEqual(duplicateBlockStatus.status, 0);
      assert.match(duplicateBlockStatus.stderr, /could not verify/);
      await rm(duplicateBlock);
      await writeFile(unknownDisabled, "unknown\n");
      const unknownDisabledStatus = lifecycle("status");
      assert.notEqual(unknownDisabledStatus.status, 0);
      assert.match(unknownDisabledStatus.stderr, /could not verify/);
      await rm(unknownDisabled);
      for (const legacyValue of ["true", "false"]) {
        await writeFile(disabledValue, `${legacyValue}\n`);
        const legacyStatus = lifecycle("status");
        assert.equal(legacyStatus.status, 0, legacyStatus.stderr);
        assert.equal(JSON.parse(legacyStatus.stdout).enabled, legacyValue === "false");
      }
      await rm(disabledValue);
      await writeFile(guiUnavailable, "unavailable\n");
      const unavailableStatus = lifecycle("status");
      assert.notEqual(unavailableStatus.status, 0);
      assert.match(unavailableStatus.stderr, /could not verify/);
      await rm(guiUnavailable);
      await writeFile(oversized, "oversized\n");
      const oversizedStatus = lifecycle("status");
      assert.notEqual(oversizedStatus.status, 0);
      assert.match(oversizedStatus.stderr, /could not verify/);
      await rm(oversized);
      await writeFile(slow, "slow\n");
      const slowStarted = performance.now();
      const slowStatus = lifecycle("status");
      assert.notEqual(slowStatus.status, 0);
      assert.match(slowStatus.stderr, /could not verify/);
      assert.ok(performance.now() - slowStarted < 3_000);
      await rm(slow);

      const holder = spawn(
        installer,
        ["recover", "--test-home-root", home, "--test-hold-lock-ms", "500"],
        { stdio: "ignore" },
      );
      const holderExit = new Promise<number | null>((resolve) => holder.once("exit", resolve));
      const ready = join(services, ".test-selection-lock-ready");
      const readyDeadline = performance.now() + 2_000;
      while (
        !(await lstat(ready)
          .then(() => true)
          .catch(() => false))
      ) {
        assert.ok(performance.now() < readyDeadline);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const busy = lifecycle("status");
      assert.notEqual(busy.status, 0);
      assert.match(busy.stderr, /command is running/);
      assert.equal(await holderExit, 0);

      const receiptPath = join(services, "receipts/installed.json");
      const receiptBytes = await readFile(receiptPath);
      await rm(receiptPath);
      const missingReceipt = lifecycle("status");
      assert.notEqual(missingReceipt.status, 0);
      assert.match(missingReceipt.stderr, /requires selection recovery/);
      await writeFile(receiptPath, receiptBytes, { mode: 0o600 });

      const plistBytes = await readFile(plist);
      await rm(plist);
      const missingArtifact = lifecycle("status");
      assert.notEqual(missingArtifact.status, 0);
      assert.match(missingArtifact.stderr, /requires selection recovery/);
      await writeFile(plist, plistBytes, { mode: 0o444 });

      await writeFile(join(services, "selection-journal.json"), "unsafe\n", {
        mode: 0o600,
      });
      const pending = lifecycle("status");
      assert.notEqual(pending.status, 0);
      assert.match(pending.stderr, /requires selection recovery/);
      await rm(join(services, "selection-journal.json"));
      await rm(join(services, "selection.lock"));
      const missingLock = lifecycle("status");
      assert.notEqual(missingLock.status, 0);
      assert.match(missingLock.stderr, /requires selection recovery/);
      execFileSync("/usr/bin/mkfifo", [join(services, "selection.lock")]);
      const fifoStarted = performance.now();
      const fifoLock = lifecycle("status");
      assert.notEqual(fifoLock.status, 0);
      assert.match(fifoLock.stderr, /requires selection recovery/);
      assert.ok(performance.now() - fifoStarted < 1_000);
    });
  },
);

test(
  "native migration preparation snapshots exact stopped legacy services without changing them",
  { ...options, timeout: 30_000 },
  async (t) => {
    await withFixture(t, async ({ root, release, installer, id }) => {
      const home = join(root, "migration-home");
      const checkout = join(root, "legacy-checkout");
      const services = join(home, "Library/Application Support/Ellie/Services");
      await mkdir(join(checkout, "packages/macos/native"), { recursive: true, mode: 0o700 });
      await mkdir(join(checkout, "packages/macos/assets"), { recursive: true, mode: 0o700 });
      await mkdir(join(checkout, "apps/cli/src"), { recursive: true, mode: 0o700 });
      const repository = realpath(new URL("..", import.meta.url).pathname);
      const repositoryPath = await repository;
      await cp(
        join(repositoryPath, "packages/macos/native/EllieService.swift"),
        join(checkout, "packages/macos/native/EllieService.swift"),
      );
      await cp(
        join(repositoryPath, "packages/macos/assets/Ellie.png"),
        join(checkout, "packages/macos/assets/Ellie.png"),
      );
      await writeFile(join(checkout, "apps/cli/src/main.ts"), "// synthetic entrypoint\n", {
        mode: 0o600,
      });
      await mkdir(join(home, "Library/Application Support/Ellie"), {
        recursive: true,
        mode: 0o700,
      });
      await chmod(join(home, "Library"), 0o700);
      await chmod(join(home, "Library/Application Support"), 0o700);
      await chmod(join(home, "Library/Application Support/Ellie"), 0o700);
      await mkdir(services, { mode: 0o700 });
      await mkdir(join(home, "Library/LaunchAgents"), { mode: 0o700 });
      const application = new MacOSServiceApplication(home, process.getuid!(), undefined, "", {
        register: false,
      });
      for (const role of ["coordinator", "node"] as const) {
        await application.install(role, checkout, process.execPath);
        await writeFile(
          join(home, `Library/LaunchAgents/org.ellie.assistant.${role}.plist`),
          servicePlist(role, home, checkout, process.execPath),
          { mode: 0o600 },
        );
      }
      const migrationStage = run(installer, ["stage", release, "--test-services-root", services]);
      assert.equal(migrationStage.status, 0, migrationStage.stderr);
      const launchctl = join(root, "migration-launchctl.sh");
      const loaded = join(root, "migration-loaded");
      await writeFile(
        launchctl,
        `#!/bin/sh\nif [ "$1" = print ] && [ "$2" = gui/${process.getuid!()} ]; then exit 0; fi\nif [ "$1" = print ] && [ "$#" = 2 ]; then [ -f '${loaded.replaceAll("'", "'\\''")}' ] && [ "$2" = gui/${process.getuid!()}/org.ellie.assistant.coordinator ] && exit 0; exit 113; fi\nexit 64\n`,
        { mode: 0o700 },
      );
      await chmod(launchctl, 0o700);
      const appManifest = join(
        home,
        "Applications/Ellie Coordinator.app/Contents/Resources/ellie-build.json",
      );
      const plist = join(home, "Library/LaunchAgents/org.ellie.assistant.coordinator.plist");
      const appBefore = await readFile(appManifest);
      const plistBefore = await readFile(plist);
      for (const fault of ["after-intent", "after-copy", "after-rename"]) {
        const interrupted = run(installer, [
          "prepare-migration",
          "--roles",
          "coordinator",
          "--test-home-root",
          home,
          "--test-launchctl",
          launchctl,
          "--test-migration-fault",
          fault,
        ]);
        assert.notEqual(interrupted.status, 0);
        assert.match(interrupted.stderr, /requires explicit recovery/);
        const retryBeforeRecovery = run(installer, [
          "prepare-migration",
          "--roles",
          "coordinator",
          "--test-home-root",
          home,
          "--test-launchctl",
          launchctl,
        ]);
        assert.notEqual(retryBeforeRecovery.status, 0);
        assert.match(retryBeforeRecovery.stderr, /requires explicit recovery/);
        const recovery = run(installer, [
          "recover-migration",
          "--test-home-root",
          home,
          "--test-launchctl",
          launchctl,
        ]);
        assert.equal(recovery.status, 0, recovery.stderr);
      }
      const postRenameDetached = `${services}.migration-test-detached`;
      const postRenameSwap = run(installer, [
        "prepare-migration",
        "--roles",
        "node",
        "--test-home-root",
        home,
        "--test-launchctl",
        launchctl,
        "--test-migration-swap-after-rename",
      ]);
      assert.notEqual(postRenameSwap.status, 0);
      assert.match(postRenameSwap.stderr, /requires explicit recovery/);
      assert.equal(
        await lstat(join(postRenameDetached, "migrations/migration-preparation.json")).then(
          (value) => value.isFile(),
        ),
        true,
      );
      await rm(services, { recursive: true });
      await rename(postRenameDetached, services);
      const postRenameRecovery = run(installer, [
        "recover-migration",
        "--test-home-root",
        home,
        "--test-launchctl",
        launchctl,
      ]);
      assert.equal(postRenameRecovery.status, 0, postRenameRecovery.stderr);
      const prepared = run(installer, [
        "prepare-migration",
        "--roles",
        "coordinator,node",
        "--test-home-root",
        home,
        "--test-launchctl",
        launchctl,
      ]);
      assert.equal(prepared.status, 0, prepared.stderr);
      const snapshotID = prepared.stdout.trim();
      assert.match(snapshotID, /^legacy-v1-[a-f0-9]{64}$/);
      const migrations = join(services, "migrations");
      const snapshot = join(migrations, snapshotID);
      const manifest = JSON.parse(await readFile(join(snapshot, "manifest.json"), "utf8"));
      assert.deepEqual(manifest.roles, ["coordinator", "node"]);
      assert.equal(manifest.version, 1);
      assert.equal(manifest.files.length, 14);
      assert.equal(typeof manifest.bindings[0].entrypointSHA256, "string");
      await chmod(snapshot, 0o700);
      const unsealedRetry = run(installer, [
        "prepare-migration",
        "--roles",
        "coordinator,node",
        "--test-home-root",
        home,
        "--test-launchctl",
        launchctl,
      ]);
      assert.notEqual(unsealedRetry.status, 0);
      assert.match(unsealedRetry.stderr, /existing services were preserved/);
      await chmod(snapshot, 0o555);
      const switchArguments = [
        "adopt-migration",
        snapshotID,
        id,
        "--roles",
        "coordinator,node",
        "--test-home-root",
        home,
      ];
      await mkdir(join(services, "receipts"), { mode: 0o700 });
      await writeFile(join(services, "receipts/installed.json"), "", { mode: 0o600 });
      const competingReceipt = run(installer, switchArguments);
      assert.notEqual(competingReceipt.status, 0);
      assert.match(competingReceipt.stderr, /recover-migration-switch/);
      await rm(join(services, "receipts/installed.json"));
      for (const fault of [
        "after-journal",
        "after-staging",
        "after-app-backup-coordinator",
        "after-app-move-coordinator",
        "after-app-seal-coordinator",
        "after-role-coordinator",
        "after-app-backup-node",
        "after-app-move-node",
        "after-app-seal-node",
        "after-role-node",
      ]) {
        const interruptedSwitch = run(installer, [
          ...switchArguments,
          "--test-switch-fault",
          fault,
        ]);
        assert.notEqual(interruptedSwitch.status, 0);
        const blockedSelection = run(installer, [
          "select",
          id,
          "--roles",
          "coordinator,node",
          "--test-home-root",
          home,
        ]);
        assert.match(blockedSelection.stderr, /recover-migration-switch/);
        const blockedPreparation = run(installer, [
          "prepare-migration",
          "--roles",
          "coordinator,node",
          "--test-home-root",
          home,
          "--test-launchctl",
          launchctl,
        ]);
        assert.notEqual(blockedPreparation.status, 0);
        assert.match(blockedPreparation.stderr, /recover-migration-switch/);
        const blockedLifecycle = run(installer, [
          "status",
          "coordinator",
          "--test-home-root",
          home,
          "--test-launchctl",
          launchctl,
        ]);
        assert.notEqual(blockedLifecycle.status, 0);
        assert.match(blockedLifecycle.stderr, /recover-migration-switch/);
        if (fault === "after-journal") {
          const journalPath = join(services, "migration-switch-journal.json");
          const originalJournal = await readFile(journalPath);
          const parsedJournal = JSON.parse(originalJournal.toString()) as Record<string, unknown>;
          const parsedReceipt = JSON.parse(
            Buffer.from(parsedJournal.newReceipt as string, "base64").toString(),
          ) as Record<string, { releaseID: string } | null>;
          for (const malformedReceipt of [
            { ...parsedReceipt, node: null },
            {
              ...parsedReceipt,
              node: { ...parsedReceipt.node!, releaseID: `${id}-other` },
            },
          ]) {
            const malformedJournal = {
              ...parsedJournal,
              newReceipt: Buffer.from(canonicalJSON(malformedReceipt)).toString("base64"),
            };
            await writeFile(journalPath, canonicalJSON(malformedJournal), { mode: 0o600 });
            const malformed = run(installer, [
              "recover-migration-switch",
              "--test-home-root",
              home,
            ]);
            assert.notEqual(malformed.status, 0);
            assert.match(malformed.stderr, /recover-migration-switch/);
          }
          await writeFile(journalPath, originalJournal, { mode: 0o600 });
          await writeFile(join(services, "receipts/installed.json"), "{}", { mode: 0o600 });
          const competingRecovery = run(installer, [
            "recover-migration-switch",
            "--test-home-root",
            home,
          ]);
          assert.notEqual(competingRecovery.status, 0);
          assert.match(competingRecovery.stderr, /recover-migration-switch/);
          assert.equal(
            await lstat(join(services, "migration-switch-journal.json")).then((value) =>
              value.isFile(),
            ),
            true,
          );
          await rm(join(services, "receipts/installed.json"));
          await writeFile(join(services, "selection-journal.json"), "{}", { mode: 0o600 });
          const selectionPendingRecovery = run(installer, [
            "recover-migration-switch",
            "--test-home-root",
            home,
          ]);
          assert.notEqual(selectionPendingRecovery.status, 0);
          assert.match(selectionPendingRecovery.stderr, /recover-migration-switch/);
          await rm(join(services, "selection-journal.json"));
          await writeFile(join(migrations, "migration-preparation.json"), "{}", { mode: 0o600 });
          const preparationPendingRecovery = run(installer, [
            "recover-migration-switch",
            "--test-home-root",
            home,
          ]);
          assert.notEqual(preparationPendingRecovery.status, 0);
          assert.match(preparationPendingRecovery.stderr, /recover-migration-switch/);
          await rm(join(migrations, "migration-preparation.json"));
          const partialStage = join(
            home,
            `Applications/.ellie-migration-stage-${parsedJournal.transactionID as string}-coordinator.app`,
          );
          await mkdir(join(partialStage, "Contents"), { recursive: true, mode: 0o700 });
          const sourceInfo = await readFile(
            join(release, "payload/launchers/Ellie Coordinator.app/Contents/Info.plist"),
          );
          await writeFile(join(partialStage, "Contents/Info.plist"), Buffer.from("altered!"), {
            mode: 0o444,
          });
          await chmod(join(partialStage, "Contents/Info.plist"), 0o440);
          assert.notEqual(
            run(installer, ["recover-migration-switch", "--test-home-root", home]).status,
            0,
          );
          await chmod(join(partialStage, "Contents/Info.plist"), 0o600);
          await writeFile(join(partialStage, "Contents/Info.plist"), sourceInfo.subarray(0, 8));
          await chmod(join(partialStage, "Contents/Info.plist"), 0o440);
          await mkdir(join(partialStage, "Contents/MacOS"), { mode: 0o700 });
          const sourceBuild = await readFile(
            join(release, "payload/launchers/Ellie Coordinator.app/Contents/MacOS/EllieService"),
          );
          await writeFile(
            join(partialStage, "Contents/MacOS/EllieService"),
            sourceBuild.subarray(0, 8),
            { mode: 0o500 },
          );
          await writeFile(join(partialStage, "unexpected"), "x", { mode: 0o444 });
          assert.notEqual(
            run(installer, ["recover-migration-switch", "--test-home-root", home]).status,
            0,
          );
          await rm(join(partialStage, "unexpected"));
          await chmod(partialStage, 0o555);
          const interruptedUnseal = run(installer, [
            "recover-migration-switch",
            "--test-home-root",
            home,
            "--test-switch-fault",
            "recovery-after-unseal-stage-coordinator",
          ]);
          assert.notEqual(interruptedUnseal.status, 0);
          assert.equal((await lstat(partialStage)).mode & 0o7777, 0o700);
        }
        if (fault === "after-role-node") {
          for (const recoveryFault of [
            "recovery-after-unseal-target-coordinator",
            "recovery-after-evidence-app-coordinator",
            "recovery-after-restore-app-coordinator",
            "recovery-after-evidence-plist-coordinator",
            "recovery-after-restore-plist-coordinator",
            "recovery-after-stage-app-coordinator",
            "recovery-after-stage-plist-coordinator",
            "recovery-after-unseal-target-node",
            "recovery-after-evidence-app-node",
            "recovery-after-restore-app-node",
            "recovery-after-evidence-plist-node",
            "recovery-after-restore-plist-node",
            "recovery-after-stage-app-node",
            "recovery-after-stage-plist-node",
            "recovery-before-completed",
            "recovery-after-completed",
          ]) {
            const interruptedRecovery = run(installer, [
              "recover-migration-switch",
              "--test-home-root",
              home,
              "--test-switch-fault",
              recoveryFault,
            ]);
            assert.notEqual(interruptedRecovery.status, 0);
            if (recoveryFault === "recovery-after-restore-app-coordinator") {
              const activeJournal = JSON.parse(
                await readFile(join(services, "migration-switch-journal.json"), "utf8"),
              );
              const abandoned = join(
                home,
                `Applications/.ellie-migration-evidence-${activeJournal.transactionID as string}-abandoned-target.app-coordinator`,
              );
              await chmod(abandoned, 0o700);
              await writeFile(join(abandoned, "unexpected"), "x", { mode: 0o444 });
              const tamperedEvidence = run(installer, [
                "recover-migration-switch",
                "--test-home-root",
                home,
              ]);
              assert.notEqual(tamperedEvidence.status, 0);
              assert.match(tamperedEvidence.stderr, /recover-migration-switch/);
              await rm(join(abandoned, "unexpected"));
            }
            if (recoveryFault === "recovery-before-completed") {
              const activeJournal = JSON.parse(
                await readFile(join(services, "migration-switch-journal.json"), "utf8"),
              );
              const completedBytes = Buffer.from(
                canonicalJSON({ journal: activeJournal, outcome: "restored-legacy", version: 1 }),
              );
              await writeFile(
                join(
                  services,
                  `.migration-switch-evidence-${activeJournal.transactionID as string}-partial-completed`,
                ),
                completedBytes.subarray(0, 8),
                { mode: 0o600 },
              );
              await writeFile(
                join(
                  services,
                  `.ellie-write-${activeJournal.transactionID as string}-completed-switch`,
                ),
                completedBytes.subarray(0, 16),
                { mode: 0o600 },
              );
            }
          }
        }
        const recoveredSwitch = run(installer, [
          "recover-migration-switch",
          "--test-home-root",
          home,
        ]);
        assert.equal(recoveredSwitch.status, 0, recoveredSwitch.stderr);
        assert.equal(await readFile(appManifest).then((value) => value.equals(appBefore)), true);
        assert.equal(await readFile(plist).then((value) => value.equals(plistBefore)), true);
        assert.equal(
          await lstat(join(services, "receipts/installed.json"))
            .then(() => true)
            .catch(() => false),
          false,
        );
      }
      const replacedServices = run(installer, [
        ...switchArguments,
        "--test-switch-replace-services",
      ]);
      assert.notEqual(replacedServices.status, 0);
      assert.match(replacedServices.stderr, /recover-migration-switch/);
      await rmdir(services);
      await rename(`${services}.test-detached`, services);
      assert.equal(
        run(installer, ["recover-migration-switch", "--test-home-root", home]).status,
        0,
      );
      const loadedAfterPreflight = run(installer, [
        ...switchArguments,
        "--test-switch-load-after-preflight",
      ]);
      assert.notEqual(loadedAfterPreflight.status, 0);
      assert.match(loadedAfterPreflight.stderr, /recover-migration-switch/);
      assert.equal(
        run(installer, ["recover-migration-switch", "--test-home-root", home]).status,
        0,
      );
      await rm(join(services, "receipts"), { recursive: true });
      assert.equal(await readFile(appManifest).then((value) => value.equals(appBefore)), true);
      assert.equal(await readFile(plist).then((value) => value.equals(plistBefore)), true);
      assert.equal(
        await lstat(join(services, "releases", id)).then((value) => value.isDirectory()),
        true,
      );
      assert.equal(
        await lstat(join(migrations, "migration-preparation.json"))
          .then(() => true)
          .catch(() => false),
        false,
      );

      await writeFile(loaded, "loaded\n");
      const loadedRefusal = run(installer, [
        "prepare-migration",
        "--roles",
        "coordinator",
        "--test-home-root",
        home,
        "--test-launchctl",
        launchctl,
      ]);
      assert.notEqual(loadedRefusal.status, 0);
      assert.match(loadedRefusal.stderr, /Both legacy service labels must be unloaded/);
      await rm(loaded);

      const transactionID = randomUUID();
      const stageName = `.migration-stage-${transactionID}`;
      await mkdir(join(migrations, stageName), { mode: 0o700 });
      await writeFile(
        join(migrations, "migration-preparation.json"),
        `${JSON.stringify({
          manifestSHA256: "0".repeat(64),
          roles: ["coordinator"],
          snapshotID: `legacy-v1-${"0".repeat(64)}`,
          stageName,
          transactionID,
          version: 1,
        })}\n`,
        { mode: 0o600 },
      );
      const blockedByIntent = run(installer, [
        "prepare-migration",
        "--roles",
        "coordinator",
        "--test-home-root",
        home,
        "--test-launchctl",
        launchctl,
      ]);
      assert.notEqual(blockedByIntent.status, 0);
      assert.match(blockedByIntent.stderr, /requires explicit recovery/);
      assert.equal(
        await lstat(join(migrations, stageName)).then((value) => value.isDirectory()),
        true,
      );
      const recovered = run(installer, [
        "recover-migration",
        "--test-home-root",
        home,
        "--test-launchctl",
        launchctl,
      ]);
      assert.equal(recovered.status, 0, recovered.stderr);
      assert.equal(
        await lstat(join(migrations, stageName))
          .then(() => true)
          .catch(() => false),
        false,
      );

      const malformedTransaction = randomUUID();
      const malformedStage = `.migration-stage-${malformedTransaction}`;
      const malformedManifest =
        '{"bindings":[{"buildDigest":"' +
        "0".repeat(64) +
        `","checkout":"${checkout}","entrypointSHA256":"${"0".repeat(64)}","node":"${process.execPath}","nodeSHA256":"${"0".repeat(64)}","role":"coordinator"}],"files":[{"mode":384,"path":"roles/coordinator/launch-agent.plist","sha256":"${"0".repeat(64)}","size":18446744073709551615}],"roles":["coordinator"],"version":1}\n`;
      const malformedHash = createHash("sha256").update(malformedManifest).digest("hex");
      await mkdir(join(migrations, malformedStage), { mode: 0o700 });
      await writeFile(join(migrations, malformedStage, "manifest.json"), malformedManifest, {
        mode: 0o444,
      });
      await writeFile(
        join(migrations, "migration-preparation.json"),
        `${JSON.stringify({
          manifestSHA256: malformedHash,
          roles: ["coordinator"],
          snapshotID: `legacy-v1-${malformedHash}`,
          stageName: malformedStage,
          transactionID: malformedTransaction,
          version: 1,
        })}\n`,
        { mode: 0o600 },
      );
      const malformedRecovery = run(installer, [
        "recover-migration",
        "--test-home-root",
        home,
        "--test-launchctl",
        launchctl,
      ]);
      assert.notEqual(malformedRecovery.status, 0);
      assert.match(malformedRecovery.stderr, /requires explicit recovery/);
      assert.equal(
        await lstat(join(migrations, malformedStage)).then((value) => value.isDirectory()),
        true,
      );
      await rm(join(migrations, malformedStage), { recursive: true });
      await rm(join(migrations, "migration-preparation.json"));

      const plistBackup = `${plist}.owned-backup`;
      await rename(plist, plistBackup);
      await symlink(plistBackup, plist);
      const unsafePlist = run(installer, [
        "prepare-migration",
        "--roles",
        "coordinator",
        "--test-home-root",
        home,
        "--test-launchctl",
        launchctl,
      ]);
      assert.notEqual(unsafePlist.status, 0);
      assert.match(unsafePlist.stderr, /existing services were preserved/);
      assert.deepEqual(await readFile(plistBackup), plistBefore);
      await rm(plist);
      await rename(plistBackup, plist);

      await writeFile(join(checkout, "packages/macos/native/EllieService.swift"), "stale\n");
      const stale = run(installer, [
        "prepare-migration",
        "--roles",
        "coordinator",
        "--test-home-root",
        home,
        "--test-launchctl",
        launchctl,
      ]);
      assert.notEqual(stale.status, 0);
      assert.match(stale.stderr, /no longer matches its recorded checkout build/);
      assert.deepEqual(await readFile(appManifest), appBefore);
      assert.deepEqual(await readFile(plist), plistBefore);

      await cp(
        join(repositoryPath, "packages/macos/native/EllieService.swift"),
        join(checkout, "packages/macos/native/EllieService.swift"),
      );
      const committedSwitch = run(installer, [
        ...switchArguments,
        "--test-switch-fault",
        "after-receipt",
      ]);
      assert.notEqual(committedSwitch.status, 0);
      const committedRecovery = run(installer, [
        "recover-migration-switch",
        "--test-home-root",
        home,
      ]);
      assert.equal(committedRecovery.status, 0, committedRecovery.stderr);
      assert.equal(
        run(installer, ["recover-migration-switch", "--test-home-root", home]).status,
        0,
      );
      const installedReceipt = JSON.parse(
        await readFile(join(services, "receipts/installed.json"), "utf8"),
      );
      assert.equal(installedReceipt.coordinator.releaseID, id);
      assert.equal(installedReceipt.node.releaseID, id);
      assert.equal(
        (await lstat(join(home, "Applications/Ellie Coordinator.app"))).mode & 0o7777,
        0o555,
      );
      assert.equal((await lstat(join(home, "Applications/Ellie Node.app"))).mode & 0o7777, 0o555);
      assert.equal(
        await lstat(join(services, "migration-switch-journal.json"))
          .then(() => true)
          .catch(() => false),
        false,
      );
      const completedEvidence = (await readdir(services)).filter(
        (name) => name.startsWith(".migration-switch-evidence-") && name.endsWith(".json"),
      );
      const completedRecords = await Promise.all(
        completedEvidence.map(async (name) =>
          JSON.parse(await readFile(join(services, name), "utf8")),
        ),
      );
      const completedRecord = completedRecords.find((value) => value.outcome === "committed");
      assert.ok(completedRecord);
      assert.equal(completedRecord.outcome, "committed");
      assert.equal(completedRecord.journal.releaseID, id);
      const bothRestore = run(installer, [
        "restore-legacy",
        completedRecord.journal.transactionID as string,
        "--roles",
        "coordinator,node",
        "--test-home-root",
        home,
        "--test-legacy-restore-fault",
        "after-receipt",
      ]);
      assert.notEqual(bothRestore.status, 0);
      const bothRecovery = run(installer, ["recover-legacy-restore", "--test-home-root", home]);
      assert.equal(bothRecovery.status, 0, bothRecovery.stderr);
      assert.match(bothRecovery.stdout, /restored-legacy/);
      const readoptBoth = run(installer, switchArguments);
      assert.equal(readoptBoth.status, 0, readoptBoth.stderr);
      for (const role of ["coordinator", "node"]) {
        assert.equal(
          (await readdir(join(home, "Applications"))).some(
            (name) => name.includes(`migration-backup`) && name.includes(role),
          ),
          true,
        );
      }
      const applicationNames = await readdir(join(home, "Applications"));
      const agentNames = await readdir(join(home, "Library/LaunchAgents"));
      const coordinatorBackupApp = applicationNames.find(
        (name) => name.includes("migration-backup") && name.includes("coordinator"),
      );
      const coordinatorBackupPlist = agentNames.find(
        (name) => name.includes("migration-backup") && name.includes("coordinator"),
      );
      assert.ok(coordinatorBackupApp);
      assert.ok(coordinatorBackupPlist);
      await removeOwned(join(home, "Applications/Ellie Coordinator.app"));
      await removeOwned(join(home, "Applications/Ellie Node.app"));
      await rm(join(home, "Library/LaunchAgents/org.ellie.assistant.coordinator.plist"));
      await rm(join(home, "Library/LaunchAgents/org.ellie.assistant.node.plist"));
      await rename(
        join(home, "Applications", coordinatorBackupApp),
        join(home, "Applications/Ellie Coordinator.app"),
      );
      await rename(
        join(home, "Library/LaunchAgents", coordinatorBackupPlist),
        join(home, "Library/LaunchAgents/org.ellie.assistant.coordinator.plist"),
      );
      await rm(join(services, "receipts"), { recursive: true });
      const singlePrepared = run(installer, [
        "prepare-migration",
        "--roles",
        "coordinator",
        "--test-home-root",
        home,
        "--test-launchctl",
        launchctl,
      ]);
      assert.equal(singlePrepared.status, 0, singlePrepared.stderr);
      const singleSnapshot = singlePrepared.stdout.trim();
      assert.match(singleSnapshot, /^legacy-v1-[a-f0-9]{64}$/);
      const singleAdoption = run(installer, [
        "adopt-migration",
        singleSnapshot,
        id,
        "--roles",
        "coordinator",
        "--test-home-root",
        home,
      ]);
      assert.equal(singleAdoption.status, 0, singleAdoption.stderr);
      const singleReceipt = JSON.parse(
        await readFile(join(services, "receipts/installed.json"), "utf8"),
      );
      assert.equal(singleReceipt.coordinator.releaseID, id);
      assert.equal(singleReceipt.node, null);
      const singleCompletedRecords = await Promise.all(
        (await readdir(services))
          .filter(
            (name) => name.startsWith(".migration-switch-evidence-") && name.endsWith(".json"),
          )
          .map(async (name) => ({
            name,
            value: JSON.parse(await readFile(join(services, name), "utf8")),
          })),
      );
      const singleCompleted = singleCompletedRecords.find(
        ({ value }) =>
          value.outcome === "committed" &&
          value.journal.roles.length === 1 &&
          value.journal.roles[0] === "coordinator",
      );
      assert.ok(singleCompleted);
      const adoptionTransaction = singleCompleted.value.journal.transactionID as string;
      const exactSingleReceipt = await readFile(join(services, "receipts/installed.json"));
      const laterReceipt = JSON.parse(exactSingleReceipt.toString());
      laterReceipt.coordinator.releaseID = `${id}-later`;
      await writeFile(join(services, "receipts/installed.json"), canonicalJSON(laterReceipt), {
        mode: 0o600,
      });
      const laterSelectionRefusal = run(installer, [
        "restore-legacy",
        adoptionTransaction,
        "--roles",
        "coordinator",
        "--test-home-root",
        home,
      ]);
      assert.notEqual(laterSelectionRefusal.status, 0);
      assert.match(laterSelectionRefusal.stderr, /recover-legacy-restore/);
      await writeFile(join(services, "receipts/installed.json"), exactSingleReceipt, {
        mode: 0o600,
      });
      for (const restoreFault of [
        "after-packaged-app-unseal-coordinator",
        "after-packaged-app-coordinator",
        "after-legacy-app-publish-coordinator",
        "after-legacy-app-seal-coordinator",
      ]) {
        const interruptedRestore = run(installer, [
          "restore-legacy",
          adoptionTransaction,
          "--roles",
          "coordinator",
          "--test-home-root",
          home,
          "--test-legacy-restore-fault",
          restoreFault,
        ]);
        assert.notEqual(interruptedRestore.status, 0);
        if (restoreFault === "after-legacy-app-seal-coordinator") {
          for (const recoveryFault of [
            "recovery-after-legacy-app-unseal-coordinator",
            "recovery-after-legacy-app-evidence-coordinator",
          ]) {
            const interruptedRecovery = run(installer, [
              "recover-legacy-restore",
              "--test-home-root",
              home,
              "--test-legacy-restore-fault",
              recoveryFault,
            ]);
            assert.notEqual(interruptedRecovery.status, 0);
            if (recoveryFault === "recovery-after-legacy-app-evidence-coordinator") {
              const restoreJournal = JSON.parse(
                await readFile(join(services, "legacy-restore-journal.json"), "utf8"),
              );
              const retainedRoot = join(
                home,
                `Applications/.ellie-legacy-restore-${restoreJournal.transactionID as string}-legacy-coordinator.app`,
              );
              const codeResources = join(retainedRoot, "Contents/_CodeSignature/CodeResources");
              const heldCodeResources = join(root, "held-complete-legacy-CodeResources");
              await rename(codeResources, heldCodeResources);
              assert.notEqual(
                run(installer, ["recover-legacy-restore", "--test-home-root", home]).status,
                0,
              );
              await rename(heldCodeResources, codeResources);
            }
          }
        }
        const firstRecovery = run(installer, [
          "recover-legacy-restore",
          "--test-home-root",
          home,
          "--test-legacy-restore-fault",
          "recovery-before-packaged-app-seal-coordinator",
        ]);
        assert.notEqual(firstRecovery.status, 0);
        assert.equal(
          run(installer, ["recover-legacy-restore", "--test-home-root", home]).status,
          0,
        );
        assert.equal(
          JSON.parse(await readFile(join(services, "receipts/installed.json"), "utf8")).coordinator
            .releaseID,
          id,
        );
      }
      for (const mask of ["027", "077"] as const) {
        const partialRestore = runWithUmask(mask, installer, [
          "restore-legacy",
          adoptionTransaction,
          "--roles",
          "coordinator",
          "--test-home-root",
          home,
          "--test-legacy-truncate",
          "coordinator",
        ]);
        assert.notEqual(partialRestore.status, 0);
        if (mask === "027") {
          const activeRestore = JSON.parse(
            await readFile(join(services, "legacy-restore-journal.json"), "utf8"),
          );
          const partialApp = join(
            home,
            `Applications/.ellie-legacy-restore-${activeRestore.transactionID as string}-stage-coordinator.app`,
          );
          const partialInfo = join(partialApp, "Contents/Info.plist");
          const originalMode = (await lstat(partialInfo)).mode & 0o7777;
          await chmod(partialInfo, 0o600);
          await writeFile(partialInfo, "altered");
          await chmod(partialInfo, originalMode);
          assert.notEqual(
            run(installer, ["recover-legacy-restore", "--test-home-root", home]).status,
            0,
          );
          const snapshotInfo = await readFile(
            join(snapshot, "roles/coordinator/application/Contents/Info.plist"),
          );
          await chmod(partialInfo, 0o600);
          await writeFile(
            partialInfo,
            snapshotInfo.subarray(0, Math.max(1, snapshotInfo.length / 2)),
          );
          await chmod(partialInfo, originalMode);
          await writeFile(join(partialApp, "unexpected"), "x", { mode: 0o600 });
          assert.notEqual(
            run(installer, ["recover-legacy-restore", "--test-home-root", home]).status,
            0,
          );
          await rm(join(partialApp, "unexpected"));
        }
        const partialRecovery = run(installer, [
          "recover-legacy-restore",
          "--test-home-root",
          home,
        ]);
        assert.equal(partialRecovery.status, 0, partialRecovery.stderr);
        assert.equal(
          JSON.parse(await readFile(join(services, "receipts/installed.json"), "utf8")).coordinator
            .releaseID,
          id,
        );
      }
      const restored = run(installer, [
        "restore-legacy",
        adoptionTransaction,
        "--roles",
        "coordinator",
        "--test-home-root",
        home,
        "--test-legacy-restore-fault",
        "after-receipt",
      ]);
      assert.notEqual(restored.status, 0);
      assert.equal(
        await lstat(join(services, "receipts/installed.json"))
          .then(() => false)
          .catch(() => true),
        true,
        restored.stderr,
      );
      const committedRestoreJournal = JSON.parse(
        await readFile(join(services, "legacy-restore-journal.json"), "utf8"),
      );
      const committedRestoreRecord = Buffer.from(
        canonicalJSON({
          journal: committedRestoreJournal,
          outcome: "restored-legacy",
          runtimeCompatibility: "unverified",
          version: 1,
        }),
      );
      await writeFile(
        join(
          services,
          `.ellie-write-${committedRestoreJournal.transactionID as string}-legacy-restore-completed`,
        ),
        committedRestoreRecord.subarray(0, 11),
        { mode: 0o600 },
      );
      const committedLegacyRecovery = run(installer, [
        "recover-legacy-restore",
        "--test-home-root",
        home,
        "--test-legacy-restore-fault",
        "after-completed",
      ]);
      assert.notEqual(committedLegacyRecovery.status, 0);
      const repeatedLegacyRecovery = run(installer, [
        "recover-legacy-restore",
        "--test-home-root",
        home,
      ]);
      assert.equal(repeatedLegacyRecovery.status, 0, repeatedLegacyRecovery.stderr);
      assert.equal(
        await lstat(join(services, "receipts/installed.json"))
          .then(() => true)
          .catch(() => false),
        false,
      );
      assert.deepEqual(await readFile(appManifest), appBefore);
      assert.deepEqual(await readFile(plist), plistBefore);
      assert.equal(run(installer, ["recover-legacy-restore", "--test-home-root", home]).status, 0);
    });
  },
);

test(
  "native unselect removes only a stopped verified role and recovers before or after receipt commit",
  { ...options, timeout: 30_000 },
  async (t) => {
    await withFixture(t, async ({ root, release, installer, id }) => {
      const home = join(root, "unselect-home");
      const services = join(home, "Library/Application Support/Ellie/Services");
      await mkdir(services, { recursive: true, mode: 0o700 });
      for (const part of [
        "Library",
        "Library/Application Support",
        "Library/Application Support/Ellie",
      ])
        await chmod(join(home, part), 0o700);
      await mkdir(join(home, "Applications"), { mode: 0o700 });
      await mkdir(join(home, "Library/LaunchAgents"), { mode: 0o700 });
      await mkdir(join(home, ".ellie"), { mode: 0o700 });
      const identity = join(home, ".ellie/node.json");
      await writeFile(identity, "private identity survives\n", { mode: 0o600 });
      assert.equal(run(installer, ["stage", release, "--test-services-root", services]).status, 0);
      const select = run(installer, [
        "select",
        id,
        "--roles",
        "coordinator,node",
        "--test-home-root",
        home,
      ]);
      assert.equal(select.status, 0, select.stderr);
      const receipt = join(services, "receipts/installed.json");
      const before = await readFile(receipt);
      const coordinatorPlist = join(
        home,
        "Library/LaunchAgents/org.ellie.assistant.coordinator.plist",
      );
      const coordinatorBefore = await readFile(coordinatorPlist);
      const coordinatorApp = join(home, "Applications/Ellie Coordinator.app");
      const coordinatorAppBefore = await readFile(join(coordinatorApp, "Contents/Info.plist"));
      const nodeApp = join(home, "Applications/Ellie Node.app");
      const nodePlist = join(home, "Library/LaunchAgents/org.ellie.assistant.node.plist");
      const unselect = (...extra: string[]) =>
        run(installer, ["unselect", "node", "--test-home-root", home, ...extra]);
      const recover = () => run(installer, ["recover", "--test-home-root", home]);
      const present = async (path: string) =>
        lstat(path)
          .then(() => true)
          .catch(() => false);
      const stillSelected = async () => {
        assert.deepEqual(await readFile(receipt), before);
        assert.equal(await present(nodeApp), true);
        assert.equal(await present(nodePlist), true);
      };
      const loaded = unselect("--test-loaded", "node");
      assert.notEqual(loaded.status, 0);
      await stillSelected();
      for (const point of [
        "after-journal",
        "after-old-app-unseal-node",
        "after-old-app-backup-node",
        "after-old-plist-backup-node",
      ]) {
        const interrupted = unselect("--test-fault", point);
        assert.equal(interrupted.status, 86, `${point}: ${interrupted.stderr}`);
        const restored = recover();
        assert.equal(restored.status, 0, `${point}: ${restored.stderr}`);
        await stillSelected();
      }
      const committed = unselect("--test-loaded", "coordinator", "--test-fault", "after-receipt");
      assert.equal(committed.status, 86, committed.stderr);
      const finished = recover();
      assert.equal(finished.status, 0, finished.stderr);
      assert.equal(JSON.parse(await readFile(receipt, "utf8")).node, null);
      assert.equal(await present(nodeApp), false);
      assert.equal(await present(nodePlist), false);
      assert.deepEqual(await readFile(coordinatorPlist), coordinatorBefore);
      assert.deepEqual(
        await readFile(join(coordinatorApp, "Contents/Info.plist")),
        coordinatorAppBefore,
      );
      assert.equal(await readFile(identity, "utf8"), "private identity survives\n");
      assert.notEqual(unselect().status, 0);
      await symlink(identity, nodePlist);
      assert.notEqual(unselect().status, 0);
      assert.equal(await present(nodePlist), true);
      assert.deepEqual(await readFile(coordinatorPlist), coordinatorBefore);
      await rm(nodePlist);
      const removeCoordinator = run(installer, [
        "unselect",
        "coordinator",
        "--test-home-root",
        home,
      ]);
      assert.equal(removeCoordinator.status, 0, removeCoordinator.stderr);
      assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), {
        version: 1,
        coordinator: null,
        node: null,
      });
      assert.equal(await present(coordinatorApp), false);
      assert.equal(await present(coordinatorPlist), false);
      assert.equal(await readFile(identity, "utf8"), "private identity survives\n");
    });
  },
);

test(
  "native unselect refuses missing managed assets and retains unverified recovery backups",
  { ...options, timeout: 30_000 },
  async (t) => {
    await withFixture(t, async ({ root, release, installer, id }) => {
      const home = join(root, "unselect-damage-home");
      const services = join(home, "Library/Application Support/Ellie/Services");
      await mkdir(services, { recursive: true, mode: 0o700 });
      for (const part of [
        "Library",
        "Library/Application Support",
        "Library/Application Support/Ellie",
      ])
        await chmod(join(home, part), 0o700);
      await mkdir(join(home, "Applications"), { mode: 0o700 });
      await mkdir(join(home, "Library/LaunchAgents"), { mode: 0o700 });
      assert.equal(run(installer, ["stage", release, "--test-services-root", services]).status, 0);
      assert.equal(
        run(installer, ["select", id, "--roles", "node", "--test-home-root", home]).status,
        0,
      );
      const receipt = join(services, "receipts/installed.json");
      const before = await readFile(receipt);
      const nodePlist = join(home, "Library/LaunchAgents/org.ellie.assistant.node.plist");
      const missingPlist = join(home, "Library/LaunchAgents/missing-node.plist");
      await rename(nodePlist, missingPlist);
      assert.notEqual(run(installer, ["unselect", "node", "--test-home-root", home]).status, 0);
      assert.deepEqual(await readFile(receipt), before);
      assert.equal(await lstat(missingPlist).then(() => true), true);
      await rename(missingPlist, nodePlist);
      const interrupted = run(installer, [
        "unselect",
        "node",
        "--test-home-root",
        home,
        "--test-fault",
        "after-old-app-backup-node",
      ]);
      assert.equal(interrupted.status, 86, interrupted.stderr);
      const journalPath = join(services, "selection-journal.json");
      const transaction = JSON.parse(await readFile(journalPath, "utf8")).transactionID;
      const backup = join(home, "Applications", `.ellie-backup-${transaction}-node.app`);
      const info = join(backup, "Contents/Info.plist");
      const originalInfo = await readFile(info);
      await chmod(info, 0o644);
      await writeFile(info, "damaged managed backup");
      const refused = run(installer, ["recover", "--test-home-root", home]);
      assert.notEqual(refused.status, 0);
      assert.deepEqual(await readFile(receipt), before);
      assert.equal(await readFile(info, "utf8"), "damaged managed backup");
      assert.equal(await lstat(journalPath).then(() => true), true);
      assert.equal(await lstat(backup).then(() => true), true);
      await writeFile(info, originalInfo);
      await chmod(info, 0o444);
      assert.equal(run(installer, ["recover", "--test-home-root", home]).status, 0);
      assert.deepEqual(await readFile(receipt), before);
      const committed = run(installer, [
        "unselect",
        "node",
        "--test-home-root",
        home,
        "--test-fault",
        "after-receipt",
      ]);
      assert.equal(committed.status, 86, committed.stderr);
      const nextTransaction = JSON.parse(await readFile(journalPath, "utf8")).transactionID;
      const nextBackup = join(home, "Applications", `.ellie-backup-${nextTransaction}-node.app`);
      const nextInfo = join(nextBackup, "Contents/Info.plist");
      await chmod(nextInfo, 0o644);
      await writeFile(nextInfo, "damaged committed backup");
      assert.notEqual(run(installer, ["recover", "--test-home-root", home]).status, 0);
      assert.equal(JSON.parse(await readFile(receipt, "utf8")).node, null);
      assert.equal(await readFile(nextInfo, "utf8"), "damaged committed backup");
      assert.equal(await lstat(nextBackup).then(() => true), true);
      assert.equal(await lstat(journalPath).then(() => true), true);
    });
  },
);
