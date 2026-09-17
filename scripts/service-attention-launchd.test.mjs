import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cleanup,
  eventNames,
  fixturePlist,
  inspectFixture,
  kc01,
  kc03,
  prepare,
  servicePid,
} from "./service-attention-launchd.mjs";

const expectedFailure = ["starting", "keychain_access_unavailable", "needs_attention"];
const appendEvents = async (root, names) => {
  const log = join(root, "home", ".ellie", "logs", "coordinator.jsonl");
  const original = await readFile(log, "utf8");
  await writeFile(
    log,
    original + names.map((event) => JSON.stringify({ role: "coordinator", event }) + "\n").join(""),
  );
};

async function fakeFixture(phase) {
  const root = await mkdtemp(join(tmpdir(), "ellie-kc-fake-"));
  await mkdir(join(root, "home", ".ellie", "logs"), { recursive: true });
  await writeFile(join(root, "home", ".ellie", "logs", "coordinator.jsonl"), "");
  await writeFile(
    join(root, "home", ".ellie", "server-cert.pem"),
    "synthetic fixture certificate\n",
  );
  await writeFile(join(root, "mode"), "reject\n");
  await writeFile(join(root, "attempts"), "");
  const record = {
    version: 1,
    phase,
    label: "org.ellie.qa.kc-attention.00000000-0000-4000-8000-000000000000",
    port: 49832,
    release: "/synthetic-payload",
  };
  await writeFile(join(root, "fixture.json"), JSON.stringify(record));
  return { root, record };
}

function fakeLaunchd(root, record, { lingerPrints = 0 } = {}) {
  let loaded = false;
  let linger = 0;
  let bootstrapCount = 0;
  const calls = [];
  const command = `${record.release}/payload/lib/ellie/apps/cli/src/main.ts service run coordinator`;
  return {
    calls,
    async launchctl(args) {
      calls.push(args);
      if (args[0] === "print") {
        assert.equal(args[1], `gui/${process.getuid()}/${record.label}`);
        if (linger > 0) {
          linger--;
          return { code: 0, stdout: "\tpid = 12345\n" };
        }
        return loaded ? { code: 0, stdout: "\tpid = 12345\n" } : { code: 113, stdout: "" };
      }
      if (args[0] === "bootout") {
        assert.equal(args[1], `gui/${process.getuid()}/${record.label}`);
        assert.equal(loaded, true);
        loaded = false;
        linger = lingerPrints;
        return { code: 0, stdout: "" };
      }
      assert.equal(args[0], "bootstrap");
      assert.deepEqual(args, ["bootstrap", `gui/${process.getuid()}`, join(root, "agent.plist")]);
      assert.equal(loaded, false);
      bootstrapCount++;
      loaded = true;
      if (bootstrapCount === 1) {
        await appendEvents(root, expectedFailure);
        await writeFile(join(root, "attempts"), "server.key\n");
      } else {
        assert.equal(await readFile(join(root, "mode"), "utf8"), "success\n");
        await appendEvents(root, ["starting", "ready"]);
        await writeFile(join(root, "attempts"), "server.key\nserver.key\n");
      }
      return { code: 0, stdout: "" };
    },
    fixture: async () => JSON.parse(await readFile(join(root, "fixture.json"), "utf8")),
    observeProcess: async () =>
      loaded
        ? { code: 0, stdout: `Thu Sep 17 12:00:00 2026 /qa/node ${command}\n` }
        : { code: 1, stdout: "" },
    verifyNoListener: async () => {},
    verifyTlsListener: async () => {},
    throttleWait: async (duration) => assert.equal(duration, 31_000),
    pollWait: async () => {},
  };
}

