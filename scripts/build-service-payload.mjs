#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const MAX_NODE_BINARY = 128 * 1024 * 1024;
const MAX_NODE_LICENSE = 2 * 1024 * 1024;
const MAX_NODE_ARCHIVE = 64 * 1024 * 1024;
const SOURCE_AREAS = ["apps/cli", "apps/node", "apps/server", "packages"];
const RELEASE = /^node-(v24\.\d+\.\d+)-darwin-(arm64|x64)\.tar\.xz$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MINIMUM_MACOS = "14.0";

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: options.encoding ?? "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT,
    timeout: options.timeout ?? 120_000,
    ...options,
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactLowercaseHex(value, count) {
  return (
    typeof value === "string" &&
    value.length === count &&
    [...value].every(
      (character) =>
        (character >= "0" && character <= "9") || (character >= "a" && character <= "f"),
    )
  );
}

async function fileSha256(path) {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    for await (const bytes of handle.readableWebStream()) hash.update(bytes);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest("hex");
}

function safeRelative(path) {
  return (
    path.length > 0 &&
    path.length <= 500 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part.length <= 100 &&
          part !== "." &&
          part !== ".." &&
          /^[A-Za-z0-9._@+-]+$/.test(part),
      )
  );
}

function safePayloadRelative(path) {
  return (
    path.length > 0 &&
    path.length <= 500 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part.length <= 100 &&
          part !== "." &&
          part !== ".." &&
          [...part].every(
            (character) =>
              (character >= "0" && character <= "9") ||
              (character >= "A" && character <= "Z") ||
              (character >= "a" && character <= "z") ||
              "._@+ -".includes(character),
          ),
      )
  );
}

async function copyTree(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error("Payload input contains a symbolic link.");
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o755 });
    for (const name of (await readdir(source)).sort()) {
      if (name === "node_modules") continue;
      await copyTree(join(source, name), join(destination, name));
    }
    return;
  }
  if (!info.isFile() || info.nlink !== 1) throw new Error("Payload input is not a regular file.");
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await cp(source, destination, { preserveTimestamps: false });
  await chmod(destination, info.mode & 0o111 ? 0o755 : 0o644);
}

async function extractNodeMember(archive, member, destination, maximum, mode) {
  const bytes = command("/usr/bin/tar", ["-xOf", archive, member], {
    encoding: "buffer",
    maxBuffer: maximum + 1,
  });
  if (bytes.length === 0 || bytes.length > maximum)
    throw new Error("Node archive member is invalid.");
  await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
  await writeFile(destination, bytes, { mode, flag: "wx" });
}

export async function extractVerifiedNode({ archive, expectedSha256, destination, architecture }) {
  if (!exactLowercaseHex(expectedSha256, 64)) throw new Error("Invalid Node archive checksum.");
  const match = basename(archive).match(RELEASE);
  if (!match || match[2] !== architecture)
    throw new Error("Node archive does not match the target.");
  const handle = await open(
    archive,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes;
  try {
    const [info, named] = await Promise.all([handle.stat(), lstat(archive)]);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size <= 0 ||
      info.size > MAX_NODE_ARCHIVE ||
      named.isSymbolicLink() ||
      named.dev !== info.dev ||
      named.ino !== info.ino
    )
      throw new Error("Node archive must be one bounded regular file.");
    bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("Node archive ended before its declared size.");
      offset += read.bytesRead;
    }
    const final = await handle.stat();
    if (final.size !== info.size || final.mtimeMs !== info.mtimeMs || final.ino !== info.ino)
      throw new Error("Node archive changed while it was read.");
  } finally {
    await handle.close();
  }
  if (sha256(bytes) !== expectedSha256)
    throw new Error("Node archive checksum does not match the supplied value.");
  await mkdir(destination, { recursive: true, mode: 0o755 });
  const verifiedArchive = join(destination, ".verified-node.tar.xz");
  await writeFile(verifiedArchive, bytes, { mode: 0o600, flag: "wx" });
  const prefix = basename(archive, ".tar.xz");
  try {
    await extractNodeMember(
      verifiedArchive,
      `${prefix}/bin/node`,
      join(destination, "bin/node"),
      MAX_NODE_BINARY,
      0o755,
    );
    await extractNodeMember(
      verifiedArchive,
      `${prefix}/LICENSE`,
      join(destination, "LICENSES/Node.js-LICENSE"),
      MAX_NODE_LICENSE,
      0o644,
    );
  } finally {
    await rm(verifiedArchive, { force: true });
  }
  const version = command(join(destination, "bin/node"), ["--version"]).trim();
  if (version !== match[1])
    throw new Error("Extracted Node runtime version does not match its archive.");
  const runtimeArchitecture = command(join(destination, "bin/node"), ["-p", "process.arch"]).trim();
  if (runtimeArchitecture !== architecture)
    throw new Error("Extracted Node runtime architecture does not match its archive.");
  return {
    version,
    architecture,
    archive: basename(archive),
    sha256: expectedSha256,
    source: `https://nodejs.org/download/release/${version}/${basename(archive)}`,
    checksums: `https://nodejs.org/download/release/${version}/SHASUMS256.txt`,
    license: `https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`,
  };
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function packagePath(root, name) {
  if (!PACKAGE.test(name)) throw new Error("Invalid production dependency name.");
  return join(root, "node_modules", ...name.split("/"));
}

