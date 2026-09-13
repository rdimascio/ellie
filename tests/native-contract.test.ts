import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  NATIVE_SESSION_CONTRACT,
  VERSION,
  nativePairingQr,
  parseNativePairingQr,
} from "@ellie/protocol";
import { generatedContracts } from "../scripts/generate-contracts.ts";
import { nativePairingFixtures } from "../scripts/native-contract-fixtures.ts";

test("shared native QR fixtures follow the real canonical parser and byte limits", async () => {
  const fixtures = nativePairingFixtures();
  assert.deepEqual(
    JSON.parse(await readFile("contracts/native-pairing-fixtures.v1.json", "utf8")),
    fixtures,
  );
  for (const fixture of fixtures.valid) {
    assert.equal(nativePairingQr(fixture.payload), fixture.qr, fixture.name);
    assert.deepEqual(parseNativePairingQr(fixture.qr), fixture.payload, fixture.name);
    assert.equal(Buffer.byteLength(fixture.qr), fixture.qr.length, "Envelope is ASCII");
    assert.ok(fixture.qr.length <= 2300);
  }
  for (const fixture of fixtures.invalid)
    assert.equal(parseNativePairingQr(fixture.qr), undefined, fixture.name);
  assert.equal(
    fixtures.responses.client.expiresAt - fixtures.responses.client.createdAt,
    NATIVE_SESSION_CONTRACT.sessionLifetimeMs,
  );
  assert.deepEqual(fixtures.responses.pair, fixtures.responses.session);
  assert.equal(NATIVE_SESSION_CONTRACT.version, VERSION);
});

test("native OpenAPI describes the separate runtime routes without controller authority", () => {
  const document = JSON.parse(generatedContracts()["native-openapi.v1.json"]!);
  const routes = NATIVE_SESSION_CONTRACT.routes;
  assert.deepEqual(
    Object.keys(document.paths),
    Object.values(routes).map((route) => route.path),
  );
  assert.deepEqual(document.security, [{ nativeBearer: [] }]);
  assert.deepEqual(Object.keys(document.components.securitySchemes), ["nativeBearer"]);
  assert.equal(document.servers[0].url, "{origin}");
  assert.deepEqual(document.paths[routes.pair.path].post.security, []);
  assert.equal(
    document.paths[routes.pair.path].post.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/NativePairRequest",
  );
  for (const route of Object.values(routes)) {
    const operation = document.paths[route.path][route.method.toLowerCase()];
    assert.equal(operation.operationId, route.operationId);
    assert.equal(operation.parameters[0].schema.const, "1");
    assert.equal(operation["x-ellie-max-json-post-body-bytes"], 4096);
    assert.deepEqual(operation["x-ellie-request-channel"].forbiddenHeaders, [
      "Origin",
      "Cookie",
      "Sec-Fetch-*",
    ]);
    assert.equal(operation.responses[200].headers["Cache-Control"].schema.const, "no-store");
    assert.ok(operation.responses[503], "Storage uncertainty is documented");
  }
  for (const route of [routes.pair, routes.session]) {
    assert.equal(
      document.paths[route.path][route.method.toLowerCase()].responses[200].content[
        "application/json"
      ].schema.$ref,
      "#/components/schemas/NativeSessionResponse",
    );
  }
  assert.deepEqual(document.components.schemas.NativeSessionResponse.required, ["client"]);
  assert.equal(document.components.schemas.NativePairRequest.properties.token.writeOnly, true);
  assert.equal(document.components.schemas.NativeClient.properties.token, undefined);
  assert.equal(document.components.schemas.NativeLogoutRequest.maxProperties, 0);
  const resolveRef = (pointer: string): unknown =>
    pointer
      .slice(2)
      .split("/")
      .reduce(
        (value: any, part: string) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")],
        document,
      );
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === "object")
      for (const [key, entry] of Object.entries(value)) {
        if (key === "$ref" && typeof entry === "string")
          assert.notEqual(resolveRef(entry), undefined, entry);
        else walk(entry);
      }
  };
  walk(document);
  const coordinator = JSON.parse(generatedContracts()["openapi.v1.json"]!);
  for (const name of ["NativeGrant", "NativeClient", "NativePairingPayload"])
    assert.deepEqual(document.components.schemas[name], coordinator.components.schemas[name]);
});
