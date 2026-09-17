import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run, ServiceRole, ServiceStatus } from "./services.ts";

const packagedSourceSuffix = `${sep}payload${sep}lib${sep}ellie${sep}apps${sep}cli${sep}src${sep}packaged-service-status.ts`;

export interface PackagedServiceContext {
  installer: string;
  releaseID: string;
}

/** A packaged module uses its own Node and installer; the installer verifies release selection. */
export function packagedServiceContext(
  moduleURL = import.meta.url,
  executable = process.execPath,
): PackagedServiceContext | undefined {
  const source = fileURLToPath(moduleURL);
  if (!source.endsWith(packagedSourceSuffix)) return undefined;
  const release = source.slice(0, -packagedSourceSuffix.length);
  const releaseID = basename(release);
  const payload = join(release, "payload");
  const releaseParts = /^([0-9]+\.[0-9]+\.[0-9]+)-[a-f0-9]{40}-(arm64|x64)$/.exec(releaseID);
  if (!releaseParts || releaseParts[1]!.length > 32 || executable !== join(payload, "bin", "node"))
    throw new Error("Packaged service runtime path is invalid.");
  return { installer: join(payload, "bin", "ellie-service-installer"), releaseID };
}

/** The native installer is the authority for selected services; never reinterpret a legacy plist. */
export async function packagedServiceStatus(
  role: ServiceRole,
  context: PackagedServiceContext,
  run: Run,
): Promise<ServiceStatus> {
  const response = await run(context.installer, ["status", role]);
  if (response.code !== 0 || Buffer.byteLength(response.stdout) > 1024)
    throw new Error("Selected service status is unavailable.");
  let value: unknown;
  try {
    value = JSON.parse(response.stdout);
  } catch {
    throw new Error("Selected service status is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Selected service status is invalid.");
  const status = value as Record<string, unknown>;
  const keys = Object.keys(status);
  if (
    keys.length !== 6 ||
    !["role", "selected", "releaseID", "enabled", "loadedFromSelectedPlist", "state"].every((key) =>
      Object.hasOwn(status, key),
    ) ||
    status.role !== role ||
    status.selected !== true ||
    status.releaseID !== context.releaseID ||
    typeof status.enabled !== "boolean" ||
    typeof status.loadedFromSelectedPlist !== "boolean" ||
    (status.state !== "running" && status.state !== "waiting" && status.state !== "stopped")
  )
    throw new Error("Selected service status is invalid or belongs to another release.");
  const loaded = status.state !== "stopped";
  if (loaded !== status.loadedFromSelectedPlist)
    throw new Error("The loaded service is not the selected service.");
  return {
    role,
    installed: true,
    // A successful selected-status response has already verified launchctl's GUI domain.
    guiSession: true,
    loaded,
    enabled: status.enabled as boolean,
    state: status.state as "running" | "waiting" | "stopped",
  };
}