async function materializeWorkspaceFacade(root, workspace, source, name) {
  const value = await json(join(workspace, "package.json"));
  const declared =
    typeof value.exports === "string" ? { ".": value.exports } : (value.exports ?? {});
  if (
    !Object.keys(declared).length ||
    Object.values(declared).some((path) => typeof path !== "string")
  )
    throw new Error(`Workspace ${name} has unsupported exports.`);
  const destination = packagePath(root, name);
  const workspaceRoot = resolve(workspace);
  await mkdir(destination, { recursive: true, mode: 0o755 });
  const exports = {};
  for (const [key, target] of Object.entries(declared)) {
    const keyRelative = key === "." ? "" : key.startsWith("./") ? key.slice(2) : "";
    const targetRelative = typeof target === "string" ? target.slice(2) : "";
    const targetPath = resolve(workspaceRoot, targetRelative);
    if (
      (key !== "." && !safeRelative(keyRelative)) ||
      typeof target !== "string" ||
      !target.startsWith("./") ||
      !safeRelative(targetRelative) ||
      !target.endsWith(".ts") ||
      !targetPath.startsWith(`${workspaceRoot}${sep}`)
    )
      throw new Error(`Workspace ${name} has unsupported exports.`);
    const file = key === "." ? "index.js" : `${keyRelative}.js`;
    const copiedTarget = join(root, relative(source, workspace), targetRelative);
    let specifier = relative(dirname(join(destination, file)), copiedTarget)
      .split(sep)
      .join("/");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    await mkdir(dirname(join(destination, file)), {
      recursive: true,
      mode: 0o755,
    });
    await writeFile(join(destination, file), `export * from ${JSON.stringify(specifier)};\n`, {
      mode: 0o644,
    });
    exports[key] = `./${file}`;
  }
  await writeFile(
    join(destination, "package.json"),
    `${JSON.stringify({ name, private: true, type: "module", exports }, null, 2)}\n`,
    { mode: 0o644 },
  );
}

export function targetArchitecture(
  requested,
  platform = process.platform,
  architecture = process.arch,
) {
  const host = architecture === "arm64" ? "arm64" : architecture === "x64" ? "x64" : undefined;
  if (platform !== "darwin" || !host || (requested !== undefined && requested !== host))
    throw new Error("Service payloads require the current supported macOS architecture.");
  return host;
}

export function nativeArchitecture(architecture) {
  if (architecture === "arm64") return "arm64";
  if (architecture === "x64") return "x86_64";
  throw new Error("Unsupported native helper architecture.");
}

const launcherRoles = {
  coordinator: {
    name: "Ellie Coordinator",
    identifier: "org.ellie.assistant.coordinator.app",
    define: "ELLIE_COORDINATOR",
  },
  node: {
    name: "Ellie Node",
    identifier: "org.ellie.assistant.node.app",
    define: "ELLIE_NODE",
  },
};

function launcherInfo(role) {
  const value = launcherRoles[role];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${value.identifier}</string>
<key>CFBundleName</key><string>${value.name}</string>
<key>CFBundleDisplayName</key><string>${value.name}</string>
<key>CFBundleExecutable</key><string>EllieService</string>
<key>CFBundleIconFile</key><string>Ellie</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
}

