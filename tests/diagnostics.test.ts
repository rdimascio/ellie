import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { defaults } from "@ellie/config";
import { CAPABILITIES } from "@ellie/protocol";
import { generateCertificate } from "../apps/cli/src/certificate.ts";
import { doctor, doctorService } from "../apps/cli/src/diagnostics.ts";
import type { DiagnosticDependencies } from "../apps/cli/src/diagnostics.ts";

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
    capabilities: async () => [...CAPABILITIES],
    serviceStatus: async (requested) => ({
      role: requested,
      installed: true,
      guiSession: true,
      loaded: true,
      enabled: true,
      state: "running",
      pid: 123,
    }),
    client: () => ({
      call: async () =>
        role === "node"
          ? [{ id: nodeId, lastSeen: now, executionCapabilities: [...CAPABILITIES] }]
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
  const healthy = await doctor({ capabilities: async () => [...CAPABILITIES] });
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.lines, [`Available tools: ${CAPABILITIES.join(", ")}`]);

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
