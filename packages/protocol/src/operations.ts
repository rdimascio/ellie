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
const BROWSER_IDENTIFIER = {
  type: "string",
  minLength: 1,
  maxLength: 100,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$",
} as const;
const BROWSER_REVISION = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._-]{1,128}$",
} as const;
const BROWSER_QUERY = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  format: "ellie-browser-query",
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
    {
      id: "browser.status",
      requiredCapability: "browser.read",
      description: "Report the currently authorized browser page binding.",
      localPolicy: { appFields: [], urlFields: [] },
      input: {
        type: "object",
        additionalProperties: false,
        required: ["tool"],
        properties: { tool: { const: "browser.status" } },
      },
      output: RESULT,
    },
    {
      id: "browser.read",
      requiredCapability: "browser.read",
      description: "Read a bounded reviewed view from the authorized browser page.",
      localPolicy: { appFields: [], urlFields: [] },
      input: {
        type: "object",
        additionalProperties: false,
        required: ["tool", "view", "revision"],
        properties: {
          tool: { const: "browser.read" },
          view: BROWSER_IDENTIFIER,
          revision: BROWSER_REVISION,
        },
      },
      output: RESULT,
    },
    {
      id: "browser.scroll",
      requiredCapability: "browser.control",
      description: "Scroll the authorized browser page in one fixed direction.",
      localPolicy: { appFields: [], urlFields: [] },
      input: {
        type: "object",
        additionalProperties: false,
        required: ["tool", "direction", "revision"],
        properties: {
          tool: { const: "browser.scroll" },
          direction: { type: "string", enum: ["up", "down", "left", "right"] },
          revision: BROWSER_REVISION,
        },
      },
      output: RESULT,
    },
    {
      id: "browser.search",
      requiredCapability: "browser.control",
      description: "Submit a bounded search to the authorized browser page.",
      localPolicy: { appFields: [], urlFields: [] },
      input: {
        type: "object",
        additionalProperties: false,
        required: ["tool", "query", "revision"],
        properties: {
          tool: { const: "browser.search" },
          query: BROWSER_QUERY,
          revision: BROWSER_REVISION,
        },
      },
      output: RESULT,
    },
    {
      id: "browser.select",
      requiredCapability: "browser.control",
      description: "Select one opaque item observed in the current browser revision.",
      localPolicy: { appFields: [], urlFields: [] },
      input: {
        type: "object",
        additionalProperties: false,
        required: ["tool", "itemId", "revision"],
        properties: {
          tool: { const: "browser.select" },
          itemId: BROWSER_IDENTIFIER,
          revision: BROWSER_REVISION,
        },
      },
      output: RESULT,
    },
    {
      id: "browser.playback",
      requiredCapability: "browser.control",
      description: "Dispatch play or pause on the authorized browser page.",
      localPolicy: { appFields: [], urlFields: [] },
      input: {
        type: "object",
        additionalProperties: false,
        required: ["tool", "action", "revision"],
        properties: {
          tool: { const: "browser.playback" },
          action: { type: "string", enum: ["play", "pause"] },
          revision: BROWSER_REVISION,
        },
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

export const BROWSER_CAPABILITIES = ["browser.read", "browser.control"] as const;
export const BROWSER_WEBMCP_CAPABILITIES = BROWSER_CAPABILITIES;
export type BrowserCapability = (typeof BROWSER_CAPABILITIES)[number];
export type BrowserWebMCPCapability = BrowserCapability;
export type BrowserAction = Extract<Action, { tool: `browser.${string}` }>;
export type BrowserWebMCPAction = BrowserAction;

export type BrowserView = {
  title?: string;
  summary?: string;
  items: { id: string; label: string; state?: string }[];
};
export type BrowserWebMCPStructuredResult =
  | {
      source: "webmcp";
      operation: "status";
      status: "connected" | "unbound" | "unsupported" | "unavailable";
      revision?: string;
      origin?: string;
    }
  | {
      source: "webmcp";
      operation: "read";
      status: "completed";
      revision: string;
      view: BrowserView;
    }
  | {
      source: "webmcp";
      operation: "command";
      status: "completed" | "failed" | "unknown" | "cancelled" | "timed_out";
      revision: string;
    };
export type BrowserWebMCPOperationResult = {
  ok: boolean;
  message: string;
  browser: BrowserWebMCPStructuredResult;
};

const browserIdentifier = (value: unknown, maximum = 100): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  )
    throw new Error("Invalid browser operation input.");
  return value;
};
const exactObject = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid browser operation input.");
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error("Invalid browser operation input.");
  return object;
};

export function browserWebMCPAction(value: unknown): BrowserWebMCPAction {
  const checked = action(value);
  if (!checked.tool.startsWith("browser.")) throw new Error("Unsupported browser operation.");
  return checked as BrowserWebMCPAction;
}