export async function buildPackagedLaunchers({ source, payload, architecture, work }) {
  const helperArchitecture = nativeArchitecture(architecture);
  const iconset = join(work, "Ellie.iconset");
  const icon = join(work, "Ellie.icns");
  await mkdir(iconset, { recursive: true, mode: 0o700 });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      command(
        "/usr/bin/sips",
        [
          "-z",
          String(size * scale),
          String(size * scale),
          join(source, "packages/macos/assets/Ellie.png"),
          "--out",
          join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
        ],
        { stdio: "ignore" },
      );
    }
  }
  command("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", icon], { stdio: "ignore" });

  const result = [];
  for (const [role, value] of Object.entries(launcherRoles)) {
    const app = join(payload, "launchers", `${value.name}.app`);
    const executable = join(app, "Contents/MacOS/EllieService");
    const resources = join(app, "Contents/Resources");
    await mkdir(dirname(executable), { recursive: true, mode: 0o755 });
    await mkdir(resources, { recursive: true, mode: 0o755 });
    command(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-swift-version",
        "5",
        "-O",
        "-parse-as-library",
        "-target",
        `${helperArchitecture}-apple-macos${MINIMUM_MACOS}`,
        "-D",
        value.define,
        join(source, "packages/macos/native/PackagedServiceLauncher.swift"),
        "-o",
        executable,
      ],
      { stdio: "ignore" },
    );
    await chmod(executable, 0o755);
    await cp(icon, join(resources, "Ellie.icns"));
    await chmod(join(resources, "Ellie.icns"), 0o644);
    await writeFile(join(app, "Contents/Info.plist"), launcherInfo(role), { mode: 0o644 });
    command("/usr/bin/plutil", ["-lint", join(app, "Contents/Info.plist")], { stdio: "ignore" });
    command(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--identifier", value.identifier, app],
      {
        stdio: "ignore",
      },
    );
    command("/usr/bin/codesign", ["--verify", "--strict", app], { stdio: "ignore" });
    result.push({
      role,
      name: value.name,
      identifier: value.identifier,
      signature: "development-ad-hoc",
      architecture,
      minimumOS: MINIMUM_MACOS,
    });
  }
  return result;
}

