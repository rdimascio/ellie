import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaults } from "@ellie/config";
import { CAPABILITIES, DESKTOP_CAPABILITIES } from "@ellie/protocol";
import { generateCertificate } from "../apps/cli/src/certificate.ts";
import { doctor, doctorService } from "../apps/cli/src/diagnostics.ts";
import {
  packagedServiceContext,
  packagedServiceStatus,
} from "../apps/cli/src/packaged-service-status.ts";
import type { DiagnosticDependencies } from "../apps/cli/src/diagnostics.ts";

const packagedReleaseID = `0.1.0-${"a".repeat(40)}-arm64`;
const packagedRoot = join("/synthetic/releases", packagedReleaseID);
const packagedModule = pathToFileURL(
  join(packagedRoot, "payload/lib/ellie/apps/cli/src/packaged-service-status.ts"),
).href;
const packagedNode = join(packagedRoot, "payload/bin/node");

test("packaged doctor uses only its own staged Node and shipped read-only installer", async () => {
  assert.equal(packagedServiceContext(import.meta.url, process.execPath), undefined);
  assert.throws(() => packagedServiceContext(packagedModule, "/usr/local/bin/node"));
  const invalidRelease = join(
    "/synthetic/releases",
    `${"1".repeat(33)}.0.0-${"a".repeat(40)}-arm64`,
  );
  assert.throws(() =>
    packagedServiceContext(
      pathToFileURL(
        join(invalidRelease, "payload/lib/ellie/apps/cli/src/packaged-service-status.ts"),
      ).href,
      join(invalidRelease, "payload/bin/node"),
    ),
  );
  const context = packagedServiceContext(packagedModule, packagedNode);
  assert.deepEqual(context, {
    installer: join(packagedRoot, "payload/bin/ellie-service-installer"),
    releaseID: packagedReleaseID,
  });
  const x64Release = packagedRoot.replace(/-arm64$/, "-x64");
  assert.deepEqual(
    packagedServiceContext(
      pathToFileURL(join(x64Release, "payload/lib/ellie/apps/cli/src/packaged-service-status.ts"))
        .href,
      join(x64Release, "payload/bin/node"),
    ),
    {
      installer: join(x64Release, "payload/bin/ellie-service-installer"),
      releaseID: packagedReleaseID.replace(/-arm64$/, "-x64"),
    },
  );
  assert.ok(context);
  const calls: Array<[string, string[]]> = [];
  const status = await packagedServiceStatus("coordinator", context, async (file, args) => {
    calls.push([file, args]);
    return {
      code: 0,
      stdout: `${JSON.stringify({
        enabled: true,
        loadedFromSelectedPlist: true,
        releaseID: packagedReleaseID,
        role: "coordinator",
        selected: true,
        state: "running",
      })}\n`,
    };
  });
  assert.deepEqual(calls, [[context.installer, ["status", "coordinator"]]]);
  assert.deepEqual(status, {
    role: "coordinator",
    installed: true,
    guiSession: true,
    loaded: true,
    enabled: true,
    state: "running",
  });
});

test("packaged doctor rejects unavailable, unselected, foreign, or malformed native status", async () => {
  const context = packagedServiceContext(packagedModule, packagedNode)!;
  const selected = {
    role: "node",
    selected: true,
    releaseID: packagedReleaseID,
    enabled: true,
    state: "running",
    loadedFromSelectedPlist: true,
  };
  const invalid: Array<{ code: number; stdout: string }> = [
    { code: 1, stdout: JSON.stringify(selected) },
    { code: 0, stdout: "not-json" },
    { code: 0, stdout: JSON.stringify({ role: "node", selected: false, state: "unselected" }) },
    {
      code: 0,
      stdout: JSON.stringify({ ...selected, releaseID: `0.1.0-${"b".repeat(40)}-arm64` }),
    },
    { code: 0, stdout: JSON.stringify({ ...selected, loadedFromSelectedPlist: false }) },
    { code: 0, stdout: JSON.stringify({ ...selected, state: "unavailable" }) },
    { code: 0, stdout: JSON.stringify({ ...selected, enabled: "true" }) },
    { code: 0, stdout: JSON.stringify({ ...selected, extra: true }) },
    { code: 0, stdout: "x".repeat(1025) },
  ];
  for (const response of invalid) {
    let calls = 0;
    await assert.rejects(() =>
      packagedServiceStatus("node", context, async (file, args) => {
        calls++;
        assert.equal(file, context.installer);
        assert.deepEqual(args, ["status", "node"]);
        return response;
      }),
    );
    assert.equal(calls, 1);
  }
  const waiting = await packagedServiceStatus("node", context, async () => ({
    code: 0,
    stdout: JSON.stringify({ ...selected, state: "waiting" }),
  }));
  assert.equal(waiting.loaded, true);
  assert.equal(waiting.state, "waiting");
  const stopped = await packagedServiceStatus("node", context, async () => ({
    code: 0,
    stdout: JSON.stringify({
      ...selected,
      enabled: false,
      state: "stopped",
      loadedFromSelectedPlist: false,
    }),
  }));
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.loaded, false);
});

