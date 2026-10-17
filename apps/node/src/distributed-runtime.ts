import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const RUNNER = "ellie-mlx-rank";

export function packagedMlxRunner(runtime = process.execPath): string | undefined {
  const base = dirname(resolve(runtime));
  for (const directory of [
    base,
    join(base, "..", "helpers"),
    join(base, "..", "mlx-runtime", "bin"),
  ]) {
    const candidate = join(directory, RUNNER);
    if (existsSync(candidate)) return resolve(candidate);
  }
  return undefined;
}
