import { fileURLToPath } from "node:url";

export function packagedBrowserHelpers(): { broker: string; accessibility: string } {
  const moduleURL = new URL(import.meta.url);
  if (!moduleURL.pathname.endsWith("/lib/ellie/apps/cli/src/browser-runtime-paths.ts"))
    throw new Error("Browser execution requires a packaged Ellie installation.");
  return {
    broker: fileURLToPath(
      new URL("../../../../../helpers/ellie-browser-runtime-broker", moduleURL),
    ),
    accessibility: fileURLToPath(
      new URL("../../../../../helpers/ellie-browser-accessibility", moduleURL),
    ),
  };
}
