import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

// This is a disposable per-user launchd fixture. It never uses Ellie's managed
// org.ellie.assistant.* labels, the operator's HOME, Keychain, or service selection.
// The private child plist maps HOME to one disposable fixture directory only.
const sourceRevision = "611f74700fa9dccdf7385cf95e9f28d5987a469b";
const manifestSha256 = "609f65643325c3c89fa894e776bfd5605e98e166f64e68e649a9908e6f717626";
const qaParent = join(homedir(), ".codex", "ellie-qa");
const maxOutput = 128 * 1024;
const waitMilliseconds = 5_000;
const releaseID = `0.1.0-${sourceRevision}-arm64`;

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const xml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function assertFixtureRoot(root) {
  if (
    !isAbsolute(root) ||
    dirname(root) !== qaParent ||
    !/^kc-launchd-attention-[0-9a-f-]{36}$/.test(basename(root))
  )
    throw new Error("Fixture root must be a new direct child of the private Ellie QA directory.");
  if (root === join(homedir(), ".ellie") || root.startsWith(join(homedir(), ".ellie") + sep))
    throw new Error("Fixture must not use Ellie identity state.");
  return root;
}

export function fixtureLabel(root) {
  return `org.ellie.qa.kc-attention.${basename(root).slice("kc-launchd-attention-".length)}`;
}

export function fixturePlist({ label, node, entrypoint, home, helper, mode, attempts }) {
  for (const path of [node, entrypoint, home, helper, mode, attempts])
    if (!isAbsolute(path) || /[\r\n]/.test(path)) throw new Error("Invalid fixture path.");
  if (!/^org\.ellie\.qa\.kc-attention\.[0-9a-f-]{36}$/.test(label))
    throw new Error("Invalid fixture label.");
  const string = (value) => `<string>${xml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${[node, entrypoint, "service", "run", "coordinator"].map(string).join("")}</array>
<key>EnvironmentVariables</key><dict>
<key>HOME</key>${string(home)}
<key>PATH</key>${string(`${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`)}
<key>ELLIE_MACOS_HELPER</key>${string(helper)}
<key>ELLIE_KC_FIXTURE_MODE</key>${string(mode)}
<key>ELLIE_KC_FIXTURE_ATTEMPTS</key>${string(attempts)}
</dict>
<key>WorkingDirectory</key>${string(dirname(entrypoint))}
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ProcessType</key><string>Standard</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>AbandonProcessGroup</key><false/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>15</integer>
<key>Umask</key><integer>63</integer>
<key>SoftResourceLimits</key><dict><key>Core</key><integer>0</integer></dict>
<key>HardResourceLimits</key><dict><key>Core</key><integer>0</integer></dict>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
}

function fixtureHelper(root, node) {
  return `#!${node}\nimport { appendFileSync, readFileSync } from "node:fs";\nconst mode = process.env.ELLIE_KC_FIXTURE_MODE;\nconst attempts = process.env.ELLIE_KC_FIXTURE_ATTEMPTS;\nif (!mode || !attempts) process.exit(78);\nlet request;\ntry { request = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(78); }\nif (request.command !== "keychain.get" || !["server.key", "server.controller"].includes(request.account)) process.exit(78);\nappendFileSync(attempts, request.account + "\\n");\nif (readFileSync(mode, "utf8") !== "success\\n") process.exit(1);\nconst file = request.account === "server.key" ? ${JSON.stringify(join(root, "server-key.pem"))} : ${JSON.stringify(join(root, "controller-token"))};\nprocess.stdout.write(JSON.stringify({ value: readFileSync(file, "utf8") }));\n`;
}

async function inspectedRelease(release) {
  const manifestBytes = await readFile(join(release, "manifest.json"));
  if (sha(manifestBytes) !== manifestSha256) throw new Error("Pinned service manifest changed.");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.sourceRevision !== sourceRevision ||
    manifest.platform !== "darwin" ||
    manifest.architecture !== "arm64"
  )
    throw new Error("Release is not the reviewed development payload.");
  const installer = join(release, "payload", "bin", "ellie-service-installer");
  await releaseEntry(release, manifest, installer);
  const result = await runBounded(installer, ["inspect", release], 20_000);
  if (result.code !== 0 || result.stdout !== `${releaseID}\n`)
    throw new Error("Original shipped payload inspection failed.");
  return manifest;
}

