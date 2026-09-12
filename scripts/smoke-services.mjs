// Real launchd smoke using a temporary, inert process and a unique service label.
// Never reads household config, loads the real Ellie services, or touches Keychain.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { label, servicePlist } from "../apps/cli/src/services.ts";
import { applicationId, MacOSServiceApplication } from "../apps/cli/src/service-application.ts";

if (process.platform !== "darwin" || !process.getuid?.())
  throw new Error("Run this smoke as a logged-in macOS user, without sudo.");
if (!process.versions.node.startsWith("24.")) throw new Error("Node.js 24 required.");
const domain = `gui/${process.getuid()}`;
const smokeLabel = `org.ellie.assistant.smoke.${randomUUID()}`;
const suffix = `.smoke.${randomUUID()}`;
const target = `${domain}/${smokeLabel}`;
const launchctl = (...args) =>
  execFileSync("/bin/launchctl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
launchctl("print", domain);
const dir = await mkdtemp(join(tmpdir(), "ellie-launchd-smoke-"));
const pidPath = join(dir, "pid");
const childPath = join(dir, "child-pid");
let failure;
async function waitPid(previous) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const pid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
    if (pid > 1 && pid !== previous) return pid;
    await delay(250);
  }
  throw new Error("Temporary launchd process did not start within the bounded wait.");
}
async function childGone(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(100);
  }
  throw new Error("Temporary descendant survived its launchd job.");
}
try {
  await mkdir(join(dir, "apps/cli/src"), { recursive: true });
  // Use the exact generated ProgramArguments/working-directory/GUI/KeepAlive policy.
  await writeFile(
    join(dir, "apps/cli/src/main.ts"),
    `import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
writeFileSync(${JSON.stringify(childPath)}, String(child.pid), {mode: 0o600});
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid), {mode: 0o600});
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`,
  );
  const plistPath = join(dir, "smoke.plist");
  const app = new MacOSServiceApplication(dir, process.getuid(), undefined, suffix, {
    register: false,
  });
  await app.install("node", dir, process.execPath);
  await writeFile(
    plistPath,
    servicePlist("node", dir, dir, process.execPath)
      .replace(label("node"), smokeLabel)
      .replace(applicationId("node"), applicationId("node") + suffix),
    { mode: 0o600 },
  );
  execFileSync("/usr/bin/plutil", ["-lint", plistPath], { stdio: "ignore" });
  launchctl("bootstrap", domain, plistPath);
  const first = await waitPid();
  const firstChild = Number(await readFile(childPath, "utf8"));
  console.log("PASS: temporary GUI LaunchAgent started using generated policy.");
  // Only the unique fixture's PID is targeted. No native desktop actions exist in it.
  process.kill(first, "SIGKILL");
  await waitPid(first);
  await childGone(firstChild);
  console.log("PASS: launchd relaunched the crashed fixture within 45 seconds.");
  console.log("PASS: crashing the native app job did not leave its descendant running.");
  const nextChild = Number(await readFile(childPath, "utf8"));
  launchctl("bootout", target);
  await childGone(nextChild);
  let missing = false;
  try {
    launchctl("print", target);
  } catch (error) {
    missing = error.status === 113;
  }
  if (!missing) throw new Error("Temporary service is still registered after bootout.");
  console.log("PASS: bootout removed the fixture; KeepAlive cannot relaunch it.");
  console.log(
    "Not tested: real Ellie credentials, Accessibility under launchd, LAN outages, physical sleep/wake, model inference.",
  );
} catch (error) {
  failure = error;
} finally {
  // Bootstrap can fail after partially loading a job. Always check the unique
  // target and preserve its executable if removal cannot be confirmed.
  try {
    launchctl("bootout", target);
  } catch {
    /* Confirm absence below. */
  }
  let removed = false;
  try {
    launchctl("print", target);
  } catch (error) {
    removed = error.status === 113;
  }
  if (!removed)
    failure = new Error(
      `Smoke cleanup could not confirm removal; temporary files were preserved. Run: launchctl bootout gui/$(id -u)/${smokeLabel}`,
    );
  else await rm(dir, { recursive: true, force: true });
}
if (failure) throw failure;