function isolatedEnvironment(root, bun, cache) {
  return {
    PATH: `${dirname(process.execPath)}:${dirname(bun)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    BUN_INSTALL_CACHE_DIR: cache,
    NO_COLOR: "1",
  };
}

export async function prepareDependencies({ bun, cwd, cache, environmentRoot }) {
  if (!isAbsolute(cache) || !isAbsolute(bun))
    throw new Error("Build tools and cache paths must be absolute.");
  await mkdir(join(environmentRoot, "home"), { recursive: true, mode: 0o700 });
  await mkdir(join(environmentRoot, "tmp"), { recursive: true, mode: 0o700 });
  command(
    bun,
    ["install", "--frozen-lockfile", "--offline", "--ignore-scripts", "--cache-dir", cache],
    {
      cwd,
      env: isolatedEnvironment(environmentRoot, bun, cache),
      stdio: "ignore",
      timeout: 180_000,
    },
  );
}

async function workspaceMap(root) {
  const result = new Map();
  for (const area of ["apps", "packages"]) {
    for (const name of await readdir(join(root, area))) {
      const directory = join(root, area, name);
      try {
        const value = await json(join(directory, "package.json"));
        if (typeof value.name === "string") result.set(value.name, directory);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return result;
}

async function productionClosure(root) {
  const workspaces = await workspaceMap(root);
  const queue = ["@ellie/cli", "@ellie/node", "@ellie/server"];
  const workspaceNames = new Set();
  const externalNames = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (workspaceNames.has(name)) continue;
    const directory = workspaces.get(name);
    if (!directory) throw new Error(`Missing workspace dependency ${name}.`);
    workspaceNames.add(name);
    const value = await json(join(directory, "package.json"));
    for (const dependency of Object.keys(value.dependencies ?? {})) {
      if (dependency.startsWith("@ellie/")) queue.push(dependency);
      else externalNames.add(dependency);
    }
  }
  const externalQueue = [...externalNames];
  while (externalQueue.length) {
    const name = externalQueue.shift();
    const value = await json(join(packagePath(root, name), "package.json"));
    for (const dependency of Object.keys(value.dependencies ?? {})) {
      if (!externalNames.has(dependency)) {
        externalNames.add(dependency);
        externalQueue.push(dependency);
      }
    }
  }
  return {
    workspaces,
    workspaceNames: [...workspaceNames].sort(),
    externalNames: [...externalNames].sort(),
  };
}

function licenseNames(names) {
  return names.filter((name) => /^(?:licen[cs]e|copying|notice)(?:[-.].*)?$/i.test(name)).sort();
}

export async function stageApplication(source, destination, metadata = {}) {
  const closure = await productionClosure(source);
  const root = join(destination, "lib/ellie");
  await mkdir(root, { recursive: true, mode: 0o755 });
  for (const area of SOURCE_AREAS) {
    if (area === "packages") continue;
    await copyTree(join(source, area), join(root, area));
  }
  await copyTree(join(source, "apps/command-center/dist"), join(root, "apps/command-center/dist"));
  await copyTree(join(source, "package.json"), join(root, "package.json"));
  await copyTree(join(source, "bun.lock"), join(root, "bun.lock"));
  await copyTree(join(source, "LICENSE"), join(destination, "LICENSES/Ellie-LICENSE"));

  for (const name of closure.workspaceNames) {
    const workspace = closure.workspaces.get(name);
    const relativeWorkspace = relative(source, workspace);
    await copyTree(workspace, join(root, relativeWorkspace));
    await materializeWorkspaceFacade(root, workspace, source, name);
  }

  const components = [];
  const notices = [];
  for (const name of closure.externalNames) {
    const sourcePackage = packagePath(source, name);
    const value = await json(join(sourcePackage, "package.json"));
    const licenses = licenseNames(await readdir(sourcePackage));
    if (!licenses.length || typeof value.version !== "string" || typeof value.license !== "string")
      throw new Error(`Production dependency ${name} has incomplete license metadata.`);
    await copyTree(sourcePackage, packagePath(root, name));
    const texts = [];
    for (const file of licenses) texts.push(await readFile(join(sourcePackage, file), "utf8"));
    components.push({
      name,
      version: value.version,
      license: value.license,
      files: licenses,
    });
    notices.push(`===== ${name}@${value.version} (${value.license}) =====\n${texts.join("\n")}`);
  }
  await writeFile(
    join(destination, "LICENSES/THIRD-PARTY-NOTICES.txt"),
    `${notices.join("\n\n")}\n`,
    { mode: 0o644 },
  );
  const spdxPackages = components.map((component, index) => ({
    SPDXID: `SPDXRef-Package-${index + 1}`,
    name: component.name,
    versionInfo: component.version,
    licenseConcluded: component.license,
    licenseDeclared: component.license,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
  }));
  await writeFile(
    join(destination, "LICENSES/components.spdx.json"),
    `${JSON.stringify(
      {
        spdxVersion: "SPDX-2.3",
        dataLicense: "CC0-1.0",
        SPDXID: "SPDXRef-DOCUMENT",
        name: "Ellie service production dependencies",
        documentNamespace: `https://ellie.local/spdx/${sha256(JSON.stringify(components))}`,
        creationInfo: {
          created: metadata.created ?? "1970-01-01T00:00:00.000Z",
          creators: ["Tool: Ellie service payload builder"],
        },
        documentDescribes: spdxPackages.map(({ SPDXID }) => SPDXID),
        packages: spdxPackages,
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
  return components;
}

async function entries(root, current = root) {
  const result = [];
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const relativePath = relative(root, path).split(sep).join("/");
    if (!safePayloadRelative(relativePath)) throw new Error("Unsafe payload path.");
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Payload contains a symbolic link.");
    if (info.isDirectory()) {
      if ((info.mode & 0o7777) !== 0o755) throw new Error("Payload directory has an unsafe mode.");
      result.push(...(await entries(root, path)));
    } else if (info.isFile() && info.nlink === 1) {
      const mode = info.mode & 0o7777;
      if (mode !== 0o644 && mode !== 0o755) throw new Error("Payload file has an unsafe mode.");
      result.push({
        path: relativePath,
        mode,
        size: info.size,
        sha256: await fileSha256(path),
      });
    } else throw new Error("Payload contains an unsupported file.");
  }
  return result;
}

function sourceRecord(manifest) {
  return `Ellie service payload\nSource revision: ${manifest.sourceRevision}\nNode.js: ${manifest.runtime.version}\nNode archive SHA-256: ${manifest.runtime.sha256}\nMinimum macOS: ${manifest.minimumOS}\nHelper: ${manifest.helper.identifier} (${manifest.helper.signature})\n`;
}

async function regularFile(path, expectedMode, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o7777) !== expectedMode ||
      info.size > maximum
    )
      throw new Error("Release metadata is not one bounded regular file.");
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function verifyManifest(release) {
  const releaseInfo = await lstat(release);
  if (!releaseInfo.isDirectory() || releaseInfo.isSymbolicLink())
    throw new Error("Release root must be a directory.");
  if (
    JSON.stringify((await readdir(release)).sort()) !==
    JSON.stringify(["SOURCE.txt", "manifest.json", "payload"])
  )
    throw new Error("Release has an unexpected top-level layout.");
  const payload = join(release, "payload");
  const payloadInfo = await lstat(payload);
  if (
    !payloadInfo.isDirectory() ||
    payloadInfo.isSymbolicLink() ||
    (payloadInfo.mode & 0o7777) !== 0o755
  )
    throw new Error("Payload root must be a safe directory.");
  const manifestBytes = await regularFile(join(release, "manifest.json"), 0o644, 4 * 1024 * 1024);
  const sourceBytes = await regularFile(join(release, "SOURCE.txt"), 0o644, 16 * 1024);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest?.version !== 1 ||
    !exactLowercaseHex(manifest.sourceRevision, 40) ||
    manifest.minimumOS !== MINIMUM_MACOS ||
    manifest.helper?.identifier !== "org.ellie.helper" ||
    manifest.helper?.signature !== "development-ad-hoc" ||
    !Array.isArray(manifest.launchers) ||
    JSON.stringify(manifest.launchers) !==
      JSON.stringify(
        Object.entries(launcherRoles).map(([role, value]) => ({
          role,
          name: value.name,
          identifier: value.identifier,
          signature: "development-ad-hoc",
          architecture: manifest.architecture,
          minimumOS: MINIMUM_MACOS,
        })),
      ) ||
    !Array.isArray(manifest.files)
  )
    throw new Error("Payload manifest has an unsupported shape.");
  if (sourceBytes.toString("utf8") !== sourceRecord(manifest))
    throw new Error("SOURCE.txt does not match the payload manifest.");
  const actual = await entries(payload);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error("Payload manifest does not match its files.");
  return manifest;
}

async function trackedSource(source, destination, revision) {
  const records = command("/usr/bin/git", ["ls-tree", "-r", "-z", revision], {
    cwd: source,
  })
    .split("\0")
    .filter(Boolean);
  for (const record of records) {
    const match = record.match(/^(100644|100755) blob [a-f0-9]{40}\t(.+)$/);
    if (!match || !safeRelative(match[2])) throw new Error("Git contains an unsafe source entry.");
  }
  const archive = join(dirname(destination), "source.tar");
  command("/usr/bin/git", ["archive", "--format=tar", `--output=${archive}`, revision], {
    cwd: source,
    stdio: "ignore",
  });
  try {
    command("/usr/bin/tar", ["-xf", archive, "-C", destination], {
      stdio: "ignore",
    });
  } finally {
    await rm(archive, { force: true });
  }
}

function assertClean(root) {
  const status = command("/usr/bin/git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
  }).trim();
  if (status) throw new Error("Refusing to build from modified or untracked source.");
}

