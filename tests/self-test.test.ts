import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES } from "@ellie/protocol";
import {
  implicitSayTarget,
  nodeIdArgument,
  runServiceTest,
  selectExecutionNode,
  serviceTestOptions,
} from "../apps/cli/src/self-test.ts";

const now = 1_000_000;
const node = (id: string, lastSeen = now, tools: readonly string[] = CAPABILITIES) => ({
  id,
  lastSeen,
  capabilities: tools,
  executionCapabilities: tools,
});

test("service test flags require explicit, complete desktop authorization", () => {
  assert.deepEqual(serviceTestOptions([]), {});
  assert.deepEqual(serviceTestOptions(["--node", "node-a"]), { nodeId: "node-a" });
  assert.deepEqual(serviceTestOptions(["--desktop", "--app", "Arc"]), {
    desktopApp: "arc",
  });
  assert.deepEqual(serviceTestOptions(["--desktop", "--app", "  Google   Chrome  "]), {
    desktopApp: "google chrome",
  });
  assert.throws(() => serviceTestOptions(["--desktop"]), /both --desktop and --app/);
  assert.throws(() => serviceTestOptions(["--app", "Arc"]), /both --desktop and --app/);
  assert.throws(() => serviceTestOptions(["--desktop", "--desktop", "--app", "Arc"]), /once/);
  assert.throws(() => serviceTestOptions(["--node", "node-a", "--node", "node-b"]), /once/);
  assert.throws(() => serviceTestOptions(["--app", "Arc", "--app", "Calculator"]), /once/);
  assert.throws(() => serviceTestOptions(["--node", "--desktop"]), /node ID/);
  assert.throws(() => serviceTestOptions(["--desktop", "--app", "--node"]), /app name/);
  for (const invalid of ["Arc\nMessages", "Arc\tMessages", "Arc; Messages", "Arc_Messages"])
    assert.throws(
      () => serviceTestOptions(["--desktop", "--app", invalid]),
      /only letters, numbers, spaces, and hyphens/,
    );
  assert.throws(() => serviceTestOptions(["--unknown"]), /service test/);
});

test("literal node placeholders fail with exact discovery guidance", () => {
  for (const placeholder of ["NODE_ID", "<NODE_ID>", "your-node-id", "YOUR_NODE_ID"])
    assert.throws(() => nodeIdArgument(placeholder), /Replace NODE_ID.*ellie nodes/);
  assert.equal(
    nodeIdArgument("2c634ebb-25af-4b95-a4bf-fbf870658e16"),
    "2c634ebb-25af-4b95-a4bf-fbf870658e16",
  );
});

test("one fresh capable node is selected automatically and ambiguity stays explicit", () => {
  assert.equal(selectExecutionNode([node("only")], undefined, now).id, "only");
  assert.equal(
    selectExecutionNode([node("stale", now - 60_001), node("online")], undefined, now).id,
    "online",
  );
  assert.throws(
    () => selectExecutionNode([node("a"), node("b")], undefined, now),
    /More than one.*--node.*a, b/,
  );
  assert.throws(
    () => selectExecutionNode([node("compute", now, [])], undefined, now),
    /No online registered node.*desktop app control/,
  );
  assert.throws(
    () => selectExecutionNode([], "missing", now),
    /unknown or not currently registered/,
  );
  assert.throws(
    () => selectExecutionNode([node("known", now - 60_001)], "known", now),
    /registered but offline or stale/,
  );
});

test("coordinator targeting wins when an inactive local node identity also exists", () => {
  assert.equal(implicitSayTarget(true), "coordinator");
  assert.equal(
    selectExecutionNode(
      [node("inactive-local", now - 60_001), node("execution-mini")],
      undefined,
      now,
    ).id,
    "execution-mini",
  );
  assert.equal(implicitSayTarget(false), "node");
});

test("read-only service test checks readiness without submitting a job", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const report = await runServiceTest(
    {
      call: async (method, path, body) => {
        calls.push({ method, path, body });
        return [node("only")];
      },
    },
    {},
    now,
  );
  assert.equal(report.nodeId, "only");
  assert.equal(report.result, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: "GET", path: "/v1/nodes", body: undefined });
  assert.ok(report.lines.some((line) => line.includes("no job or desktop action")));
});

test("desktop service test submits only the explicitly named app-open command", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const report = await runServiceTest(
    {
      call: async (method, path, body) => {
        calls.push({ method, path, body });
        return path === "/v1/nodes" ? [node("only")] : { ok: true, message: "Done." };
      },
    },
    { desktopApp: "arc" },
    now,
  );
  assert.deepEqual(calls[1], {
    method: "POST",
    path: "/v1/commands",
    body: { nodeId: "only", text: "open app arc" },
  });
  assert.equal(report.result?.ok, true);
});
