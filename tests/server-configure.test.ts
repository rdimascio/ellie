import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaults } from "@ellie/config";

const cli = new URL("../apps/cli/src/main.ts", import.meta.url).pathname;

async function isolatedHome(host: string) {
  const home = await mkdtemp(join(tmpdir(), "ellie-configure-"));
  await mkdir(join(home, ".ellie"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, ".ellie", "server.json"),
    JSON.stringify({ version: 1, host, port: 7437, preferences: defaults }, null, 2) + "\n",
    { mode: 0o600 },
  );
  return home;
}

const run = (home: string, args: string[]) =>
  execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, HOME: home },
  });

const hostOf = async (home: string) =>
  JSON.parse(await readFile(join(home, ".ellie", "server.json"), "utf8")).host;

test("changing the listening address preserves identity, port and preferences", async (t) => {
  const home = await isolatedHome("127.0.0.1");
  t.after(() => rm(home, { recursive: true, force: true }));
  const before = JSON.parse(await readFile(join(home, ".ellie", "server.json"), "utf8"));

  assert.match(
    run(home, ["server", "configure", "--lan"]),
    /listen on 0\.0\.0\.0 after an explicit restart/,
  );
  const after = JSON.parse(await readFile(join(home, ".ellie", "server.json"), "utf8"));
  assert.equal(after.host, "0.0.0.0");
  assert.deepEqual(
    { ...after, host: undefined },
    { ...before, host: undefined },
    "only the listening address changes",
  );

  assert.match(run(home, ["server", "configure", "--local"]), /listen on 127\.0\.0\.1/);
  assert.equal(await hostOf(home), "127.0.0.1");
});

test("an unchanged listening address reports no change instead of rewriting config", async (t) => {
  const home = await isolatedHome("0.0.0.0");
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.match(run(home, ["server", "configure", "--lan"]), /already listens on 0\.0\.0\.0/);
  assert.equal(await hostOf(home), "0.0.0.0");
});

test("configure requires an explicit address choice", async (t) => {
  const home = await isolatedHome("127.0.0.1");
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const args of [
    ["server", "configure"],
    ["server", "configure", "--lan", "--local"],
    ["server", "configure", "--wan"],
  ])
    assert.throws(() => run(home, args), /configure --lan \| --local/);
  assert.equal(await hostOf(home), "127.0.0.1", "a rejected command changes nothing");
});