const boundedText = (value: unknown, maximum: number): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /\p{C}/u.test(value)
  )
    throw new Error("Invalid browser operation result.");
  return value;
};
export function browserWebMCPOperationResult(value: unknown): BrowserWebMCPOperationResult {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("Invalid browser operation result.");
  }
  if (Buffer.byteLength(encoded) > 16_384) throw new Error("Invalid browser operation result.");
  const body = exactObject(value, ["ok", "message", "browser"]);
  if (typeof body.ok !== "boolean") throw new Error("Invalid browser operation result.");
  const message = boundedText(body.message, RESULT_MESSAGE_MAX_LENGTH);
  const browser = body.browser as Record<string, unknown>;
  if (!browser || typeof browser !== "object" || Array.isArray(browser))
    throw new Error("Invalid browser operation result.");
  if (browser.operation === "status") {
    const connected = browser.status === "connected";
    exactObject(
      browser,
      connected
        ? ["source", "operation", "status", "revision", "origin"]
        : ["source", "operation", "status"],
    );
    if (browser.source !== "webmcp") throw new Error("Invalid browser operation result.");
    if (
      !connected &&
      browser.status !== "unbound" &&
      browser.status !== "unsupported" &&
      browser.status !== "unavailable"
    )
      throw new Error("Invalid browser operation result.");
    if (body.ok !== connected) throw new Error("Invalid browser operation result.");
    const checked: BrowserWebMCPStructuredResult = connected
      ? {
          source: "webmcp",
          operation: "status",
          status: "connected",
          revision: browserIdentifier(browser.revision),
          origin: boundedText(browser.origin, 2048),
        }
      : {
          source: "webmcp",
          operation: "status",
          status: browser.status as "unbound" | "unsupported" | "unavailable",
        };
    return { ok: body.ok, message, browser: checked };
  }
  if (browser.operation === "read") {
    exactObject(browser, ["source", "operation", "status", "revision", "view"]);
    if (browser.source !== "webmcp") throw new Error("Invalid browser operation result.");
    if (browser.status !== "completed") throw new Error("Invalid browser operation result.");
    if (body.ok !== true) throw new Error("Invalid browser operation result.");
    const view = browser.view as Record<string, unknown>;
    if (!view || typeof view !== "object" || Array.isArray(view))
      throw new Error("Invalid browser operation result.");
    const allowed = ["title", "summary", "items"];
    if (
      Object.keys(view).some((key) => !allowed.includes(key)) ||
      !Array.isArray(view.items) ||
      view.items.length > 64
    )
      throw new Error("Invalid browser operation result.");
    const items = view.items.map((raw) => {
      const row = raw as Record<string, unknown>;
      exactObject(row, Object.hasOwn(row, "state") ? ["id", "label", "state"] : ["id", "label"]);
      return {
        id: browserIdentifier(row.id),
        label: boundedText(row.label, 500),
        ...(row.state === undefined ? {} : { state: boundedText(row.state, 100) }),
      };
    });
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error("Invalid browser operation result.");
    return {
      ok: body.ok,
      message,
      browser: {
        source: "webmcp",
        operation: "read",
        status: "completed",
        revision: browserIdentifier(browser.revision),
        view: {
          ...(view.title === undefined ? {} : { title: boundedText(view.title, 500) }),
          ...(view.summary === undefined ? {} : { summary: boundedText(view.summary, 2000) }),
          items,
        },
      },
    };
  }
  exactObject(browser, ["source", "operation", "status", "revision"]);
  if (browser.source !== "webmcp") throw new Error("Invalid browser operation result.");
  if (
    browser.operation !== "command" ||
    !["completed", "failed", "unknown", "cancelled", "timed_out"].includes(browser.status as string)
  )
    throw new Error("Invalid browser operation result.");
  if (body.ok !== (browser.status === "completed"))
    throw new Error("Invalid browser operation result.");
  return {
    ok: body.ok,
    message,
    browser: {
      source: "webmcp",
      operation: "command",
      status: browser.status as "completed" | "failed" | "unknown" | "cancelled" | "timed_out",
      revision: browserIdentifier(browser.revision),
    },
  };
}

export const CAPABILITIES = Object.freeze([
  ...new Set(OPERATION_REGISTRY.operations.map((operation) => operation.requiredCapability)),
]) as readonly Capability[];
export const DESKTOP_CAPABILITIES = Object.freeze([
  "app.open",
  "url.open",
  "window.place",
  "window.adjacent",
]) as readonly Capability[];
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
  if (schema.format === "ellie-browser-query" && (value !== value.trim() || /\p{C}/u.test(value)))
    throw new Error("Invalid operation input.");
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
  if (
    definition.input.additionalProperties === false &&
    (Object.keys(input).length !== definition.input.required.length ||
      Object.keys(input).some((key) => !definition.input.required.includes(key as never)))
  )
    throw new Error("Invalid operation input.");
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
