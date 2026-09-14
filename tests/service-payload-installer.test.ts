import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
  rename,
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
const selectionSource = new URL(
  "../packages/macos/native/ServicePayloadSelection.swift",
  import.meta.url,
).pathname;
const lifecycleSource = new URL(
  "../packages/macos/native/ServicePayloadLifecycle.swift",
  import.meta.url,
).pathname;
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
    selectionSource,
    lifecycleSource,
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
test("installer stage diagnostics are compiled into test builds only", options, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-installer-diagnostic-")));
  t.after(() => removeOwned(root));
  const testing = join(root, "testing-installer");
  const production = join(root, "production-installer");
  execFileSync("/usr/bin/xcrun", [
    "swiftc",
    "-swift-version",
    "5",
    "-parse-as-library",
    "-D",
    "ELLIE_INSTALLER_TESTING",
    selectionSource,
    lifecycleSource,
    source,
    "-o",
    testing,
  ]);
  execFileSync("/usr/bin/xcrun", [
    "swiftc",
    "-swift-version",
    "5",
    "-parse-as-library",
    selectionSource,
    lifecycleSource,
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
});

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

      assert.equal(run(installer, ["stage", release, "--test-services-root", services]).status, 0);
      assert.equal((await lstat(incompleteRelease)).mode & 0o7777, 0o555);
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
  { ...options, timeout: 20_000 },
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
      const duplicateBlock = join(root, "fake-launchctl-duplicate-block");
      const oversized = join(root, "fake-launchctl-oversized");
      const unknownDisabled = join(root, "fake-launchctl-unknown-disabled");
      const disabledValue = join(root, "fake-launchctl-disabled-value");
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
        `#!/bin/sh\n{ printf 'CALL\\n'; for arg in "$@"; do printf 'ARG:%s\\n' "$arg"; done; printf 'END\\n'; } >> ${shell(log)}\nif [ "$1" = print ] && [ "$2" = gui/${uid} ] && [ "$#" = 2 ]; then [ -f ${shell(guiUnavailable)} ] && exit 64; exit 0; fi\nif [ "$1" = print-disabled ] && [ "$2" = gui/${uid} ] && [ "$#" = 2 ]; then\n  if [ -f ${shell(unknownDisabled)} ]; then value=mystery; elif [ -f ${shell(disabledValue)} ]; then value=$(/bin/cat ${shell(disabledValue)}); elif [ -f ${shell(enabled)} ]; then value=enabled; else value=disabled; fi\n  printf '\\ndisabled services = {\\n\\t\\t"${label}" => %s\\n}\\n' "$value"; exit 0\nfi\nif [ "$1" = print ] && [ "$2" = ${target} ] && [ "$#" = 2 ]; then\n  [ -f ${shell(queryFailed)} ] && exit 64\n  if [ -f ${shell(swapAncestor)} ]; then count=0; [ -f ${shell(swapCount)} ] && count=$(/bin/cat ${shell(swapCount)}); count=$((count + 1)); printf '%s\\n' "$count" > ${shell(swapCount)}; if [ "$count" = 2 ]; then /bin/mv ${shell(launchAgents)} ${shell(launchAgentsBackup)}; /bin/mkdir -m 700 ${shell(launchAgents)}; /bin/cp ${shell(join(home, `Library/LaunchAgents/${label}.plist`))} 2>/dev/null || /bin/cp ${shell(join(home, `Library/LaunchAgents.acceptance-backup/${label}.plist`))} ${shell(plist)}; fi; fi\n  [ -f ${shell(state)} ] || exit 113\n  if [ -f ${shell(slow)} ]; then /bin/sleep 3; fi\n  if [ -f ${shell(oversized)} ]; then i=0; while [ "$i" -lt 70000 ]; do printf x; i=$((i + 1)); done; exit 0; fi\n  if [ -f ${shell(malformed)} ]; then printf '${target} = {\\n\\tpath = ${plist}\\n\\tpath = /tmp/duplicate.plist\\n}\\n'; exit 0; fi\n  if [ -f ${shell(nestedSpoof)} ]; then printf '${target} = {\\n\\tpath = ${plist}\\n\\targuments = {\\n\\t\\tpath = /tmp/spoof\\n\\t}\\n}\\n'; exit 0; fi\n  if [ -f ${shell(duplicateBlock)} ]; then printf '${target} = {\\n\\targuments = {\\n\\t}\\n\\targuments = {\\n\\t}\\n}\\n'; exit 0; fi\n  if [ -f ${shell(foreign)} ]; then path=/tmp/unmanaged.plist; else path=${shell(plist)}; fi\n  printf '${target} = {\\n\\tactive count = 1\\n\\tpath = %s\\n\\ttype = LaunchAgent\\n\\tstate = running\\n\\tprogram = ${executable}\\n\\targuments = {\\n\\t\\t${executable}\\n\\t\\t--launch-agent\\n\\t}\\n\\tenvironment = {\\n\\t\\tHOME => /redacted\\n\\t}\\n\\tpid = 123\\n}\\n' "$path"; exit 0\nfi\nif [ "$1" = enable ] && [ "$2" = ${target} ] && [ "$#" = 2 ]; then /usr/bin/touch ${shell(enabled)}; [ -f ${shell(failAfterMutation)} ] && /usr/bin/touch ${shell(queryFailed)}; exit 0; fi\nif [ "$1" = disable ] && [ "$2" = ${target} ] && [ "$#" = 2 ]; then if [ -f ${shell(disableLeavesEnabledUnloads)} ]; then /bin/rm -f ${shell(state)}; else /bin/rm -f ${shell(enabled)}; fi; [ -f ${shell(failAfterMutation)} ] && /usr/bin/touch ${shell(queryFailed)}; exit 0; fi\nif [ "$1" = bootstrap ] && [ "$2" = gui/${uid} ] && [ "$3" = ${shell(plist)} ] && [ "$#" = 3 ]; then /usr/bin/touch ${shell(state)}; [ -f ${shell(failAfterMutation)} ] && /usr/bin/touch ${shell(queryFailed)}; exit 0; fi\nif [ "$1" = bootout ] && [ "$2" = gui/${uid} ] && [ "$3" = ${shell(plist)} ] && [ "$#" = 3 ]; then /bin/rm -f ${shell(state)}; [ -f ${shell(failAfterBootout)} ] && /usr/bin/touch ${shell(queryFailed)}; exit 0; fi\nexit 64\n`,
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
