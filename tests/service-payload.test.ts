import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createReleaseArchive,
  extractVerifiedNode,
  MAXIMUM_PAYLOAD_FILES,
  nativeArchitecture,
  prepareDependencies,
  stageApplication,
  targetArchitecture,
  verifyManifest,
  verifyStagedLifeRuntime,
} from "../scripts/build-service-payload.mjs";
// @ts-expect-error The archive preflight remains directly executable JavaScript.
import { zipEntries } from "../scripts/test-packaged-runtime.mjs";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function manifest(files: object[]) {
  return {
    version: 1,
    sourceRevision: "a".repeat(40),
    architecture: "arm64",
    minimumOS: "14.0",
    runtime: { version: "v24.9.0", sha256: "b".repeat(64) },
    helper: { identifier: "org.ellie.helper", signature: "development-ad-hoc" },
    launchers: [
      {
        role: "coordinator",
        name: "Ellie Coordinator",
        identifier: "org.ellie.assistant.coordinator.app",
        signature: "development-ad-hoc",
        architecture: "arm64",
        minimumOS: "14.0",
      },
      {
        role: "node",
        name: "Ellie Node",
        identifier: "org.ellie.assistant.node.app",
        signature: "development-ad-hoc",
        architecture: "arm64",
        minimumOS: "14.0",
      },
    ],
    files,
  };
}

function sourceRecord() {
  return `Ellie service payload\nSource revision: ${"a".repeat(40)}\nNode.js: v24.9.0\nNode archive SHA-256: ${"b".repeat(64)}\nMinimum macOS: 14.0\nHelper: org.ellie.helper (development-ad-hoc)\n`;
}

async function temporary(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test(
  "release ZIP omits AppleDouble metadata while preserving manifested file modes",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const directory = await temporary(t, "ellie-payload-zip-");
    const release = join(directory, "EllieServices-test");
    await mkdir(release);
    const executable = join(release, "helper");
    await writeFile(executable, "fixture\n", { mode: 0o755 });
    execFileSync("/usr/bin/xattr", ["-w", "com.ellie.test.fixture", "metadata", executable]);
    const archive = join(directory, "release.zip");

    createReleaseArchive(release, archive);

    const entries = zipEntries(await readFile(archive), "EllieServices-test") as Array<{
      name: string;
      mode: number;
    }>;
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["EllieServices-test/", "EllieServices-test/helper"],
    );
    assert.equal(entries[1]!.mode & 0o777, 0o755);
  },
);

test("extracts only a checksum-verified target Node runtime and its license", async (t) => {
  const directory = await temporary(t, "ellie-node-archive-");
  const source = join(directory, "node-v24.9.0-darwin-arm64");
  await mkdir(join(source, "bin"), { recursive: true });
  await writeFile(
    join(source, "bin/node"),
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'v24.9.0\\n'; else printf 'arm64\\n'; fi\n",
    { mode: 0o755 },
  );
  await writeFile(join(source, "LICENSE"), "Synthetic Node fixture license\n");
  await writeFile(join(source, "ignored-private-file"), "must not be extracted\n");
  const archive = `${source}.tar.xz`;
  execFileSync("/usr/bin/tar", ["-cJf", archive, "-C", directory, source.split("/").at(-1)!]);
  const archiveBytes = await readFile(archive);
  const output = join(directory, "output");
  await mkdir(output);

  const provenance = await extractVerifiedNode({
    archive,
    expectedSha256: digest(archiveBytes),
    destination: output,
    architecture: "arm64",
  });

  assert.equal(provenance.version, "v24.9.0");
  assert.equal(
    await readFile(join(output, "LICENSES/Node.js-LICENSE"), "utf8"),
    "Synthetic Node fixture license\n",
  );
  await assert.rejects(readFile(join(output, "ignored-private-file")), {
    code: "ENOENT",
  });
  await assert.rejects(
    extractVerifiedNode({
      archive,
      expectedSha256: "0".repeat(64),
      destination: join(directory, "bad"),
      architecture: "arm64",
    }),
    /checksum/,
  );
  await mkdir(join(directory, "linked-input"));
  const linked = join(directory, "linked-input/node-v24.9.0-darwin-arm64.tar.xz");
  await symlink(archive, linked);
  await assert.rejects(
    extractVerifiedNode({
      archive: linked,
      expectedSha256: digest(archiveBytes),
      destination: join(directory, "linked"),
      architecture: "arm64",
    }),
  );
});

