export const BROWSER_WEBMCP_PROTOCOL = "ellie.browser-webmcp.v1" as const;

export const BROWSER_WEBMCP_LIMITS = Object.freeze({
  maximumMessageBytes: 32_768,
  maximumIdentifierLength: 100,
  maximumUrlLength: 2_048,
  maximumTools: 16,
  maximumNameLength: 100,
  maximumDescriptionLength: 300,
  maximumSchemaBytes: 8_192,
  maximumArgumentsBytes: 8_192,
  maximumResultBytes: 16_384,
  maximumJsonDepth: 8,
  maximumJsonEntries: 256,
  bindingLifetimeMs: 15 * 60_000,
  discoveryDeadlineMs: 2_000,
  executionDeadlineMs: 15_000,
} as const);

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const requestTypes = [
  "binding.status",
  "binding.refresh",
  "page.inspect",
  "media.execute",
  "tools.list",
  "tool.execute",
  "cancel",
] as const;
export const BROWSER_WEBMCP_STATUSES = [
  "ok",
  "unbound",
  "unsupported_origin",
  "page_changed",
  "stale_tool",
  "invalid_arguments",
  "busy",
  "cancelled",
  "timed_out",
  "unknown",
  "unavailable",
] as const;

export type BrowserWebMCPStatus = (typeof BROWSER_WEBMCP_STATUSES)[number];
export type BrowserCompanionCommand =
  | { type: "inspect"; actionId: string }
  | { type: "scrollViewport"; actionId: string; direction: "up" | "down" }
  | {
      type: "scrollRow";
      actionId: string;
      snapshotId: string;
      candidateId: string;
      direction: "left" | "right";
    }
  | { type: "open"; actionId: string; snapshotId: string; candidateId: string }
  | { type: "play" | "pause"; actionId: string };
export type BrowserWebMCPRequest =
  | { protocol: typeof BROWSER_WEBMCP_PROTOCOL; id: string; type: "binding.status" }
  | { protocol: typeof BROWSER_WEBMCP_PROTOCOL; id: string; type: "binding.refresh" }
  | {
      protocol: typeof BROWSER_WEBMCP_PROTOCOL;
      id: string;
      type: "page.inspect";
      bindingId: string;
      documentId: string;
    }
  | {
      protocol: typeof BROWSER_WEBMCP_PROTOCOL;
      id: string;
      type: "media.execute";
      bindingId: string;
      documentId: string;
      command: BrowserCompanionCommand;
    }
  | { protocol: typeof BROWSER_WEBMCP_PROTOCOL; id: string; type: "tools.list" }
  | {
      protocol: typeof BROWSER_WEBMCP_PROTOCOL;
      id: string;
      type: "tool.execute";
      bindingId: string;
      documentId: string;
      toolHandle: string;
      args: Record<string, unknown>;
    }
  | {
      protocol: typeof BROWSER_WEBMCP_PROTOCOL;
      id: string;
      type: "cancel";
      targetId: string;
    };

export type BrowserWebMCPResult = {
  protocol: typeof BROWSER_WEBMCP_PROTOCOL;
  id: string;
  type: "result";
  status: BrowserWebMCPStatus;
  value?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid message.");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error("Invalid message.");
}

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > BROWSER_WEBMCP_LIMITS.maximumIdentifierLength ||
    !identifierPattern.test(value)
  )
    throw new Error("Invalid message.");
  return value;
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function companionCommand(value: unknown): BrowserCompanionCommand {
  const body = record(value);
  const actionId = identifier(body.actionId);
  if (!uuidPattern.test(actionId)) throw new Error("Invalid message.");
  if (body.type === "inspect" || body.type === "play" || body.type === "pause") {
    exactKeys(body, ["type", "actionId"]);
    return { type: body.type, actionId };
  }
  if (body.type === "scrollViewport") {
    exactKeys(body, ["type", "actionId", "direction"]);
    if (body.direction !== "up" && body.direction !== "down") throw new Error("Invalid message.");
    return { type: "scrollViewport", actionId, direction: body.direction };
  }
  if (body.type === "open" || body.type === "scrollRow") {
    exactKeys(
      body,
      body.type === "open"
        ? ["type", "actionId", "snapshotId", "candidateId"]
        : ["type", "actionId", "snapshotId", "candidateId", "direction"],
    );
    const snapshotId = identifier(body.snapshotId);
    const candidateId = identifier(body.candidateId);
    if (!uuidPattern.test(snapshotId) || !uuidPattern.test(candidateId))
      throw new Error("Invalid message.");
    if (body.type === "open") return { type: "open", actionId, snapshotId, candidateId };
    if (body.direction !== "left" && body.direction !== "right")
      throw new Error("Invalid message.");
    return { type: "scrollRow", actionId, snapshotId, candidateId, direction: body.direction };
  }
  throw new Error("Invalid message.");
}

