import { KeychainFailure } from "@ellie/config";
import { serviceLogs } from "./service-logs.ts";
import type { ServiceRole } from "./services.ts";

// Only call this for a service's initial credential read, before it can open a
// listener or construct a node client. Later Keychain errors are not admitted.
export async function startupCredential<T>(
  read: () => Promise<T>,
  mark: (error: KeychainFailure) => void,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof KeychainFailure) mark(error);
    throw error;
  }
}

// Run every pre-listener cleanup even if one fails. The caller retains the
// original credential failure and reports the separate cleanup uncertainty.
export async function settleStartupCleanup(
  cleanups: readonly (() => Promise<void> | void)[],
): Promise<boolean> {
  let uncertain = false;
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch {
      uncertain = true;
    }
  }
  return uncertain;
}

// Keep launchd's existing job alive without another credential attempt. An
// explicit service stop terminates it; a new start is a new attended attempt.
export function holdForServiceAttention(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 60_000);
    if (!signal) return;
    const finish = () => {
      clearInterval(keepAlive);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

// A fresh `starting` entry makes any previous run's attention record stale.
// The service PID is checked separately: log history alone is not readiness.
export type ServiceCredentialState = "none" | "starting" | "needs_attention";
export async function serviceCredentialState(
  state: string,
  role: ServiceRole,
): Promise<ServiceCredentialState> {
  const entries = await serviceLogs(state, role);
  const start = entries.findLastIndex((entry) => entry.event === "starting");
  if (start < 0) return "none";
  const latest = entries.at(-1)?.event;
  if (latest === "starting") return "starting";
  if (
    latest === "needs_attention" ||
    latest === "keychain_timeout" ||
    latest === "keychain_helper_unavailable" ||
    latest === "keychain_access_unavailable" ||
    latest === "keychain_cleanup_uncertain" ||
    latest === "service_cleanup_uncertain"
  )
    return "needs_attention";
  return "none";
}

export const attentionRecovery =
  "Credentials need attention in this Mac's login session. Review service logs; after resolving access, run service stop then service start for this role. Any cleanup-uncertain event needs operator reconciliation first.";