test("materializes the finite production workspace closure and complete license inventory", async (t) => {
  const directory = await temporary(t, "ellie-payload-closure-");
  const source = join(directory, "source");
  const payload = join(directory, "payload");
  const packageFile = async (path: string, value: object) => {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), `${JSON.stringify(value)}\n`);
    await writeFile(join(path, "index.ts"), "export {};\n");
  };
  await writeFile(join(directory, "ellie-license"), "Ellie fixture license\n");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "LICENSE"), "Ellie fixture license\n");
  await writeFile(join(source, "package.json"), '{"name":"fixture"}\n');
  await writeFile(join(source, "bun.lock"), "fixture-lock\n");
  for (const name of ["cli", "node", "server"]) {
    await packageFile(join(source, "apps", name), {
      name: `@ellie/${name}`,
      version: "1.0.0",
      exports: "./index.ts",
      dependencies:
        name === "cli"
          ? { "@ellie/protocol": "*", "@ellie/life": "*", qrcode: "1.0.0" }
          : { "@ellie/protocol": "*" },
    });
  }
  await packageFile(join(source, "packages/protocol"), {
    name: "@ellie/protocol",
    version: "1.0.0",
    exports: "./index.ts",
  });
  await packageFile(join(source, "apps/life"), {
    name: "@ellie/life",
    version: "1.0.0",
    exports: { "./embedded": "./index.ts" },
    dependencies: { "@ellie/life-core": "*" },
  });
  await packageFile(join(source, "packages/life-core"), {
    name: "@ellie/life-core",
    version: "1.0.0",
    exports: "./index.ts",
  });
  await mkdir(join(source, "apps/command-center/dist"), { recursive: true });
  await writeFile(join(source, "apps/command-center/dist/index.html"), "fixture\n");
  await mkdir(join(source, "apps/life-ui/dist/assets"), { recursive: true });
  await writeFile(join(source, "apps/life-ui/dist/index.html"), "Life fixture\n");
  await writeFile(join(source, "apps/life-ui/dist/assets/main.js"), "export {};\n");
  await packageFile(join(source, "node_modules/qrcode"), {
    name: "qrcode",
    version: "1.0.0",
    license: "MIT",
    dependencies: { helper: "1.0.0" },
  });
  await writeFile(join(source, "node_modules/qrcode/LICENSE-MIT.txt"), "QR fixture license\n");
  await packageFile(join(source, "node_modules/helper"), {
    name: "helper",
    version: "1.0.0",
    license: "ISC",
  });
  await writeFile(join(source, "node_modules/helper/COPYING"), "Helper fixture license\n");
  await mkdir(join(payload, "LICENSES"), { recursive: true });

  const components = await stageApplication(source, payload);

  assert.deepEqual(
    components.map(({ name }) => name),
    ["helper", "qrcode"],
  );
  assert.match(
    await readFile(join(payload, "lib/ellie/node_modules/@ellie/protocol/index.js"), "utf8"),
    /packages\/protocol\/index\.ts/,
  );
  assert.equal(
    (await readFile(join(payload, "lib/ellie/packages/protocol/index.ts"), "utf8")).trim(),
    "export {};",
  );
  assert.match(
    await readFile(join(payload, "lib/ellie/node_modules/@ellie/life/embedded.js"), "utf8"),
    /apps\/life\/index\.ts/,
  );
  assert.equal(
    await readFile(join(payload, "lib/ellie/packages/life-core/index.ts"), "utf8"),
    "export {};\n",
  );
  assert.equal(
    await readFile(join(payload, "lib/ellie/apps/life-ui/dist/index.html"), "utf8"),
    "Life fixture\n",
  );
  assert.equal(
    await readFile(join(payload, "lib/ellie/apps/life-ui/dist/assets/main.js"), "utf8"),
    "export {};\n",
  );
  assert.match(
    await readFile(join(payload, "LICENSES/THIRD-PARTY-NOTICES.txt"), "utf8"),
    /helper@1\.0\.0/,
  );

  await rm(join(source, "apps/life-ui/dist"), { recursive: true });
  await assert.rejects(stageApplication(source, join(directory, "missing-life-assets")), {
    code: "ENOENT",
  });
  await mkdir(join(source, "apps/life-ui/dist"), { recursive: true });

  await writeFile(
    join(source, "packages/protocol/package.json"),
    JSON.stringify({ name: "@ellie/protocol", exports: "./../escape.ts" }),
  );
  await assert.rejects(
    stageApplication(source, join(directory, "traversal")),
    /unsupported exports/,
  );

  await writeFile(
    join(source, "packages/protocol/package.json"),
    JSON.stringify({ name: "@ellie/protocol", exports: "./linked.ts" }),
  );
  await symlink(join(directory, "ellie-license"), join(source, "packages/protocol/linked.ts"));
  await assert.rejects(stageApplication(source, join(directory, "linked")), /symbolic link/);
});

