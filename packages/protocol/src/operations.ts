const IDENTIFIER = {
  type: "string",
  minLength: 1,
  maxLength: 100,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
} as const;

const HTTPS_URL = {
  type: "string",
  minLength: 1,
  maxLength: 2048,
  format: "ellie-https-url",
  description: "An absolute HTTPS URL without embedded credentials.",
} as const;

const RESULT_MESSAGE_MAX_LENGTH = 4000;
const RESULT_MESSAGE = {
  type: "string",
  minLength: 1,
  maxLength: RESULT_MESSAGE_MAX_LENGTH,
  pattern: "\\S",
} as const;

const RESULT = {
  type: "object",
  additionalProperties: true,
  required: ["ok", "message"],
  properties: {
    ok: { type: "boolean" },
    message: RESULT_MESSAGE,
  },
} as const;

const LAYOUT_VALUES = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "left",
  "right",
  "maximize",
  "fullscreen",
] as const;
const MONITOR_VALUES = ["current", "largest", "primary"] as const;

/**
 * The versioned, executable source of truth for Ellie's bounded desktop operations.
 * The generator serializes this data and translates its small schema subset to JSON
 * Schema. `ellie-https-url` is an Ellie format enforced by the runtime validator.
 */
export const OPERATION_REGISTRY = {
  version: 1,
  schemaDialect: "ellie-operation-schema-1",
  limits: {
    maxActionsPerJob: 4,
    maxRequestBodyBytes: 32768,
    maxResultMessageLength: RESULT_MESSAGE_MAX_LENGTH,
  },
  values: {
    layouts: LAYOUT_VALUES,
    monitors: MONITOR_VALUES,
  },
  errors: {
    request: {
      type: "object",
      additionalProperties: false,
      required: ["error"],
      properties: { error: RESULT_MESSAGE },
    },
    operationFailure: RESULT,
  },
  operations: [
    {
      id: "app.open",
      requiredCapability: "app.open",
      description: "Open an application from the configured local app allowlist.",
      localPolicy: { appFields: ["app"], urlFields: [] },
      input: {
        type: "object",
        additionalProperties: true,
        required: ["tool", "app"],
        properties: { tool: { const: "app.open" }, app: IDENTIFIER },
      },
      output: RESULT,
    },
    {
      id: "url.open",
      requiredCapability: "url.open",
      description: "Open a configured HTTPS site in an allowed application.",
      localPolicy: { appFields: ["app"], urlFields: ["url"] },
      input: {
        type: "object",
        additionalProperties: true,
        required: ["tool", "app", "url"],
        properties: { tool: { const: "url.open" }, app: IDENTIFIER, url: HTTPS_URL },
      },
      output: RESULT,
    },
    {
      id: "window.place",
      requiredCapability: "window.place",
      description: "Place an allowed application window in a fixed layout.",
      localPolicy: { appFields: ["app"], urlFields: [] },
      input: {
        type: "object",
        additionalProperties: true,
        required: ["tool", "app", "layout", "monitor"],
        properties: {
          tool: { const: "window.place" },
          app: IDENTIFIER,
          layout: { type: "string", enum: LAYOUT_VALUES },
          monitor: { type: "string", enum: MONITOR_VALUES },
        },
      },
      output: RESULT,
    },
    {
      id: "window.adjacent",
      requiredCapability: "window.adjacent",
      description: "Place one allowed application window next to another.",
      localPolicy: { appFields: ["app", "anchor"], urlFields: [] },
      input: {
        type: "object",
        additionalProperties: true,
        required: ["tool", "app", "anchor"],
        properties: { tool: { const: "window.adjacent" }, app: IDENTIFIER, anchor: IDENTIFIER },
      },
      output: RESULT,
    },
  ],
} as const;

type Operation = (typeof OPERATION_REGISTRY.operations)[number];
type InferSchema<Schema> = Schema extends { const: infer Constant }
  ? Constant
  : Schema extends { enum: readonly (infer Value)[] }
    ? Value
    : Schema extends { type: "string" }
      ? string
      : Schema extends { type: "boolean" }
        ? boolean
        : never;
type InferObject<Schema> = Schema extends { properties: infer Properties }
  ? { [Key in keyof Properties]: InferSchema<Properties[Key]> }
  : never;
type InferOperation<Definition> = Definition extends { input: infer Input }
  ? InferObject<Input>
  : never;

export type Action = InferOperation<Operation>;
export type OperationId = Operation["id"];
export type Capability = Operation["requiredCapability"];
export type Layout = (typeof LAYOUT_VALUES)[number];
export type Monitor = (typeof MONITOR_VALUES)[number];
export type OperationResult = InferObject<typeof RESULT>;

export const CAPABILITIES = Object.freeze(
  OPERATION_REGISTRY.operations.map((operation) => operation.requiredCapability),
) as readonly Capability[];
export const LAYOUTS = OPERATION_REGISTRY.values.layouts;
export const MONITORS = OPERATION_REGISTRY.values.monitors;

const operationsById = new Map<OperationId, Operation>(
  OPERATION_REGISTRY.operations.map((operation) => [operation.id, operation]),
);

export function operationDefinition(id: OperationId): Operation {
  return operationsById.get(id)!;
}

function validateField(schema: Record<string, unknown>, value: unknown): unknown {
  if ("const" in schema) {
    if (value !== schema.const) throw new Error("Invalid operation discriminator.");
    return value;
  }
  if (schema.type !== "string" || typeof value !== "string")
    throw new Error("Invalid operation input.");
  const minLength = Number(schema.minLength ?? 0);
  const maxLength = Number(schema.maxLength ?? Number.MAX_SAFE_INTEGER);
  if (value.length < minLength || value.length > maxLength || !value.trim())
    throw new Error("Invalid operation input.");
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))
    throw new Error("Invalid operation input.");
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    throw new Error("Invalid operation input.");
  if (schema.format === "ellie-https-url") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Only HTTPS links without credentials are supported.");
    }
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Only HTTPS links without credentials are supported.");
    return url.href;
  }
  return value;
}

/** Validate one operation using the registry's deliberately small schema subset. */
export function action(value: unknown): Action {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object.");
  const input = value as Record<string, unknown>;
  const definition =
    typeof input.tool === "string" ? operationsById.get(input.tool as OperationId) : undefined;
  if (!definition) throw new Error("Unsupported tool.");
  const schemas = definition.input.properties as Record<string, Record<string, unknown>>;
  const validated: Record<string, unknown> = {};
  for (const required of definition.input.required) {
    if (!Object.hasOwn(input, required)) throw new Error("Invalid operation input.");
    validated[required] = validateField(schemas[required]!, input[required]);
  }
  return validated as Action;
}

export function actions(value: unknown): Action[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > OPERATION_REGISTRY.limits.maxActionsPerJob
  )
    throw new Error("Invalid actions.");
  return value.map(action);
}