function boundedJson(value: unknown, maximumBytes: number, requireObject = false): unknown {
  if (requireObject && (!value || typeof value !== "object" || Array.isArray(value)))
    throw new Error("Invalid message.");
  let entries = 0;
  const active = new Set<object>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > BROWSER_WEBMCP_LIMITS.maximumJsonDepth) throw new Error("Invalid message.");
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Invalid message.");
      return;
    }
    if (typeof current !== "object") throw new Error("Invalid message.");
    if (active.has(current)) throw new Error("Invalid message.");
    active.add(current);
    const values = Array.isArray(current)
      ? current
      : Object.entries(current as Record<string, unknown>).map(([key, item]) => {
          if (!key || key.length > BROWSER_WEBMCP_LIMITS.maximumNameLength)
            throw new Error("Invalid message.");
          return item;
        });
    entries += values.length;
    if (entries > BROWSER_WEBMCP_LIMITS.maximumJsonEntries) throw new Error("Invalid message.");
    for (const item of values) visit(item, depth + 1);
    active.delete(current);
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > maximumBytes)
    throw new Error("Invalid message.");
  return value;
}

export function browserWebMCPRequest(value: unknown): BrowserWebMCPRequest {
  boundedJson(value, BROWSER_WEBMCP_LIMITS.maximumMessageBytes, true);
  const body = record(value);
  if (
    body.protocol !== BROWSER_WEBMCP_PROTOCOL ||
    !requestTypes.includes(body.type as (typeof requestTypes)[number])
  )
    throw new Error("Invalid message.");
  const base = { protocol: BROWSER_WEBMCP_PROTOCOL, id: identifier(body.id) };
  if (
    body.type === "binding.status" ||
    body.type === "binding.refresh" ||
    body.type === "tools.list"
  ) {
    exactKeys(body, ["protocol", "id", "type"]);
    return { ...base, type: body.type };
  }
  if (body.type === "cancel") {
    exactKeys(body, ["protocol", "id", "type", "targetId"]);
    return { ...base, type: "cancel", targetId: identifier(body.targetId) };
  }
  if (body.type === "page.inspect") {
    exactKeys(body, ["protocol", "id", "type", "bindingId", "documentId"]);
    return {
      ...base,
      type: "page.inspect",
      bindingId: identifier(body.bindingId),
      documentId: identifier(body.documentId),
    };
  }
  if (body.type === "media.execute") {
    exactKeys(body, ["protocol", "id", "type", "bindingId", "documentId", "command"]);
    return {
      ...base,
      type: "media.execute",
      bindingId: identifier(body.bindingId),
      documentId: identifier(body.documentId),
      command: companionCommand(body.command),
    };
  }
  exactKeys(body, ["protocol", "id", "type", "bindingId", "documentId", "toolHandle", "args"]);
  return {
    ...base,
    type: "tool.execute",
    bindingId: identifier(body.bindingId),
    documentId: identifier(body.documentId),
    toolHandle: identifier(body.toolHandle),
    args: boundedJson(body.args, BROWSER_WEBMCP_LIMITS.maximumArgumentsBytes, true) as Record<
      string,
      unknown
    >,
  };
}

export function browserWebMCPResult(value: unknown): BrowserWebMCPResult {
  boundedJson(value, BROWSER_WEBMCP_LIMITS.maximumMessageBytes, true);
  const body = record(value);
  const hasValue = Object.hasOwn(body, "value");
  exactKeys(
    body,
    hasValue ? ["protocol", "id", "type", "status", "value"] : ["protocol", "id", "type", "status"],
  );
  if (
    body.protocol !== BROWSER_WEBMCP_PROTOCOL ||
    body.type !== "result" ||
    !BROWSER_WEBMCP_STATUSES.includes(body.status as BrowserWebMCPStatus) ||
    (body.status === "ok") !== hasValue
  )
    throw new Error("Invalid message.");
  if (hasValue) boundedJson(body.value, BROWSER_WEBMCP_LIMITS.maximumResultBytes);
  return {
    protocol: BROWSER_WEBMCP_PROTOCOL,
    id: identifier(body.id),
    type: "result",
    status: body.status as BrowserWebMCPStatus,
    ...(hasValue ? { value: body.value } : {}),
  };
}

export function browserWebMCPResultFor(
  id: string,
  status: BrowserWebMCPStatus,
  value?: unknown,
): BrowserWebMCPResult {
  return browserWebMCPResult({
    protocol: BROWSER_WEBMCP_PROTOCOL,
    id,
    type: "result",
    status,
    ...(status === "ok" ? { value } : {}),
  });
}