test("supplies only the pinned provider-utils upstream license when its npm package omits one", async (t) => {
  const directory = await temporary(t, "ellie-provider-utils-license-");
  const source = join(directory, "source");
  const packageDirectory = join(source, "node_modules/@ai-sdk/provider-utils");
  const license = join(source, "scripts/licenses/provider-utils-5.0.43.LICENSE");
  const packageJson = join(packageDirectory, "package.json");
  const lock = join(source, "bun.lock");
  const integrity =
    "sha512-gw/bcNseOGSs59TMtV4H1KwqXXe24NHgx+uBYr98pa4Fg6Uvp8hPPxjuckVnfFFyIxHCDew8so0ujpvcSuyMZA==";
  const lockText = (value: string) =>
    `{\n  "packages": {\n    "@ai-sdk/provider-utils": ["@ai-sdk/provider-utils@5.0.43", "", {}, "${value}"],\n  },\n}\n`;
  const packageValue = {
    name: "@ai-sdk/provider-utils",
    version: "5.0.43",
    license: "Apache-2.0",
  };
  for (const name of ["cli", "node", "server"]) {
    const root = join(source, "apps", name);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "index.ts"), "export {};\n");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: `@ellie/${name}`,
        exports: "./index.ts",
        dependencies: name === "cli" ? { "@ai-sdk/provider-utils": "5.0.43" } : {},
      }),
    );
  }
  await mkdir(join(source, "packages"));
  for (const area of [
    "apps/command-center/dist",
    "apps/life-ui/dist",
    "scripts/licenses",
    "node_modules/@ai-sdk/provider-utils",
  ])
    await mkdir(join(source, area), { recursive: true });
  await writeFile(join(source, "apps/command-center/dist/index.html"), "fixture\n");
  await writeFile(join(source, "apps/life-ui/dist/index.html"), "fixture\n");
  await writeFile(join(source, "LICENSE"), "Ellie fixture license\n");
  await writeFile(join(source, "package.json"), '{"name":"fixture"}\n');
  await writeFile(lock, lockText(integrity));
  await writeFile(packageJson, JSON.stringify(packageValue));
  await writeFile(join(packageDirectory, "index.js"), "export {};\n");
  const upstream = await readFile(
    new URL("../scripts/licenses/provider-utils-5.0.43.LICENSE", import.meta.url),
  );
  await writeFile(license, upstream);
  const stage = async (name: string) => {
    const payload = join(directory, name);
    await mkdir(join(payload, "LICENSES"), { recursive: true });
    return { payload, components: await stageApplication(source, payload) };
  };

  const { payload, components } = await stage("exact");
  assert.deepEqual(components, [
    {
      name: "@ai-sdk/provider-utils",
      version: "5.0.43",
      license: "Apache-2.0",
      files: ["LICENSE"],
    },
  ]);
  assert.deepEqual(
    await readFile(join(payload, "lib/ellie/node_modules/@ai-sdk/provider-utils/LICENSE")),
    upstream,
  );
  assert.match(
    await readFile(join(payload, "LICENSES/THIRD-PARTY-NOTICES.txt"), "utf8"),
    /@ai-sdk\/provider-utils@5\.0\.43 \(Apache-2\.0\)/,
  );
  assert.match(
    await readFile(join(payload, "LICENSES/components.spdx.json"), "utf8"),
    /"name": "@ai-sdk\/provider-utils"/,
  );

  for (const [field, value] of [
    ["name", "@ai-sdk/other"],
    ["version", "5.0.44"],
    ["license", "MIT"],
  ] as const) {
    await writeFile(packageJson, JSON.stringify({ ...packageValue, [field]: value }));
    await assert.rejects(stage(`wrong-${field}`), /incomplete license metadata/);
  }
  await writeFile(packageJson, JSON.stringify(packageValue));
  await writeFile(lock, lockText(`sha512-${"A".repeat(88)}`));
  await assert.rejects(stage("wrong-integrity"), /incomplete license metadata/);
  await writeFile(
    lock,
    lockText(integrity).replace("@ai-sdk/provider-utils@5.0.43", "@ai-sdk/provider-utils@5.0.44"),
  );
  await assert.rejects(stage("wrong-lock-version"), /incomplete license metadata/);
  await writeFile(lock, lockText(integrity));
  const tampered = Buffer.from(upstream);
  const firstByte = tampered[0];
  assert.ok(firstByte !== undefined);
  tampered[0] = firstByte ^ 1;
  await writeFile(license, tampered);
  await assert.rejects(stage("tampered-notice"), /does not match its upstream source/);
  await rm(license);
  await assert.rejects(stage("missing-notice"), { code: "ENOENT" });
  await symlink(join(source, "LICENSE"), license);
  await assert.rejects(stage("linked-notice"), { code: "ELOOP" });
  await rm(license);
  await mkdir(license);
  await assert.rejects(stage("nonregular-notice"), /bounded regular file/);
  await rm(license, { recursive: true });
  await writeFile(license, upstream);
  await link(license, join(source, "second-license-link"));
  await assert.rejects(stage("hardlinked-notice"), /bounded regular file/);
  await rm(join(source, "second-license-link"));
  await rm(license);

  await writeFile(join(packageDirectory, "LICENSE"), "Package supplied license\n");
  const preferred = await stage("package-license-preferred");
  assert.equal(
    await readFile(
      join(preferred.payload, "lib/ellie/node_modules/@ai-sdk/provider-utils/LICENSE"),
      "utf8",
    ),
    "Package supplied license\n",
  );
  await rm(join(packageDirectory, "LICENSE"));
  await writeFile(license, upstream);
  await writeFile(
    join(source, "apps/cli/package.json"),
    JSON.stringify({
      name: "@ellie/cli",
      exports: "./index.ts",
      dependencies: { "@ai-sdk/provider-utils": "5.0.43", unlicensed: "1.0.0" },
    }),
  );
  await mkdir(join(source, "node_modules/unlicensed"));
  await writeFile(
    join(source, "node_modules/unlicensed/package.json"),
    JSON.stringify({
      name: "unlicensed",
      version: "1.0.0",
      license: "MIT",
    }),
  );
  await assert.rejects(
    stage("other-missing-license"),
    /Production dependency unlicensed has incomplete license metadata/,
  );
});

