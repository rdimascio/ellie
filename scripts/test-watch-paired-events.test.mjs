import assert from "node:assert/strict";
import { test } from "node:test";
import { requireReadUnknownEvents } from "./watch-paired-events.mjs";

const target = "watch-fixture-mac-a";
const row = (operation, selectedTarget = target) =>
  JSON.stringify({ operation, target: selectedTarget });

test("paired read unknown requires one refresh, one read, and zero mutations", () => {
  assert.deepEqual(requireReadUnknownEvents(`${row("refresh")}\n${row("read")}\n`, target), {
    refresh: 1,
    read: 1,
    play: 0,
    pause: 0,
  });

  for (const value of [
    `${row("refresh")}\n${row("read")}\n${row("play")}\n`,
    `${row("refresh")}\n${row("read")}\n${row("read")}\n`,
    `${row("read")}\n`,
    `${row("refresh")}\n${row("read", "watch-fixture-mac-b")}\n`,
    `${JSON.stringify({ operation: "read", target, extra: true })}\n`,
    "not-json\n",
  ]) {
    assert.throws(() => requireReadUnknownEvents(value, target));
  }
});
