import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const BROKER = "ellie-browser-runtime-broker";
const ACCESSIBILITY = "ellie-browser-accessibility";

/**
 * Helpers ship beside the runtime executable inside the application bundle, or in a
 * staged payload's sibling `helpers` directory. Resolving from the running executable
 * keeps the helper identity tied to the signed bundle that launched it.
 */
export function packagedBrowserHelpers(runtime = process.execPath): {
  broker: string;
  accessibility: string;
} {
  const base = dirname(resolve(runtime));
  for (const directory of [base, join(base, "..", "helpers")]) {
    const broker = join(directory, BROKER);
    const accessibility = join(directory, ACCESSIBILITY);
    if (existsSync(broker) && existsSync(accessibility))
      return { broker: resolve(broker), accessibility: resolve(accessibility) };
  }
  throw new Error("Browser helpers are missing from this Ellie installation.");
}
