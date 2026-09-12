import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@ellie/config";
import { Services, label, run, servicePlist, serviceRole } from "../apps/cli/src/services.ts";
import type { Run } from "../apps/cli/src/services.ts";
import { ServiceLog, serviceLogs } from "../apps/cli/src/service-logs.ts";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ellie-service-"));
  const dir = join(home, ".ellie");
  const checkout = join(home, "source & checkout");
  await mkdir(join(dir, "bin"), { recursive: true, mode: 0o700 });
  await mkdir(join(checkout, "apps/cli/src"), { recursive: true });
  await writeFile(join(checkout, "apps/cli/src/main.ts"), "");
  await writeFile(join(dir, "bin/ellie-macos"), "fixture helper", { mode: 0o700 });
  await writeFile(
    join(dir, "server.json"),
    JSON.stringify({ version: 1, port: 7437, host: "127.0.0.1", preferences: defaults }),
    { mode: 0o600 },
  );
  await writeFile(join(dir, "server-cert.pem"), "synthetic cert", { mode: 0o600 });
  await writeFile(join(dir, "auth.json"), "{}", { mode: 0o600 });
  await writeFile(join(dir, "identity-preserve.txt"), "existing identity", { mode: 0o600 });
  let loaded = false;
  let enabled = true;
  let gui = true;
  let failBootout = false;
  let printError = 0;
  const calls: string[][] = [];
  const fake: Run = async (file, args) => {
    calls.push([file, ...args]);
    if (file === process.execPath) return { code: 0, stdout: "v24.0.0" };
    if (file === "/usr/bin/plutil") return { code: 0, stdout: "" };
    if (args[0] === "print" && args[1] === `gui/${process.getuid!()}`)
      return { code: gui ? 0 : 125, stdout: "" };
    if (args[0] === "print-disabled")
      return { code: 0, stdout: `"${label("coordinator")}" => ${!enabled}` };
    if (args[0] === "print")
      return {
        code: printError || (loaded ? 0 : 113),
        stdout: loaded
          ? " state = running\n pid = 4242\n last exit code = 1\nprivate env = synthetic-secret"
          : "",
      };
    if (args[0] === "enable") enabled = true;
    if (args[0] === "disable") enabled = false;
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") {
      if (failBootout) return { code: 5, stdout: "sensitive path" };
      loaded = false;
    }
    return { code: 0, stdout: "" };
  };
  const service = new Services({
    home,
    checkout,
    node: process.execPath,
    platform: "darwin",
    run: fake,
    application: {
      matches: async () => true,
      install: async (_role, _checkout, _node, commit) => {
        await commit?.();
      },
      uninstall: async () => {},
    },
  });
  return {
    home,
    dir,
    checkout,
    service,
    calls,
    setGui: (v: boolean) => {
      gui = v;
    },
    setBootoutFailure: () => {
      failBootout = true;
    },
    setPrintError: () => {
      printError = 5;
    },
    close: () => rm(home, { recursive: true, force: true }),
  };
}

test("per-user GUI lifecycle is idempotent and uninstall preserves private identity", async () => {
  const f = await fixture();
  try {
    await f.service.install("coordinator");
    const before = await stat(f.service.path("coordinator"));
    await f.service.install("coordinator");
    assert.equal((await stat(f.service.path("coordinator"))).mtimeMs, before.mtimeMs);
    assert.equal(before.mode & 0o777, 0o600);
    assert.equal(
      f.calls.some((c) => c[1] === "bootstrap"),
      false,
    );
    await f.service.start("coordinator");
    await f.service.start("coordinator");
    assert.equal(f.calls.filter((c) => c[1] === "bootstrap").length, 1);
    assert.equal(
      f.calls.some((c) => c.includes("-k")),
      false,
    );
    const status = await f.service.status("coordinator");
    assert.equal(status.state, "running");
    assert.equal(status.pid, 4242);
    assert.equal(JSON.stringify(status).includes("secret"), false);
    // A loaded job can outlive its plist. Reinstallation must not claim new
    // paths are active while launchd still has the old definition in memory.
    await rm(f.service.path("coordinator"));
    await assert.rejects(f.service.install("coordinator"), /Stop the service/);
    await f.service.stop("coordinator");
    await f.service.stop("coordinator");
    assert.equal((await f.service.status("coordinator")).enabled, false);
    assert.equal(f.calls.filter((c) => c[1] === "bootout").length, 1);
    await f.service.uninstall("coordinator");
    await f.service.uninstall("coordinator");
    assert.equal(await readFile(join(f.dir, "identity-preserve.txt"), "utf8"), "existing identity");
    assert.equal((await f.service.status("coordinator")).installed, false);
    await f.service.install("coordinator");
    await f.service.start("coordinator");
    assert.equal((await f.service.status("coordinator")).enabled, true);
  } finally {
    await f.close();
  }
});

