import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHouseholdManagement } from "../apps/server/src/household-management.ts";
import { handleNativeHousehold } from "../apps/server/src/native-household.ts";
import type { NativeAuth } from "../apps/server/src/native-auth.ts";
import type { HouseholdState } from "../apps/server/src/household-state.ts";

const request = (extra: string[] = []) =>
  ({
    method: "GET",
    rawHeaders: ["Authorization", `Bearer ${"a".repeat(64)}`, "X-Ellie-Version", "1", ...extra],
  }) as IncomingMessage;

test("household management rejects browser and ambiguous authority headers", async () => {
  const path = "/v1/household/authorities";
  assert.equal((await handleHouseholdManagement(request(), path, "controller"))?.status, 503);
  for (const headers of [
    ["Cookie", "session=browser"],
    ["Origin", "https://example.invalid"],
    ["Sec-Fetch-Site", "same-origin"],
    ["Authorization", `Bearer ${"b".repeat(64)}`],
    ["X-Ellie-Version", "1"],
  ]) {
    const result = await handleHouseholdManagement(request(headers), path, "controller");
    assert.deepEqual(result, {
      status: 403,
      body: { error: "Household management request rejected." },
    });
  }
});

test("native household handler classifies malformed document values as fixed 400", async () => {
  for (const widget of [
    { id: "music", type: ["playlist"], title: "Music", size: "small", config: {} },
    { id: "weather", type: "weather", title: "Weather", size: "small", config: { secret: "x" } },
  ]) {
    const body = JSON.stringify({
      value: {
        version: 1,
        dashboards: [{ id: "home", name: "Home", widgets: [widget] }],
      },
    });
    const incoming = Object.assign(Readable.from([body]), {
      method: "PUT",
      rawHeaders: ["If-Match", '"ellie-revision-0"'],
    }) as unknown as IncomingMessage;
    let result: { status: number; body: unknown } | undefined;
    const handled = await handleNativeHousehold(
      incoming,
      {} as ServerResponse,
      "/native/v1/household/shared/dashboards",
      {} as NativeAuth,
      {} as HouseholdState,
      `Bearer ${"a".repeat(64)}`,
      (status, responseBody) => {
        result = { status, body: responseBody };
      },
    );
    assert.equal(handled, true);
    assert.deepEqual(result, { status: 400, body: { error: "Invalid household document." } });
  }
});

test("native household handler distinguishes missing and duplicate conditional revisions", async () => {
  for (const [headers, expected] of [
    [[], 428],
    [["If-Match", '"ellie-revision-0"', "If-Match", '"ellie-revision-0"'], 400],
  ] as const) {
    const incoming = Object.assign(Readable.from([]), {
      method: "PUT",
      rawHeaders: headers.flat(),
    }) as unknown as IncomingMessage;
    let status = 0;
    await handleNativeHousehold(
      incoming,
      {} as ServerResponse,
      "/native/v1/household/shared/dashboards",
      {} as NativeAuth,
      {} as HouseholdState,
      `Bearer ${"a".repeat(64)}`,
      (value) => {
        status = value;
      },
    );
    assert.equal(status, expected);
  }
});
