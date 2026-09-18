import { createHash, randomUUID } from "node:crypto";
import {
  BROWSER_WEBMCP_PROTOCOL,
  browserWebMCPAction,
  browserWebMCPRequest,
  browserWebMCPResult,
  browserWebMCPOperationResult,
  type BrowserWebMCPAction,
  type BrowserWebMCPRequest,
  type BrowserWebMCPResult,
  type BrowserWebMCPOperationResult,
} from "@ellie/protocol";
import type {
  ReviewedBrowserBinding,
  ReviewedBrowserRegistry,
} from "./browser-operation-registry.ts";

type Bridge = {
  request(
    request: Exclude<BrowserWebMCPRequest, { type: "cancel" }>,
    signal: AbortSignal,
  ): Promise<BrowserWebMCPResult>;
};
type Binding = { bindingId: string; documentId: string; origin: string; expiresAt: number };
type Tool = { handle: string; name: string; inputSchema: unknown };
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new Error();
  return result;
};
const id = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value))
    throw new Error();
  return value;
};
const revision = (binding: Binding): string =>
  createHash("sha256")
    .update(binding.bindingId)
    .update("\0")
    .update(binding.documentId)
    .digest("hex");
const canonical = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error();
  return `{${Object.keys(value as object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};

export class BrowserWebMCPOperations {
  private readonly observed = new Map<string, Set<string>>();
  private currentRevision?: string;
  private readonly bridge: Bridge;
  private readonly registry: ReviewedBrowserRegistry;
  constructor(bridge: Bridge, registry: ReviewedBrowserRegistry) {
    this.bridge = bridge;
    this.registry = registry;
  }

  private async call(
    request: Exclude<BrowserWebMCPRequest, { type: "cancel" }>,
    signal: AbortSignal,
  ): Promise<BrowserWebMCPResult> {
    const checked = browserWebMCPRequest(request);
    if (checked.type === "cancel") throw new Error();
    return browserWebMCPResult(await this.bridge.request(checked, signal));
  }
  private async binding(signal: AbortSignal): Promise<Binding | "unbound" | "unsupported"> {
    const response = await this.call(
      { protocol: BROWSER_WEBMCP_PROTOCOL, id: randomUUID(), type: "binding.status" },
      signal,
    );
    if (response.status === "unbound" || response.status === "unsupported_origin") {
      this.observed.clear();
      this.currentRevision = undefined;
      return response.status === "unbound" ? "unbound" : "unsupported";
    }
    if (response.status !== "ok") throw new Error();
    const value = exact(response.value, ["bindingId", "documentId", "origin", "url", "expiresAt"]);
    if (typeof value.origin !== "string" || typeof value.url !== "string") throw new Error();
    const origin = new URL(value.origin);
    const url = new URL(value.url);
    if (origin.origin !== value.origin || origin.pathname !== "/" || origin.protocol !== "https:")
      throw new Error();
    if (url.origin !== origin.origin || url.username || url.password) throw new Error();
    if (!Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= Date.now())
      throw new Error();
    const checked = {
      bindingId: id(value.bindingId),
      documentId: id(value.documentId),
      origin: origin.origin,
      expiresAt: Number(value.expiresAt),
    };
    const nextRevision = revision(checked);
    if (this.currentRevision !== nextRevision) {
      this.observed.clear();
      this.currentRevision = nextRevision;
    }
    return checked;
  }
  private reviewed(
    origin: string,
    operation: ReviewedBrowserBinding["operation"],
    key: string,
  ): ReviewedBrowserBinding {
    const found = this.registry.bindings.filter(
      (item) => item.origin === origin && item.operation === operation && item.id === key,
    );
    if (found.length !== 1) throw new Error();
    return found[0]!;
  }
  private async tool(
    binding: Binding,
    reviewed: ReviewedBrowserBinding,
    signal: AbortSignal,
  ): Promise<Tool> {
    const response = await this.call(
      { protocol: BROWSER_WEBMCP_PROTOCOL, id: randomUUID(), type: "tools.list" },
      signal,
    );
    if (response.status !== "ok") throw new Error();
    const value = exact(response.value, ["bindingId", "documentId", "tools"]);
    if (
      id(value.bindingId) !== binding.bindingId ||
      id(value.documentId) !== binding.documentId ||
      !Array.isArray(value.tools) ||
      value.tools.length > 16
    )
      throw new Error();
    const matches = value.tools
      .map((raw) => {
        const row = raw as Record<string, unknown>;
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error();
        exact(row, ["handle", "name", "description", "inputSchema", "annotations"]);
        if (
          typeof row.name !== "string" ||
          row.name.length < 1 ||
          row.name.length > 100 ||
          /\p{C}/u.test(row.name)
        )
          throw new Error();
        if (
          typeof row.description !== "string" ||
          row.description.length > 300 ||
          /\p{C}/u.test(row.description)
        )
          throw new Error();
        const annotations = exact(row.annotations, [
          "readOnlyHint",
          "untrustedContentHint",
          "consequentialHint",
        ]);
        if (Object.values(annotations).some((value) => typeof value !== "boolean"))
          throw new Error();
        return { handle: id(row.handle), name: row.name, inputSchema: row.inputSchema };
      })
      .filter(
        (item) =>
          item.name === reviewed.toolName &&
          createHash("sha256").update(canonical(item.inputSchema)).digest("hex") ===
            reviewed.inputSchemaSha256,
      );
    if (matches.length !== 1) throw new Error();
    return matches[0]!;
  }
  async execute(raw: unknown, signal: AbortSignal): Promise<BrowserWebMCPOperationResult> {
    const action = browserWebMCPAction(raw);
    let binding: Binding | "unbound" | "unsupported";
    try {
      binding = await this.binding(signal);
    } catch {
      if (action.tool === "browser.status") {
        return browserWebMCPOperationResult({
          ok: false,
          message: "Browser connection is unavailable.",
          browser: { source: "webmcp", operation: "status", status: "unavailable" },
        });
      }
      throw new Error("Browser connection is unavailable.");
    }
    if (action.tool === "browser.status")
      return browserWebMCPOperationResult({
        ok: typeof binding === "object",
        message:
          typeof binding === "object"
            ? "Browser tab connected."
            : binding === "unsupported"
              ? "The connected page does not offer reviewed WebMCP tools."
              : "No reviewed browser tab is connected.",
        browser:
          typeof binding === "object"
            ? {
                source: "webmcp",
                operation: "status",
                status: "connected",
                revision: revision(binding),
                origin: binding.origin,
              }
            : { source: "webmcp", operation: "status", status: binding },
      });
    if (typeof binding !== "object" || revision(binding) !== action.revision)
      throw new Error("Browser page changed before the requested action.");
    const operation = action.tool.slice("browser.".length) as ReviewedBrowserBinding["operation"];
    const key = action.tool === "browser.read" ? action.view : operation;
    const reviewed = this.reviewed(binding.origin, operation, key);
    if (action.tool === "browser.select" && !this.observed.get(action.revision)?.has(action.itemId))
      throw new Error("Browser selection is stale.");
    const tool = await this.tool(binding, reviewed, signal);
    const scalar =
      action.tool !== "browser.read"
        ? action.tool === "browser.scroll"
          ? action.direction
          : action.tool === "browser.search"
            ? action.query
            : action.tool === "browser.select"
              ? action.itemId
              : action.action
        : undefined;
    const args = reviewed.argumentKey ? { [reviewed.argumentKey]: scalar } : {};
    const response = await this.call(
      {
        protocol: BROWSER_WEBMCP_PROTOCOL,
        id: randomUUID(),
        type: "tool.execute",
        bindingId: binding.bindingId,
        documentId: binding.documentId,
        toolHandle: tool.handle,
        args,
      },
      signal,
    );
    if (action.tool === "browser.read") {
      if (response.status !== "ok") throw new Error();
      const rawView = response.value as Record<string, unknown>;
      const view = exact(rawView, [
        "items",
        ...(Object.hasOwn(rawView, "title") ? ["title"] : []),
        ...(Object.hasOwn(rawView, "summary") ? ["summary"] : []),
      ]);
      if (!Array.isArray(view.items)) throw new Error();
      const checked = browserWebMCPOperationResult({
        ok: true,
        message: "Browser view read.",
        browser: {
          source: "webmcp",
          operation: "read",
          status: "completed",
          revision: action.revision,
          view,
        },
      });
      this.observed.set(
        action.revision,
        new Set(
          checked.browser.operation === "read"
            ? checked.browser.view.items.map((item) => item.id)
            : [],
        ),
      );
      return checked;
    }
    const confirmed =
      response.status === "ok" &&
      createHash("sha256").update(canonical(response.value)).digest("hex") ===
        reviewed.successValueSha256;
    const status = confirmed
      ? "completed"
      : response.status === "ok"
        ? "unknown"
        : response.status === "cancelled"
          ? "cancelled"
          : response.status === "timed_out"
            ? "timed_out"
            : response.status === "unknown" || response.status === "page_changed"
              ? "unknown"
              : "failed";
    return browserWebMCPOperationResult({
      ok: status === "completed",
      message:
        status === "completed"
          ? "Reviewed browser tool reported completion."
          : "Browser action did not confirm completion.",
      browser: { source: "webmcp", operation: "command", status, revision: action.revision },
    });
  }
}
