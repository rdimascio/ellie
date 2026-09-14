import { action } from "./operations.ts";
import { identifier, record } from "./index.ts";
import { nativeSessionSchemas } from "./native-session-contract.ts";

export const NATIVE_CONTROL_CONTRACT = {
  apps: ["arc", "safari", "messages"],
  maximumNodes: 16,
  maximumResponseBytes: 8192,
  discoveryDeadlineMs: 5000,
  commandDeadlineMs: 35000,
  routes: {
    nodes: { method: "GET", path: "/native/v1/nodes", operationId: "listNativeNodes" },
    commands: { method: "POST", path: "/native/v1/commands", operationId: "openNativeApp" },
  },
} as const;
export type NativePhoneApp = (typeof NATIVE_CONTROL_CONTRACT.apps)[number];

/** Native commands use one canonical operation, never arbitrary text or extra fields. */
export function nativeAppCommand(value: unknown): {
  nodeId: string;
  action: { tool: "app.open"; app: NativePhoneApp };
} {
  const body = record(value);
  const input = record(body.action);
  if (
    Object.keys(body).length !== 2 ||
    !Object.hasOwn(body, "nodeId") ||
    !Object.hasOwn(body, "action") ||
    Object.keys(input).length !== 2 ||
    !Object.hasOwn(input, "tool") ||
    !Object.hasOwn(input, "app")
  )
    throw new Error("Invalid native command.");
  const operation = action(input);
  if (
    operation.tool !== "app.open" ||
    !NATIVE_CONTROL_CONTRACT.apps.includes(operation.app as NativePhoneApp)
  )
    throw new Error("Invalid native command.");
  return {
    nodeId: identifier(body.nodeId),
    action: { tool: "app.open", app: operation.app as NativePhoneApp },
  };
}

export function nativeControlSchemas() {
  const shared = nativeSessionSchemas();
  return {
    NativeControlNode: {
      type: "object",
      additionalProperties: false,
      required: ["id", "label", "online", "capabilities"],
      properties: {
        id: shared.NativeGrant.properties.target,
        label: shared.NativeClient.properties.label,
        online: { type: "boolean" },
        capabilities: { type: "array", maxItems: 1, items: { const: "app.open" } },
      },
    },
    NativeNodesResponse: {
      type: "object",
      additionalProperties: false,
      required: ["nodes"],
      properties: {
        nodes: {
          type: "array",
          maxItems: NATIVE_CONTROL_CONTRACT.maximumNodes,
          items: { $ref: "#/components/schemas/NativeControlNode" },
          "x-ellie-unique-key": "id",
        },
      },
      "x-ellie-max-response-bytes": NATIVE_CONTROL_CONTRACT.maximumResponseBytes,
    },
    NativeAppRequest: {
      type: "object",
      additionalProperties: false,
      required: ["nodeId", "action"],
      properties: {
        nodeId: shared.NativeGrant.properties.target,
        action: {
          type: "object",
          additionalProperties: false,
          required: ["tool", "app"],
          properties: {
            tool: { const: "app.open" },
            app: { type: "string", enum: [...NATIVE_CONTROL_CONTRACT.apps] },
          },
        },
      },
    },
    NativeCommandResponse: {
      type: "object",
      additionalProperties: false,
      required: ["outcome"],
      properties: { outcome: { enum: ["completed", "failed"] } },
    },
    NativeUnknownResponse: {
      type: "object",
      additionalProperties: false,
      required: ["outcome"],
      properties: { outcome: { const: "unknown" } },
      description:
        "The command may have executed. Check the selected Mac before another explicit action; never replay automatically.",
    },
  };
}
