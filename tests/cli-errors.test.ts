import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { Client } from "@ellie/transport";
import { generateCertificate } from "../apps/cli/src/certificate.ts";
import { cliErrorMessage, coordinatorResult } from "../apps/cli/src/errors.ts";

function systemError(code: string, detail: string): Error {
  return Object.assign(new Error(detail), { code });
}

test("connection refusal, unreachable networks, and DNS failures use fixed redacted guidance", () => {
  for (const code of ["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"]) {
    const message = cliErrorMessage(systemError(code, "private-host.local 192.168.1.20 /Users/me"));
    assert.match(message, /Could not reach the Ellie coordinator/);
    assert.doesNotMatch(message, /private-host|192\.168|\/Users/);
  }
});

test("an interrupted outstanding command reports unknown outcome before retry guidance", () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT"]) {
    const message = cliErrorMessage(systemError(code, "socket failed at 192.168.1.20"), true);
    assert.match(message, /command was outstanding/);
    assert.match(message, /outcome may be unknown/);
    assert.match(message, /ellie jobs/);
    assert.match(message, /before explicitly retrying/);
    assert.doesNotMatch(message, /192\.168/);
  }
});

test("an interrupted read-only request does not claim a job has an unknown outcome", () => {
  const message = cliErrorMessage(systemError("EPIPE", "write EPIPE to private-host"));
  assert.match(message, /connection was interrupted/);
  assert.doesNotMatch(message, /outcome may be unknown|ellie jobs|private-host/);
});

test("configuration and local resource errors preserve fixed existing guidance", () => {
  assert.match(cliErrorMessage(systemError("ENOENT", "/Users/me/.ellie/server.json")), /missing/);
  assert.match(
    cliErrorMessage(systemError("ELLIE_INVALID_CONFIG", "secret input")),
    /invalid JSON/,
  );
  assert.match(cliErrorMessage(new SyntaxError("secret input")), /invalid JSON/);
  assert.match(
    cliErrorMessage(systemError("EACCES", "/Users/me/.ellie/private")),
    /local resource/,
  );
});

test("nested connection errors are classified without exposing aggregate details", () => {
  const error = new AggregateError(
    [systemError("ECONNREFUSED", "192.168.1.20"), systemError("ECONNREFUSED", "host.local")],
    "All connection attempts failed for private hosts",
  );
  const message = cliErrorMessage(error);
  assert.match(message, /Could not reach the Ellie coordinator/);
  assert.doesNotMatch(message, /192\.168|host\.local|private hosts/);
});

test("actual Client deadlines distinguish read-only and outstanding requests", async () => {
  const { key, cert } = await generateCertificate();
  const server = createServer({ key, cert }, () => {
    // Keep the request open until the client's absolute deadline aborts it.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new Client(`https://127.0.0.1:${(server.address() as AddressInfo).port}`, cert);
  try {
    for (const commandOutcomeMayBeUnknown of [false, true]) {
      await assert.rejects(
        client.call(
          commandOutcomeMayBeUnknown ? "POST" : "GET",
          "/wait",
          commandOutcomeMayBeUnknown ? {} : undefined,
          { timeoutMs: 30 },
        ),
        (error) => {
          const message = cliErrorMessage(error, commandOutcomeMayBeUnknown);
          if (commandOutcomeMayBeUnknown) {
            assert.match(message, /outcome may be unknown/);
            assert.match(message, /ellie jobs/);
          } else {
            assert.match(message, /did not respond before the request deadline/);
            assert.doesNotMatch(message, /outcome may be unknown|ellie jobs/);
          }
          return true;
        },
      );
    }
  } finally {
    client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("malformed coordinator responses never look like invalid private configuration", async () => {
  const { key, cert } = await generateCertificate();
  const server = createServer({ key, cert }, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new Client(`https://127.0.0.1:${(server.address() as AddressInfo).port}`, cert);
  try {
    for (const commandOutcomeMayBeUnknown of [false, true]) {
      await assert.rejects(client.call("GET", "/invalid"), (error) => {
        const message = cliErrorMessage(error, commandOutcomeMayBeUnknown);
        assert.match(message, /invalid or incomplete response/);
        assert.doesNotMatch(message, /configuration|private JSON/);
        if (commandOutcomeMayBeUnknown) assert.match(message, /outcome may be unknown/);
        else assert.doesNotMatch(message, /outcome may be unknown/);
        return true;
      });
    }
    assert.throws(
      () => coordinatorResult({ ok: true }),
      (error) => {
        const message = cliErrorMessage(error, true);
        assert.match(message, /invalid or incomplete response/);
        assert.match(message, /outcome may be unknown/);
        return true;
      },
    );
  } finally {
    client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
