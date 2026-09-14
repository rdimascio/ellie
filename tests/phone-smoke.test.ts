import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  phoneSmokeConfig,
  readPrivateTestJson,
  runPhoneSmoke,
} from "../apps/cli/src/phone-smoke.ts";
const config = {
  driverOrigin: "http://127.0.0.1:4444",
  origin: "https://ellie.test:8444",
  deviceId: "test-device",
  invitationFile: "/private/invitation.json",
};
const invitation = () => ({ code: "a".repeat(64), expiresAt: Date.now() + 60_000 });
function driver(
  options: {
    platform?: string;
    commandFailure?: boolean;
    deleteFailure?: boolean;
    oversized?: boolean;
    redirected?: boolean;
    pairFailure?: boolean;
    lateRedirect?: boolean;
    selectionFailure?: boolean;
  } = {},
) {
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let clicked = false;
  let selectedNode = "";
  let leftTrustedPage = false;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, method, body });
    if (path.endsWith("/click") && path.includes("command-button")) {
      clicked = true;
      if (options.commandFailure) throw new Error("private token and transcript");
    }
    if (method === "DELETE" && options.deleteFailure) throw new Error("private token");
    if (options.oversized) return new Response(" ".repeat(65_537));
    let value: unknown = null;
    if (path === "/session")
      value = { sessionId: "isolated", capabilities: { platformName: options.platform ?? "iOS" } };
    else if (path.endsWith("/url") && method === "GET")
      value = options.redirected || leftTrustedPage ? "http://outside.test" : config.origin;
    else if (
      path.endsWith("/element") &&
      body.value === "#phone-remote-heading" &&
      options.pairFailure
    )
      throw new Error("Pairing outcome unknown");
    else if (path.endsWith("/element"))
      value = {
        "element-6066-11e4-a52e-4f735466cecf": String(body.value).includes("remote-apps")
          ? "command-button"
          : body.value === "#remote-node"
            ? "node-select"
            : String(body.value).includes("#remote-node option")
              ? "node-option"
              : "element",
      };
    else if (path.endsWith("node-option/click")) {
      if (!options.selectionFailure) selectedNode = "mini";
    } else if (path.endsWith("node-select/property/value")) {
      value = selectedNode;
      if (options.lateRedirect) leftTrustedPage = true;
    } else if (path.endsWith("/text")) value = clicked ? "Opened Arc." : "";
    return Response.json({ value });
  };
  return { calls, fetcher };
}

