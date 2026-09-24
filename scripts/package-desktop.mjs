#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { measureTree } from "./bundle-runtime.mjs";

const argv = process.argv.slice(2);
if (argv.length && (argv.length !== 2 || argv[0] !== "--runtime" || !isAbsolute(argv[1])))
  throw new Error("Usage: node scripts/package-desktop.mjs [--runtime /absolute/path/payload]");
const runtimeSource = argv.length ? resolve(argv[1]) : undefined;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Unable to determine source revision.");
const modifiedSources = execFileSync(
  "/usr/bin/git",
  ["status", "--porcelain", "--untracked-files=all"],
  { cwd: root, encoding: "utf8" },
).trim();
if (modifiedSources) throw new Error("Refusing to package a working tree that differs from HEAD.");
const short = revision.slice(0, 8);
const destination = join(root, "dist", "release", `Ellie-0.1.0-dev-${short}`);
try {
  await lstat(destination);
  throw new Error(`Refusing to overwrite ${destination}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const scratch = await mkdtemp(join(tmpdir(), "ellie-package-"));
try {
  await mkdir(dirname(destination), { recursive: true });
  const app = join(scratch, "Ellie.app");
  execFileSync(
    process.execPath,
    [
      join(root, "scripts", "build-desktop.mjs"),
      "--output",
      app,
      ...(runtimeSource ? ["--runtime", runtimeSource] : []),
    ],
    { cwd: root, stdio: "inherit" },
  );
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], {
    stdio: "inherit",
  });
  const archive = join(scratch, `Ellie-0.1.0-dev-${short}.zip`);
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
  const roundTrip = join(scratch, "round-trip");
  await mkdir(roundTrip, { mode: 0o700 });
  execFileSync("/usr/bin/ditto", ["-x", "-k", archive, roundTrip]);
  const entries = await readdir(roundTrip);
  if (entries.length !== 1 || entries[0] !== "Ellie.app")
    throw new Error("Packaged archive has an unexpected top-level layout.");
  const archivedApp = join(roundTrip, "Ellie.app");
  const archivedStat = await lstat(archivedApp);
  if (!archivedStat.isDirectory() || archivedStat.isSymbolicLink())
    throw new Error("Packaged archive does not contain an application bundle.");
  execFileSync("/usr/bin/plutil", ["-lint", join(archivedApp, "Contents", "Info.plist")], {
    stdio: "inherit",
  });
  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", archivedApp],
    {
      stdio: "inherit",
    },
  );
  const provenance = JSON.parse(
    await readFile(join(archivedApp, "Contents", "Resources", "build-provenance.json"), "utf8"),
  );
  if (
    Object.keys(provenance).sort().join() !==
      "bundleId,runtime,sourceModified,sourceRevision,version" ||
    provenance.bundleId !== "org.ellie.dashboard" ||
    provenance.sourceModified !== false ||
    provenance.sourceRevision !== revision ||
    provenance.version !== "0.1.0"
  )
    throw new Error("Packaged archive provenance does not match its clean source revision.");
  // Re-measure what survived the archive round trip rather than trusting the record the
  // build wrote, so a truncated or padded runtime cannot ship as a complete one.
  const archivedRuntime = join(archivedApp, "Contents", "Resources", "runtime");
  const embedded = await lstat(archivedRuntime).then(
    () => measureTree(archivedRuntime),
    (error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    },
  );
  if (JSON.stringify(embedded) !== JSON.stringify(provenance.runtime ?? null))
    throw new Error("Packaged archive runtime does not match its recorded provenance.");
  if (Boolean(runtimeSource) !== Boolean(embedded))
    throw new Error("Packaged archive runtime does not match what was requested.");
  const digest = execFileSync("/usr/bin/shasum", ["-a", "256", archive], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Unable to checksum archive.");
  const archiveName = archive.split("/").at(-1);
  const staged = join(scratch, "candidate");
  await mkdir(staged, { mode: 0o755 });
  await rename(app, join(staged, "Ellie.app"));
  await rename(archive, join(staged, archiveName));
  await writeFile(join(staged, "SHA256SUMS"), `${digest}  ${archiveName}\n`, { mode: 0o644 });
  await writeFile(
    join(staged, "SOURCE.txt"),
    `Ellie 0.1.0 development candidate\nSource revision: ${revision}\nBundle: org.ellie.dashboard\nRuntime: ${
      embedded
        ? `embedded, ${embedded.files} files, tree SHA-256 ${embedded.sha256}`
        : "not embedded"
    }\nSignature: ad hoc (not notarized)\n`,
    { mode: 0o644 },
  );
  try {
    await rename(staged, destination);
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY")
      throw new Error(`Refusing to overwrite ${destination}`);
    throw error;
  }
  console.log(`Packaged ${destination}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