test("lifecycle refuses unsafe state, absent GUI, unmanaged files, and failed bootout", async () => {
  const f = await fixture();
  try {
    await rm(join(f.dir, "auth.json"));
    await assert.rejects(f.service.install("coordinator"), { code: "ENOENT" });
    await writeFile(join(f.dir, "auth.json"), "{}", { mode: 0o644 });
    await assert.rejects(f.service.install("coordinator"), /unsafe/);
    await chmod(join(f.dir, "auth.json"), 0o600);
    await chmod(join(f.dir, "server.json"), 0o644);
    await assert.rejects(f.service.install("coordinator"), /unsafe/);
    await chmod(join(f.dir, "server.json"), 0o600);
    await f.service.install("coordinator");
    f.setGui(false);
    assert.equal((await f.service.status("coordinator")).state, "unavailable");
    await assert.rejects(f.service.start("coordinator"), /graphical desktop/);
    f.setGui(true);
    await f.service.start("coordinator");
    f.setBootoutFailure();
    await assert.rejects(f.service.uninstall("coordinator"), /files were preserved/);
    assert.ok(await readFile(f.service.path("coordinator"), "utf8"));
    f.setPrintError();
    await assert.rejects(f.service.status("coordinator"), /Cannot inspect service state/);
    await writeFile(f.service.path("coordinator"), "unmanaged definition");
    await assert.rejects(f.service.install("coordinator"), /unmanaged/);
    assert.equal(await readFile(f.service.path("coordinator"), "utf8"), "unmanaged definition");
  } finally {
    await f.close();
  }
});

test("service definitions escape paths and bind only to the GUI user with no secrets", async () => {
  assert.throws(() => serviceRole("server"), /coordinator or node/);
  const plist = servicePlist("node", "/Users/synthetic", "/source & <checkout>", "/runtime/node");
  assert.match(plist, /Aqua/);
  assert.match(plist, /Ellie Node\.app\/Contents\/MacOS\/EllieService/);
  assert.match(plist, /AssociatedBundleIdentifiers/);
  assert.match(plist, /org\.ellie\.assistant\.node\.app/);
  assert.match(plist, /source &amp; &lt;checkout&gt;/);
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.doesNotMatch(plist, /NetworkState|LaunchDaemons|Bearer|NODE_OPTIONS/);
  assert.throws(() => servicePlist("node", "relative", "/source", "/node"), /absolute/);
  assert.throws(() => servicePlist("node", "/home", "/source\x01", "/node"), /control character/);
  await assert.rejects(new Services({ platform: "linux" }).status("node"), /macOS/);
  await assert.rejects(new Services({ platform: "darwin", uid: 0 }).status("node"), /without sudo/);
});

test("competing lifecycle commands fail without modifying the active service", async () => {
  const f = await fixture();
  try {
    await f.service.install("coordinator");
    const before = await readFile(f.service.path("coordinator"), "utf8");
    const lock = join(f.dir, "service-coordinator.lock");
    await writeFile(lock, "synthetic active owner", { mode: 0o600 });
    await assert.rejects(f.service.start("coordinator"), /Another service command/);
    await assert.rejects(f.service.uninstall("coordinator"), /Another service command/);
    assert.equal(await readFile(f.service.path("coordinator"), "utf8"), before);
    assert.equal((await f.service.status("coordinator")).state, "stopped");
    await rm(lock);
    await f.service.start("coordinator");
    assert.equal((await f.service.status("coordinator")).state, "running");
  } finally {
    await f.close();
  }
});

test("generated plist passes macOS plutil", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture();
  try {
    const path = join(f.home, "fixture.plist");
    await writeFile(path, servicePlist("node", f.home, f.checkout, process.execPath));
    assert.equal((await run("/usr/bin/plutil", ["-lint", path])).code, 0);
  } finally {
    await f.close();
  }
});

test("service logs are bounded, private, event-only, and reject symlink targets", async () => {
  const f = await fixture();
  try {
    const log = await ServiceLog.open(f.dir, "node");
    log.write("starting");
    log.write("starting");
    assert.equal((await serviceLogs(f.dir, "node")).length, 1);
    assert.throws(() => log.write("Bearer synthetic-secret" as "ready"), /Invalid service event/);
    const path = join(f.dir, "logs/node.jsonl");
    await writeFile(path, "x".repeat(128 * 1024));
    log.write("connected");
    assert.ok((await stat(path)).size < 128 * 1024);
    assert.equal((await stat(`${path}.1`)).mode & 0o777, 0o600);
    await writeFile(
      path,
      JSON.stringify({
        time: "2026-01-01T00:00:00.000Z",
        role: "node",
        event: "failed",
        secret: "synthetic-secret",
      }) + "\n",
    );
    assert.deepEqual(await serviceLogs(f.dir, "node"), [
      { time: "2026-01-01T00:00:00.000Z", role: "node", event: "failed" },
    ]);
    await rm(path);
    await symlink(join(f.dir, "identity-preserve.txt"), path);
    assert.throws(() => log.write("stopping"));
    await assert.rejects(serviceLogs(f.dir, "node"));
    assert.equal(await readFile(join(f.dir, "identity-preserve.txt"), "utf8"), "existing identity");
  } finally {
    await f.close();
  }
});
