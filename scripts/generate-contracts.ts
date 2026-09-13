import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OPERATION_REGISTRY } from "../packages/protocol/src/operations.ts";
import { JOB_OUTCOME_CODES, JOB_STATES } from "../packages/protocol/src/index.ts";

import {
  NATIVE_SESSION_CONTRACT,
  nativeSessionSchemas,
} from "../packages/protocol/src/native-session-contract.ts";
import { nativePairingFixtures } from "./native-contract-fixtures.ts";
import {
  NATIVE_CONTROL_CONTRACT,
  nativeControlSchemas,
} from "../packages/protocol/src/native-controls.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const root = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = join(root, "contracts");

function jsonSchema(value: unknown): Json {
  if (Array.isArray(value)) return value.map(jsonSchema);
  if (!value || typeof value !== "object") return value as Json;
  const source = value as Record<string, unknown>;
  const output: Record<string, Json> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === "format" && item === "ellie-https-url") {
      output.format = "uri";
      output.pattern = "^https://[^/@]+(?:[/?#]|$)";
      output["x-ellie-https-no-credentials"] = true;
    } else output[key] = jsonSchema(item);
  }
  return output;
}

function openApiRefs(value: Json): Json {
  if (Array.isArray(value)) return value.map(openApiRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "$ref" && typeof item === "string" && item.startsWith("#/$defs/")
        ? item.replace("#/$defs/", "#/components/schemas/")
        : openApiRefs(item),
    ]),
  );
}

const identifier = {
  type: "string",
  minLength: 1,
  maxLength: 100,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
};
const finiteNumber = { type: "number" };
const boundedString = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
  pattern: "\\S",
});
const householdRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const exactObject = (required: string[], properties: Record<string, Json>) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const dashboardIdentifier = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^(?![\\s\\S]*[^A-Za-z0-9_-])[A-Za-z0-9]",
};
const dashboardText = (maximum: number) => ({
  type: "string",
  minLength: 1,
  maxLength: maximum,
  "x-ellie-max-utf16-code-units": maximum,
  "x-ellie-no-boundary-foundation-whitespace": true,
});
const householdClientIdentifier = {
  ...identifier,
  pattern: "^(?![\\s\\S]*[^A-Za-z0-9._-])[A-Za-z0-9]",
};
const widgetConfig = (properties: Record<string, Json>) => exactObject([], properties);
const widgetVariant = (type: string, config: Json) =>
  exactObject(["id", "type", "title", "size", "config"], {
    id: householdRef("DashboardIdentifier"),
    type: { const: type },
    title: dashboardText(80),
    size: { enum: ["small", "wide"] },
    config,
  });
