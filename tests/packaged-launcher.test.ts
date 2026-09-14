import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { buildPackagedLaunchers } from "../scripts/build-service-payload.mjs";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function files(root: string, current = root): Promise<object[]> {
  const result: object[] = [];
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const information = await lstat(path);
    if (information.isDirectory()) result.push(...(await files(root, path)));
    else {
      const bytes = await readFile(path);
      result.push({
        path: relative(root, path),
        mode: information.mode & 0o111 ? 0o755 : 0o644,
        size: bytes.length,
        sha256: digest(bytes),
      });
    }
  }
  return result;
}

async function makeReadOnly(path: string): Promise<void> {
  const information = await lstat(path);
  if (information.isDirectory()) {
    for (const name of await readdir(path)) await makeReadOnly(join(path, name));
    await chmod(path, 0o555);
  } else {
    await chmod(path, information.mode & 0o111 ? 0o555 : 0o444);
  }
}

async function makeWritable(path: string): Promise<void> {
  const information = await lstat(path);
  if (information.isDirectory()) {
    await chmod(path, 0o755);
    for (const name of await readdir(path)) await makeWritable(join(path, name));
  } else {
    await chmod(path, information.mode & 0o111 ? 0o755 : 0o644);
  }
}

test("shipping launchers validate a complete installed payload and exec one fixed role", async (t) => {
  if (process.platform !== "darwin") return t.skip("Packaged launchers require macOS build tools.");
  const directory = await mkdtemp(join(tmpdir(), "ellie-packaged-launchers-"));
  await chmod(directory, 0o700);
  t.after(async () => {
    await makeWritable(directory);
    await rm(directory, { recursive: true, force: true });
  });
  const release = join(directory, "release");
  const payload = join(release, "payload");
  const output = join(directory, "execution.txt");
  await mkdir(join(payload, "bin"), { recursive: true });
  await mkdir(join(payload, "lib/ellie/apps/cli/src"), { recursive: true });
  await mkdir(join(payload, "helpers"), { recursive: true });
  await writeFile(
    join(payload, "bin/node"),
    `#!/bin/sh\nprintf 'argv=%s\\nhelper=%s\\noptions=%s\\npath=%s\\n' "$*" "$ELLIE_MACOS_HELPER" "$NODE_OPTIONS" "$PATH" > "$ELLIE_LAUNCHER_TEST_OUTPUT"\n`,
    { mode: 0o755 },
  );
  await writeFile(join(payload, "lib/ellie/apps/cli/src/main.ts"), "// synthetic fixture\n");
  await writeFile(join(payload, "helpers/ellie-macos"), "#!/bin/sh\n", { mode: 0o755 });
  const launchers = await buildPackagedLaunchers({
    source: process.cwd(),
    payload,
    architecture: process.arch as "arm64" | "x64",
    work: join(directory, "work"),
  });
  const manifest = {
    version: 1,
    sourceRevision: "a".repeat(40),
    platform: "darwin",
    architecture: process.arch,
    minimumOS: "14.0",
    runtime: { architecture: process.arch },
    files: await files(payload),
  };
  const baseFiles = manifest.files;
  await writeFile(join(release, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  await makeReadOnly(release);
  const canonicalPayload = await realpath(payload);

  for (const { role, name } of launchers) {
    const executable = join(payload, "launchers", `${name}.app/Contents/MacOS/EllieService`);
    const result = spawnSync(executable, ["--launch-agent"], {
      cwd: release,
      env: {
        HOME: join(directory, "home"),
        ELLIE_LAUNCHER_TEST_OUTPUT: output,
        NODE_OPTIONS: "--synthetic-preload-must-be-removed",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    const observed = await readFile(output, "utf8");
    assert.match(observed, new RegExp(`argv=.*main\\.ts service run ${role}`));
    assert.match(observed, new RegExp(`helper=${canonicalPayload}/helpers/ellie-macos`));
    assert.match(observed, /options=\n/);
    assert.match(
      observed,
      new RegExp(`path=${canonicalPayload}/bin:/usr/bin:/bin:/usr/sbin:/sbin`),
    );
  }

  const executable = join(payload, "launchers/Ellie Node.app/Contents/MacOS/EllieService");
  const rejected = () =>
    spawnSync(executable, ["--launch-agent"], { cwd: release, timeout: 10_000 }).status;
  const publishManifest = async (value: typeof manifest) => {
    await chmod(release, 0o755);
    await chmod(join(release, "manifest.json"), 0o644);
    await writeFile(join(release, "manifest.json"), `${JSON.stringify(value)}\n`);
    await chmod(join(release, "manifest.json"), 0o444);
    await chmod(release, 0o555);
  };

  await chmod(payload, 0o755);
  await mkdir(join(payload, "undeclared-empty"), { mode: 0o555 });
  await chmod(payload, 0o555);
  assert.equal(rejected(), 78);

  await makeWritable(payload);
  await rm(join(payload, "undeclared-empty"), { recursive: true });
  await writeFile(join(payload, "undeclared-file"), "mutation\n");
  await makeReadOnly(payload);
  assert.equal(rejected(), 78);

  await makeWritable(payload);
  await rm(join(payload, "undeclared-file"));
  const originalEntrypoint = "// synthetic fixture\n";
  const tamperedEntrypoint = "// tampered! fixture\n";
  assert.equal(Buffer.byteLength(tamperedEntrypoint), Buffer.byteLength(originalEntrypoint));
  await writeFile(join(payload, "lib/ellie/apps/cli/src/main.ts"), tamperedEntrypoint);
  await makeReadOnly(payload);
  assert.equal(rejected(), 78);

  await makeWritable(payload);
  await writeFile(join(payload, "lib/ellie/apps/cli/src/main.ts"), originalEntrypoint);
  let deep = join(payload, "deep");
  for (let index = 0; index < 18; index++) deep = join(deep, `d${index}`);
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "file"), "deep\n");
  manifest.files = await files(payload);
  await publishManifest(manifest);
  await makeReadOnly(payload);
  assert.equal(rejected(), 78);

  await makeWritable(payload);
  await rm(join(payload, "deep"), { recursive: true });
  for (let index = 0; index < 1_400; index++) {
    const nested = join(payload, "wide", `d${index}`, "inner");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "file"), "wide\n");
  }
  manifest.files = await files(payload);
  await publishManifest(manifest);
  await makeReadOnly(payload);
  assert.equal(rejected(), 78);

  await makeWritable(payload);
  await rm(join(payload, "wide"), { recursive: true });
  await chmod(join(payload, "bin/node"), 0o444);
  manifest.files = baseFiles.map((file) =>
    "path" in file && file.path === "bin/node" ? { ...file, mode: 0o644 } : file,
  );
  await publishManifest(manifest);
  await makeReadOnly(payload);
  assert.equal(rejected(), 78);

  await makeWritable(payload);
  await chmod(join(payload, "bin/node"), 0o755);
  manifest.files = baseFiles;
  for (const suffix of ["\n", "\r", "\r\n", "g"]) {
    manifest.sourceRevision = `${"a".repeat(40)}${suffix}`;
    await publishManifest(manifest);
    await makeReadOnly(payload);
    assert.equal(rejected(), 78);
    await makeWritable(payload);
  }
});