export function eventNames(text) {
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error("Fixture event log is oversized.");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value = JSON.parse(line);
      if (
        value.role !== "coordinator" ||
        typeof value.event !== "string" ||
        !/^[a-z_]{1,40}$/.test(value.event)
      )
        throw new Error("Invalid fixture event.");
      return value.event;
    });
}

export function servicePid(output) {
  if (Buffer.byteLength(output) > maxOutput) throw new Error("launchd status is oversized.");
  const matches = [...output.matchAll(/^\s*pid = ([1-9][0-9]*)\s*$/gm)];
  if (matches.length !== 1) throw new Error("Fixture launchd PID is unavailable or ambiguous.");
  const pid = Number(matches[0][1]);
  if (!Number.isSafeInteger(pid)) throw new Error("Fixture launchd PID is invalid.");
  return pid;
}

async function privateEntry(path, directory) {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0 ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
  )
    throw new Error("Fixture path is not private and owned; preserving it.");
  return info;
}

async function releaseEntry(release, manifest, path) {
  const relative = path.slice(join(release, "payload").length + 1);
  const expected = manifest.files.find((item) => item.path === relative);
  if (!expected || manifest.files.filter((item) => item.path === relative).length !== 1)
    throw new Error("Pinned payload entry is absent or ambiguous.");
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== expected.mode ||
    info.size !== expected.size ||
    (info.mode & 0o022) !== 0
  )
    throw new Error("Pinned payload entry metadata changed.");
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino || !opened.isFile())
      throw new Error("Pinned payload entry changed during open.");
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    if (digest.digest("hex") !== expected.sha256)
      throw new Error("Pinned payload entry digest changed.");
  } finally {
    await handle.close();
  }
}