test("phone smoke requires private files, literal loopback and explicit finite command scope", async () => {
  assert.equal(phoneSmokeConfig(config).origin, config.origin);
  for (const change of [
    { driverOrigin: "http://example.com" },
    { driverOrigin: "http://localhost:4444" },
    { origin: "http://ellie.test" },
    { origin: "https://secret@ellie.test" },
    { origin: "https://ellie.test/?token=x" },
    { app: "arc" },
    { nodeId: "mini" },
    { app: "terminal", nodeId: "mini" },
    { app: "arc", nodeId: 'x"]' },
    { invitationFile: "relative" },
    { acceptInsecureCerts: true },
  ])
    assert.throws(() => phoneSmokeConfig({ ...config, ...change }));
  const root = await mkdtemp(join(tmpdir(), "ellie-phone-test-"));
  try {
    const path = join(root, "input.json");
    await writeFile(path, JSON.stringify(invitation()), { mode: 0o600 });
    assert.deepEqual(
      await readPrivateTestJson(path),
      JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"))),
    );
    await symlink(path, join(root, "link"));
    await assert.rejects(readPrivateTestJson(join(root, "link")));
    await writeFile(join(root, "public.json"), "{}", { mode: 0o644 });
    await assert.rejects(readPrivateTestJson(join(root, "public.json")));
    await writeFile(path, " ".repeat(16_385));
    await assert.rejects(readPrivateTestJson(path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fake driver verifies pairing, refresh and logout without desktop command by default", async () => {
  const fake = driver();
  const report = await runPhoneSmoke(config, invitation(), fake.fetcher);
  assert.deepEqual(report, {
    passed: true,
    platform: "physical-ios",
    pairAttempted: true,
    paired: true,
    refreshed: true,
    command: "not-requested",
    loggedOut: true,
    sessionClosed: true,
    stage: "complete",
  });
  const session = fake.calls[0]!.body.capabilities as { alwaysMatch: Record<string, unknown> };
  assert.equal(session.alwaysMatch["platformName"], "iOS");
  assert.equal(session.alwaysMatch["safari:deviceUDID"], config.deviceId);
  assert.equal(session.alwaysMatch["safari:useSimulator"], false);
  assert.equal(session.alwaysMatch["acceptInsecureCerts"], false);
  assert.equal(
    fake.calls.some((call) => String(call.body.value).includes("remote-apps")),
    false,
  );
  assert.doesNotMatch(JSON.stringify(report), /test-device|aaaa|token|ellie.test/);
});

test("a command clicks once, confirms result and never retries a lost command response", async () => {
  for (const fail of [false, true]) {
    const fake = driver({ commandFailure: fail });
    const report = await runPhoneSmoke(
      { ...config, nodeId: "mini", app: "arc" },
      invitation(),
      fake.fetcher,
    );
    assert.equal(report.command, fail ? "unknown" : "confirmed");
    assert.equal(report.passed, !fail);
    assert.equal(report.sessionClosed, true);
    assert.equal(fake.calls.filter((call) => call.path.endsWith("command-button/click")).length, 1);
    assert.doesNotMatch(JSON.stringify(report), /private|token|transcript/);
  }
});

test("late navigation or an uncommitted node selection prevents command dispatch", async () => {
  for (const options of [{ lateRedirect: true }, { selectionFailure: true }]) {
    const fake = driver(options);
    const report = await runPhoneSmoke(
      { ...config, nodeId: "mini", app: "arc" },
      invitation(),
      fake.fetcher,
    );
    assert.equal(report.passed, false);
    assert.equal(report.command, "not-sent");
    assert.equal(fake.calls.filter((call) => call.path.endsWith("command-button/click")).length, 0);
    assert.equal(report.sessionClosed, true);
  }
});

test("desktop fallback, expired invite, oversized response and cleanup failure never pass", async () => {
  const desktop = driver({ platform: "macOS" });
  const wrong = await runPhoneSmoke(config, invitation(), desktop.fetcher);
  assert.equal(wrong.passed, false);
  assert.equal(wrong.sessionClosed, true);
  assert.equal(
    desktop.calls.some((call) => call.path.endsWith("/url")),
    false,
  );
  await assert.rejects(runPhoneSmoke(config, { ...invitation(), expiresAt: 1 }, desktop.fetcher));
  const huge = driver({ oversized: true });
  assert.equal((await runPhoneSmoke(config, invitation(), huge.fetcher)).passed, false);
  const cleanup = driver({ deleteFailure: true });
  assert.equal(
    (await runPhoneSmoke(config, invitation(), cleanup.fetcher)).stage,
    "session-cleanup",
  );
});

test("redirects stop before invitation disclosure and uncertain pairing requests cleanup", async () => {
  const redirect = driver({ redirected: true });
  const rejected = await runPhoneSmoke(config, invitation(), redirect.fetcher);
  assert.equal(rejected.passed, false);
  assert.equal(rejected.pairAttempted, false);
  assert.equal(
    redirect.calls.some((call) => call.path.endsWith("/value")),
    false,
  );
  const uncertain = driver({ pairFailure: true });
  const result = await runPhoneSmoke(config, invitation(), uncertain.fetcher);
  assert.equal(result.pairAttempted, true);
  assert.equal(result.paired, false);
  assert.equal(result.loggedOut, false);
  assert.equal(result.sessionClosed, true);
});