test("fake launchd requires a single rejecting start, stable attention, then explicit recovery", async () => {
  const { root, record } = await fakeFixture("prepared");
  try {
    const io = fakeLaunchd(root, record, { lingerPrints: 2 });
    await kc01(root, io);
    const attention = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
    assert.equal(attention.phase, "attention");
    assert.equal(await readFile(join(root, "attempts"), "utf8"), "server.key\n");
    assert.deepEqual(
      eventNames(await readFile(join(root, "home", ".ellie", "logs", "coordinator.jsonl"), "utf8")),
      expectedFailure,
    );
    const labels = io.calls.filter(([command]) => command === "bootstrap");
    assert.equal(labels.length, 1);
    await writeFile(
      join(root, "fixture.json"),
      JSON.stringify({ ...attention, phase: "diagnosed" }),
    );
    await kc03(root, io);
    const recovered = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
    assert.equal(recovered.phase, "recovered");
    assert.deepEqual(io.calls.filter(([command]) => command === "bootout").length, 1);
    assert.deepEqual(io.calls.filter(([command]) => command === "bootstrap").length, 2);
    assert.ok(io.calls.filter(([command]) => command === "print").length >= 2);
    assert.equal(await readFile(join(root, "attempts"), "utf8"), "server.key\nserver.key\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fake recovery failure stays uncertain and never auto-retries", async () => {
  const { root, record } = await fakeFixture("diagnosed");
  try {
    await appendEvents(root, expectedFailure);
    await writeFile(join(root, "attempts"), "server.key\n");
    const command = `${record.release}/payload/lib/ellie/apps/cli/src/main.ts service run coordinator`;
    const identity = {
      pid: 12345,
      started: "Thu Sep 17 12:00:00 2026",
      commandSha256: createHash("sha256").update(`/qa/node ${command}`).digest("hex"),
    };
    await writeFile(join(root, "attention.json"), JSON.stringify({ case: "KC01", identity }));
    const calls = [];
    let loaded = true;
    await assert.rejects(
      kc03(root, {
        fixture: async () => record,
        launchctl: async (args) => {
          calls.push(args);
          if (args[0] === "bootout") {
            loaded = false;
            return { code: 0, stdout: "" };
          }
          if (args[0] === "print")
            return loaded ? { code: 0, stdout: "\tpid = 12345\n" } : { code: 113, stdout: "" };
          return { code: 1, stdout: "" };
        },
        observeProcess: async () =>
          loaded
            ? { code: 0, stdout: `Thu Sep 17 12:00:00 2026 /qa/node ${command}\n` }
            : { code: 1, stdout: "" },
        verifyNoListener: async () => {},
      }),
      /no automatic retry/,
    );
    assert.equal(JSON.parse(await readFile(join(root, "fixture.json"), "utf8")).phase, "uncertain");
    assert.equal(calls.filter(([command]) => command === "bootstrap").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup waits for the exact owned service process after the label disappears", async () => {
  const { root, record } = await fakeFixture("recovered");
  try {
    const command = `${record.release}/payload/lib/ellie/apps/cli/src/main.ts service run coordinator`;
    const identity = {
      pid: 12345,
      started: "Thu Sep 17 12:00:00 2026",
      commandSha256: createHash("sha256").update(`/qa/node ${command}`).digest("hex"),
    };
    await writeFile(join(root, "recovered.json"), JSON.stringify({ case: "KC03", identity }));
    let loaded = true;
    const calls = [];
    await cleanup(root, {
      fixture: async () => record,
      launchctl: async (args) => {
        calls.push(args);
        if (args[0] === "bootout") {
          loaded = false;
          return { code: 0, stdout: "" };
        }
        return loaded ? { code: 0, stdout: "\tpid = 12345\n" } : { code: 113, stdout: "" };
      },
      observeProcess: async () =>
        loaded
          ? { code: 0, stdout: `Thu Sep 17 12:00:00 2026 /qa/node ${command}\n` }
          : { code: 1, stdout: "" },
      verifyNoListener: async () => {},
    });
    assert.equal(JSON.parse(await readFile(join(root, "fixture.json"), "utf8")).phase, "stopped");
    assert.equal(calls.filter(([commandName]) => commandName === "bootout").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed post-bootout process observation retains uncertain cleanup", async () => {
  const { root, record } = await fakeFixture("recovered");
  try {
    const command = `${record.release}/payload/lib/ellie/apps/cli/src/main.ts service run coordinator`;
    let loaded = true;
    let bootouts = 0;
    await assert.rejects(
      cleanup(root, {
        fixture: async () => record,
        launchctl: async ([action]) => {
          if (action === "bootout") {
            bootouts++;
            loaded = false;
            return { code: 0, stdout: "" };
          }
          return loaded ? { code: 0, stdout: "\tpid = 12345\n" } : { code: 113, stdout: "" };
        },
        observeProcess: async () =>
          loaded
            ? { code: 0, stdout: `Thu Sep 17 12:00:00 2026 /qa/node ${command}\n` }
            : { code: 2, stdout: "" },
        verifyNoListener: async () => {},
      }),
      /process state is unavailable/,
    );
    assert.equal(bootouts, 1);
    assert.equal(JSON.parse(await readFile(join(root, "fixture.json"), "utf8")).phase, "uncertain");
    assert.equal(await readFile(join(root, "mode"), "utf8"), "reject\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture launchd parsing and private label are bounded", () => {
  assert.equal(servicePid("\tpid = 100\n"), 100);
  assert.throws(() => servicePid("\tpid = 100\n\tpid = 101\n"), /ambiguous/);
  assert.throws(() => eventNames('{"role":"other","event":"ready"}\n'), /Invalid fixture event/);
  const plist = fixturePlist({
    label: "org.ellie.qa.kc-attention.00000000-0000-4000-8000-000000000000",
    node: "/qa/node",
    entrypoint: "/qa/main.ts",
    home: "/qa/home",
    helper: "/qa/helper",
    mode: "/qa/mode",
    attempts: "/qa/attempts",
  });
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>HOME<\/key><string>\/qa\/home<\/string>/);
  assert.doesNotMatch(plist, /org\.ellie\.assistant/);
});

test(
  "offline pinned payload rejects modified plist, helper, and coordinator config",
  {
    skip: !process.env.ELLIE_KC_RELEASE || process.platform !== "darwin",
  },
  async () => {
    const root = join(homedir(), ".codex", "ellie-qa", `kc-launchd-attention-${randomUUID()}`);
    try {
      await prepare({ root, release: process.env.ELLIE_KC_RELEASE });
      assert.equal((await inspectFixture(root)).phase, "prepared");
      for (const path of [
        join(root, "agent.plist"),
        join(root, "helper.mjs"),
        join(root, "home", ".ellie", "server.json"),
      ]) {
        const original = await readFile(path);
        try {
          await writeFile(path, Buffer.concat([original, Buffer.from("\n")]));
          await assert.rejects(inspectFixture(root), /changed/);
        } finally {
          await writeFile(path, original);
        }
      }
      assert.equal((await inspectFixture(root)).phase, "prepared");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
