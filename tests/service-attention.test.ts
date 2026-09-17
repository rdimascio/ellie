import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeychainFailure } from "@ellie/config";
import {
  holdForServiceAttention,
  serviceCredentialState,
  settleStartupCleanup,
  startupCredential,
} from "../apps/cli/src/service-attention.ts";
import { ServiceLog } from "../apps/cli/src/service-logs.ts";

test("only an exact typed startup credential failure is marked, without retry", async () => {
  let calls = 0;
  const marked: KeychainFailure[] = [];
  const failure = new KeychainFailure("timeout");
  await assert.rejects(
    startupCredential(
      async () => {
        calls += 1;
        throw failure;
      },
      (error) => marked.push(error),
    ),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
  assert.deepEqual(marked, [failure]);
  await assert.rejects(
    startupCredential(
      async () => {
        calls += 1;
        throw new Error("synthetic private account");
      },
      (error) => marked.push(error),
    ),
  );
  assert.equal(calls, 2);
  assert.deepEqual(marked, [failure]);
});

test("pre-listener cleanup preserves a credential failure and attempts all owned releases", async () => {
  const releases: string[] = [];
  const uncertain = await settleStartupCleanup([
    () => {
      releases.push("browser");
      throw new Error("synthetic private path");
    },
    () => {
      releases.push("job store");
    },
  ]);
  assert.equal(uncertain, true);
  assert.deepEqual(releases, ["browser", "job store"]);
});

test("the held service never settles on its own and releases its timer on explicit cancellation", async () => {
  const controller = new AbortController();
  let settled = false;
  const held = holdForServiceAttention(controller.signal).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  controller.abort();
  await held;
  assert.equal(settled, true);
});

test("only the latest startup sequence can report credential attention", async () => {
  const state = await mkdtemp(join(tmpdir(), "ellie-service-attention-"));
  try {
    assert.equal(await serviceCredentialState(state, "node"), "unknown");
    const rotated = await ServiceLog.open(state, "node");
    rotated.write("connected");
    assert.equal(await serviceCredentialState(state, "node"), "none");
    const failed = await ServiceLog.open(state, "node");
    failed.write("starting");
    assert.equal(await serviceCredentialState(state, "node"), "starting");
    failed.write("keychain_timeout");
    assert.equal(await serviceCredentialState(state, "node"), "needs_attention");
    failed.write("needs_attention");
    assert.equal(await serviceCredentialState(state, "node"), "needs_attention");
    const restarted = await ServiceLog.open(state, "node");
    restarted.write("starting");
    assert.equal(await serviceCredentialState(state, "node"), "starting");
    restarted.write("connected");
    assert.equal(await serviceCredentialState(state, "node"), "none");
    const generic = await ServiceLog.open(state, "node");
    generic.write("starting");
    generic.write("failed");
    assert.equal(await serviceCredentialState(state, "node"), "none");
    const cleanup = await ServiceLog.open(state, "node");
    cleanup.write("starting");
    cleanup.write("service_cleanup_uncertain");
    assert.equal(await serviceCredentialState(state, "node"), "needs_attention");
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
