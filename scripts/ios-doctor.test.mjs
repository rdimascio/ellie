import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkIOS,
  formatHuman,
  runBounded,
  summarizeDevices,
  summarizeIdentities,
} from "./ios-doctor.mjs";

const successDevice = {
  hardwareProperties: {
    deviceType: "iPhone",
    platform: "iOS",
    reality: "physical",
    serialNumber: "private",
  },
  connectionProperties: {
    pairingState: "paired",
    transportType: "wired",
    tunnelState: "connected",
  },
  deviceProperties: { developerModeStatus: "enabled", name: "private" },
};
const fakeCommands = (devices) => async (file, args) => {
  if (file === "xcodebuild") return { code: 0, stdout: "Xcode 16.2\nBuild version 16C5032a\n" };
  if (args[0] === "--sdk") return { code: 0, stdout: "18.2\n" };
  if (file === "security")
    return {
      code: 0,
      stdout:
        '  1) 0123456789abcdef0123456789abcdef01234567 "Apple Development: Private (TEAM)"\n  1 valid identities found\n',
    };
  await writeFile(
    args.at(-1),
    JSON.stringify({
      info: { commandType: "devicectl.list.devices", jsonVersion: 2, outcome: "success" },
      result: { devices },
    }),
  );
  return { code: 0, stdout: "" };
};

test("empty real-shaped inventory is blocked, not simulator success", () => {
  assert.deepEqual(
    summarizeDevices({
      info: { commandType: "devicectl.list.devices", jsonVersion: 2, outcome: "success" },
      result: { devices: [] },
    }),
    {
      status: "blocked",
      count: 0,
      paired: 0,
      developerMode: 0,
    },
  );
});

test("synthetic positive device reports observed signals, never install readiness or identifiers", async () => {
  const result = await checkIOS({ run: fakeCommands([successDevice]), platform: "darwin" });
  assert.deepEqual(result.xcode, { status: "observed" });
  assert.deepEqual(result.identity, { status: "observed", count: 1 });
  assert.deepEqual(result.devices, { status: "observed", count: 1, paired: 1, developerMode: 1 });
  assert.equal(result.provisioning, "unverified");
  assert.equal(result.buildInstall, "unverified");
  assert.doesNotMatch(JSON.stringify(result) + formatHuman(result), /private|TEAM|01234567/);
});

test("missing or unfamiliar device fields stay unknown; explicit disabled mode is blocked", () => {
  assert.equal(
    summarizeDevices({
      info: { commandType: "devicectl.list.devices", jsonVersion: 2, outcome: "success" },
      result: { devices: [{ hardwareProperties: { deviceType: "iPhone", platform: "iOS" } }] },
    }).status,
    "unknown",
  );
  assert.equal(
    summarizeDevices({
      info: { commandType: "devicectl.list.devices", jsonVersion: 2, outcome: "success" },
      result: {
        devices: [{ ...successDevice, deviceProperties: { developerModeStatus: "disabled" } }],
      },
    }).status,
    "blocked",
  );
  assert.equal(
    summarizeDevices({
      info: { commandType: "devicectl.list.devices", jsonVersion: 2, outcome: "success" },
      result: { devices: [{ deviceProperties: { developerModeStatus: "enabled" } }] },
    }).status,
    "unknown",
  );
  assert.equal(
    summarizeDevices({
      info: { commandType: "devicectl.list.devices", jsonVersion: 2, outcome: "success" },
      result: { devices: "broken" },
    }).status,
    "unknown",
  );
});

test("unrecognized pairing and Developer Mode values remain unknown", () => {
  const envelope = (device) => ({
    info: { commandType: "devicectl.list.devices", jsonVersion: 2, outcome: "success" },
    result: { devices: [device] },
  });
  assert.equal(
    summarizeDevices(
      envelope({
        ...successDevice,
        connectionProperties: {
          ...successDevice.connectionProperties,
          pairingState: "future-pairing",
        },
      }),
    ).status,
    "unknown",
  );
  assert.equal(
    summarizeDevices(
      envelope({
        ...successDevice,
        deviceProperties: { ...successDevice.deviceProperties, developerModeStatus: "future-mode" },
      }),
    ).status,
    "unknown",
  );
});

