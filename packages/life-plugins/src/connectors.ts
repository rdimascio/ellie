import { isIP } from "node:net";
import type {
  LifeProviderAdapter,
  ProviderPullInput,
  ProviderObservation,
} from "../../life-connectors/src/provider-types.ts";

export interface ConnectorPluginManifest {
  id: string;
  label: string;
  version: 1;
  kind: "connector";
  observationKinds: Array<"event" | "message" | "transaction">;
  auth: "google-oauth" | "host-provisioned";
  scopes: string[];
  origins: string[];
}

const FIELDS = new Set([
  "id",
  "label",
  "version",
  "kind",
  "observationKinds",
  "auth",
  "scopes",
  "origins",
]);
const OBSERVATIONS = new Set(["event", "message", "transaction"]);

function invalid(): never {
  // Manifest validation errors deliberately exclude input values and credential-like fields.
  throw new TypeError("Connector plugin manifest is invalid.");
}

function list(
  value: unknown,
  max: number,
  valid: (item: unknown) => boolean,
  empty = false,
): string[] {
  if (
    !Array.isArray(value) ||
    (!empty && value.length === 0) ||
    value.length > max ||
    value.some((item) => !valid(item)) ||
    new Set(value).size !== value.length
  )
    invalid();
  return [...value] as string[];
}

function publicOrigin(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 253) return false;
  try {
    const url = new URL(value),
      hostname = url.hostname;
    return (
      url.protocol === "https:" &&
      value === url.origin &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      isIP(hostname.replace(/^\[|\]$/g, "")) === 0 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(hostname) &&
      !/\.(?:localhost|local|internal|invalid|test|example|onion|home|lan)$/.test(hostname)
    );
  } catch {
    return false;
  }
}

export function validateConnectorPluginManifest(value: unknown): ConnectorPluginManifest {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !FIELDS.has(key)) ||
    Object.values(fields).some((field) => !field.enumerable || !("value" in field))
  )
    invalid();
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    !/^[a-z][a-z0-9.-]{0,79}$/.test(item.id) ||
    typeof item.label !== "string" ||
    !item.label.trim() ||
    item.label.length > 120 ||
    [...item.label].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    item.version !== 1 ||
    item.kind !== "connector" ||
    (item.auth !== "google-oauth" && item.auth !== "host-provisioned")
  )
    invalid();
  const observationKinds = list(
    item.observationKinds,
    3,
    (kind) => typeof kind === "string" && OBSERVATIONS.has(kind),
  ) as ConnectorPluginManifest["observationKinds"];
  const scopes = list(
    item.scopes,
    16,
    (scope) => typeof scope === "string" && /^[A-Za-z][A-Za-z0-9._:/-]{0,199}$/.test(scope),
    true,
  );
  const origins = list(item.origins, 8, publicOrigin);
  return {
    id: item.id,
    label: item.label.trim(),
    version: 1,
    kind: "connector",
    observationKinds,
    auth: item.auth,
    scopes,
    origins,
  };
}

/** Trusted host instances only. This registry never loads code or grants iframe capabilities. */
export class ConnectorPluginRegistry {
  private readonly entries = new Map<
    string,
    { manifest: ConnectorPluginManifest; adapter: LifeProviderAdapter }
  >();

  register(rawManifest: unknown, adapter: LifeProviderAdapter): void {
    const manifest = validateConnectorPluginManifest(rawManifest);
    if (
      !adapter ||
      adapter.id !== manifest.id ||
      typeof adapter.identity !== "function" ||
      typeof adapter.pull !== "function"
    )
      throw new TypeError("Connector plugin adapter does not match its manifest.");
    if (this.entries.has(manifest.id)) throw new Error("Connector plugin is already registered.");
    if (this.entries.size >= 64) throw new Error("Connector plugin registry is full.");
    const identity = adapter.identity.bind(adapter),
      pull = adapter.pull.bind(adapter);
    const kinds = new Set(manifest.observationKinds);
    const registered: LifeProviderAdapter = Object.freeze({
      id: manifest.id,
      identity,
      async pull(input: ProviderPullInput) {
        const result = await pull(input);
        if (
          !result ||
          !Array.isArray(result.items) ||
          result.items.some(
            (item: ProviderObservation) =>
              !item || !kinds.has(item.kind === "deleted" ? item.data?.previousKind : item.kind),
          )
        )
          throw new Error("Connector plugin returned undeclared observation kinds.");
        return result;
      },
    });
    this.entries.set(manifest.id, { manifest, adapter: registered });
  }

  list(): ConnectorPluginManifest[] {
    return [...this.entries.values()].map(({ manifest }) => ({
      ...manifest,
      observationKinds: [...manifest.observationKinds],
      scopes: [...manifest.scopes],
      origins: [...manifest.origins],
    }));
  }

  adapters(): LifeProviderAdapter[] {
    return [...this.entries.values()].map(({ adapter }) => adapter);
  }
}
