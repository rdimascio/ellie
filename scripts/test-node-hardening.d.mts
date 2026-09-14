export interface NodeHardeningOptions {
  archive: string;
  sha256: string;
  /** Tests only; the command-line interface never accepts this override. */
  testMaximumNodeBytes?: number;
}

export const nodeHardeningEntitlements: Readonly<Record<string, true>>;
export function parseNodeHardeningOptions(args: string[]): NodeHardeningOptions;
export function validateNodeEntitlements(value: unknown): void;
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
