import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import {
  openAuthorizationUrl,
  type AuthorizationBrowserOptions,
} from "../apps/life/src/authorization-browser.ts";

function authorization(): URL {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: "synthetic-desktop-client",
    redirect_uri: "http://127.0.0.1:7440/api/connections/callback",
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    state: "s".repeat(43),
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return url;
}

function launcher(exit: "success" | "failure" | "error" | "hang" = "success") {
  const requests: Array<{ command: string; args: readonly string[]; options: unknown }> = [],
    child = new EventEmitter();
  let killed = false;
  const process = Object.assign(child, {
    kill: () => {
      killed = true;
      return true;
    },
  }) as unknown as ChildProcess;
  const spawn: AuthorizationBrowserOptions["spawn"] = (command, args, options) => {
    requests.push({ command, args, options });
    queueMicrotask(() => {
      if (exit === "success") child.emit("exit", 0);
      else if (exit === "failure") child.emit("exit", 1);
      else if (exit === "error") child.emit("error", new Error("Synthetic opener failure"));
    });
    return process;
  };
  return {
    requests,
    spawn,
    get killed() {
      return killed;
    },
  };
}

test("Google consent opens through an absolute OS helper without a shell", async () => {
  const fake = launcher(),
    url = authorization().href;
  assert.equal(await openAuthorizationUrl(url, { platform: "darwin", spawn: fake.spawn }), true);
  assert.deepEqual(fake.requests, [
    { command: "/usr/bin/open", args: [url], options: { shell: false, stdio: "ignore" } },
  ]);
  assert.equal(fake.killed, false);
});

test("unsupported platforms and opener failures return manual-browser fallback", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const fake = launcher();
    assert.equal(
      await openAuthorizationUrl(authorization().href, { platform, spawn: fake.spawn }),
      false,
    );
    assert.equal(fake.requests.length, 0);
  }
  for (const status of ["failure", "error"] as const) {
    const fake = launcher(status);
    assert.equal(
      await openAuthorizationUrl(authorization().href, { platform: "darwin", spawn: fake.spawn }),
      false,
    );
  }
  assert.equal(
    await openAuthorizationUrl(authorization().href, {
      platform: "darwin",
      spawn() {
        throw new Error("Synthetic launch failure");
      },
    }),
    false,
  );
  const hanging = launcher("hang");
  assert.equal(
    await openAuthorizationUrl(authorization().href, {
      platform: "darwin",
      spawn: hanging.spawn,
      timeoutMs: 5,
    }),
    false,
  );
  assert.equal(hanging.killed, true);
});

test("only the exact Google read-only PKCE flow can reach the OS opener", async () => {
  const invalid = [
    "file:///etc/passwd",
    "https://example.com",
    "https://accounts.google.com.evil.example/o/oauth2/v2/auth",
    "-a Calculator",
    "$(touch /tmp/unwanted)",
  ];
  for (const mutate of [
    (url: URL) => {
      url.protocol = "http:";
    },
    (url: URL) => {
      url.username = "user";
    },
    (url: URL) => {
      url.hash = "fragment";
    },
    (url: URL) => {
      url.port = "8443";
    },
    (url: URL) => {
      url.pathname = "/other";
    },
    (url: URL) => {
      url.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.modify");
    },
    (url: URL) => {
      url.searchParams.set("redirect_uri", "http://example.com/callback");
    },
    (url: URL) => {
      url.searchParams.set("redirect_uri", "http://127.0.0.1:7440/other");
    },
    (url: URL) => {
      url.searchParams.set("code_challenge_method", "plain");
    },
    (url: URL) => {
      url.searchParams.append("state", "different");
    },
    (url: URL) => {
      url.searchParams.set("module", "https://example.com/payload.js");
    },
  ]) {
    const url = authorization();
    mutate(url);
    invalid.push(url.href);
  }
  const fake = launcher();
  for (const url of invalid)
    assert.equal(await openAuthorizationUrl(url, { platform: "darwin", spawn: fake.spawn }), false);
  assert.equal(fake.requests.length, 0);
});