test("role doctor uses validated packaged status without changing other diagnostics", async () => {
  const f = await fixture("coordinator");
  const context = packagedServiceContext(packagedModule, packagedNode)!;
  const report = await doctorService("coordinator", {
    ...f.deps,
    serviceStatus: (role) =>
      packagedServiceStatus(role, context, async (file, args) => {
        assert.equal(file, context.installer);
        assert.deepEqual(args, ["status", "coordinator"]);
        return {
          code: 0,
          stdout: JSON.stringify({
            role,
            selected: true,
            releaseID: packagedReleaseID,
            enabled: true,
            state: "running",
            loadedFromSelectedPlist: true,
          }),
        };
      }),
  });
  assert.equal(report.ok, true, report.lines.join("\n"));
  assert.ok(report.lines.includes("PASS Coordinator LaunchAgent is installed and running."));
});

async function fixture(role: "coordinator" | "node") {
  const generated = await generateCertificate();
  const now = Date.now();
  const nodeId = "synthetic-node";
  const config =
    role === "coordinator"
      ? { version: 1, host: "127.0.0.1", port: 7437, preferences: defaults }
      : {
          version: 1,
          id: nodeId,
          serverUrl: "https://127.0.0.1:7437",
          preferences: defaults,
          executionEnabled: true,
        };
  const files = new Map([
    [
      `/synthetic/.ellie/${role === "coordinator" ? "server.json" : "node.json"}`,
      JSON.stringify(config),
    ],
    [
      `/synthetic/.ellie/${role === "coordinator" ? "server-cert.pem" : "node-server-cert.pem"}`,
      generated.cert,
    ],
  ]);
  let closed = false;
  const deps: Partial<DiagnosticDependencies> = {
    stateDir: "/synthetic/.ellie",
    uid: 501,
    now: () => now,
    privatePath: async () => {},
    readFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("PRIVATE / secret path");
      return value;
    },
    access: async () => {},
    keychainGet: async (account) => {
      if (account === "server.key") return generated.key;
      return "a".repeat(64);
    },
    run: async () => ({ code: 0, stdout: "" }),
    capabilities: async () => [...DESKTOP_CAPABILITIES],
    serviceStatus: async (requested) => ({
      role: requested,
      installed: true,
      guiSession: true,
      loaded: true,
      enabled: true,
      state: "running",
      pid: 123,
    }),
    serviceCredentialState: async () => "none",
    client: () => ({
      call: async () =>
        role === "node"
          ? [{ id: nodeId, lastSeen: now, executionCapabilities: [...DESKTOP_CAPABILITIES] }]
          : [],
      close: () => {
        closed = true;
      },
    }),
    inferenceHealth: async () => true,
  };
  return { deps, closed: () => closed };
}

test("lightweight doctor preserves available-tool output and Accessibility failure semantics", async () => {
  const healthy = await doctor({ capabilities: async () => [...DESKTOP_CAPABILITIES] });
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.lines, [`Available tools: ${DESKTOP_CAPABILITIES.join(", ")}`]);

  const limited = await doctor({ capabilities: async () => ["app.open", "url.open"] });
  assert.equal(limited.ok, false);
  assert.equal(limited.lines[0], "Available tools: app.open, url.open");
  assert.match(limited.lines[1]!, /Accessibility/);
});

