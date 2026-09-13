import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";

const mac = process.platform === "darwin";
const source = new URL("../packages/macos/native/ServicePayloadInstaller.swift", import.meta.url)
  .pathname;
const launcherSource = new URL(
  "../packages/macos/native/PackagedServiceLauncher.swift",
  import.meta.url,
).pathname;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const run = (file: string, args: string[]) =>
  spawnSync(file, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });

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
async function fixture(root: string, installer: string, tiny: string) {
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
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "org.ellie.helper",
    join(payload, "helpers/ellie-macos"),
  ]);
  for (const [name, identifier, define] of [
    ["Ellie Coordinator", "org.ellie.assistant.coordinator.app", "ELLIE_COORDINATOR"],
    ["Ellie Node", "org.ellie.assistant.node.app", "ELLIE_NODE"],
  ] as const) {
    const app = join(payload, "launchers", `${name}.app`);
    await mkdir(join(app, "Contents/MacOS"), { recursive: true, mode: 0o755 });
    execFileSync("/usr/bin/xcrun", [
      "swiftc",
      "-swift-version",
      "5",
      "-parse-as-library",
      "-D",
      define,
      launcherSource,
      "-o",
      join(app, "Contents/MacOS/EllieService"),
    ]);
    await writeFile(
      join(app, "Contents/Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>EllieService</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
      { mode: 0o644 },
    );
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", identifier, app]);
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
  t.after(() => removeOwned(root));
  const installer = join(root, "installer");
  const tinySource = join(root, "tiny.swift");
  const tiny = join(root, "tiny");
  await writeFile(tinySource, "@main struct Tiny { static func main() {} }\n");
  execFileSync("/usr/bin/xcrun", [
    "swiftc",
    "-swift-version",
    "5",
    "-parse-as-library",
    "-D",
    "ELLIE_INSTALLER_TESTING",
    source,
    "-o",
    installer,
  ]);
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "org.ellie.installer",
    installer,
  ]);
  execFileSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", tinySource, "-o", tiny]);
  const { release, id } = await fixture(root, installer, tiny);
  const services = join(root, "Services");
  await mkdir(services, { mode: 0o700 });
  await action({ root, release, installer, services, id });
}

const options = { skip: !mac };
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
      assert.equal(run(installer, ["stage", release, "--test-services-root", services]).status, 0);
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
      assert.equal((await readdir(join(services, "releases"))).includes(id), true);
      assert.equal(run(installer, ["stage", release, "--test-services-root", services]).status, 0);
    });
  },
);
