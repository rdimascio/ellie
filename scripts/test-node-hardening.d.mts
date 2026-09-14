export interface NodeHardeningOptions {
  archive: string;
  sha256: string;
  /** Tests only; the command-line interface never accepts this override. */
  testMaximumNodeBytes?: number;
  identitySha1?: string;
  teamId?: string;
}

export const nodeHardeningEntitlements: Readonly<Record<string, true>>;
export function parseNodeHardeningOptions(args: string[]): NodeHardeningOptions;
export function validateDeveloperIdOptions(options: {
  identitySha1?: string;
  teamId?: string;
}): void;
export function developerIdSigningEnvironment(
  options: NodeHardeningOptions,
  isolatedEnvironment: Record<string, string>,
  callerHome: unknown,
): Record<string, string>;
export function classifyDeveloperIdSigningFailure(stderr: unknown): string;
export function validateNodeEntitlements(value: unknown): void;
export function nodeHardeningSigningArguments(
  options: NodeHardeningOptions,
  node: string,
  entitlements: string,
): string[];
export function nodeHardeningVerificationArguments(
  options: NodeHardeningOptions,
  node: string,
): string[];
export function validateNodeSignatureMetadata(details: string, teamId?: string): void;
export function runNodeHardeningValidation(options: NodeHardeningOptions): Promise<void>;
export function runNodeHardeningCommandFixture(
  file: string,
  args: string[],
  options: {
    root: string;
    timeout: number;
    killAfter?: number;
    reapAfter?: number;
    interruptAfter?: number;
    outputFile?: string;
    maximumFile?: number;
    /** Exercise the production cleanup decision on this fixture's owned root. */
    cleanupOnSettlement?: boolean;
  },
): Promise<{ outcome: string; cleanupCertain: boolean; laterBlocked: boolean }>;