test("role diagnostics cover private state, Keychain, certificate, helper, GUI, service and pinned reachability", async () => {
  for (const role of ["coordinator", "node"] as const) {
    const f = await fixture(role);
    const report = await doctorService(role, f.deps);
    assert.equal(report.ok, true, report.lines.join("\n"));
    assert.equal(f.closed(), true);
    assert.ok(report.lines.some((line) => line.includes("configuration and file permissions")));
    assert.ok(report.lines.some((line) => line.includes("Keychain")));
    assert.ok(report.lines.some((line) => line.includes("code signature")));
    assert.ok(report.lines.some((line) => line.includes("LaunchAgent")));
    assert.ok(
      report.lines.some(
        (line) => line.includes("authenticated endpoint") || line.includes("registration is fresh"),
      ),
    );
  }
});

test("attention diagnostic refuses a second Keychain query", async () => {
  const f = await fixture("node");
  let credentialReads = 0;
  const report = await doctorService("node", {
    ...f.deps,
    serviceCredentialState: async () => "needs_attention",
    keychainGet: async () => {
      credentialReads += 1;
      throw new Error("synthetic private account");
    },
  });
  assert.equal(report.ok, false);
  assert.equal(credentialReads, 0);
  assert.equal(report.lines.length, 1);
  assert.match(report.lines[0]!, /needs credential attention/);
  assert.doesNotMatch(report.lines[0]!, /synthetic private account/);
});

test("an unfinished startup diagnostic also refuses a second Keychain query", async () => {
  const f = await fixture("coordinator");
  let credentialReads = 0;
  const report = await doctorService("coordinator", {
    ...f.deps,
    serviceCredentialState: async () => "starting",
    keychainGet: async () => {
      credentialReads += 1;
      throw new Error("synthetic private account");
    },
  });
  assert.equal(report.ok, false);
  assert.equal(credentialReads, 0);
  assert.match(report.lines[0]!, /not reported startup readiness/);
});

test("unreadable attention records fail closed before Keychain", async () => {
  const f = await fixture("node");
  let credentialReads = 0;
  const report = await doctorService("node", {
    ...f.deps,
    serviceCredentialState: async () => {
      throw new Error("synthetic private path");
    },
    keychainGet: async () => {
      credentialReads += 1;
      return "synthetic secret";
    },
  });
  assert.equal(report.ok, false);
  assert.equal(credentialReads, 0);
  assert.doesNotMatch(report.lines.join("\n"), /synthetic private path|synthetic secret/);
});

test("missing startup records in a running service also skip Keychain", async () => {
  const f = await fixture("node");
  let credentialReads = 0;
  const report = await doctorService("node", {
    ...f.deps,
    serviceCredentialState: async () => "unknown",
    keychainGet: async () => {
      credentialReads += 1;
      return "synthetic secret";
    },
  });
  assert.equal(report.ok, false);
  assert.equal(credentialReads, 0);
  assert.match(report.lines[0]!, /no complete startup record/);
});

test("diagnostic failures and optional inference warnings stay redacted", async () => {
  const f = await fixture("node");
  const secret = "https://private-host.example/opaque-node-id?token=PRIVATE";
  const report = await doctorService("node", {
    ...f.deps,
    privatePath: async () => {
      throw new Error(secret);
    },
    keychainGet: async () => {
      throw new Error(secret);
    },
    access: async () => {
      throw new Error(secret);
    },
    capabilities: async () => {
      throw new Error(secret);
    },
    serviceStatus: async () => {
      throw new Error(secret);
    },
    client: () => {
      throw new Error(secret);
    },
    inferenceHealth: async () => {
      throw new Error(secret);
    },
  });
  assert.equal(report.ok, false);
  assert.doesNotMatch(report.lines.join("\n"), /private-host|opaque-node|token=|PRIVATE/);
});

