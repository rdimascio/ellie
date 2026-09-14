import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
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
  extractVerifiedNode,
  nativeArchitecture,
  prepareDependencies,
  stageApplication,
  targetArchitecture,
  verifyManifest,
  verifyStagedLifeRuntime,
} from "../scripts/build-service-payload.mjs";

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
