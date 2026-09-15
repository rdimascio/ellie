import { join, resolve } from "node:path";
import {
  BROWSER_WEBMCP_NATIVE_HOST,
  ELLIE_BROWSER_EXTENSION_ID,
  ellieBrowserWebMCPNativeHostManifest,
} from "../apps/node/src/browser-native-host.ts";

export type BrowserWebMCPHostInstallationPlan = {
  extensionId: typeof ELLIE_BROWSER_EXTENSION_ID;
  executablePath: string;
  manifestName: `${typeof BROWSER_WEBMCP_NATIVE_HOST}.json`;
  manifest: string;
};

/**
 * Produces a reviewable manifest artifact for an already authenticated captured release.
 * The caller must independently retain and revalidate that release before installation.
 */
export function browserWebMCPHostInstallationPlan(
  capturedRelease: string,
): BrowserWebMCPHostInstallationPlan {
  if (
    !capturedRelease.startsWith("/") ||
    capturedRelease.includes("\0") ||
    resolve(capturedRelease) !== capturedRelease
  )
    throw new Error("Invalid captured browser host release.");
  const executablePath = join(capturedRelease, "payload", "bin", "ellie-browser-webmcp-host");
  return {
    extensionId: ELLIE_BROWSER_EXTENSION_ID,
    executablePath,
    manifestName: `${BROWSER_WEBMCP_NATIVE_HOST}.json`,
    manifest: ellieBrowserWebMCPNativeHostManifest(executablePath),
  };
}
