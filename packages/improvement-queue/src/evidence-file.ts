import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const MAX_LOCAL_EVIDENCE_BYTES = 1024 * 1024;

export interface LocalEvidenceFile {
  reference: string;
  sha256: string;
  bytes: Buffer;
}

export function readPrivateEvidenceFile(
  path: string,
  maximumBytes = MAX_LOCAL_EVIDENCE_BYTES,
): LocalEvidenceFile {
  if (!isAbsolute(path)) throw new Error("Private evidence path must be absolute.");
  const lexical = resolve(path);
  let canonical: string;
  try {
    canonical = realpathSync.native(lexical);
  } catch (error) {
    throw new Error("Private evidence file could not be resolved safely.", { cause: error });
  }
  if (canonical !== lexical)
    throw new Error("Private evidence path must be canonical without symlink ancestors.");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    const pathStat = lstatSync(canonical);
    if (
      !stat.isFile() ||
      pathStat.isSymbolicLink() ||
      pathStat.dev !== stat.dev ||
      pathStat.ino !== stat.ino ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Private evidence must be an owner-only regular file.");
    if (stat.size === 0 || stat.size > maximumBytes)
      throw new Error(`Private evidence exceeds the supported ${maximumBytes}-byte bound.`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const afterPath = lstatSync(canonical);
    if (
      bytes.length !== stat.size ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      afterPath.isSymbolicLink() ||
      afterPath.dev !== stat.dev ||
      afterPath.ino !== stat.ino
    )
      throw new Error("Private evidence changed while it was being read.");
    return {
      reference: canonical,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Private evidence")) throw error;
    throw new Error("Private evidence file could not be read safely.", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
