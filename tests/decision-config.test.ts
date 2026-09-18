import test from "node:test";
import assert from "node:assert/strict";
import { decisionRoutingConfig, defaults, serverConfig } from "@ellie/config";
import { createDecisionRouting, routingCommand } from "../apps/cli/src/decision-routing.ts";

test("decision routing stays absent by default and hosted routing needs explicit disclosure", () => {
  assert.equal(
    serverConfig({ version: 1, host: "127.0.0.1", port: 7437, preferences: defaults })
      .decisionRouting,
    undefined,
  );
  for (const cloudDisclosure of [undefined, false, "true"])
    assert.throws(
      () => decisionRoutingConfig({ provider: "typesafe", mode: "shadow", cloudDisclosure }),
      /disclosure/,
    );
  assert.deepEqual(
    decisionRoutingConfig({ provider: "typesafe", mode: "shadow", cloudDisclosure: true }),
    {
      provider: "typesafe",
      mode: "shadow",
      cloudDisclosure: true,
      model: "jev-latest",
      timeoutMs: 3000,
      minProbability: 0.98,
      minMargin: 0.2,
    },
  );
});

test("local routing endpoints cannot redirect private state to a remote origin", () => {
  for (const endpoint of [
    "http://localhost:1234",
    "http://127.1:1234",
    "http://2130706433:1234",
    "https://example.com",
    "http://127.0.0.1/path",
    "http://user:pass@127.0.0.1",
    "http://127.0.0.1/?key=x",
    "file:///tmp/socket",
  ])
    assert.throws(() =>
      decisionRoutingConfig({ provider: "local", mode: "shadow", model: "test", endpoint }),
    );
  assert.equal(
    decisionRoutingConfig({
      provider: "local",
      mode: "shadow",
      model: "test",
      endpoint: "http://[::1]:1234",
    }).provider,
    "local",
  );
});

test("decision settings reject invalid modes, bounds, and non-finite thresholds", () => {
  const base = { provider: "typesafe", mode: "shadow", cloudDisclosure: true };
  for (const change of [
    { mode: "auto" },
    { timeoutMs: 0 },
    { timeoutMs: 10001 },
    { minProbability: NaN },
    { minMargin: Infinity },
    { minProbability: -0.1 },
    { minMargin: 1.1 },
    { model: "" },
  ])
    assert.throws(() => decisionRoutingConfig({ ...base, ...change }));
});

test("CLI configuration starts in shadow and requires explicit separate execution mode", () => {
  assert.throws(() => routingCommand(["typesafe"]));
  assert.throws(() => routingCommand(["typesafe", "--allow-cloud", "--typo"]));
  assert.throws(() => routingCommand(["mode", "execute"]), /Configure/);
  const command = routingCommand(["typesafe", "--allow-cloud"]);
  assert.equal(command.kind, "save");
  if (command.kind !== "save") throw new Error("Expected config");
  assert.equal(command.config?.mode, "shadow");
  assert.equal(command.needsKey, true);
  const execute = routingCommand(["mode", "execute"], command.config);
  assert.equal(execute.kind === "save" && execute.config?.mode, "execute");
  assert.deepEqual(routingCommand(["off"], command.config), { kind: "save" });
});

test("disabled and local providers never read cloud credentials", async () => {
  const secrets = {
    get: async () => {
      throw new Error("Unexpected key access");
    },
    set: async () => {},
  };
  assert.equal(await createDecisionRouting(undefined, secrets), undefined);
  const local = await createDecisionRouting(
    decisionRoutingConfig({
      provider: "local",
      mode: "shadow",
      model: "test",
      endpoint: "http://127.0.0.1:1234",
    }),
    secrets,
  );
  assert.equal(local?.provider.locality, "local");
});
