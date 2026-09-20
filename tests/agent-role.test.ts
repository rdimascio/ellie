import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentRole, parseAgentCommand } from "../apps/cli/src/agent-role.ts";

const cli = new URL("../apps/cli/src/main.ts", import.meta.url).pathname;
const home = async () => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-agent-"));
  await mkdir(join(dir, ".ellie"), { recursive: true, mode: 0o700 });
  return dir;
};
const run = (dir: string, args: string[]) =>
  execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, HOME: dir },
  });

test("a recorded role round-trips through the private role file", async (t) => {
  const dir = await home();
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.match(run(dir, ["agent", "--set-role", "coordinator"]), /configured as the coordinator/);
  const saved = JSON.parse(await readFile(join(dir, ".ellie/role.json"), "utf8"));
  assert.deepEqual(saved, { version: 1, role: "coordinator" });
  assert.match(run(dir, ["agent", "--set-role", "node"]), /configured as the node/);
  assert.equal(JSON.parse(await readFile(join(dir, ".ellie/role.json"), "utf8")).role, "node");
});

test("running without a recorded role explains how to choose one", async (t) => {
  const dir = await home();
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.throws(() => run(dir, ["agent"]), /no Ellie role yet/);
});

test("an unreadable or unknown role is rejected rather than assumed", async (t) => {
  const dir = await home();
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const value of ['{"version":1,"role":"controller"}', '{"version":2,"role":"node"}', "{}"]) {
    await writeFile(join(dir, ".ellie/role.json"), value, { mode: 0o600 });
    assert.throws(() => run(dir, ["agent"]), /Invalid Ellie role|coordinator or node/, value);
  }
});

test("the role validator and argument parser accept only the two roles", () => {
  assert.deepEqual(agentRole({ version: 1, role: "node" }), { version: 1, role: "node" });
  assert.throws(() => agentRole({ version: 1, role: "node", extra: 1 }), /Invalid Ellie role/);
  assert.deepEqual(parseAgentCommand(["agent"]), {});
  assert.deepEqual(parseAgentCommand(["agent", "--set-role", "coordinator"]), {
    setRole: "coordinator",
  });
  for (const args of [
    ["agent", "--set-role"],
    ["agent", "coordinator"],
    ["agent", "-x", "node"],
  ])
    assert.throws(() => parseAgentCommand(args), /--set-role coordinator\|node/);
});
