import test from "node:test";
import assert from "node:assert/strict";
import { job, record } from "@ellie/protocol";
import type { DecisionProvider } from "@ellie/decisions";
import { fixture } from "./helpers.ts";

for (const mode of ["execute", "shadow"] as const) {
  test(`typed browser commands bypass ${mode} decision routing over HTTPS`, async () => {
    let providerCalls = 0;
    const provider: DecisionProvider = {
      id: "unavailable-stub",
      locality: "local",
      async evaluate() {
        providerCalls++;
        throw new Error("The decision provider should only receive unfamiliar text.");
      },
    };
    const f = await fixture(2000, { decisionRouting: { mode, provider } });
    try {
      const node = await f.pair("browser-node");
      await node.call("POST", "/v1/register", { capabilities: ["browser.read", "app.open"] });

      const typed = f.controller.call("POST", "/v1/commands", {
        nodeId: "browser-node",
        action: { tool: "browser.status" },
      });
      const task = job(record(await node.call("GET", "/v1/poll")).job);
      assert.deepEqual(task.actions, [{ tool: "browser.status" }]);
      assert.equal(providerCalls, 0);
      await node.call("POST", "/v1/result", {
        id: task.id,
        result: {
          ok: false,
          message: "No reviewed browser tab is connected.",
          browser: { source: "webmcp", operation: "status", status: "unbound" },
        },
      });
      const result = record(await typed);
      assert.equal(result.ok, false);
      assert.equal(record(result.browser).status, "unbound");
      assert.equal(providerCalls, 0);
      assert.equal(f.jobStore.list("browser-node", 1)[0]?.kind, "desktop");

      for (const payload of [
        { nodeId: "browser-node", text: "open Arc", action: { tool: "browser.status" } },
        { nodeId: "browser-node", action: { tool: "app.open", app: "com.apple.Notes" } },
        { nodeId: "browser-node", action: { tool: "browser.status", app: "com.apple.Notes" } },
      ])
        await assert.rejects(
          f.controller.call("POST", "/v1/commands", payload),
          /Command request rejected|Request rejected/,
        );
      assert.equal(providerCalls, 0);
      assert.equal(f.jobStore.list("browser-node").length, 1);

      const unfamiliar = record(
        await f.controller.call("POST", "/v1/commands", {
          nodeId: "browser-node",
          text: "Show Notes",
        }),
      );
      assert.equal(unfamiliar.ok, false);
      assert.match(String(unfamiliar.message), /Decision routing was unavailable/);
      assert.equal(providerCalls, 1);
      assert.equal(f.jobStore.list("browser-node").length, 1);
    } finally {
      await f.close();
    }
  });
}
