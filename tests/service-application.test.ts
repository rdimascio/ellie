import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  applicationPath,
  applicationExecutable,
  MacOSServiceApplication,
} from "../apps/cli/src/service-application.ts";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ellie-app-test-"));
  const source = join(home, "checkout with spaces & quotes'");
  await mkdir(join(source, "packages/macos/native"), { recursive: true });
  await mkdir(join(source, "packages/macos/assets"), { recursive: true });
  await writeFile(join(source, "packages/macos/native/EllieService.swift"), "fixture source");
  await writeFile(join(source, "packages/macos/assets/Ellie.png"), "fixture icon");
  let registrations = 0;
  let failRegistration = false;
  let damaged = false;
  const command = async (file: string, args: string[]) => {
    if (file === "/usr/bin/xcrun") await writeFile(args.at(-1)!, "fixture executable");
    if (file === "/usr/bin/iconutil") await writeFile(args.at(-1)!, "fixture icns");
    if (
      file === "/usr/bin/codesign" &&
      args.includes("--verify") &&
      damaged &&
      args.at(-1) === applicationPath(home, "node")
    )
      throw new Error("fixture damaged signature");
    if (args[0] === "--register") {
      registrations++;
      if (failRegistration) throw new Error("fixture registration failed");
    }
  };
  const app = new MacOSServiceApplication(home, process.getuid!(), source, ".test", { command });
  return {
    home,
    source,
    app,
    registrations: () => registrations,
    failRegistration: (value: boolean) => {
      failRegistration = value;
    },
    damage: (value: boolean) => {
      damaged = value;
    },
    close: () => rm(home, { recursive: true, force: true }),
  };
}

test("application keeps a stable signed bundle on repeated installs, re-registers, and separates roles", async () => {
  const f = await fixture();
  try {
    await f.app.install("node", f.source, process.execPath);
    const path = applicationExecutable(f.home, "node");
    const before = await stat(path);
    await f.app.install("node", f.source, process.execPath);
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    assert.equal(f.registrations(), 2);
    const resources = join(applicationPath(f.home, "node"), "Contents/Resources");
    assert.deepEqual(JSON.parse(await readFile(join(resources, "runtime.json"), "utf8")), {
      node: process.execPath,
      entrypoint: join(f.source, "apps/cli/src/main.ts"),
      role: "node",
    });
    assert.equal(await f.app.matches("node", f.source + " moved", process.execPath), false);
    assert.equal(await f.app.matches("node", f.source, "/different/node"), false);
    await f.app.install("coordinator", f.source, process.execPath);
    await f.app.uninstall("coordinator");
    assert.equal(await f.app.matches("node", f.source, process.execPath), true);
    await f.app.uninstall("node");
    await f.app.uninstall("node");
  } finally {
    await f.close();
  }
});

test("registration and plist commit failures restore the previous app; damaged managed signatures are repairable", async () => {
  const f = await fixture();
  try {
    await f.app.install("node", f.source, process.execPath);
    const manifest = join(applicationPath(f.home, "node"), "Contents/Resources/ellie-build.json");
    const original = await readFile(manifest, "utf8");
    f.failRegistration(true);
    await assert.rejects(
      f.app.install("node", f.source + " moved", process.execPath),
      /registration failed/,
    );
    assert.equal(await readFile(manifest, "utf8"), original);
    f.failRegistration(false);
    await assert.rejects(
      f.app.install("node", f.source + " moved", process.execPath, async () => {
        throw new Error("fixture plist failed");
      }),
      /plist failed/,
    );
    assert.equal(await readFile(manifest, "utf8"), original);
    f.damage(true);
    assert.equal(await f.app.matches("node", f.source, process.execPath), false);
    await f.app.install("node", f.source, process.execPath);
    f.damage(false);
    assert.equal(await f.app.matches("node", f.source, process.execPath), true);
  } finally {
    await f.close();
  }
});

test("unmanaged applications and symlinked application directories are preserved", async () => {
  const f = await fixture();
  try {
    await f.app.install("node", f.source, process.execPath);
    const manifest = join(applicationPath(f.home, "node"), "Contents/Resources/ellie-build.json");
    await writeFile(manifest, "null");
    await assert.rejects(f.app.install("node", f.source, process.execPath), /unmanaged/);
    await assert.rejects(f.app.uninstall("node"), /unmanaged/);
    assert.equal(await readFile(manifest, "utf8"), "null");
    const actual = join(f.home, "real-apps");
    await mkdir(actual);
    await rm(join(f.home, "Applications"), { recursive: true });
    await symlink(actual, join(f.home, "Applications"));
    await assert.rejects(f.app.install("node", f.source, process.execPath), /unsafe/);
  } finally {
    await f.close();
  }
});

test(
  "native macOS application builds with valid signature and full-resolution icon",
  { skip: process.platform !== "darwin" },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ellie-native-app-"));
    try {
      const app = new MacOSServiceApplication(
        home,
        process.getuid!(),
        undefined,
        `.test.${randomUUID()}`,
        { register: false },
      );
      await app.install("node", process.cwd(), process.execPath);
      assert.equal(await app.matches("node", process.cwd(), process.execPath), true);
      const contents = join(applicationPath(home, "node"), "Contents");
      const info = await readFile(join(contents, "Info.plist"), "utf8");
      assert.match(info, /<key>CFBundleDisplayName<\/key><string>Ellie Node<\/string>/);
      assert.match(info, /<key>CFBundlePackageType<\/key><string>APPL<\/string>/);
      const icon = await readFile(join(contents, "Resources/Ellie.icns"));
      assert.equal(icon.subarray(0, 4).toString(), "icns");
      assert.ok(icon.includes(Buffer.from("ic10")), "512@2x icon is included");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