const householdSchemas: Record<string, Json> = {
  HouseholdProfile: { enum: ["shared", "private"] },
  HouseholdKind: { enum: ["dashboards", "chores"] },
  HouseholdAccess: { enum: ["read", "write"] },
  HouseholdRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  DashboardIdentifier: dashboardIdentifier,
  HouseholdGrant: exactObject(["clientId", "profile", "kind", "access"], {
    clientId: householdClientIdentifier,
    profile: householdRef("HouseholdProfile"),
    kind: householdRef("HouseholdKind"),
    access: householdRef("HouseholdAccess"),
  }),
  HouseholdAuthorityResponse: exactObject(["grants"], {
    grants: { type: "array", maxItems: 128, items: householdRef("HouseholdGrant") },
  }),
  HouseholdGrantResponse: exactObject(["ok", "grant"], {
    ok: { const: true },
    grant: householdRef("HouseholdGrant"),
  }),
  HouseholdRevokeRequest: exactObject(["clientId", "profile", "kind"], {
    clientId: householdClientIdentifier,
    profile: householdRef("HouseholdProfile"),
    kind: householdRef("HouseholdKind"),
  }),
  HouseholdRevokeResponse: exactObject(["ok", "revoked"], {
    ok: { const: true },
    revoked: { type: "boolean" },
  }),
  DashboardWidget: {
    oneOf: [
      widgetVariant(
        "clock",
        widgetConfig({
          timeZone: {
            type: "string",
            maxLength: 100,
            "x-ellie-time-zone": "IANA or Foundation GMT offset",
          },
        }),
      ),
      widgetVariant(
        "note",
        widgetConfig({
          text: { type: "string", maxLength: 2_000, "x-ellie-max-utf16-code-units": 2_000 },
        }),
      ),
      widgetVariant("weather", widgetConfig({})),
      widgetVariant("calendar", widgetConfig({})),
      widgetVariant("chores", widgetConfig({})),
      widgetVariant(
        "playlist",
        widgetConfig({
          youtubePlaylistID: {
            type: "string",
            minLength: 13,
            maxLength: 80,
            pattern: "^(?![\\s\\S]*[^A-Za-z0-9_-])PL",
          },
        }),
      ),
    ],
  },
  Dashboard: exactObject(["id", "name", "widgets"], {
    id: householdRef("DashboardIdentifier"),
    name: dashboardText(80),
    widgets: { type: "array", maxItems: 24, items: householdRef("DashboardWidget") },
  }),
  DashboardDocument: exactObject(["version", "dashboards"], {
    version: { const: 1 },
    dashboards: { type: "array", maxItems: 12, items: householdRef("Dashboard") },
  }),
  ChoreDay: {
    type: "string",
    format: "date",
    minLength: 10,
    maxLength: 10,
    pattern: "^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}$(?![\\s\\S])",
  },
  ChoreIdentifier: {
    type: "string",
    minLength: 36,
    maxLength: 36,
    pattern: "^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$(?![\\s\\S])",
  },
  Chore: exactObject(["id", "title", "member", "body", "dueDay"], {
    id: householdRef("ChoreIdentifier"),
    title: dashboardText(120),
    member: dashboardText(60),
    body: {
      type: "string",
      maxLength: 500,
      "x-ellie-max-utf16-code-units": 500,
      "x-ellie-no-boundary-foundation-whitespace": true,
    },
    dueDay: householdRef("ChoreDay"),
    completedDay: { oneOf: [householdRef("ChoreDay"), { type: "null" }] },
  }),
  ChoresDocument: exactObject(["version", "householdTimeZone", "chores"], {
    version: { const: 1 },
    householdTimeZone: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      "x-ellie-time-zone": "IANA or Foundation GMT offset",
    },
    chores: { type: "array", maxItems: 500, items: householdRef("Chore") },
  }),
  HouseholdDocument: {
    oneOf: [householdRef("DashboardDocument"), householdRef("ChoresDocument")],
  },
  HouseholdPutRequest: exactObject(["value"], {
    value: householdRef("HouseholdDocument"),
  }),
  HouseholdDocumentResponse: {
    oneOf: [
      exactObject(["profile", "kind", "revision", "value"], {
        profile: householdRef("HouseholdProfile"),
        kind: { const: "dashboards" },
        revision: householdRef("HouseholdRevision"),
        value: householdRef("DashboardDocument"),
      }),
      exactObject(["profile", "kind", "revision", "value"], {
        profile: householdRef("HouseholdProfile"),
        kind: { const: "chores" },
        revision: householdRef("HouseholdRevision"),
        value: householdRef("ChoresDocument"),
      }),
    ],
  },
  HouseholdConflictResponse: exactObject(["profile", "kind", "revision"], {
    profile: householdRef("HouseholdProfile"),
    kind: householdRef("HouseholdKind"),
    revision: householdRef("HouseholdRevision"),
  }),
};
const ok = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { const: true } },
};

function protocolSchema(): Json {
  const actions = OPERATION_REGISTRY.operations.map((operation) => jsonSchema(operation.input));
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://ellie.local/contracts/protocol.v1.schema.json",
    title: "Ellie protocol version 1 desktop job",
    $ref: "#/$defs/Job",
    $defs: {
      Identifier: identifier,
      Capability: {
        type: "string",
        enum: OPERATION_REGISTRY.operations.map((operation) => operation.requiredCapability),
      },
      Layout: { type: "string", enum: [...OPERATION_REGISTRY.values.layouts] },
      Monitor: { type: "string", enum: [...OPERATION_REGISTRY.values.monitors] },
      Action: { oneOf: actions },
      Result: jsonSchema(OPERATION_REGISTRY.operations[0].output),
      ErrorResponse: jsonSchema(OPERATION_REGISTRY.errors.request),
      Job: {
        type: "object",
        additionalProperties: true,
        required: ["version", "id", "expiresAt", "actions"],
        properties: {
          version: { const: OPERATION_REGISTRY.version },
          id: { $ref: "#/$defs/Identifier" },
          expiresAt: finiteNumber,
          actions: {
            type: "array",
            minItems: 1,
            maxItems: OPERATION_REGISTRY.limits.maxActionsPerJob,
            items: { $ref: "#/$defs/Action" },
          },
        },
      },
    },
  };
}

