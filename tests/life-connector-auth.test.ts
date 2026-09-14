import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_READONLY_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleLoopbackOAuth,
  GoogleOAuthError,
} from "../packages/life-connectors/src/oauth.ts";
import { HostCredentialVault } from "../packages/life-connectors/src/vault.ts";

test("host vault encrypts credentials, persists atomically, and enforces private paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-vault-test-")),
    directory = join(root, "vault"),
    secret = "refresh-token-that-must-not-be-plaintext";
  try {
    let vault = new HostCredentialVault(directory);
    vault.put("connection:one", { accessToken: "access", refreshToken: secret, expiresAt: 123 });
    assert.deepEqual(vault.get("connection:one"), {
      accessToken: "access",
      refreshToken: secret,
      expiresAt: 123,
    });
    const keyPath = join(directory, "credential-vault.key"),
      dataPath = join(directory, "credential-vault.json");
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(keyPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(dataPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(dataPath, "utf8"), new RegExp(secret));
    vault.close();
    assert.throws(() => vault.get("connection:one"), /closed/);
    vault = new HostCredentialVault(directory);
    assert.equal(vault.get<{ refreshToken: string }>("connection:one")?.refreshToken, secret);
    assert.equal(vault.delete("connection:one"), true);
    assert.equal(vault.get("connection:one"), undefined);
    vault.put("connection:two", { token: "two" });
    vault.put("oauth-state:alice", { actorId: "alice", verifier: "private-a" });
    vault.put("oauth-state:bob", { actorId: "bob", verifier: "private-b" });
    vault.put("link:alice", { actorId: "alice", provider: "gmail" });
    assert.equal(
      vault.deleteMatching((_id, value) => (value as { actorId?: string }).actorId === "alice"),
      2,
    );
    assert.equal(vault.get("oauth-state:alice"), undefined);
    assert.equal(vault.get("link:alice"), undefined);
    assert.ok(vault.get("oauth-state:bob"));
    assert.throws(() =>
      vault.deleteMatching(() => {
        throw new Error("predicate failed");
      }),
    );
    assert.ok(vault.get("oauth-state:bob"));
    vault.clear();
    assert.equal(vault.get("connection:two"), undefined);
    vault.close();

    const unsafe = join(root, "unsafe");
    await symlink(directory, unsafe);
    assert.throws(() => new HostCredentialVault(unsafe), /ownership checks|symbolic link/);
    await chmod(directory, 0o755);
    assert.throws(() => new HostCredentialVault(directory), /ownership checks/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Google loopback PKCE state is exact, one-use, and consumed before exchange", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-oauth-test-"));
  let now = 1_000;
  const vault = new HostCredentialVault(join(root, "vault")),
    requests: Array<{ url: string; body: URLSearchParams }> = [],
    fetcher: typeof fetch = async (url, init) => {
      assert.equal(init?.redirect, "error");
      requests.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
      return Response.json({
        access_token: "access-one",
        refresh_token: "refresh-one",
        expires_in: 3600,
        scope: GOOGLE_READONLY_SCOPES["google-calendar"],
        token_type: "Bearer",
      });
    },
    oauth = new GoogleLoopbackOAuth({
      vault,
      fetcher,
      clientId: "registered-client.apps.googleusercontent.com",
      now: () => now,
    }),
    redirectUri = "http://127.0.0.1:43123/oauth/callback",
    begun = oauth.begin({ actorId: "alice", provider: "google-calendar", redirectUri }),
    authorization = new URL(begun.authorizationUrl);
  try {
    assert.equal(authorization.origin + authorization.pathname, GOOGLE_AUTHORIZATION_ENDPOINT);
    assert.equal(
      authorization.searchParams.get("scope"),
      GOOGLE_READONLY_SCOPES["google-calendar"],
    );
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("access_type"), "offline");
    assert.equal(authorization.searchParams.get("state"), begun.state);
    assert.equal(authorization.searchParams.get("redirect_uri"), redirectUri);
    assert.ok((authorization.searchParams.get("code_challenge")?.length ?? 0) >= 43);

    const completed = await oauth.complete({
      state: begun.state,
      code: "one-use-code",
      redirectUri,
    });
    assert.equal(completed.actorId, "alice");
    assert.equal(completed.provider, "google-calendar");
    assert.equal(completed.credential.refreshToken, "refresh-one");
    assert.equal(completed.credential.expiresAt, now + 3_600_000);
    assert.deepEqual(completed.grantedScopes, [GOOGLE_READONLY_SCOPES["google-calendar"]]);
    assert.equal(requests[0]?.url, GOOGLE_TOKEN_ENDPOINT);
    assert.equal(requests[0]?.body.get("grant_type"), "authorization_code");
    assert.equal(requests[0]?.body.get("redirect_uri"), redirectUri);
    assert.ok((requests[0]?.body.get("code_verifier")?.length ?? 0) >= 43);
    await assert.rejects(
      oauth.complete({ state: begun.state, code: "replay", redirectUri }),
      (error: unknown) => error instanceof GoogleOAuthError && error.code === "invalid_state",
    );
    assert.equal(requests.length, 1);

    const wrongRedirect = oauth.begin({ actorId: "alice", provider: "gmail", redirectUri });
    await assert.rejects(
      oauth.complete({
        state: wrongRedirect.state,
        code: "wrong-redirect",
        redirectUri: "http://127.0.0.1:43124/oauth/callback",
      }),
      (error: unknown) => error instanceof GoogleOAuthError && error.code === "invalid_state",
    );
    await assert.rejects(
      oauth.complete({ state: wrongRedirect.state, code: "replay", redirectUri }),
      (error: unknown) => error instanceof GoogleOAuthError && error.code === "invalid_state",
    );
    assert.equal(requests.length, 1);

    const expiring = oauth.begin({ actorId: "alice", provider: "gmail", redirectUri });
    now += 10 * 60_000;
    await assert.rejects(
      oauth.complete({ state: expiring.state, code: "expired", redirectUri }),
      (error: unknown) => error instanceof GoogleOAuthError && error.code === "expired_state",
    );
    assert.equal(requests.length, 1);
    assert.throws(
      () =>
        oauth.begin({
          actorId: "alice",
          provider: "gmail",
          redirectUri: "https://example.com/callback",
        }),
      /loopback/,
    );
  } finally {
    vault.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("token exchange deadlines bound hanging fetches and response streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-oauth-deadline-")),
    redirectUri = "http://127.0.0.1:43125/oauth/callback";
  try {
    for (const fetcher of [
      (() => new Promise<Response>(() => {})) as typeof fetch,
      (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"access_token":"partial"'));
            },
          }),
        )) as typeof fetch,
    ]) {
      const vault = new HostCredentialVault(join(root, `vault-${crypto.randomUUID()}`)),
        oauth = new GoogleLoopbackOAuth({
          vault,
          fetcher,
          clientId: "registered-client.apps.googleusercontent.com",
          timeoutMs: 10,
        }),
        begun = oauth.begin({ actorId: "alice", provider: "gmail", redirectUri });
      await assert.rejects(
        oauth.complete({ state: begun.state, code: "bounded", redirectUri }),
        (error: unknown) => error instanceof GoogleOAuthError && error.code === "timeout",
      );
      await assert.rejects(
        oauth.complete({ state: begun.state, code: "replay", redirectUri }),
        (error: unknown) => error instanceof GoogleOAuthError && error.code === "invalid_state",
      );
      vault.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh preserves or rotates refresh tokens and never exposes provider response bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-oauth-refresh-"));
  let now = 20_000;
  const responses = [
      Response.json({ access_token: "access-two", expires_in: 1200 }),
      Response.json({
        access_token: "access-three",
        refresh_token: "refresh-three",
        expires_in: 1800,
      }),
      Response.json(
        { error: "invalid_grant", error_description: "secret provider detail" },
        { status: 400 },
      ),
    ],
    vault = new HostCredentialVault(join(root, "vault")),
    oauth = new GoogleLoopbackOAuth({
      vault,
      clientId: "registered-client.apps.googleusercontent.com",
      now: () => now,
      fetcher: async () => responses.shift()!,
    }),
    original = {
      accessToken: "access-one",
      refreshToken: "refresh-one",
      expiresAt: 0,
      clientId: "registered-client.apps.googleusercontent.com",
      grantedScopes: [GOOGLE_READONLY_SCOPES.gmail],
    };
  try {
    vault.put("connection:gmail", original);
    const preserved = await oauth.refreshCredential(original);
    assert.equal(preserved.refreshToken, "refresh-one");
    assert.equal(
      vault.get<{ accessToken: string }>("connection:gmail")?.accessToken,
      "access-one",
      "standalone refresh does not write without the broker's authorization CAS",
    );
    now += 1_000;
    const rotated = await oauth.refreshCredential(preserved);
    assert.equal(rotated.refreshToken, "refresh-three");
    await assert.rejects(
      oauth.refreshCredential(rotated),
      (error: unknown) =>
        error instanceof GoogleOAuthError &&
        error.code === "provider_error" &&
        !error.message.includes("secret provider detail") &&
        !error.message.includes("invalid_grant"),
    );
  } finally {
    vault.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh binds host client configuration and rejects scope loss or escalation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-oauth-scopes-"));
  let calls = 0;
  const vault = new HostCredentialVault(join(root, "vault")),
    oauth = new GoogleLoopbackOAuth({
      vault,
      clientId: "host-client.apps.googleusercontent.com",
      clientSecret: "host-secret",
      fetcher: async (_url, init) => {
        calls++;
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("client_id"), "host-client.apps.googleusercontent.com");
        assert.equal(body.get("client_secret"), "host-secret");
        return Response.json({
          access_token: "new-access",
          expires_in: 3600,
          scope:
            calls === 1
              ? "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly"
              : calls === 2
                ? "https://www.googleapis.com/auth/calendar.readonly"
                : "https://www.googleapis.com/auth/gmail.readonly",
        });
      },
    }),
    credential = {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 0,
      clientId: "host-client.apps.googleusercontent.com",
      clientSecret: "injected-secret-must-not-be-used",
      grantedScopes: [GOOGLE_READONLY_SCOPES.gmail],
    };
  try {
    await assert.rejects(
      oauth.refreshCredential({ ...credential, clientId: "other-client" }),
      (error: unknown) => error instanceof GoogleOAuthError && error.code === "invalid_input",
    );
    assert.equal(calls, 0);
    await assert.rejects(
      oauth.refreshCredential(credential),
      (error: unknown) => error instanceof GoogleOAuthError && error.code === "invalid_response",
    );
    assert.equal(calls, 1);
    await assert.rejects(
      oauth.refreshCredential(credential),
      (error: unknown) => error instanceof GoogleOAuthError && error.code === "invalid_response",
    );
    assert.equal(calls, 2);
    const exact = await oauth.refreshCredential(credential);
    assert.deepEqual(exact.grantedScopes, [GOOGLE_READONLY_SCOPES.gmail]);
  } finally {
    vault.close();
    await rm(root, { recursive: true, force: true });
  }
});
