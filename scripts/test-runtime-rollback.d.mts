export const OLD_REVISION: string;
export const NEW_REVISION: string;
export function exactRevision(value: unknown): string;
export function requireExactSHA256(path: string, expected: string): Promise<void>;
export function ownedCommand(
  lifecycle: unknown,
  file: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
): Promise<void>;
export function syntheticIdentity(
  lifecycle: unknown,
  owned: string,
): Promise<{ key: string; cert: string }>;
export function assertPreserved(
  before: Record<string, string>,
  after: Record<string, string>,
  label?: string,
): void;
