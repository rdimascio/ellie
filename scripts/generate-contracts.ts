import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OPERATION_REGISTRY } from "../packages/protocol/src/operations.ts";
import { JOB_OUTCOME_CODES, JOB_STATES } from "../packages/protocol/src/index.ts";

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
        NativeGrant: {
          type: "object",
          additionalProperties: false,
          required: ["target", "capabilities"],
          properties: {
            target: identifier,
            capabilities: {
              type: "array",
              prefixItems: [{ const: "app.open" }],
              minItems: 1,
              maxItems: 1,
            },
          },
        },
        NativeInvitationSpec: {
          type: "object",
          additionalProperties: false,
          required: ["label", "grants"],
          properties: {
            label: boundedString(64),
            grants: { type: "array", minItems: 1, maxItems: 16, items: ref("NativeGrant") },
          },
        },
        NativeClient: {
          type: "object",
          additionalProperties: false,
          required: ["id", "role", "label", "grants", "createdAt", "expiresAt"],
          properties: {
            id: identifier,
            role: { const: "native_phone_controller" },
            label: boundedString(64),
            grants: { type: "array", minItems: 1, maxItems: 16, items: ref("NativeGrant") },
            createdAt: finiteNumber,
            expiresAt: finiteNumber,
          },
        },
        NativePairingPayload: {
          type: "object",
          additionalProperties: false,
          required: [
            "version",
            "origin",
            "certificateSha256",
            "invitation",
            "expiresAt",
            "label",
            "grants",
          ],
          properties: {
            version: { const: 1 },
            origin: { type: "string", format: "uri", pattern: "^https://[^/@]+$" },
            certificateSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            invitation: { type: "string", pattern: "^[a-f0-9]{64}$" },
            expiresAt: finiteNumber,
            label: boundedString(64),
            grants: { type: "array", minItems: 1, maxItems: 16, items: ref("NativeGrant") },
          },
        },
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

function serialized(value: Json): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function generatedContracts(): Record<string, string> {
  return {
    "operation-registry.v1.json": serialized(OPERATION_REGISTRY as unknown as Json),
    "protocol.v1.schema.json": serialized(protocolSchema()),
    "openapi.v1.json": serialized(openApi()),
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
