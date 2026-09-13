#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(repositoryRoot, "apps/desktop");
const iconSource = join(repositoryRoot, "packages/macos/assets/Ellie.png");

function usage() {
  return `Usage: node scripts/build-desktop.mjs [--output /absolute/path/Ellie.app] [--bundle-id ID]

Builds and ad-hoc signs the native Ellie macOS application. The default output is
dist/desktop/Ellie.app. A custom output must be an absolute, non-existing .app path.`;
}

function parseArgs(argv) {
  let output = join(repositoryRoot, "dist/desktop/Ellie.app");
  let bundleId = "org.ellie.dashboard";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true, output };
    if (argument === "--bundle-id") {
      const value = argv[index + 1];
      if (!value || !/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(value))
        throw new Error("--bundle-id requires a reverse-DNS identifier.");
      bundleId = value;
      index += 1;
      continue;
    }
    if (argument !== "--output") throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--output requires a path.");
    if (!isAbsolute(value)) throw new Error("--output must be an absolute path.");
    output = resolve(value);
    index += 1;
  }
  if (!output.endsWith(".app") || basename(output) === ".app") {
    throw new Error("The output must be a named .app bundle.");
  }
  return { help: false, output, bundleId };
}

function run(file, args) {
  execFileSync(file, args, { cwd: repositoryRoot, stdio: "inherit" });
}

async function assertMissing(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing output: ${path}`);
}

async function createIcon(workDirectory, resourcesDirectory) {
  const iconset = join(workDirectory, "Ellie.iconset");
  await mkdir(iconset, { mode: 0o700 });
  for (const [points, pixels] of [
    [16, 16],
    [16, 32],
    [32, 32],
    [32, 64],
    [128, 128],
    [128, 256],
    [256, 256],
    [256, 512],
    [512, 512],
    [512, 1024],
  ]) {
    const suffix = pixels === points ? "" : "@2x";
    run("/usr/bin/sips", [
      "-z",
      String(pixels),
      String(pixels),
      iconSource,
      "--out",
      join(iconset, `icon_${points}x${points}${suffix}.png`),
    ]);
  }
  run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(resourcesDirectory, "Ellie.icns")]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("The native Ellie application must be built on macOS.");
  }

  await assertMissing(options.output);
  await mkdir(dirname(options.output), { recursive: true });
  const workDirectory = await mkdtemp(join(tmpdir(), "ellie-desktop-"));
  await chmod(workDirectory, 0o700);

  try {
    const stagedBundle = join(workDirectory, "Ellie.app");
    const contents = join(stagedBundle, "Contents");
    const macOSDirectory = join(contents, "MacOS");
    const resourcesDirectory = join(contents, "Resources");
    const sourceRevision = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(sourceRevision))
      throw new Error("Unable to determine source revision.");
    const sourceModified = Boolean(
      execFileSync("/usr/bin/git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim(),
    );
    const scratchPath = join(workDirectory, "swift-build");
    run("/usr/bin/xcrun", [
      "swift",
      "build",
      "--package-path",
      packagePath,
      "--scratch-path",
      scratchPath,
      "--configuration",
      "release",
      "--product",
      "Ellie",
    ]);
    const binaryPath = execFileSync(
      "/usr/bin/xcrun",
      [
        "swift",
        "build",
        "--package-path",
        packagePath,
        "--scratch-path",
        scratchPath,
        "--configuration",
        "release",
        "--show-bin-path",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    ).trim();

    await mkdir(macOSDirectory, { recursive: true, mode: 0o755 });
    await mkdir(resourcesDirectory, { recursive: true, mode: 0o755 });
    await cp(
      join(repositoryRoot, "scripts/voice-transcribe.mjs"),
      join(resourcesDirectory, "voice-transcribe.mjs"),
    );
    await cp(
      join(repositoryRoot, "packages/speech/src/index.ts"),
      join(resourcesDirectory, "speech-index.ts"),
    );
    await cp(join(binaryPath, "Ellie"), join(macOSDirectory, "Ellie"));
    await chmod(join(macOSDirectory, "Ellie"), 0o755);
    await createIcon(workDirectory, resourcesDirectory);
    await writeFile(
      join(resourcesDirectory, "build-provenance.json"),
      `${JSON.stringify({ bundleId: options.bundleId, sourceModified, sourceRevision, version: "0.1.0" }, null, 2)}\n`,
      { mode: 0o644 },
    );
    await writeFile(
      join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>Ellie</string>
  <key>CFBundleIconFile</key><string>Ellie</string>
  <key>CFBundleIdentifier</key><string>${options.bundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Ellie</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>EllieSourceRevision</key><string>${sourceRevision}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><false/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Ellie records only while you explicitly use Push to Talk and transcribes the temporary recording locally.</string>
  <key>NSLocalNetworkUsageDescription</key><string>Ellie connects to your household coordinator to show your paired Macs and open apps you choose on them.</string>
</dict>
</plist>
`,
      { mode: 0o644 },
    );

    run("/usr/bin/plutil", ["-lint", join(contents, "Info.plist")]);
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", stagedBundle]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", stagedBundle]);
    await assertMissing(options.output);
    await rename(stagedBundle, options.output);
    console.log(`Built ${options.output}`);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`desktop:build failed: ${error.message}`);
  process.exitCode = 1;
});