function openApi(): Json {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const response = (description: string, schema: Json) => ({
    description,
    content: { "application/json": { schema } },
  });
  const request = (schema: Json) => ({
    required: true,
    content: { "application/json": { schema } },
  });
  const errorResponses = {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
    "404": { $ref: "#/components/responses/NotFound" },
    "409": { $ref: "#/components/responses/Conflict" },
    "415": { $ref: "#/components/responses/UnsupportedMediaType" },
    "503": { $ref: "#/components/responses/ServiceUnavailable" },
  };
  const errors = (...codes: Array<keyof typeof errorResponses>) =>
    Object.fromEntries(codes.map((code) => [code, errorResponses[code]]));
  const versionHeader = [{ $ref: "#/components/parameters/ProtocolVersion" }];
  const operation = (details: Record<string, Json>) => ({ parameters: versionHeader, ...details });
  const householdManagementChannel = {
    "x-ellie-request-channel": {
      controllerBearerOnly: true,
      forbiddenHeaders: ["Origin", "Cookie", "Sec-Fetch-*"],
      duplicateHeadersRejected: ["Authorization", "X-Ellie-Version"],
    },
  };
  const schemas = openApiRefs(
    (protocolSchema() as { $defs: Record<string, Json> }).$defs as unknown as Json,
  ) as Record<string, Json>;
  return {
    openapi: "3.1.0",
    info: {
      title: "Ellie local coordinator API",
      version: "1.0.0",
      description:
        "Contracts for the routes implemented by the Ellie V1 HTTPS coordinator. Bearer identity roles and local capability/app/site allowlists are runtime authorization checks; this document describes them but cannot enforce them.",
    },
    servers: [
      {
        url: "https://127.0.0.1:7437",
        description:
          "Default loopback coordinator; paired nodes may use the configured trusted-LAN origin.",
      },
    ],
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/pair": {
        post: operation({
          operationId: "pairNode",
          summary: "Pair a node with a single-use invitation",
          security: [],
          requestBody: request(ref("PairRequest")),
          responses: {
            "200": response("Node credential issued.", ref("PairResponse")),
            ...errors("400", "403", "415"),
          },
        }),
      },
      "/v1/invite": {
        post: operation({
          operationId: "createInvitation",
          summary: "Create a pairing invitation",
          description: "Controller bearer identity required.",
          requestBody: request({ type: "object" }),
          responses: {
            "200": response("Single-use invitation created.", ref("Invitation")),
            ...errors("400", "401", "403", "404", "415"),
          },
        }),
      },
      "/v1/revoke": {
        post: operation({
          operationId: "revokeNode",
          summary: "Revoke a node identity",
          description: "Controller bearer identity required.",
          requestBody: request(ref("NodeIdRequest")),
          responses: {
            "200": response("Node revoked.", ref("OkResponse")),
            ...errors("400", "401", "403", "404", "415"),
          },
        }),
      },
      "/v1/browser": {
        get: operation({
          operationId: "getBrowserStatus",
          summary: "Inspect optional browser listener readiness",
          description:
            "Controller bearer identity required. The response contains only fixed status and recovery reason values, plus the canonical origin when ready.",
          responses: {
            "200": response("Browser listener status.", ref("BrowserStatus")),
            ...errors("400", "401", "403"),
          },
        }),
      },
      "/v1/browser/invitations": {
        post: operation({
          operationId: "createBrowserInvitation",
          summary: "Create a fixed-authority browser invitation",
          description:
            "Controller bearer identity required. The response deliberately contains a single-use code; callers must not log it or place it in a URL.",
          requestBody: request(ref("BrowserInvitationSpec")),
          responses: {
            "200": response("Single-use browser invitation created.", ref("BrowserInvitation")),
            ...errors("400", "401", "403", "415", "503"),
          },
        }),
      },
      "/v1/browser/clients": {
        get: operation({
          operationId: "listBrowserClients",
          summary: "List public browser client identities and grants",
          description:
            "Controller bearer identity required. Credential verifiers are never returned.",
          responses: {
            "200": response("Active public browser clients.", {
              type: "array",
              maxItems: 128,
              items: ref("BrowserClient"),
            }),
            ...errors("400", "401", "403", "503"),
          },
        }),
      },
      "/v1/browser/revoke": {
        post: operation({
          operationId: "revokeBrowserClient",
          summary: "Revoke one browser client session",
          description:
            "Controller bearer identity required. Revocation is persisted before success.",
          requestBody: request(ref("BrowserRevokeRequest")),
          responses: {
            "200": response("Browser revocation result.", ref("BrowserRevokeResponse")),
            ...errors("400", "401", "403", "415", "503"),
          },
        }),
      },
      "/v1/native/invitations": {
        post: operation({
          operationId: "createNativeInvitation",
          summary: "Create a scoped native-app invitation",
          description:
            "Controller bearer identity required. The response binds a single-use invitation to the actual native listener origin and leaf certificate pin.",
          requestBody: request(ref("NativeInvitationSpec")),
          responses: {
            "200": response("Native pairing payload created.", ref("NativePairingPayload")),
            ...errors("400", "401", "403", "415", "503"),
          },
        }),
      },
      "/v1/native/clients": {
        get: operation({
          operationId: "listNativeClients",
          summary: "List public native-app identities and grants",
          description:
            "Controller bearer identity required. Credential verifiers are never returned.",
          responses: {
            "200": response("Active public native clients.", {
              type: "array",
              maxItems: 128,
              items: ref("NativeClient"),
            }),
            ...errors("400", "401", "403", "503"),
          },
        }),
      },
      "/v1/native/revoke": {
        post: operation({
          operationId: "revokeNativeClient",
          summary: "Revoke one native-app session",
          description:
            "Controller bearer identity required. Revocation is persisted before success.",
          requestBody: request(ref("BrowserRevokeRequest")),
          responses: {
            "200": response("Native revocation result.", ref("BrowserRevokeResponse")),
            ...errors("400", "401", "403", "415", "503"),
          },
        }),
      },
      "/v1/household/authorities": {
        get: operation({
          ...householdManagementChannel,
          operationId: "listHouseholdAuthorities",
          summary: "List explicit native household-data grants",
          description:
            "Controller bearer identity required. Pairing and app.open grants confer no household-data authority.",
          responses: {
            "200": response("Current bounded grants.", ref("HouseholdAuthorityResponse")),
            ...errors("400", "401", "403", "503"),
          },
        }),
        post: operation({
          ...householdManagementChannel,
          operationId: "grantHouseholdAuthority",
          summary: "Grant one active native client household-data access",
          description: "Controller bearer identity required. The grant is durable before success.",
          requestBody: request(ref("HouseholdGrant")),
          responses: {
            "200": response("Grant durably saved.", ref("HouseholdGrantResponse")),
            ...errors("400", "401", "403", "404", "415", "503"),
          },
        }),
      },
      "/v1/household/authorities/revoke": {
        post: operation({
          ...householdManagementChannel,
          operationId: "revokeHouseholdAuthority",
          summary: "Revoke one native client's household-data grant",
          description: "Controller bearer identity required. Revocation is durable before success.",
          requestBody: request(ref("HouseholdRevokeRequest")),
          responses: {
            "200": response("Revocation durably saved.", ref("HouseholdRevokeResponse")),
            ...errors("400", "401", "403", "415", "503"),
          },
        }),
      },
      "/v1/nodes": {
        get: operation({
          operationId: "listNodes",
          summary: "List visible connected nodes",
          description: "The controller sees all nodes; a node bearer identity sees only itself.",
          responses: {
            "200": response("Visible node state.", { type: "array", items: ref("NodeInfo") }),
            ...errors("400", "401", "403"),
          },
        }),
      },
      "/v1/register": {
        post: operation({
          operationId: "registerNode",
          summary: "Register node capabilities",
          description:
            "Node bearer identity required. `capabilities` is the optional V1 legacy execution field; `executionCapabilities` takes precedence when both are present. Compute capability requires telemetry.",
          requestBody: request(ref("Registration")),
          responses: {
            "200": response("Node registered.", ref("OkResponse")),
            ...errors("400", "401", "403", "404", "415"),
          },
        }),
      },
      "/v1/heartbeat": {
        post: operation({
          operationId: "heartbeatNode",
          summary: "Refresh node liveness and optional compute state",
          description:
            "Node bearer identity required and the node must already be registered. Compute capability requires telemetry.",
          requestBody: request(ref("Heartbeat")),
          responses: {
            "200": response(
              "Heartbeat accepted with cancellation requests.",
              ref("HeartbeatResponse"),
            ),
            ...errors("400", "401", "403", "404", "415"),
          },
        }),
      },
      "/v1/poll": {
        get: operation({
          operationId: "pollNodeJob",
          summary: "Wait for one node job",
          description: "Node bearer identity required and the node must already be registered.",
          responses: {
            "200": response(
              "A desktop job, inference job, or null after the long-poll interval.",
              ref("PollResponse"),
            ),
            ...errors("400", "401", "403", "404", "409", "503"),
          },
        }),
      },
      "/v1/result": {
        post: operation({
          operationId: "reportNodeResult",
          summary: "Report the matching in-flight job result",
          description:
            "Node bearer identity required. The ID must match that node’s delivered job.",
          requestBody: request(ref("ResultRequest")),
          responses: {
            "200": response("Result accepted.", ref("OkResponse")),
            ...errors("400", "401", "403", "404", "409", "415"),
          },
        }),
      },
      "/v1/start": {
        post: operation({
          operationId: "startNodeJob",
          summary: "Commit that a delivered job is starting",
          description:
            "Node bearer identity required. The response prevents execution when cancellation won the delivery/start race.",
          requestBody: request(ref("JobIdRequest")),
          responses: {
            "200": response("Start decision committed.", ref("StartResponse")),
            ...errors("400", "401", "403", "404", "409", "415"),
          },
        }),
      },
      "/v1/inference": {
        post: operation({
          operationId: "runInference",
          summary: "Run bounded inference on one eligible independent worker",
          description:
            "Controller bearer identity required. Worker selection and local admission are semantic runtime checks.",
          requestBody: request(ref("InferenceRequest")),
          responses: {
            "200": response("Inference outcome and selected worker.", ref("InferenceResponse")),
            ...errors("400", "401", "403", "404", "409", "415"),
          },
        }),
      },
      "/v1/commands": {
        post: operation({
          operationId: "submitCommand",
          summary: "Route and deliver a deterministic desktop command",
          description:
            "A controller can target any visible node. A node identity can target only itself. Required operation capability and the coordinator and node app/site allowlists are semantic runtime checks.",
          requestBody: request(ref("CommandRequest")),
          responses: {
            "200": response(
              "Command outcome, including unsupported deterministic input as `ok: false`.",
              ref("Result"),
            ),
            ...errors("400", "401", "403", "404", "409", "415"),
          },
        }),
      },
      "/v1/jobs": {
        get: operation({
          operationId: "listJobs",
          summary: "List recent payload-free job metadata",
          responses: {
            "200": response("Recent visible job metadata.", {
              type: "array",
              maxItems: 100,
              items: ref("JobMetadata"),
            }),
            ...errors("400", "401", "403"),
          },
        }),
      },
      "/v1/jobs/{id}": {
        get: operation({
          operationId: "getJob",
          summary: "Inspect payload-free job metadata",
          parameters: [...versionHeader, { $ref: "#/components/parameters/JobId" }],
          responses: {
            "200": response("Visible job metadata.", ref("JobMetadata")),
            ...errors("400", "401", "403", "404"),
          },
        }),
        post: operation({
          operationId: "cancelJob",
          summary: "Request cancellation of queued or running work",
          description: "Cancellation does not undo native side effects that already started.",
          parameters: [...versionHeader, { $ref: "#/components/parameters/JobId" }],
          requestBody: request({ type: "object" }),
          responses: {
            "200": response("Current job metadata after the request.", ref("JobMetadata")),
            ...errors("400", "401", "403", "404", "415"),
          },
        }),
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "64 lowercase hexadecimal characters",
        },
      },
      parameters: {
        ProtocolVersion: {
          name: "x-ellie-version",
          in: "header",
          required: true,
          description: "Exact wire protocol version.",
          schema: { type: "string", const: String(OPERATION_REGISTRY.version) },
        },
        JobId: { name: "id", in: "path", required: true, schema: identifier },
      },
      responses: Object.fromEntries(
        (
          [
            ["BadRequest", "Request rejected. Check input, pairing, and granted capabilities."],
            ["Unauthorized", "Authentication required. Pair this node first."],
            [
              "Forbidden",
              "Identity role, node ownership, origin, or revocation rejected the request.",
            ],
            ["NotFound", "Endpoint unavailable for this identity."],
            ["Conflict", "Current node or job state rejected the request."],
            ["UnsupportedMediaType", "JSON required."],
            ["ServiceUnavailable", "The coordinator service is temporarily unavailable."],
          ] as const
        ).map(([name, description]) => [name, response(description, ref("ErrorResponse"))]),
      ),
      schemas: {
        ...schemas,
        ...householdSchemas,
        PairRequest: {
          type: "object",
          required: ["code", "id"],
          properties: { code: boundedString(64), id: identifier },
        },
        PairResponse: {
          type: "object",
          required: ["token"],
          properties: { token: { type: "string", pattern: "^[a-f0-9]{64}$" } },
        },
        Invitation: {
          type: "object",
          required: ["code", "expiresAt"],
          properties: {
            code: { type: "string", pattern: "^[a-f0-9]{64}$" },
            expiresAt: finiteNumber,
          },
        },
        BrowserGrant: {
          type: "object",
          additionalProperties: false,
          required: ["target", "capabilities"],
          properties: {
            target: identifier,
            capabilities: {
              type: "array",
              minItems: 1,
              maxItems: OPERATION_REGISTRY.operations.length,
              uniqueItems: true,
              items: ref("Capability"),
            },
          },
        },
        BrowserInvitationSpec: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["role", "label", "grants"],
              properties: {
                role: { const: "phone_controller" },
                label: boundedString(64),
                grants: {
                  type: "array",
                  minItems: 1,
                  maxItems: 16,
                  items: ref("BrowserGrant"),
                },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["role", "label", "grants"],
              properties: {
                role: { const: "tv_viewer" },
                label: boundedString(64),
                grants: { type: "array", maxItems: 0 },
              },
            },
          ],
        },
        BrowserClient: {
          type: "object",
          additionalProperties: false,
          required: ["id", "role", "label", "grants", "createdAt", "expiresAt"],
          properties: {
            id: identifier,
            role: { enum: ["phone_controller", "tv_viewer"] },
            label: boundedString(64),
            grants: { type: "array", maxItems: 16, items: ref("BrowserGrant") },
            createdAt: { type: "number", minimum: 0 },
            expiresAt: { type: "number", minimum: 0 },
          },
        },
        BrowserInvitation: {
          type: "object",
          additionalProperties: false,
          required: ["id", "role", "label", "grants", "createdAt", "expiresAt", "code"],
          properties: {
            id: identifier,
            role: { enum: ["phone_controller", "tv_viewer"] },
            label: boundedString(64),
            grants: { type: "array", maxItems: 16, items: ref("BrowserGrant") },
            createdAt: { type: "number", minimum: 0 },
            expiresAt: { type: "number", minimum: 0 },
            code: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
        BrowserStatus: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["status", "origin"],
              properties: {
                status: { const: "ready" },
                origin: {
                  type: "string",
                  format: "uri",
                  pattern: "^https://[^/@]+$",
                },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["status"],
              properties: { status: { const: "disabled" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["status", "reason"],
              properties: {
                status: { const: "unavailable" },
                reason: {
                  enum: [
                    "identity_unavailable",
                    "assets_unavailable",
                    "auth_unavailable",
                    "listener_unavailable",
                  ],
                },
              },
            },
          ],
        },
        BrowserRevokeRequest: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: identifier },
        },
        BrowserRevokeResponse: {
          type: "object",
          additionalProperties: false,
          required: ["ok", "revoked"],
          properties: { ok: { const: true }, revoked: { type: "boolean" } },
        },
        ...nativeSessionSchemas(),
        NodeIdRequest: { type: "object", required: ["id"], properties: { id: identifier } },
        OkResponse: ok,
        InstalledModel: {
          type: "object",
          required: ["id", "requiredFreeMemoryBytes"],
          properties: {
            id: boundedString(200),
            requiredFreeMemoryBytes: {
              type: "number",
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          },
        },
        ComputeCapabilities: {
          type: "object",
          required: ["kind", "backend", "mode", "models"],
          properties: {
            kind: { const: "inference-worker" },
            backend: { const: "local-openai" },
            mode: { const: "independent" },
            models: { type: "array", maxItems: 32, items: ref("InstalledModel") },
          },
        },
        Power: {
          type: "object",
          required: ["source", "batteryPercent", "lowPowerMode"],
          properties: {
            source: { enum: ["ac", "battery", "unknown"] },
            batteryPercent: { type: ["number", "null"], minimum: 0, maximum: 100 },
            lowPowerMode: { type: ["boolean", "null"] },
          },
        },
        Network: {
          type: "object",
          required: ["roundTripMs", "quality"],
          properties: {
            roundTripMs: { type: ["number", "null"], minimum: 0, maximum: 3600000 },
            quality: { enum: ["good", "poor", "unknown"] },
          },
        },
        Telemetry: {
          type: "object",
          required: [
            "freeMemoryBytes",
            "totalMemoryBytes",
            "activeJobs",
            "load",
            "power",
            "thermal",
            "network",
          ],
          properties: {
            freeMemoryBytes: { type: "number", minimum: 0 },
            totalMemoryBytes: { type: "number", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            activeJobs: { type: "integer", minimum: 0, maximum: 1024 },
            load: { type: "number", minimum: 0, maximum: 10000 },
            power: ref("Power"),
            thermal: { enum: ["nominal", "fair", "serious", "critical", "unknown"] },
            network: ref("Network"),
          },
        },
        Registration: {
          type: "object",
          dependentRequired: { computeCapabilities: ["telemetry"] },
          properties: {
            capabilities: {
              type: "array",
              maxItems: OPERATION_REGISTRY.operations.length,
              items: ref("Capability"),
            },
            executionCapabilities: {
              type: "array",
              maxItems: OPERATION_REGISTRY.operations.length,
              items: ref("Capability"),
            },
            computeCapabilities: ref("ComputeCapabilities"),
            telemetry: ref("Telemetry"),
          },
        },
        Heartbeat: {
          type: "object",
          dependentRequired: { computeCapabilities: ["telemetry"] },
          properties: {
            computeCapabilities: ref("ComputeCapabilities"),
            telemetry: ref("Telemetry"),
          },
        },
        HeartbeatResponse: {
          type: "object",
          required: ["ok", "cancelJobIds"],
          properties: {
            ok: { const: true },
            cancelJobIds: { type: "array", maxItems: 1, items: identifier },
          },
        },
        JobIdRequest: {
          type: "object",
          required: ["id"],
          properties: { id: identifier },
        },
        StartResponse: {
          type: "object",
          required: ["cancel"],
          properties: { cancel: { type: "boolean" } },
        },
        JobMetadata: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "target", "state", "createdAt", "updatedAt", "expiresAt"],
          properties: {
            id: identifier,
            kind: { enum: ["desktop", "inference"] },
            target: identifier,
            state: { enum: [...JOB_STATES] },
            createdAt: finiteNumber,
            updatedAt: finiteNumber,
            expiresAt: finiteNumber,
            outcomeOk: { type: "boolean" },
            outcomeCode: { enum: [...JOB_OUTCOME_CODES] },
          },
        },
        NodeInfo: {
          type: "object",
          required: ["id", "capabilities", "executionCapabilities", "lastSeen"],
          properties: {
            id: identifier,
            capabilities: { type: "array", items: ref("Capability") },
            executionCapabilities: { type: "array", items: ref("Capability") },
            computeCapabilities: ref("ComputeCapabilities"),
            telemetry: ref("Telemetry"),
            telemetryReceivedAt: finiteNumber,
            lastSeen: finiteNumber,
          },
        },
        InferenceRequest: {
          type: "object",
          required: ["model", "prompt"],
          properties: {
            mode: { const: "independent", default: "independent" },
            model: boundedString(200),
            prompt: boundedString(4000),
            maxTokens: { type: "integer", minimum: 1, maximum: 2048, default: 256 },
          },
        },
        InferenceJob: {
          type: "object",
          required: ["version", "kind", "id", "expiresAt", "request"],
          properties: {
            version: { const: OPERATION_REGISTRY.version },
            kind: { const: "inference" },
            id: identifier,
            expiresAt: finiteNumber,
            request: ref("InferenceRequest"),
          },
        },
        PollResponse: {
          type: "object",
          required: ["job"],
          properties: { job: { oneOf: [ref("Job"), ref("InferenceJob"), { type: "null" }] } },
        },
        ResultRequest: {
          type: "object",
          required: ["id", "result"],
          properties: { id: identifier, result: ref("Result") },
        },
        InferenceResponse: {
          type: "object",
          additionalProperties: true,
          required: ["ok", "message", "workerId"],
          properties: {
            ok: { type: "boolean" },
            message: jsonSchema(OPERATION_REGISTRY.operations[0].output.properties.message),
            workerId: identifier,
          },
        },
        CommandRequest: {
          type: "object",
          required: ["nodeId", "text"],
          properties: {
            nodeId: identifier,
            text: boundedString(500),
          },
        },
      },
    },
  };
}

