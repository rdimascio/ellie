export interface NodeRuntimeProvenance {
  version: string;
  architecture: "arm64" | "x64";
  archive: string;
  sha256: string;
  source: string;
  checksums: string;
  license: string;
}

export interface DependencyComponent {
  name: string;
  version: string;
  license: string;
  files: string[];
}

export const MAXIMUM_PAYLOAD_FILES: 3072;

export function extractVerifiedNode(options: {
  archive: string;
  expectedSha256: string;
  destination: string;
  architecture: "arm64" | "x64";
}): Promise<NodeRuntimeProvenance>;

export function stageApplication(
  source: string,
  destination: string,
  metadata?: { created?: string },
): Promise<DependencyComponent[]>;

export function verifyManifest(release: string): Promise<Record<string, unknown>>;

export function verifyStagedLifeRuntime(payload: string, environmentRoot: string): Promise<void>;

export function targetArchitecture(
  requested?: "arm64" | "x64",
  platform?: string,
  architecture?: string,
): "arm64" | "x64";

export function nativeArchitecture(architecture: "arm64" | "x64"): "arm64" | "x86_64";

export function buildPackagedLaunchers(options: {
  source: string;
  payload: string;
  architecture: "arm64" | "x64";
  work: string;
}): Promise<
  Array<{
    role: "coordinator" | "node";
    name: string;
    identifier: string;
    signature: "development-ad-hoc";
    architecture: "arm64" | "x64";
    minimumOS: "14.0";
  }>
>;

export function prepareDependencies(options: {
  bun: string;
  cwd: string;
  cache: string;
  environmentRoot: string;
}): Promise<void>;

export function buildServicePayload(options: {
  source?: string;
  output: string;
  nodeArchive: string;
  nodeSha256: string;
  architecture?: "arm64" | "x64";
  bun?: string;
  bunCache: string;
}): Promise<{
  output: string;
  release: string;
  archive: string;
  digest: string;
  manifest: Record<string, unknown>;
}>;
