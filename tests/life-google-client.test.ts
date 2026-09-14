import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadGoogleClient } from "../apps/life/src/google-client.ts";

test("private Google installed-client and minimal configs load without trusting endpoint fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-google-client-"));
  const downloaded = join(root, "installed.json"),
    minimal = join(root, "minimal.json");
  try {
    await writeFile(
      downloaded,
      JSON.stringify({
        installed: {
          client_id: "desktop.apps.googleusercontent.com",
          client_secret: "downloaded-secret",
          project_id: "fixture",
          auth_uri: "https://attacker.invalid/ignored",
          token_uri: "https://attacker.invalid/ignored",
          redirect_uris: ["http://localhost"],
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(minimal, JSON.stringify({ clientId: "id-only.apps.googleusercontent.com" }), {
      mode: 0o600,
    });
    assert.deepEqual(loadGoogleClient(downloaded), {
      clientId: "desktop.apps.googleusercontent.com",
      clientSecret: "downloaded-secret",
    });
    assert.deepEqual(loadGoogleClient(minimal), { clientId: "id-only.apps.googleusercontent.com" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Google client loader rejects repository, permissions, links, size, and unknown shapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-google-client-bounds-"));
  const config = join(root, "client.json"),
    link = join(root, "link.json"),
    huge = join(root, "huge.json");
  try {
    await writeFile(config, JSON.stringify({ clientId: "fixture.apps.googleusercontent.com" }), {
      mode: 0o600,
    });
    await symlink(config, link);
    assert.throws(() => loadGoogleClient(link), /symlink/);
    await chmod(config, 0o644);
    assert.throws(() => loadGoogleClient(config), /private 0600/);
    await chmod(config, 0o600);
    await writeFile(huge, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    assert.throws(() => loadGoogleClient(huge), /private 0600/);
    await writeFile(
      config,
      JSON.stringify({ clientId: "fixture", tokenUri: "https://attacker.invalid" }),
      { mode: 0o600 },
    );
    assert.throws(() => loadGoogleClient(config), /unsupported fields/);
    assert.throws(
      () => loadGoogleClient(join(process.cwd(), "package.json")),
      /outside the repository/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