export async function buildServicePayload(options) {
  const source = resolve(options.source ?? scriptRoot);
  const output = resolve(options.output);
  const architecture = targetArchitecture(options.architecture);
  const helperArchitecture = nativeArchitecture(architecture);
  if (!process.versions.node.startsWith("24."))
    throw new Error("Build service payloads with Node.js 24.");
  const bunInput = options.bun ?? "bun";
  const bun = bunInput.startsWith("/")
    ? resolve(bunInput)
    : command("/usr/bin/which", [bunInput]).trim();
  if (!bun.startsWith("/") || !options.bunCache)
    throw new Error("Use an absolute Bun executable and explicit pre-populated cache.");
  const bunCache = resolve(options.bunCache);
  if (command(bun, ["--version"]).trim() !== "1.4.2")
    throw new Error("Build service payloads with Bun 1.4.2.");
  assertClean(source);
  const revision = command("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: source,
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Unable to determine source revision.");
  const created = new Date(
    command("/usr/bin/git", ["show", "-s", "--format=%cI", revision], {
      cwd: source,
    }).trim(),
  ).toISOString();
  try {
    await lstat(output);
    throw new Error("Refusing to overwrite the output directory.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const scratch = await mkdtemp(join(tmpdir(), "ellie-service-payload-"));
  await chmod(scratch, 0o700);
  try {
    const buildSource = join(scratch, "source");
    await mkdir(buildSource, { mode: 0o700 });
    await trackedSource(source, buildSource, revision);
    const buildEnvironment = join(scratch, "build-environment");
    await prepareDependencies({
      bun,
      cwd: buildSource,
      cache: bunCache,
      environmentRoot: buildEnvironment,
    });
    command(bun, ["run", "demo:build"], {
      cwd: buildSource,
      env: isolatedEnvironment(buildEnvironment, bun, bunCache),
      stdio: "ignore",
      timeout: 180_000,
    });
    const name = `EllieServices-0.1.0-dev-${revision.slice(0, 8)}-macos-${architecture}`;
    const stagedOutput = join(scratch, "output");
    const release = join(stagedOutput, name);
    const payload = join(release, "payload");
    await mkdir(join(payload, "LICENSES"), { recursive: true, mode: 0o755 });
    const runtime = await extractVerifiedNode({
      archive: resolve(options.nodeArchive),
      expectedSha256: options.nodeSha256,
      destination: payload,
      architecture,
    });
    const components = await stageApplication(buildSource, payload, {
      created,
    });
    await mkdir(join(payload, "helpers"), { mode: 0o755 });
    command(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-swift-version",
        "5",
        "-O",
        "-parse-as-library",
        "-target",
        `${helperArchitecture}-apple-macos${MINIMUM_MACOS}`,
        join(buildSource, "packages/macos/native/Geometry.swift"),
        join(buildSource, "packages/macos/native/EllieHelper.swift"),
        "-o",
        join(payload, "helpers/ellie-macos"),
      ],
      { stdio: "ignore" },
    );
    command(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        "-",
        "--identifier",
        "org.ellie.helper",
        join(payload, "helpers/ellie-macos"),
      ],
      { stdio: "ignore" },
    );
    const helperPath = join(payload, "helpers/ellie-macos");
    if (command("/usr/bin/lipo", ["-archs", helperPath]).trim() !== helperArchitecture)
      throw new Error("Native helper architecture does not match the payload.");
    const buildVersion = command("/usr/bin/xcrun", ["vtool", "-show-build", helperPath]);
    const minimumPattern = new RegExp(`minos ${MINIMUM_MACOS.replace(".", "\\.")}(?:\\s|$)`);
    if (!/platform MACOS/.test(buildVersion) || !minimumPattern.test(buildVersion))
      throw new Error("Native helper minimum macOS version does not match the payload.");
    const launchers = await buildPackagedLaunchers({
      source: buildSource,
      payload,
      architecture,
      work: join(scratch, "launcher-build"),
    });
    const installer = join(payload, "bin/ellie-service-installer");
    command(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-swift-version",
        "5",
        "-O",
        "-parse-as-library",
        "-target",
        `${helperArchitecture}-apple-macos${MINIMUM_MACOS}`,
        join(buildSource, "packages/macos/native/ServicePayloadSelection.swift"),
        join(buildSource, "packages/macos/native/ServicePayloadLifecycle.swift"),
        join(buildSource, "packages/macos/native/ServicePayloadMigration.swift"),
        join(buildSource, "packages/macos/native/ServicePayloadInstaller.swift"),
        "-o",
        installer,
      ],
      { stdio: "ignore" },
    );
    await chmod(installer, 0o755);
    command(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--identifier", "org.ellie.installer", installer],
      { stdio: "ignore" },
    );
    command("/usr/bin/codesign", ["--verify", "--strict", installer], { stdio: "ignore" });
    if (command("/usr/bin/lipo", ["-archs", installer]).trim() !== helperArchitecture)
      throw new Error("Native installer architecture does not match the payload.");
    const installerBuild = command("/usr/bin/xcrun", ["vtool", "-show-build", installer]);
    if (!/platform MACOS/.test(installerBuild) || !minimumPattern.test(installerBuild))
      throw new Error("Native installer minimum macOS version does not match the payload.");
    const lockSha256 = await fileSha256(join(buildSource, "bun.lock"));
    const manifest = {
      version: 1,
      productVersion: "0.1.0",
      sourceRevision: revision,
      sourceModified: false,
      platform: "darwin",
      architecture,
      minimumOS: MINIMUM_MACOS,
      lockSha256,
      buildTools: { node: process.versions.node, bun: "1.4.2" },
      runtime,
      helper: {
        identifier: "org.ellie.helper",
        signature: "development-ad-hoc",
        architecture,
        minimumOS: MINIMUM_MACOS,
      },
      launchers,
      components,
      files: await entries(payload),
    };
    await writeFile(join(release, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o644,
    });
    await writeFile(join(release, "SOURCE.txt"), sourceRecord(manifest), {
      mode: 0o644,
    });
    await verifyManifest(release);
    const originalManifest = await regularFile(
      join(release, "manifest.json"),
      0o644,
      4 * 1024 * 1024,
    );
    const originalSource = await regularFile(join(release, "SOURCE.txt"), 0o644, 16 * 1024);
    const archiveName = `${name}.zip`;
    const archive = join(stagedOutput, archiveName);
    command("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", release, archive], {
      stdio: "ignore",
    });
    const roundTrip = join(scratch, "round-trip");
    await mkdir(roundTrip, { mode: 0o700 });
    command("/usr/bin/ditto", ["-x", "-k", archive, roundTrip], {
      stdio: "ignore",
    });
    const roundTripNames = await readdir(roundTrip);
    if (roundTripNames.length !== 1 || roundTripNames[0] !== name)
      throw new Error("Service archive has an unexpected top-level layout.");
    await verifyManifest(join(roundTrip, name));
    for (const value of Object.values(launcherRoles)) {
      const app = join(roundTrip, name, "payload/launchers", `${value.name}.app`);
      command("/usr/bin/codesign", ["--verify", "--strict", app], { stdio: "ignore" });
      if (
        command("/usr/libexec/PlistBuddy", [
          "-c",
          "Print :CFBundleIdentifier",
          join(app, "Contents/Info.plist"),
        ]).trim() !== value.identifier
      )
        throw new Error("Round-trip launcher identity does not match its manifest.");
    }
    const roundTripManifest = await regularFile(
      join(roundTrip, name, "manifest.json"),
      0o644,
      4 * 1024 * 1024,
    );
    const roundTripSource = await regularFile(
      join(roundTrip, name, "SOURCE.txt"),
      0o644,
      16 * 1024,
    );
    if (!originalManifest.equals(roundTripManifest) || !originalSource.equals(roundTripSource))
      throw new Error("Service archive changed its release metadata.");
    const digest = await fileSha256(archive);
    await writeFile(join(stagedOutput, "SHA256SUMS"), `${digest}  ${archiveName}\n`, {
      mode: 0o644,
    });
    assertClean(source);
    if (command("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: source }).trim() !== revision)
      throw new Error("Source revision changed during the build.");
    await mkdir(dirname(output), { recursive: true });
    await rename(stagedOutput, output);
    return {
      output,
      release: join(output, name),
      archive: join(output, archiveName),
      digest,
      manifest,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error("Every payload option requires a value.");
    if (key === "--node-archive") options.nodeArchive = value;
    else if (key === "--node-sha256") options.nodeSha256 = value;
    else if (key === "--bun-cache") options.bunCache = value;
    else if (key === "--output") options.output = value;
    else throw new Error("Unknown payload builder option.");
  }
  if (!options.nodeArchive || !options.nodeSha256 || !options.bunCache || !options.output)
    throw new Error("Use --node-archive, --node-sha256, --bun-cache, and --output.");
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildServicePayload(parse(process.argv.slice(2)))
    .then((result) => console.log(`Built ${result.output}`))
    .catch(() => {
      console.error(
        "Service payload build failed. Verify the clean source, explicit Node archive and checksum, Bun 1.4.2, Xcode tools, and output path.",
      );
      process.exitCode = 1;
    });
}
