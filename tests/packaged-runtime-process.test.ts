import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error The acceptance runner stays directly executable JavaScript.
import { launch, releaseHelper, stop, zipEntries } from "../scripts/test-packaged-runtime.mjs";

type OwnedProcess = {
  child: import("node:child_process").ChildProcess;
  pgid: number;
  exited: Promise<unknown>;
};

function centralZip(entries: Array<{ name: string; size?: number; mode: number }>): Buffer {
  let localOffset = 0;
  const locals: Buffer[] = [];
  const records = entries.map(({ name, size = 0, mode }) => {
    const bytes = Buffer.from(name, "ascii");
    const local = Buffer.alloc(30 + bytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(bytes.length, 26);
    bytes.copy(local, 30);
    const record = Buffer.alloc(46 + bytes.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(bytes.length, 28);
    record.writeUInt32LE(mode * 65_536, 38);
    record.writeUInt32LE(localOffset, 42);
    bytes.copy(record, 46);
    localOffset += local.length;
    locals.push(local);
    return record;
  });
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("ZIP preflight rejects unsafe roots, aliases, local headers, and expanded size", () => {
  const root = "EllieServices-test/";
  assert.throws(
    () =>
      zipEntries(
        centralZip([
          { name: root, mode: 0o040755 },
          { name: "other/file", size: 1, mode: 0o100644 },
        ]),
        "EllieServices-test",
      ),
    /top-level root/,
  );
  assert.throws(
    () =>
      zipEntries(
        centralZip([
          { name: root, mode: 0o040755 },
          ...Array.from({ length: 5 }, (_, index) => ({
            name: `${root}file-${index}`,
            size: 128 * 1024 * 1024,
            mode: 0o100644,
          })),
        ]),
        "EllieServices-test",
      ),
    /expanded bound/,
  );
  assert.throws(
    () =>
      zipEntries(
        centralZip([
          { name: root, mode: 0o040755 },
          { name: `${root}/aliased`, mode: 0o100644 },
        ]),
        "EllieServices-test",
      ),
    /unsafe path/,
  );
  const mismatched = centralZip([{ name: root, mode: 0o040755 }]);
  mismatched[30] = "X".charCodeAt(0);
  assert.throws(() => zipEntries(mismatched, "EllieServices-test"), /local entry/);
});

test("a failed second spawn cannot bypass cleanup of an owned running process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-packaged-runtime-spawn-"));
  let running: OwnedProcess | undefined;
  try {
    const started = launch(process.execPath, { PATH: "/usr/bin:/bin" }, directory, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    running = started;
    await new Promise<void>((resolveSpawn) => started.child.once("spawn", resolveSpawn));
    assert.throws(
      () => launch(join(directory, "missing-executable"), {}, directory),
      /Invalid owned process ID/,
    );
  } finally {
    await stop(running);
    await rm(directory, { recursive: true });
  }
});

test("immediate cleanup reaps retained direct children without group signaling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-packaged-runtime-group-"));
  let running: OwnedProcess | undefined;
  try {
    for (let index = 0; index < 20; index++) {
      running = launch(process.execPath, { PATH: "/usr/bin:/bin" }, directory, [
        "-e",
        "setInterval(() => {}, 1000)",
      ]);
      await stop(running);
      running = undefined;
    }
  } finally {
    if (running) {
      try {
        await stop(running);
        running = undefined;
      } catch {}
    }
    if (running) console.error(`Owned process fixture was retained: ${directory}`);
    else await rm(directory, { recursive: true });
  }
});

test("a release acknowledgement never substitutes for helper process exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-packaged-runtime-release-"));
  const release = join(directory, "release");
  const acknowledgement = join(directory, "acknowledgement");
  const token = "a".repeat(64);
  let running: OwnedProcess | undefined;
  try {
    const started = launch(process.execPath, { PATH: "/usr/bin:/bin" }, directory, [
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    running = started;
    await new Promise<void>((resolveSpawn) => started.child.once("spawn", resolveSpawn));
    await writeFile(acknowledgement, token, { mode: 0o600, flag: "wx" });
    const releasing = releaseHelper(release, acknowledgement, token, started.child.pid, 250);
    await assert.rejects(releasing, /remained after release/);
  } finally {
    await stop(running);
    await rm(directory, { recursive: true });
  }
});

test("wrong and linked release sentinels cannot be accepted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-packaged-runtime-token-"));
  const target = join(directory, "target");
  const release = join(directory, "release");
  const acknowledgement = join(directory, "acknowledgement");
  try {
    await writeFile(release, "b".repeat(64), { mode: 0o600, flag: "wx" });
    await assert.rejects(
      releaseHelper(release, acknowledgement, "a".repeat(64), process.pid, 50),
      /release file changed/,
    );
    await rm(release);
    await writeFile(target, "a".repeat(64), { mode: 0o600, flag: "wx" });
    await symlink(target, release);
    await assert.rejects(releaseHelper(release, acknowledgement, "a".repeat(64), process.pid, 50));
  } finally {
    await rm(directory, { recursive: true });
  }
});
