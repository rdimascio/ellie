import { spawn, type ChildProcess } from "node:child_process";

type BrowserSpawner = (
  command: string,
  args: readonly string[],
  options: { shell: false; stdio: "ignore" },
) => ChildProcess;

export interface AuthorizationBrowserOptions {
  platform?: NodeJS.Platform;
  spawn?: BrowserSpawner;
  timeoutMs?: number;
}

const PARAMETERS = new Set([
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "access_type",
  "prompt",
  "login_hint",
]);
const SCOPES = new Set([
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
]);

function authorizationUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 16_384 || /\s/.test(value)) return;
  try {
    const url = new URL(value),
      query = url.searchParams;
    if (
      value !== url.href ||
      url.origin !== "https://accounts.google.com" ||
      url.pathname !== "/o/oauth2/v2/auth" ||
      url.username ||
      url.password ||
      url.hash ||
      [...query.keys()].some((key) => !PARAMETERS.has(key) || query.getAll(key).length !== 1) ||
      query.get("response_type") !== "code" ||
      query.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(query.get("code_challenge") ?? "") ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(query.get("state") ?? "") ||
      !query.get("client_id") ||
      (query.get("client_id")?.length ?? 0) > 1_000 ||
      query.get("access_type") !== "offline" ||
      query.get("prompt") !== "consent"
    )
      return;
    const scopes = (query.get("scope") ?? "").split(/\s+/).filter(Boolean);
    if (!scopes.length || scopes.length > 2 || scopes.some((scope) => !SCOPES.has(scope))) return;
    const redirect = new URL(query.get("redirect_uri") ?? "");
    if (
      redirect.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(redirect.hostname) ||
      !redirect.port ||
      redirect.pathname !== "/api/connections/callback" ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      redirect.hash
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

/** Launch Google's native-app consent in the OS browser, never an embedded webview or shell. */
export async function openAuthorizationUrl(
  value: string,
  options: AuthorizationBrowserOptions = {},
): Promise<boolean> {
  const url = authorizationUrl(value),
    timeoutMs = options.timeoutMs ?? 3_000;
  if (!url || (options.platform ?? process.platform) !== "darwin") return false;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000)
    throw new TypeError("Authorization browser timeout is invalid.");
  let child: ChildProcess;
  try {
    child = (options.spawn ?? spawn)("/usr/bin/open", [url], { shell: false, stdio: "ignore" });
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    let finished = false;
    const finish = (success: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      // Keep the one-use error listener for a late spawn/kill error after timeout.
      resolve(success);
    };
    const onExit = (code: number | null) => finish(code === 0),
      onError = () => finish(false);
    const timer = setTimeout(() => {
      // The process is only the short-lived OS opener, not the browser it starts.
      try {
        child.kill("SIGTERM");
      } catch {
        /* Launch failure remains a manual browser fallback. */
      }
      finish(false);
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
