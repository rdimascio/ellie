import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { action, actions } from "@ellie/protocol";
import {
  CAPABILITIES,
  LAYOUTS,
  MONITORS,
  OPERATION_REGISTRY,
  job,
  operationDefinition,
  result,
} from "@ellie/protocol";
import { authorize } from "@ellie/permissions";
import { defaults } from "@ellie/config";
import { string } from "@ellie/protocol";
import { generatedContracts } from "../scripts/generate-contracts.ts";

const run = promisify(execFile);

test("OpenAPI describes shutdown and matches runtime rejection of blank strings", () => {
  const api = JSON.parse(generatedContracts()["openapi.v1.json"]!) as {
    paths: Record<string, Record<string, { responses: Record<string, { $ref?: string }> }>>;
    components: { schemas: Record<string, { properties: Record<string, { pattern: string }> }> };
  };
  assert.equal(
    api.paths["/v1/poll"]!.get!.responses["503"]!.$ref,
    "#/components/responses/ServiceUnavailable",
  );
  for (const [name, field] of [
    ["PairRequest", "code"],
    ["InstalledModel", "id"],
    ["InferenceRequest", "model"],
    ["InferenceRequest", "prompt"],
    ["CommandRequest", "text"],
    ["Result", "message"],
    ["InferenceResponse", "message"],
  ] as const) {
    const pattern = new RegExp(api.components.schemas[name]!.properties[field]!.pattern);
    for (const blank of ["", " ", "\t\r\n", "\u00a0"]) {
      assert.equal(pattern.test(blank), false, `${name}.${field} rejects blank input`);
      assert.throws(() => string(blank));
    }
    assert.equal(pattern.test(" hello "), true);
    assert.doesNotThrow(() => string(" hello "));
  }
});

test("the registry derives operation types, capabilities, enums, validation, and local policy", () => {
  assert.deepEqual(
    CAPABILITIES,
    OPERATION_REGISTRY.operations.map((operation) => operation.id),
  );
  assert.equal(LAYOUTS, OPERATION_REGISTRY.values.layouts);
  assert.equal(MONITORS, OPERATION_REGISTRY.values.monitors);

  const open = action({ tool: "app.open", app: defaults.browser, ignoredByV1: true });
  assert.deepEqual(open, { tool: "app.open", app: defaults.browser });
  assert.equal(operationDefinition(open.tool).requiredCapability, "app.open");
  assert.throws(() => authorize([open], [], defaults), /has not granted app\.open/);
  assert.doesNotThrow(() => authorize([open], ["app.open"], defaults));

  const inherited = Object.assign(Object.create({ app: defaults.browser }), { tool: "app.open" });
  assert.throws(() => action(inherited), /Invalid operation input/);
});

test("registry bounds reject malformed, unknown, and oversized desktop jobs", () => {
  assert.throws(() => action({ tool: "unknown", app: defaults.browser }), /Unsupported tool/);
  assert.throws(
    () => action({ tool: "app.open", app: `a${"b".repeat(100)}` }),
    /Invalid operation input/,
  );
  assert.throws(
    () =>
      action({
        tool: "url.open",
        app: defaults.browser,
        url: `https://example.com/${"x".repeat(2048)}`,
      }),
    /Invalid operation input/,
  );
  assert.throws(() =>
    actions(
      Array.from({ length: OPERATION_REGISTRY.limits.maxActionsPerJob + 1 }, () => ({
        tool: "app.open",
        app: defaults.browser,
      })),
    ),
  );
  assert.throws(
    () =>
      job({
        version: 1,
        id: "job",
        expiresAt: 1,
        actions: [{ tool: "shell.exec", command: "whoami" }],
      }),
    /Unsupported tool/,
  );
  assert.throws(() =>
    result({
      ok: false,
      message: "x".repeat(OPERATION_REGISTRY.limits.maxResultMessageLength + 1),
    }),
  );
});

test("generated JSON Schema and OpenAPI stay aligned with the registry and actual routes", async () => {
  await run(process.execPath, ["scripts/generate-contracts.ts", "--check"]);
  const schema = JSON.parse(await readFile("contracts/protocol.v1.schema.json", "utf8")) as {
    $defs: {
      Capability: { enum: string[] };
      Job: { properties: { actions: { maxItems: number } } };
    };
  };
  const openapi = JSON.parse(await readFile("contracts/openapi.v1.json", "utf8")) as {
    paths: Record<
      string,
      Record<string, { operationId: string; responses: Record<string, { $ref?: string }> }>
    >;
    components: {
      schemas: {
        Registration: { dependentRequired: { computeCapabilities: string[] } };
        Action: { oneOf: Array<{ properties: { url?: Record<string, unknown> } }> };
        InferenceResponse: { required: string[]; properties: Record<string, unknown> };
      };
    };
  };
  assert.deepEqual(schema.$defs.Capability.enum, CAPABILITIES);
  assert.equal(
    schema.$defs.Job.properties.actions.maxItems,
    OPERATION_REGISTRY.limits.maxActionsPerJob,
  );
  assert.deepEqual(Object.keys(openapi.paths), [
    "/v1/pair",
    "/v1/invite",
    "/v1/revoke",
    "/v1/browser",
    "/v1/browser/invitations",
    "/v1/browser/clients",
    "/v1/browser/revoke",
    "/v1/native/invitations",
    "/v1/native/clients",
    "/v1/native/revoke",
    "/v1/household/authorities",
    "/v1/household/authorities/revoke",
    "/v1/speech/authorities",
    "/v1/speech/authorities/revoke",
    "/v1/nodes",
    "/v1/register",
    "/v1/heartbeat",
    "/v1/poll",
    "/v1/result",
    "/v1/start",
    "/v1/inference",
    "/v1/commands",
    "/v1/jobs",
    "/v1/jobs/{id}",
  ]);
  const ids = Object.values(openapi.paths).flatMap((path) =>
    Object.values(path).map((operation) => operation.operationId),
  );
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    openapi.components.schemas.Registration.dependentRequired.computeCapabilities[0],
    "telemetry",
  );
  assert.equal(
    openapi.components.schemas.Action.oneOf[1]!.properties.url?.["x-ellie-https-no-credentials"],
    true,
  );
  assert.deepEqual(openapi.components.schemas.InferenceResponse.required, [
    "ok",
    "message",
    "workerId",
  ]);
  assert.ok(openapi.components.schemas.InferenceResponse.properties.workerId);
  assert.equal(
    openapi.paths["/v1/commands"]?.post?.responses["404"]?.$ref,
    "#/components/responses/NotFound",
  );
  assert.equal(
    openapi.paths["/v1/browser/invitations"]?.post?.responses["503"]?.$ref,
    "#/components/responses/ServiceUnavailable",
  );
  assert.equal(
    openapi.paths["/v1/browser/revoke"]?.post?.responses["403"]?.$ref,
    "#/components/responses/Forbidden",
  );

  const document = openapi as unknown as Record<string, unknown>;
  const resolve = (pointer: string): unknown =>
    pointer
      .slice(2)
      .split("/")
      .reduce<unknown>((value, part) => {
        assert.ok(value && typeof value === "object");
        return (value as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")];
      }, document);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string" && item.startsWith("#/"))
        assert.notEqual(resolve(item), undefined, item);
      else visit(item);
    }
  };
  visit(document);
});