function nativeOpenApi(): Json {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const response = (description: string, schema: Json) => ({
    description,
    content: { "application/json": { schema } },
    headers: { "Cache-Control": { schema: { const: "no-store" } } },
  });
  const documentResponse = (description: string) => {
    const result = response(description, ref("HouseholdDocumentResponse"));
    return {
      ...result,
      headers: {
        ...result.headers,
        ETag: {
          description:
            "Exactly matches the JSON revision; use it for an explicit conditional save.",
          schema: { type: "string", pattern: '^"ellie-revision-(0|[1-9][0-9]*)"$(?![\\s\\S])' },
        },
      },
    };
  };
  const request = (schema: Json) => ({
    required: true,
    content: { "application/json": { schema } },
  });
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 415, 500, 503].map((status) => [
      String(status),
      response(
        status === 401
          ? "Native credential rejected or expired."
          : status === 503 || status === 500
            ? "Authorization persistence or listener unavailable; a mutation outcome may be uncertain."
            : "Request rejected by the native listener.",
        ref("NativeError"),
      ),
    ]),
  );
  const routes = NATIVE_SESSION_CONTRACT.routes;
  const common = {
    parameters: [
      {
        name: "X-Ellie-Version",
        in: "header",
        required: true,
        schema: { type: "string", const: "1" },
      },
    ],
    "x-ellie-max-json-post-body-bytes": NATIVE_SESSION_CONTRACT.requestBodyBytes,
    "x-ellie-request-channel": {
      exactHost: true,
      forbiddenHeaders: ["Origin", "Cookie", "Sec-Fetch-*"],
      duplicateHeadersRejected: ["Host", "Authorization", "X-Ellie-Version"],
      jsonPostRequiresSingleContentType: true,
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Ellie native client API",
      version: "1.0.0",
      description:
        "The optional client HTTPS listener exposes native enrollment, sessions and scoped app controls. Use the exact origin from the explicitly confirmed QR. Verify its leaf SHA-256, hostname and certificate validity. Native bearer credentials never authenticate as coordinator, execution-node or browser credentials. No cookies, Origin or Sec-Fetch-* headers are allowed; Host must match the exact listener authority. JSON POST bodies require a single application/json Content-Type, optionally charset=utf-8. No automatic mutation replay is permitted.",
    },
    servers: [
      {
        url: "{origin}",
        variables: {
          origin: {
            default: "https://coordinator.example:8444",
            description:
              "Reserved example only. Replace with the verified QR origin; never infer the coordinator API port.",
          },
        },
      },
    ],
    security: [{ nativeBearer: [] }],
    paths: {
      [routes.pair.path]: {
        post: {
          ...common,
          operationId: routes.pair.operationId,
          security: [],
          summary: "Exchange a single-use invitation for a native session",
          description:
            "Authorization is forbidden. Generate and safely retain a random candidate token before the single POST. Success means durable pairing committed. An interrupted response is uncertain: use GET session with the candidate to recover, never replay this POST automatically.",
          requestBody: request(ref("NativePairRequest")),
          responses: {
            ...errors,
            "200": response(
              "Pairing durably committed. No credential is returned; the client already holds its candidate.",
              ref("NativeSessionResponse"),
            ),
          },
        },
      },
      [routes.session.path]: {
        get: {
          ...common,
          operationId: routes.session.operationId,
          summary: "Inspect or recover the native credential",
          description:
            "Read-only. Candidate bearer authentication returns the public record after a committed pair, including after a lost pair response. A 401 means the candidate is not currently authorized; this read never consumes an invitation or creates a session.",
          responses: {
            ...errors,
            "200": response("Current native session metadata.", ref("NativeSessionResponse")),
          },
        },
      },
      [routes.logout.path]: {
        post: {
          ...common,
          operationId: routes.logout.operationId,
          summary: "Revoke this native credential",
          description:
            "The empty JSON body is required. Success confirms durable revocation. On interruption retain uncertainty; GET session may resolve whether the credential still authenticates. Local credential removal alone does not confirm server revocation.",
          requestBody: request(ref("NativeLogoutRequest")),
          responses: {
            ...errors,
            "200": response("Native credential durably revoked.", ref("NativeLogoutResponse")),
          },
        },
      },
      "/native/v1/household/authority": {
        get: {
          ...common,
          operationId: "getNativeHouseholdAuthority",
          summary: "List this native client's explicit household data grants",
          responses: {
            ...errors,
            "200": response("Current data grants.", ref("HouseholdAuthorityResponse")),
          },
        },
      },
      "/native/v1/household/{profile}/{kind}": {
        parameters: [
          ...common.parameters,
          { name: "profile", in: "path", required: true, schema: { enum: ["shared", "private"] } },
          { name: "kind", in: "path", required: true, schema: { enum: ["dashboards", "chores"] } },
        ],
        get: {
          operationId: "getNativeHouseholdDocument",
          summary: "Read one explicitly granted household document",
          "x-ellie-request-channel": common["x-ellie-request-channel"],
          responses: {
            ...errors,
            "200": documentResponse("Current document and revision."),
          },
        },
        put: {
          operationId: "putNativeHouseholdDocument",
          summary: "Conditionally replace one explicitly granted household document",
          "x-ellie-request-channel": {
            ...common["x-ellie-request-channel"],
            jsonPutRequiresSingleContentType: true,
          },
          "x-ellie-max-json-body-bytes-by-kind": {
            dashboards: 128 * 1024 + 1024,
            chores: 256 * 1024 + 1024,
          },
          "x-ellie-duplicate-if-match-rejected": true,
          parameters: [
            {
              name: "If-Match",
              in: "header",
              required: true,
              schema: {
                type: "string",
                maxLength: 33,
                pattern: '^"ellie-revision-(0|[1-9][0-9]*)"$',
                "x-ellie-maximum-revision": Number.MAX_SAFE_INTEGER,
              },
            },
          ],
          requestBody: {
            ...request(ref("HouseholdPutRequest")),
            description:
              "The value must match the document kind in the path; accepted values are not normalized.",
          },
          responses: {
            ...errors,
            "200": documentResponse("Document durably replaced."),
            "412": response(
              "Revision conflict without document contents.",
              ref("HouseholdConflictResponse"),
            ),
            "428": response("Conditional revision required.", ref("NativeError")),
          },
        },
      },
      [NATIVE_CONTROL_CONTRACT.routes.nodes.path]: {
        get: {
          ...common,
          operationId: NATIVE_CONTROL_CONTRACT.routes.nodes.operationId,
          summary: "List configured devices allowed by this native credential",
          description:
            "Read-only, bounded to 16 configured targets and 8192 response bytes. Returns only explicitly granted app.open targets, labels, online state and the app.open capability; no household telemetry. Discovery has a five-second deadline.",
          responses: {
            ...errors,
            "200": response("Granted configured devices.", ref("NativeNodesResponse")),
          },
        },
      },
      [NATIVE_CONTROL_CONTRACT.routes.commands.path]: {
        post: {
          ...common,
          operationId: NATIVE_CONTROL_CONTRACT.routes.commands.operationId,
          summary: "Explicitly open an allowed app on a granted device",
          description:
            "Only app.open for Arc, Safari or Messages. Revalidates authority and live inventory before dispatch. Shares per-device reservations with browser commands. No persistence or automatic retry. Command dispatch has a 35-second deadline after bounded discovery. A timeout, disconnect or 502 may follow execution; check the Mac before issuing another action. Cancellation requests upstream cancellation but does not undo a launched app. 409 also means the device is offline, incapable or has an unfinished command.",
          requestBody: request(ref("NativeAppRequest")),
          responses: {
            ...errors,
            "200": response("Known command outcome.", ref("NativeCommandResponse")),
            "502": response(
              "Execution outcome is uncertain; never replay automatically.",
              ref("NativeUnknownResponse"),
            ),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        nativeBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "64 lowercase hexadecimal characters",
          description:
            "The separate native candidate/session token. Never a controller token, node token, browser cookie or invitation.",
        },
      },
      schemas: { ...nativeSessionSchemas(), ...nativeControlSchemas(), ...householdSchemas },
    },
  } as Json;
}

function serialized(value: Json): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function generatedContracts(): Record<string, string> {
  return {
    "operation-registry.v1.json": serialized(OPERATION_REGISTRY as unknown as Json),
    "protocol.v1.schema.json": serialized(protocolSchema()),
    "openapi.v1.json": serialized(openApi()),
    "native-openapi.v1.json": serialized(nativeOpenApi()),
    "native-pairing-fixtures.v1.json": serialized(nativePairingFixtures() as Json),
  };
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const generated = generatedContracts();
  if (!check) await mkdir(outputDirectory, { recursive: true });
  const drift: string[] = [];
  for (const [name, content] of Object.entries(generated)) {
    const path = join(outputDirectory, name);
    if (check) {
      const existing = await readFile(path, "utf8").catch(() => "");
      if (existing !== content) drift.push(name);
    } else await writeFile(path, content);
  }
  if (drift.length)
    throw new Error(
      `Generated contracts are stale: ${drift.join(", ")}. Run node scripts/generate-contracts.ts.`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
