import test from "node:test";
import assert from "node:assert/strict";
import { cliErrorMessage } from "../apps/cli/src/errors.ts";

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