test("optional inference failure does not fail an otherwise healthy compute node", async () => {
  const f = await fixture("node");
  const raw = JSON.parse(await f.deps.readFile!("/synthetic/.ellie/node.json"));
  raw.inferenceWorker = {
    endpoint: "http://127.0.0.1:11434",
    models: [{ id: "synthetic-model", requiredFreeMemoryBytes: 1 }],
  };
  const read = f.deps.readFile!;
  const report = await doctorService("node", {
    ...f.deps,
    readFile: async (path) => (path.endsWith("node.json") ? JSON.stringify(raw) : read(path)),
    inferenceHealth: async () => {
      throw new Error("synthetic-model at a private runner URL");
    },
  });
  assert.equal(report.ok, true, report.lines.join("\n"));
  assert.ok(report.lines.some((line) => line.startsWith("WARN") && line.includes("inference")));
  assert.doesNotMatch(report.lines.join("\n"), /synthetic-model|private runner/);
});

test("coordinator certificate must match its existing Keychain private key", async () => {
  const f = await fixture("coordinator");
  const unrelated = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  const report = await doctorService("coordinator", {
    ...f.deps,
    keychainGet: async (account) => (account === "server.key" ? unrelated : "a".repeat(64)),
  });
  assert.equal(report.ok, false);
  assert.ok(report.lines.some((line) => line.startsWith("FAIL") && line.includes("identity")));
});

test("role diagnostics reject expired certificates without exposing certificate details", async () => {
  const f = await fixture("coordinator");
  const report = await doctorService("coordinator", {
    ...f.deps,
    now: () => Date.now() + 366 * 24 * 60 * 60_000,
  });
  assert.equal(report.ok, false);
  assert.ok(
    report.lines.some(
      (line) => line === "FAIL The pinned TLS certificate is invalid, expired, or not yet valid.",
    ),
  );
});

test("node diagnostics fail when the authenticated registration is stale", async () => {
  const f = await fixture("node");
  const report = await doctorService("node", {
    ...f.deps,
    client: () => ({
      call: async () => [{ id: "synthetic-node", lastSeen: 0 }],
      close: () => {},
    }),
  });
  assert.equal(report.ok, false);
  assert.ok(
    report.lines.some(
      (line) =>
        line === "FAIL The coordinator is unavailable or this node's registration is stale.",
    ),
  );
});

test("terminal Accessibility cannot mask missing window tools in the running node", async () => {
  const f = await fixture("node");
  const report = await doctorService("node", {
    ...f.deps,
    client: () => ({
      call: async () => [
        {
          id: "synthetic-node",
          lastSeen: Date.now(),
          capabilities: [...CAPABILITIES],
          executionCapabilities: ["app.open", "url.open"],
        },
      ],
      close: () => {},
    }),
  });
  assert.equal(report.ok, false);
  assert.ok(
    report.lines.includes(
      "Terminal helper tools: app.open, url.open, window.place, window.adjacent",
    ),
  );
  assert.ok(report.lines.includes("Registered node tools: app.open, url.open"));
  assert.ok(
    report.lines.some((line) =>
      line.startsWith("FAIL The running node has not advertised every desktop tool."),
    ),
  );
});

test("healthy service registration makes a terminal Accessibility difference a warning", async () => {
  const f = await fixture("node");
  const report = await doctorService("node", {
    ...f.deps,
    capabilities: async () => ["app.open", "url.open"],
  });
  assert.equal(report.ok, true, report.lines.join("\n"));
  assert.ok(
    report.lines.some(
      (line) => line.startsWith("WARN") && line.includes("healthy running service registration"),
    ),
  );
  assert.ok(report.lines.includes("PASS The running node advertises every desktop capability."));
});

test("compute-only node does not require desktop registration and unknown tool names stay redacted", async () => {
  const f = await fixture("node");
  const read = f.deps.readFile!;
  const config = JSON.parse(await read("/synthetic/.ellie/node.json"));
  config.executionEnabled = false;
  const client = (executionCapabilities: string[]) => ({
    call: async () => [{ id: "synthetic-node", lastSeen: Date.now(), executionCapabilities }],
    close: () => {},
  });
  const compute = await doctorService("node", {
    ...f.deps,
    readFile: async (path) => (path.endsWith("node.json") ? JSON.stringify(config) : read(path)),
    client: () => client([]),
  });
  assert.equal(compute.ok, true, compute.lines.join("\n"));
  const malformed = await doctorService("node", {
    ...f.deps,
    client: () => client(["PRIVATE-token"]),
  });
  assert.equal(malformed.ok, false);
  assert.doesNotMatch(malformed.lines.join("\n"), /PRIVATE-token/);
});