test("restricts payload architecture to the current supported Mac host", () => {
  assert.equal(targetArchitecture("arm64", "darwin", "arm64"), "arm64");
  assert.throws(() => targetArchitecture("x64", "darwin", "arm64"), /current supported/);
  assert.throws(() => targetArchitecture(undefined, "linux", "arm64"), /current supported/);
  assert.equal(nativeArchitecture("arm64"), "arm64");
  assert.equal(nativeArchitecture("x64"), "x86_64");
});

test("staged bundled Node resolves Life imports without starting the application", async (t) => {
  const directory = await temporary(t, "ellie-payload-life-import-");
  const payload = join(directory, "payload"),
    runtime = join(payload, "lib/ellie"),
    entry = join(runtime, "apps/life/src/embedded.ts"),
    dependency = join(runtime, "packages/life-dependency/index.ts");
  await mkdir(join(payload, "bin"), { recursive: true });
  await copyFile(process.execPath, join(payload, "bin/node"));
  await chmod(join(payload, "bin/node"), 0o755);
  await mkdir(join(runtime, "apps/life/src"), { recursive: true });
  await mkdir(join(runtime, "packages/life-dependency"), { recursive: true });
  await writeFile(join(runtime, "package.json"), '{"type":"module"}\n');
  await writeFile(dependency, "export const ready = true;\n");
  await writeFile(
    entry,
    'import { ready } from "../../../packages/life-dependency/index.ts"; if (!ready) throw new Error("Missing dependency."); export function createLifeApplication() { throw new Error("Must not start Life."); } export const createEmbeddedLifeApplication = createLifeApplication;\n',
  );
  await verifyStagedLifeRuntime(payload, join(directory, "environment"));
  await rm(dependency);
  await assert.rejects(verifyStagedLifeRuntime(payload, join(directory, "environment")));
});

