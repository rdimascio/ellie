import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  householdDocument,
  householdGrant,
  householdKind,
  type HouseholdKind,
} from "@ellie/protocol";

interface HouseholdFixtures {
  version: number;
  valid: Array<{ kind: HouseholdKind; value?: unknown; rawValue?: string }>;
  invalid: Array<{ kind: HouseholdKind; value?: unknown; rawValue?: string }>;
}

const fixtureValue = (fixture: { value?: unknown; rawValue?: string }) =>
  fixture.rawValue === undefined ? fixture.value : JSON.parse(fixture.rawValue);

test("shared household fixtures match the protocol validator", async () => {
  const fixtures = JSON.parse(
    await readFile("contracts/household-schema-fixtures.v1.json", "utf8"),
  ) as HouseholdFixtures;
  assert.equal(fixtures.version, 1);
  for (const fixture of fixtures.valid)
    assert.deepEqual(
      householdDocument(householdKind(fixture.kind), fixtureValue(fixture)),
      fixtureValue(fixture),
    );
  for (const fixture of fixtures.invalid)
    assert.throws(() => householdDocument(householdKind(fixture.kind), fixtureValue(fixture)));
});

test("generated household contracts expose exact bounded wire schemas", async () => {
  const controller = JSON.parse(await readFile("contracts/openapi.v1.json", "utf8"));
  const native = JSON.parse(await readFile("contracts/native-openapi.v1.json", "utf8"));
  assert.equal(
    controller.paths["/v1/household/authorities"].get.responses[200].content["application/json"]
      .schema.$ref,
    "#/components/schemas/HouseholdAuthorityResponse",
  );
  assert.deepEqual(
    controller.paths["/v1/household/authorities"].get["x-ellie-request-channel"].forbiddenHeaders,
    ["Origin", "Cookie", "Sec-Fetch-*"],
  );
  assert.equal(
    controller.components.schemas.HouseholdAuthorityResponse.properties.grants.maxItems,
    128,
  );
  assert.equal(controller.components.schemas.DashboardIdentifier.maxLength, 64);
  assert.equal(controller.components.schemas.DashboardWidget.oneOf.length, 6);
  assert.equal(controller.components.schemas.Chore.required.includes("completedDay"), false);
  const route = native.paths["/native/v1/household/{profile}/{kind}"];
  assert.equal(
    route.get.responses[200].content["application/json"].schema.$ref,
    "#/components/schemas/HouseholdDocumentResponse",
  );
  assert.equal(
    route.put.responses[412].content["application/json"].schema.$ref,
    "#/components/schemas/HouseholdConflictResponse",
  );
  assert.deepEqual(route.put["x-ellie-max-json-body-bytes-by-kind"], {
    dashboards: 128 * 1024 + 1024,
    chores: 256 * 1024 + 1024,
  });
  assert.equal(route.put["x-ellie-duplicate-if-match-rejected"], true);
  assert.equal(native.components.schemas.HouseholdRevision.maximum, Number.MAX_SAFE_INTEGER);
});

test("household validators reject unknown shapes, terminal controls, invalid calendar days and time zones", () => {
  assert.deepEqual(
    householdGrant({
      clientId: `client.with.periods.${"x".repeat(80)}`,
      profile: "shared",
      kind: "dashboards",
      access: "read",
    }).profile,
    "shared",
  );
  assert.throws(() =>
    householdGrant({ clientId: "client\n", profile: "shared", kind: "dashboards", access: "read" }),
  );
  assert.throws(() =>
    householdGrant({
      clientId: "client",
      profile: "shared",
      kind: "dashboards",
      access: "read",
      extra: true,
    }),
  );
  const chores = (dueDay: string, householdTimeZone = "UTC") => ({
    version: 1,
    householdTimeZone,
    chores: [
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        title: "One",
        member: "A",
        body: "line one\nline two",
        dueDay,
        completedDay: null,
      },
    ],
  });
  assert.deepEqual(householdDocument("chores", chores("2030-02-28")), chores("2030-02-28"));
  assert.throws(() => householdDocument("chores", chores("2030-02-30")));
  assert.throws(() => householdDocument("chores", chores("2030-02-28", "Not/AZone")));
  assert.throws(() => householdDocument("chores", { ...chores("2030-02-28"), extra: true }));
});