test("command failure and malformed JSON yield unknown without propagating local output", async () => {
  const result = await checkIOS({
    run: async (file, args) =>
      file === "xcodebuild"
        ? { code: 1, stdout: "/private/secret" }
        : file === "security"
          ? { code: 1, stdout: "account name" }
          : args[0] === "devicectl"
            ? { code: 0, stdout: "", limited: false }
            : { code: 1, stdout: "" },
    readJSON: async () => {
      throw new Error("private path");
    },
    platform: "darwin",
  });
  assert.equal(result.xcode.status, "blocked");
  assert.equal(result.identity.status, "unknown");
  assert.equal(result.devices.status, "unknown");
  assert.doesNotMatch(JSON.stringify(result), /private|account/);
});

test("identity count uses only exact Apple Development lines", () => {
  assert.deepEqual(
    summarizeIdentities(
      '  1) 0123456789abcdef0123456789abcdef01234567 "Developer ID Application: Private"\n  1 valid identities found',
    ),
    { status: "blocked", count: 0 },
  );
  assert.equal(
    summarizeIdentities(
      '  1) 0123456789abcdef0123456789abcdef01234567 "Apple Development: Private"\n  1 valid identities found',
    ).count,
    1,
  );
});

test("help and invalid flags exit before invoking host commands", () => {
  const script = fileURLToPath(new URL("./ios-doctor.mjs", import.meta.url));
  const environment = { ...process.env, PATH: "/nonexistent" };
  const help = spawnSync(process.execPath, [script, "--help"], {
    env: environment,
    encoding: "utf8",
  });
  const invalid = spawnSync(process.execPath, [script, "--unexpected"], {
    env: environment,
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Usage:/);
});

test("unsupported host performs no commands", async () => {
  const result = await checkIOS({
    platform: "linux",
    run: async () => {
      throw new Error("host command unexpectedly invoked");
    },
  });
  assert.equal(result.host, "unsupported");
  assert.equal(result.xcode.status, "unknown");
});

test("disconnected, simulated, and failed-inventory cases cannot claim observed phone", () => {
  const envelope = (devices, outcome = "success") => ({
    info: { commandType: "devicectl.list.devices", jsonVersion: 2, outcome },
    result: { devices },
  });
  assert.equal(
    summarizeDevices(
      envelope([
        {
          ...successDevice,
          connectionProperties: {
            ...successDevice.connectionProperties,
            tunnelState: "disconnected",
          },
        },
      ]),
    ).status,
    "unknown",
  );
  assert.equal(
    summarizeDevices(
      envelope([
        {
          ...successDevice,
          hardwareProperties: { ...successDevice.hardwareProperties, reality: "simulated" },
        },
      ]),
    ).status,
    "unknown",
  );
  assert.equal(
    summarizeDevices(
      envelope([
        { ...successDevice, hardwareProperties: { deviceType: "iPhone", platform: "iOS" } },
      ]),
    ).status,
    "unknown",
  );
  assert.equal(summarizeDevices(envelope([successDevice], "failed")).status, "unknown");
  assert.equal(
    summarizeDevices({
      info: { commandType: "devicectl.list.devices", jsonVersion: 5, outcome: "success" },
      result: { devices: [successDevice] },
    }).status,
    "unknown",
  );
});

test("uncertain child ownership stops later host commands", async () => {
  let calls = 0;
  const result = await checkIOS({
    platform: "darwin",
    run: async () => {
      calls++;
      throw Object.assign(new Error("private"), { code: "OWNERSHIP_UNCERTAIN" });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.subprocessOwnership, "uncertain");
});

test("bounded runner counts multibyte output bytes and reaps an owned Node child", async () => {
  const result = await runBounded(
    process.execPath,
    ["-e", "process.stdout.write('é'.repeat(9000)); setInterval(() => {}, 1000)"],
    { timeoutMs: 3_000 },
  );
  assert.equal(result.limited, true);
  assert.equal(result.stdout, "");
  assert.equal(result.signal, "SIGTERM");
});

test("bounded runner escalates an owned Node child that ignores TERM to KILL", async () => {
  const result = await runBounded(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('READY\\n'); setInterval(() => {}, 1000)",
    ],
    { timeoutMs: 3_000 },
  );
  assert.equal(result.limited, true);
  assert.equal(result.signal, "SIGKILL");
});