test("dependency preparation ignores lifecycle scripts and inherited private state", async (t) => {
  const directory = await temporary(t, "ellie-payload-install-");
  const project = join(directory, "project");
  const dependency = join(project, "fixture");
  const cache = join(directory, "cache");
  const marker = join(directory, "script-ran");
  const bun = execFileSync("/usr/bin/which", ["bun"], { encoding: "utf8" }).trim();
  await mkdir(dependency, { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      trustedDependencies: ["fixture"],
      private: true,
      dependencies: { fixture: "file:./fixture" },
    }),
  );
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: {
        install: `node -e "require('fs').writeFileSync('${marker}','ran')"`,
      },
    }),
  );
  execFileSync(bun, ["install", "--ignore-scripts", "--cache-dir", cache], {
    cwd: project,
    env: {
      PATH: `${bun.slice(0, bun.lastIndexOf("/"))}:/usr/bin:/bin`,
      HOME: join(directory, "seed-home"),
    },
    stdio: "ignore",
  });
  await rm(join(project, "node_modules"), { recursive: true, force: true });
  execFileSync(bun, ["install", "--offline", "--cache-dir", cache], {
    cwd: project,
    env: {
      PATH: `${bun.slice(0, bun.lastIndexOf("/"))}:/usr/bin:/bin`,
      HOME: join(directory, "control-home"),
    },
    stdio: "ignore",
  });
  assert.equal(await readFile(marker, "utf8"), "ran");
  await rm(join(project, "node_modules"), { recursive: true, force: true });
  await rm(marker);
  process.env.ELLIE_PRIVATE_SENTINEL = "must-not-inherit";
  try {
    await prepareDependencies({
      bun,
      cwd: project,
      cache,
      environmentRoot: join(directory, "environment"),
    });
  } finally {
    delete process.env.ELLIE_PRIVATE_SENTINEL;
  }
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("dependency preparation passes only the intended isolated environment", async (t) => {
  const directory = await temporary(t, "ellie-payload-environment-");
  const fakeBun = join(directory, "fake-bun");
  const observed = join(directory, "observed");
  await writeFile(
    fakeBun,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${observed}.args'\nprintf 'HOME=%s\\nTMPDIR=%s\\nCACHE=%s\\nPATH=%s\\nSENTINEL=%s\\n' "$HOME" "$TMPDIR" "$BUN_INSTALL_CACHE_DIR" "$PATH" "$ELLIE_PRIVATE_SENTINEL" > '${observed}.env'\n`,
    { mode: 0o755 },
  );
  process.env.ELLIE_PRIVATE_SENTINEL = "must-not-inherit";
  try {
    await prepareDependencies({
      bun: fakeBun,
      cwd: directory,
      cache: join(directory, "cache"),
      environmentRoot: join(directory, "environment"),
    });
  } finally {
    delete process.env.ELLIE_PRIVATE_SENTINEL;
  }
  assert.deepEqual((await readFile(`${observed}.args`, "utf8")).trim().split("\n"), [
    "install",
    "--frozen-lockfile",
    "--offline",
    "--ignore-scripts",
    "--cache-dir",
    join(directory, "cache"),
  ]);
  const environment = await readFile(`${observed}.env`, "utf8");
  assert.match(environment, new RegExp(`HOME=${join(directory, "environment/home")}`));
  assert.match(
    environment,
    new RegExp(`PATH=${process.execPath.slice(0, process.execPath.lastIndexOf("/"))}:${directory}`),
  );
  assert.match(environment, /SENTINEL=\n$/);
  assert.doesNotMatch(environment, /must-not-inherit/);
});

test("manifest verification rejects any payload mutation", async (t) => {
  const directory = await temporary(t, "ellie-payload-manifest-");
  const release = join(directory, "release");
  await mkdir(join(release, "payload/bin"), { recursive: true });
  const runtime = join(release, "payload/bin/node");
  await writeFile(runtime, "fixture", { mode: 0o755 });
  await writeFile(
    join(release, "manifest.json"),
    `${JSON.stringify(
      manifest([
        {
          path: "bin/node",
          mode: 0o755,
          size: 7,
          sha256: digest(Buffer.from("fixture")),
        },
      ]),
    )}\n`,
  );
  await writeFile(join(release, "SOURCE.txt"), sourceRecord());
  await verifyManifest(release);
  await writeFile(runtime, "changed", { mode: 0o755 });
  await assert.rejects(verifyManifest(release), /does not match/);
  await writeFile(runtime, "fixture", { mode: 0o755 });
  await chmod(runtime, 0o4755);
  await assert.rejects(verifyManifest(release), /unsafe mode/);
});

