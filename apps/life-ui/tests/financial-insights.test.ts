import assert from "node:assert/strict";
import { test } from "node:test";
import { financialInsights } from "../src/financial-insights.ts";
import type { ConnectorConnection } from "../src/api.ts";
import type { LifeRecord } from "../src/types.ts";

const now = Date.parse("2026-09-16T22:41:00Z");
const connection: ConnectorConnection = {
  id: "bank",
  provider: "plaid",
  label: "Personal account",
  state: "connected",
  mode: "observe",
};
const insight: LifeRecord = {
  id: "pattern",
  kind: "memory",
  title: "A recurring pattern",
  scope: { type: "user", id: "person" },
  revision: 1,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
  data: {
    type: "connected-insight-v1",
    connected: { connectionId: "bank", expiresAt: now + 60_000 },
  },
};
const select = (records: LifeRecord[], connections = [connection]) =>
  financialInsights(records, connections, "person", now);

test("financial insights require a current personal Plaid connection", () => {
  assert.deepEqual(select([insight]), [insight]);
  assert.deepEqual(select([insight], []), []);
  for (const state of ["connecting", "paused", "error", "revoked"] as const)
    assert.deepEqual(select([insight], [{ ...connection, state }]), []);
  assert.deepEqual(select([insight], [{ ...connection, provider: "gmail" }]), []);
  assert.deepEqual(select([insight], [{ ...connection, id: "another-bank" }]), []);
  assert.deepEqual(select([{ ...insight, scope: { type: "group", id: "person" } }]), []);
  assert.deepEqual(select([{ ...insight, scope: { type: "user", id: "someone-else" } }]), []);
});

test("expired, malformed, ordinary, or invalidated memories are not financial insights", () => {
  for (const expiresAt of [now, now - 1, undefined, "tomorrow", Infinity, NaN]) {
    assert.deepEqual(
      select([
        { ...insight, data: { ...insight.data, connected: { connectionId: "bank", expiresAt } } },
      ]),
      [],
    );
  }
  for (const connected of [null, [], "bank", {}])
    assert.deepEqual(select([{ ...insight, data: { ...insight.data, connected } }]), []);
  assert.deepEqual(select([{ ...insight, data: {} }]), []);
  assert.deepEqual(select([{ ...insight, kind: "source" }]), []);
  assert.deepEqual(select([{ ...insight, provenanceStatus: "needs-review" }]), []);
  assert.deepEqual(
    select([{ ...insight, provenance: [{ sourceId: "source", invalidatedAt: 0 }] }]),
    [],
  );
});