async function fixture(root) {
  assertFixtureRoot(root);
  await privateEntry(qaParent, true);
  await privateEntry(root, true);
  const record = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
  if (
    record.version !== 1 ||
    record.label !== fixtureLabel(root) ||
    record.releaseRevision !== sourceRevision ||
    record.manifestSha256 !== manifestSha256 ||
    !Number.isInteger(record.port) ||
    record.port < 1 ||
    record.port > 65535 ||
    !["prepared", "attention", "diagnosed", "recovered", "stopped", "uncertain"].includes(
      record.phase,
    )
  )
    throw new Error("Fixture record is invalid.");
  const release = await realpath(record.release);
  if (release !== record.release || !isAbsolute(release)) throw new Error("Release path changed.");
  const manifest = await inspectedRelease(release);
  const node = join(release, "payload", "bin", "node");
  const entrypoint = join(release, "payload", "lib", "ellie", "apps", "cli", "src", "main.ts");
  await Promise.all([
    releaseEntry(release, manifest, node),
    releaseEntry(release, manifest, entrypoint),
  ]);
  for (const name of [
    "fixture.json",
    "agent.plist",
    "helper.mjs",
    "mode",
    "attempts",
    "server-key.pem",
    "controller-token",
  ])
    await privateEntry(join(root, name), false);
  await privateEntry(join(root, "home"), true);
  await privateEntry(join(root, "home", ".ellie"), true);
  await privateEntry(join(root, "home", ".ellie", "bin"), true);
  await privateEntry(join(root, "home", ".ellie", "bin", "ellie-macos"), false);
  for (const name of ["server.json", "server-cert.pem", "auth.json"])
    await privateEntry(join(root, "home", ".ellie", name), false);
  const plist = fixturePlist({
    label: record.label,
    node,
    entrypoint,
    home: join(root, "home"),
    helper: join(root, "helper.mjs"),
    mode: join(root, "mode"),
    attempts: join(root, "attempts"),
  });
  if (
    (await readFile(join(root, "agent.plist"), "utf8")) !== plist ||
    (await readFile(join(root, "helper.mjs"), "utf8")) !== fixtureHelper(root, node)
  )
    throw new Error("Fixture plist or helper changed after preparation.");
  if (
    (await readFile(join(root, "home", ".ellie", "bin", "ellie-macos"), "utf8")) !==
    "fixture marker; never execute\n"
  )
    throw new Error("Fixture helper marker changed.");
  const { defaults } = await import(
    pathToFileURL(
      join(release, "payload", "lib", "ellie", "packages", "config", "src", "defaults.ts"),
    )
  );
  const config = await readFile(join(root, "home", ".ellie", "server.json"), "utf8");
  if (
    config !==
    JSON.stringify({ version: 1, host: "127.0.0.1", port: record.port, preferences: defaults })
  )
    throw new Error("Fixture coordinator configuration changed.");
  const token = await readFile(join(root, "controller-token"), "utf8");
  const auth = JSON.parse(await readFile(join(root, "home", ".ellie", "auth.json"), "utf8"));
  if (
    !/^[a-f0-9]{64}$/.test(token) ||
    JSON.stringify(auth) !==
      JSON.stringify({
        identities: [{ id: "controller", role: "controller", tokenHash: sha(token) }],
      })
  )
    throw new Error("Fixture synthetic authorization changed.");
  const cert = new X509Certificate(await readFile(join(root, "home", ".ellie", "server-cert.pem")));
  if (!cert.checkPrivateKey(createPrivateKey(await readFile(join(root, "server-key.pem")))))
    throw new Error("Fixture synthetic TLS identity changed.");
  return record;
}