test("builder admits the finite native file limit and rejects files, entries, and depth beyond it", async (t) => {
  const directory = await temporary(t, "ellie-payload-inventory-limits-");
  const release = join(directory, "release");
  const payload = join(release, "payload");
  await mkdir(payload, { recursive: true, mode: 0o755 });
  const bytes = Buffer.from("x");
  const files = [];
  for (let index = 0; index < MAXIMUM_PAYLOAD_FILES; index++) {
    const name = `f${String(index).padStart(4, "0")}`;
    await writeFile(join(payload, name), bytes, { mode: 0o644 });
    files.push({ path: name, mode: 0o644, size: 1, sha256: digest(bytes) });
  }
  await writeFile(join(release, "SOURCE.txt"), sourceRecord());
  await writeFile(join(release, "manifest.json"), `${JSON.stringify(manifest(files))}\n`);
  const acceptedFiles = (await verifyManifest(release)).files;
  assert.ok(Array.isArray(acceptedFiles));
  assert.equal(acceptedFiles.length, 3_072);

  const extra = join(payload, "f3072");
  await writeFile(extra, bytes, { mode: 0o644 });
  await assert.rejects(verifyManifest(release), /file or byte limit/);
  await writeFile(
    join(release, "manifest.json"),
    `${JSON.stringify(manifest([...files, { path: "f3072", mode: 0o644, size: 1, sha256: digest(bytes) }]))}\n`,
  );
  await assert.rejects(verifyManifest(release), /unsupported shape/);
  await rm(extra);
  await writeFile(join(release, "manifest.json"), `${JSON.stringify(manifest(files))}\n`);

  for (let index = 0; index < 1_025; index++)
    await mkdir(join(payload, `d${String(index).padStart(4, "0")}`));
  await assert.rejects(verifyManifest(release), /entry or depth limit/);
  for (let index = 0; index < 1_025; index++)
    await rm(join(payload, `d${String(index).padStart(4, "0")}`), { recursive: true });

  let nested = payload;
  for (let index = 0; index < 17; index++) {
    nested = join(nested, `n${index}`);
    await mkdir(nested);
  }
  await assert.rejects(verifyManifest(release), /entry or depth limit/);
});

test("manifest verification rejects linked release roots and mismatched source metadata", async (t) => {
  const directory = await temporary(t, "ellie-payload-manifest-links-");
  const release = join(directory, "release");
  const external = join(directory, "external");
  await mkdir(join(external, "payload"), { recursive: true });
  await writeFile(join(external, "manifest.json"), `${JSON.stringify(manifest([]))}\n`);
  await writeFile(join(external, "SOURCE.txt"), sourceRecord());
  await mkdir(release);
  await symlink(join(external, "payload"), join(release, "payload"));
  await symlink(join(external, "manifest.json"), join(release, "manifest.json"));
  await writeFile(join(release, "SOURCE.txt"), sourceRecord());
  await assert.rejects(verifyManifest(release));

  await rm(release, { recursive: true });
  await mkdir(join(release, "payload"), { recursive: true });
  await writeFile(join(release, "manifest.json"), `${JSON.stringify(manifest([]))}\n`);
  await writeFile(join(release, "SOURCE.txt"), "wrong\n");
  await assert.rejects(verifyManifest(release), /SOURCE/);
});

test("manifest parsing rejects noncanonical source revisions and payload paths", async (t) => {
  const directory = await temporary(t, "ellie-payload-manifest-syntax-");
  const release = join(directory, "release");
  await mkdir(join(release, "payload"), { recursive: true });
  await writeFile(join(release, "SOURCE.txt"), sourceRecord());
  for (const suffix of ["\n", "\r", "\r\n", "g"]) {
    await writeFile(
      join(release, "manifest.json"),
      `${JSON.stringify({ ...manifest([]), sourceRevision: `${"a".repeat(40)}${suffix}` })}\n`,
    );
    await assert.rejects(verifyManifest(release), /unsupported shape/);
  }
  await writeFile(join(release, "payload/bad\n"), "unsafe\n");
  await writeFile(join(release, "manifest.json"), `${JSON.stringify(manifest([]))}\n`);
  await assert.rejects(verifyManifest(release), /Unsafe payload path/);
});
