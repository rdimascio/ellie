const UNREACHABLE_CODES = new Set([
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

const INTERRUPTED_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

function errorCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 2) return undefined;
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof value.code === "string") return value.code;
  const fromCause = errorCode(value.cause, depth + 1);
  if (fromCause) return fromCause;
  if (Array.isArray(value.errors)) {
    for (const nested of value.errors) {
      const code = errorCode(nested, depth + 1);
      if (code) return code;
    }
  }
  return undefined;
}

export function cliErrorMessage(error: unknown, commandOutcomeMayBeUnknown = false): string {
  const code = errorCode(error);
  if (code === "ENOENT")
    return "Private configuration is missing. Run server init or node pair first.";
  if (error instanceof SyntaxError)
    return "Private configuration is invalid JSON. Review the local configuration file.";
  if (code === "ETIMEDOUT" && commandOutcomeMayBeUnknown)
    return "The coordinator connection was interrupted while a command was outstanding. Its outcome may be unknown. On the coordinator Mac, run `bun run ellie jobs` and inspect the job before explicitly retrying.";
  if (code && UNREACHABLE_CODES.has(code))
    return "Could not reach the Ellie coordinator. Check that its service is running and that this Mac can reach it over the local network.";
  if (code && INTERRUPTED_CODES.has(code))
    return commandOutcomeMayBeUnknown
      ? "The coordinator connection was interrupted while a command was outstanding. Its outcome may be unknown. On the coordinator Mac, run `bun run ellie jobs` and inspect the job before explicitly retrying."
      : "The coordinator connection was interrupted. Check its service status and the local network, then try again.";
  if (code) return "Could not access a required local resource. Run doctor for diagnostics.";
  return error instanceof Error ? error.message : "Ellie could not complete the request.";
}
