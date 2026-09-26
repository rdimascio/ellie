import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = new URL("../apps/cli/src/main.ts", import.meta.url).pathname;

test("Google client preflight is read-only and prints only fixed redacted facts", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-google-client-preflight-")));
  t.after(() => rm(root, { recursive: true }));
  const client = join(root, "client.json"),
    secret = "synthetic-secret-that-must-not-be-printed",
    clientId = "synthetic-client-id.apps.googleusercontent.com",
    original = Buffer.from(
      JSON.stringify({
        installed: {
          client_id: clientId,
          client_secret: secret,
          project_id: "synthetic-project",
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          token_uri: "https://oauth2.googleapis.com/token",
          redirect_uris: ["http://localhost"],
        },
      }),
    );
  await writeFile(client, original, { mode: 0o600 });
  const result = await execute(
    process.execPath,
    ["--experimental-strip-types", cli, "life", "google-client", "check", client],
    { env: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: root } },
  );
  assert.equal(
    result.stdout,
    "Google OAuth client preflight passed. No account or consent request was opened.\n" +
      "Client secret: present.\n" +
      'Next, reference this file as "googleOAuthClientFile" in the private Life host config. Calendar and Gmail remain separate read-only consent requests.\n',
  );
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, new RegExp(clientId));
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stdout, new RegExp(root));
  assert.deepEqual(await readFile(client), original);
});

test("Google client preflight accepts a public client and redacts unsafe-file failures", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-google-client-preflight-")));
  t.after(() => rm(root, { recursive: true }));
  const client = join(root, "client.json"),
    clientId = "synthetic-public-client.apps.googleusercontent.com";
  await writeFile(client, JSON.stringify({ clientId }), { mode: 0o600 });
  const invoke = () =>
    execute(
      process.execPath,
      ["--experimental-strip-types", cli, "life", "google-client", "check", client],
      { env: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: root } },
    );
  const accepted = await invoke();
  assert.match(accepted.stdout, /Client secret: absent\./);
  assert.doesNotMatch(accepted.stdout, new RegExp(clientId));
  assert.doesNotMatch(accepted.stdout, new RegExp(root));

  await chmod(client, 0o644);
  await assert.rejects(invoke(), (error: unknown) => {
    const stderr = String((error as { stderr?: string }).stderr);
    assert.match(stderr, /Google OAuth client file is unavailable, invalid, or unsafe/);
    assert.doesNotMatch(stderr, new RegExp(clientId));
    assert.doesNotMatch(stderr, new RegExp(root));
    assert.doesNotMatch(stderr, /server init|node pair/);
    return true;
  });

  const missing = join(root, "missing-client.json");
  await assert.rejects(
    execute(
      process.execPath,
      ["--experimental-strip-types", cli, "life", "google-client", "check", missing],
      { env: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: root } },
    ),
    (error: unknown) => {
      const stderr = String((error as { stderr?: string }).stderr);
      assert.match(stderr, /Google OAuth client file is unavailable, invalid, or unsafe/);
      assert.doesNotMatch(stderr, new RegExp(root));
      assert.doesNotMatch(stderr, /server init|node pair/);
      return true;
    },
  );
});

test("Google client preflight requires the exact read-only command shape", async () => {
  await assert.rejects(
    execute(process.execPath, [
      "--experimental-strip-types",
      cli,
      "life",
      "google-client",
      "check",
      "relative.json",
    ]),
    (error: unknown) => {
      assert.match(
        String((error as { stderr?: string }).stderr),
        /Use: bun run ellie life google-client check \/absolute\/private\/google-client.json/,
      );
      return true;
    },
  );
});
