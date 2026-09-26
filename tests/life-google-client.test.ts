import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
    repositoryAncestor = join(root, "repository"),
    coreStateAncestor = join(root, "core-state"),
    fakeHome = join(root, "home"),
    huge = join(root, "huge.json");
  const previousHome = process.env.HOME;
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
    await symlink(process.cwd(), repositoryAncestor, "dir");
    assert.throws(
      () => loadGoogleClient(join(repositoryAncestor, "package.json")),
      /outside the repository/,
    );
    await mkdir(join(fakeHome, ".ellie"), { recursive: true, mode: 0o700 });
    process.env.HOME = fakeHome;
    assert.throws(
      () => loadGoogleClient(join(homedir(), ".ellie", "synthetic-google-client.json")),
      /outside ~\/\.ellie/,
    );
    await symlink(join(homedir(), ".ellie"), coreStateAncestor, "dir");
    assert.throws(
      () => loadGoogleClient(join(coreStateAncestor, "synthetic-google-client.json")),
      /outside ~\/\.ellie/,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
