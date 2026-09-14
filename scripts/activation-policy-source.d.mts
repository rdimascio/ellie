export function unavailableActivationPolicySource(): string;
export function readActivationPolicyBuildFile(
  path: string,
  maximum: number,
  expectedMode?: number,
): Promise<{
  data: Buffer;
  identity: {
    dev: bigint;
    ino: bigint;
    uid: bigint;
    mode: bigint;
    nlink: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
}>;
export function captureActivationPolicyBuildDirectory(path: string): Promise<unknown>;
export function verifyActivationPolicyBuildDirectory(directory: unknown): Promise<void>;
export function inspectActivationPolicyBlob(
  path: string,
  architecture: "arm64" | "x64",
  expected: Buffer,
): Promise<Buffer>;

export function generateActivationPolicySource(options: {
  source: string;
  output: string;
  publisherTeamID: string;
  architecture: "arm64" | "x64";
}): Promise<{
  data: Buffer;
  digest: string;
  envelopePolicyDigest: string;
  payloadPolicyDigest: string;
  source: string;
}>;

export function runActivationPolicyBuildCommand(
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; maximumOutputBytes?: number },
): Promise<Buffer>;

export interface ActivationPolicyProbe {
  data: Buffer;
  digest: string;
  envelopePolicyDigest: string;
  payloadPolicyDigest: string;
}

export function parseActivationPolicyProbe(
  stdout: Buffer,
  publisherTeamID: string,
): ActivationPolicyProbe;

export function activationPolicyAuditMatches(
  output: Buffer | string,
  expected: ActivationPolicyProbe,
  publisherTeamID: string,
  architecture: "arm64" | "x64",
): boolean;
