import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = realpathSync.native(fileURLToPath(new URL("../../..", import.meta.url)));

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function canonicalProspectivePath(path: string): string {
  const missing: string[] = [];
  let existing = path;
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  return join(realpathSync.native(existing), ...missing);
}

function insideGitCheckout(path: string): boolean {
  let current = path;
  for (;;) {
    try {
      lstatSync(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function validatedImprovementStateDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error("Improvement queue state directory must be absolute.");
  const lexical = resolve(path);
  const canonical = canonicalProspectivePath(lexical);
  if (canonical !== lexical)
    throw new Error(
      "Improvement queue state directory must use a canonical path without symlink ancestors.",
    );
  const identityRoot = canonicalProspectivePath(resolve(homedir(), ".ellie"));
  if (contains(repositoryRoot, canonical) || contains(identityRoot, canonical))
    throw new Error(
      "Improvement queue state must remain outside repositories and Ellie identity state.",
    );
  if (insideGitCheckout(canonical))
    throw new Error("Improvement queue state must remain outside every Git checkout.");
  return canonical;
}