async function writeRecord(root, record) {
  const target = join(root, "fixture.json");
  const temporary = join(root, `.fixture-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, target);
}

async function freePort() {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return server.address().port;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function prepare({ root, release }) {
  assertFixtureRoot(root);
  await privateEntry(qaParent, true);
  if (!isAbsolute(release) || (await realpath(release)) !== release)
    throw new Error("Release must be a canonical absolute path.");
  const parsed = await inspectedRelease(release);
  const node = join(release, "payload", "bin", "node");
  const entrypoint = join(release, "payload", "lib", "ellie", "apps", "cli", "src", "main.ts");
  await Promise.all([
    releaseEntry(release, parsed, node),
    releaseEntry(release, parsed, entrypoint),
  ]);
  if (/\s/.test(node)) throw new Error("Packaged Node path cannot be used as a fixture shebang.");
  await mkdir(root, { mode: 0o700 }); // EEXIST is a deliberate no-overwrite failure.
  const home = join(root, "home");
  const state = join(home, ".ellie");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await mkdir(join(state, "bin"), { mode: 0o700 });
  // Services.validate checks the legacy helper path for executable access.
  // The isolated launch uses ELLIE_MACOS_HELPER instead; this marker is never invoked.
  await writeFile(join(state, "bin", "ellie-macos"), "fixture marker; never execute\n", {
    mode: 0o700,
  });
  const { generateCertificate } = await import(
    pathToFileURL(join(release, "payload", "lib", "ellie", "apps", "cli", "src", "certificate.ts"))
  );
  const { Auth } = await import(
    pathToFileURL(join(release, "payload", "lib", "ellie", "apps", "server", "src", "auth.ts"))
  );
  const { defaults } = await import(
    pathToFileURL(
      join(release, "payload", "lib", "ellie", "packages", "config", "src", "defaults.ts"),
    )
  );
  const { key, cert } = await generateCertificate();
  const token = randomBytes(32).toString("hex");
  const port = await freePort();
  await writeFile(
    join(state, "server.json"),
    JSON.stringify({ version: 1, host: "127.0.0.1", port, preferences: defaults }),
    { mode: 0o600 },
  );
  await writeFile(join(state, "server-cert.pem"), cert, { mode: 0o600 });
  await Auth.initialize(token, state);
  await writeFile(join(root, "server-key.pem"), key, { mode: 0o600 });
  await writeFile(join(root, "controller-token"), token, { mode: 0o600 });
  await writeFile(join(root, "mode"), "reject\n", { mode: 0o600 });
  await writeFile(join(root, "attempts"), "", { mode: 0o600 });
  const helper = join(root, "helper.mjs");
  await writeFile(helper, fixtureHelper(root, node), { mode: 0o700 });
  await chmod(helper, 0o700);
  const label = fixtureLabel(root);
  await writeFile(
    join(root, "agent.plist"),
    fixturePlist({
      label,
      node,
      entrypoint,
      home,
      helper,
      mode: join(root, "mode"),
      attempts: join(root, "attempts"),
    }),
    { mode: 0o600 },
  );
  await writeRecord(root, {
    version: 1,
    label,
    release,
    releaseRevision: sourceRevision,
    manifestSha256,
    port,
    phase: "prepared",
  });
  await fixture(root);
  return { label, port, manifestSha256, root };
}

export async function inspectFixture(root) {
  const record = await fixture(root);
  return { label: record.label, phase: record.phase, manifestSha256, port: record.port };
}

// Retain only each exact command child handle. Never signal a process group or service PID.
async function runBounded(binary, args, timeout = 10_000) {
  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "C", LANG: "C", LC_CTYPE: "C", COLUMNS: "1000" },
  });
  const chunks = [];
  let bytes = 0;
  let overLimit = false;
  const collect = (value) => {
    bytes += value.length;
    if (bytes <= maxOutput) chunks.push(value);
    else {
      overLimit = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => {});
  let timer;
  try {
    const result = await Promise.race([
      closed,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeout);
      }),
    ]);
    if (result.timedOut) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const grace = await Promise.race([closed, sleep(250).then(() => null)]);
      if (!grace && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.race([
        closed,
        sleep(3_000).then(() => {
          throw new Error("Owned launchctl cleanup is uncertain.");
        }),
      ]);
      throw new Error("Owned launchctl timed out.");
    }
    if (overLimit) throw new Error("Owned launchctl output exceeded the bound.");
    return { ...result, stdout: Buffer.concat(chunks).toString("utf8") };
  } finally {
    clearTimeout(timer);
  }
}

export async function launchctl(args, timeout = 10_000) {
  return runBounded("/bin/launchctl", args, timeout);
}

async function processIdentity(pid, entrypoint, io = {}, requireRole = true) {
  const result = await (
    io.observeProcess ??
    ((value) =>
      runBounded("/bin/ps", ["-ww", "-p", String(value), "-o", "lstart=", "-o", "command="], 5_000))
  )(pid);
  if (result.code === 1 && !result.stdout.trim()) return undefined;
  if (result.code !== 0) throw new Error("Fixture process state is unavailable.");
  const lines = result.stdout.trim().split("\n");
  if (lines.length !== 1) throw new Error("Fixture process identity is ambiguous.");
  const match = lines[0].match(
    /^([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
  );
  if (!match || (requireRole && !match[2].includes(`${entrypoint} service run coordinator`)))
    throw new Error("Fixture process is not the reviewed role command.");
  return { pid, started: match[1], commandSha256: sha(match[2]) };
}

async function waitGone(identity, entrypoint, io = {}) {
  const deadline = Date.now() + 5_000;
  do {
    const current = await processIdentity(identity.pid, entrypoint, io, false);
    if (!current || JSON.stringify(current) !== JSON.stringify(identity)) return;
    await (io.pollWait ?? sleep)(50);
  } while (Date.now() < deadline);
  throw new Error("Owned service process exit was not observed; retaining fixture state.");
}

async function recordedIdentity(root, name = "attention", caseName = "KC01") {
  const evidence = JSON.parse(await readFile(join(root, `${name}.json`), "utf8"));
  const identity = evidence.identity;
  if (
    evidence.case !== caseName ||
    !Number.isSafeInteger(identity?.pid) ||
    identity.pid < 1 ||
    typeof identity.started !== "string" ||
    !/^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(identity.started) ||
    !/^[a-f0-9]{64}$/.test(identity.commandSha256)
  )
    throw new Error("KC01 process identity evidence is missing or invalid.");
  return identity;
}

async function printJob(label, io = { launchctl }) {
  return io.launchctl(["print", `gui/${process.getuid()}/${label}`]);
}

async function loadedPid(label, io) {
  const result = await printJob(label, io);
  if (result.code === 113) return undefined;
  if (result.code !== 0) throw new Error("Fixture launchd state is unavailable.");
  return servicePid(result.stdout);
}

async function absent(label, io) {
  const result = await printJob(label, io);
  if (result.code !== 113)
    throw new Error("Fixture label is already loaded or cannot be inspected.");
}

async function events(root) {
  const path = join(root, "home", ".ellie", "logs", "coordinator.jsonl");
  return eventNames(await readFile(path, "utf8"));
}

async function attempts(root) {
  const list = (await readFile(join(root, "attempts"), "utf8")).split("\n").filter(Boolean);
  if (list.some((value) => value !== "server.key"))
    throw new Error("Unexpected fixture helper request.");
  return list.length;
}

async function waitFor(root, expectedEvents, expectedAttempts) {
  const deadline = Date.now() + waitMilliseconds;
  while (Date.now() < deadline) {
    const observed = await events(root).catch((error) =>
      error.code === "ENOENT" ? [] : Promise.reject(error),
    );
    if (observed.length >= expectedEvents.length) {
      assert.deepEqual(observed.slice(0, expectedEvents.length), expectedEvents);
      assert.equal(await attempts(root), expectedAttempts);
      return;
    }
    await sleep(50);
  }
  throw new Error("Fixture service did not produce the expected bounded event sequence.");
}

async function verifyNoListener(port) {
  const socket = createServer();
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(port, "127.0.0.1", resolve);
    });
  } finally {
    await new Promise((resolve) => socket.close(resolve));
  }
}

async function verifyTlsListener(port, cert) {
  await new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: "127.0.0.1",
      port,
      servername: "ellie.local",
      ca: cert,
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Fixture TLS listener timed out."));
    }, 3_000);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function update(root, record, phase, evidence) {
  await writeRecord(root, { ...record, phase });
  const path = join(root, `${phase}.json`);
  await writeFile(path, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

export async function kc01(root, io = { launchctl }) {
  const record = await (io.fixture ?? fixture)(root);
  if (record.phase !== "prepared" || (await readFile(join(root, "mode"), "utf8")) !== "reject\n")
    throw new Error("KC01 requires an unused rejecting fixture.");
  await absent(record.label, io);
  await (io.verifyNoListener ?? verifyNoListener)(record.port);
  try {
    const bootstrap = await io.launchctl([
      "bootstrap",
      `gui/${process.getuid()}`,
      join(root, "agent.plist"),
    ]);
    if (bootstrap.code !== 0)
      throw new Error("Fixture bootstrap failed; inspect exact label before retry.");
    await waitFor(root, ["starting", "keychain_access_unavailable", "needs_attention"], 1);
    const pid = await loadedPid(record.label, io);
    if (!pid) throw new Error("Credential attention did not retain the launchd service process.");
    const entrypoint = join(
      record.release,
      "payload",
      "lib",
      "ellie",
      "apps",
      "cli",
      "src",
      "main.ts",
    );
    const identity = await processIdentity(pid, entrypoint, io);
    await (io.verifyNoListener ?? verifyNoListener)(record.port);
    await (io.throttleWait ?? sleep)(31_000); // Past the retained production 30-second launchd throttle interval.
    assert.equal(await loadedPid(record.label, io), pid);
    assert.deepEqual(await processIdentity(pid, entrypoint, io), identity);
    assert.equal(await attempts(root), 1);
    assert.deepEqual(await events(root), [
      "starting",
      "keychain_access_unavailable",
      "needs_attention",
    ]);
    await update(root, record, "attention", {
      case: "KC01",
      oneAttempt: true,
      pidStableAcrossThrottle: true,
      noListener: true,
      identity,
    });
  } catch (error) {
    await writeRecord(root, { ...record, phase: "uncertain" });
    throw error;
  }
}

export async function kc02(root, io = { launchctl }) {
  const record = await (io.fixture ?? fixture)(root);
  if (record.phase !== "attention") throw new Error("KC02 requires KC01 attention evidence.");
  const pid = await loadedPid(record.label, io);
  if (!pid) throw new Error("Fixture service is not running.");
  const identity = await recordedIdentity(root);
  const entrypoint = join(
    record.release,
    "payload",
    "lib",
    "ellie",
    "apps",
    "cli",
    "src",
    "main.ts",
  );
  assert.deepEqual(await processIdentity(pid, entrypoint, io), identity);
  const before = await attempts(root);
  const releaseRoot = join(record.release, "payload", "lib", "ellie");
  const { doctorService } = await import(
    pathToFileURL(join(releaseRoot, "apps", "cli", "src", "diagnostics.ts"))
  );
  const { serviceCredentialState } = await import(
    pathToFileURL(join(releaseRoot, "apps", "cli", "src", "service-attention.ts"))
  );
  let credentialQueries = 0;
  const result = await doctorService("coordinator", {
    stateDir: join(root, "home", ".ellie"),
    serviceStatus: async () => ({
      role: "coordinator",
      installed: true,
      guiSession: true,
      loaded: true,
      enabled: true,
      state: "running",
      pid,
    }),
    serviceCredentialState: () =>
      serviceCredentialState(join(root, "home", ".ellie"), "coordinator"),
    keychainGet: async () => {
      credentialQueries++;
      throw new Error("Fixture doctor must not query credentials.");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.lines.length, 1);
  assert.match(result.lines[0], /Doctor skipped Keychain/);
  assert.equal(credentialQueries, 0);
  assert.equal(await attempts(root), before);
  assert.equal(await loadedPid(record.label, io), pid);
  assert.deepEqual(await processIdentity(pid, entrypoint, io), identity);
  await update(root, record, "diagnosed", {
    case: "KC02",
    doctorSkippedCredentialRead: true,
    helperAttemptsUnchanged: true,
    productionCliStatus: "unverified_fixed_managed_label",
  });
}

export async function kc03(root, io = { launchctl }) {
  const record = await (io.fixture ?? fixture)(root);
  if (record.phase !== "diagnosed") throw new Error("KC03 requires KC02 diagnosis evidence.");
  const identity = await recordedIdentity(root);
  const entrypoint = join(
    record.release,
    "payload",
    "lib",
    "ellie",
    "apps",
    "cli",
    "src",
    "main.ts",
  );
  const currentPid = await loadedPid(record.label, io);
  if (
    currentPid !== identity.pid ||
    JSON.stringify(await processIdentity(currentPid, entrypoint, io)) !== JSON.stringify(identity)
  )
    throw new Error("KC03 service identity changed; no lifecycle command was sent.");
  try {
    const bootout = await io.launchctl(["bootout", `gui/${process.getuid()}/${record.label}`]);
    if (bootout.code !== 0)
      throw new Error("Exact fixture label could not be stopped; state retained.");
    await absent(record.label, io);
    await waitGone(identity, entrypoint, io);
    await (io.verifyNoListener ?? verifyNoListener)(record.port);
    await writeFile(join(root, "mode"), "success\n", { mode: 0o600 });
    const bootstrap = await io.launchctl([
      "bootstrap",
      `gui/${process.getuid()}`,
      join(root, "agent.plist"),
    ]);
    if (bootstrap.code !== 0)
      throw new Error("Explicit fixture recovery bootstrap failed; no automatic retry.");
    await waitFor(
      root,
      ["starting", "keychain_access_unavailable", "needs_attention", "starting", "ready"],
      2,
    );
    const pid = await loadedPid(record.label, io);
    if (!pid) throw new Error("Recovered fixture has no running service process.");
    const recoveredIdentity = await processIdentity(pid, entrypoint, io);
    await (io.verifyTlsListener ?? verifyTlsListener)(
      record.port,
      await readFile(join(root, "home", ".ellie", "server-cert.pem"), "utf8"),
    );
    assert.equal(await attempts(root), 2);
    await update(root, record, "recovered", {
      case: "KC03",
      explicitRestart: true,
      exactlyOneNewCredentialRead: true,
      tlsLoopbackReady: true,
      identity: recoveredIdentity,
    });
  } catch (error) {
    await writeRecord(root, { ...record, phase: "uncertain" });
    throw error;
  }
}

export async function cleanup(root, io = { launchctl }) {
  const record = await (io.fixture ?? fixture)(root);
  const current = await printJob(record.label, io);
  const entrypoint = join(
    record.release,
    "payload",
    "lib",
    "ellie",
    "apps",
    "cli",
    "src",
    "main.ts",
  );
  const identity =
    current.code === 0
      ? await processIdentity(servicePid(current.stdout), entrypoint, io)
      : ["attention", "diagnosed"].includes(record.phase)
        ? await recordedIdentity(root)
        : record.phase === "recovered"
          ? await recordedIdentity(root, "recovered", "KC03")
          : undefined;
  if (record.phase === "uncertain" && current.code === 113)
    throw new Error("Uncertain fixture ownership requires manual process reconciliation.");
  if (current.code === 0) {
    const stopped = await io.launchctl(["bootout", `gui/${process.getuid()}/${record.label}`]);
    if (stopped.code !== 0) throw new Error("Fixture bootout is uncertain; artifacts retained.");
  } else if (current.code !== 113)
    throw new Error("Fixture label status is uncertain; artifacts retained.");
  await absent(record.label, io);
  if (identity) await waitGone(identity, entrypoint, io);
  await (io.verifyNoListener ?? verifyNoListener)(record.port);
  await writeRecord(root, { ...record, phase: "stopped" });
  // Artifacts, including synthetic key and fixed event evidence, remain private for review.
}

async function cli() {
  const [phase, root, release] = process.argv.slice(2);
  if (
    !["prepare", "verify", "kc01", "kc02", "kc03", "cleanup"].includes(phase) ||
    !root ||
    (phase === "prepare" ? !release : !!release)
  )
    throw new Error(
      "Use: node scripts/service-attention-launchd.mjs prepare ROOT RELEASE | verify|kc01|kc02|kc03|cleanup ROOT",
    );
  if (process.platform !== "darwin" || !process.version.startsWith("v24."))
    throw new Error("The fixture requires macOS and Node 24.");
  if (phase === "prepare") console.log(JSON.stringify(await prepare({ root, release }), null, 2));
  if (phase === "verify") console.log(JSON.stringify(await inspectFixture(root), null, 2));
  if (phase === "kc01") await kc01(root);
  if (phase === "kc02") await kc02(root);
  if (phase === "kc03") await kc03(root);
  if (phase === "cleanup") await cleanup(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cli().catch(() => {
    console.error("Fixture phase failed; private evidence was retained for reconciliation.");
    process.exitCode = 1;
  });
