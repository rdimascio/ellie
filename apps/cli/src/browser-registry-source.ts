import { lstat } from "node:fs/promises";
import { join } from "node:path";

import {
  loadInstalledBrowserRegistry,
  loadReviewedBrowserRegistry,
  type ReviewedBrowserRegistry,
} from "../../node/src/browser-operation-registry.ts";
import { installedBrowserRegistry } from "./browser-runtime-paths.ts";

const NAME = "browser-operations.json";

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Reviewed browser configuration is unavailable.");
  }
}

/**
 * Resolves the reviewed bindings a node runs with. An installation ships its own reviewed
 * registry, so browser capability no longer depends on a file copied in by hand; a
 * registry in private Ellie state overrides it, which is how someone reviews a binding
 * before it has shipped. Undefined means no reviewed registry exists and the node runs
 * without browser capability rather than refusing to start.
 */
export async function reviewedBrowserBindings(
  stateDir: string,
  runtime = process.execPath,
): Promise<ReviewedBrowserRegistry | undefined> {
  const override = join(stateDir, NAME);
  if (await present(override)) return loadReviewedBrowserRegistry(override);
  const installed = installedBrowserRegistry(runtime);
  return installed ? loadInstalledBrowserRegistry(installed) : undefined;
}
