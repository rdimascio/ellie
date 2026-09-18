import { isAbsolute } from "node:path";

function shellPath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\r\n\0]/.test(value))
    throw new Error("Synthetic Node launcher path is invalid.");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// The shell replaces itself with the exact Node process, preserving the
// speech adapter's direct-child ownership without relying on SSH/launchd PATH.
export function fixtureNodeLauncher(node, script) {
  return `#!/bin/sh\nexec ${shellPath(node)} ${shellPath(script)} "$@"\n`;
}
