import { createHash, randomBytes } from "node:crypto";
import type { ProviderId } from "./provider-types.ts";
import { HostCredentialVault } from "./vault.ts";

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_READONLY_SCOPES = {
  "google-calendar": "https://www.googleapis.com/auth/calendar.readonly",
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
} as const;

export type GoogleOAuthProvider = keyof typeof GOOGLE_READONLY_SCOPES;
export interface GoogleOAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
  clientSecret?: string;
  grantedScopes: string[];
}

type PendingState = {
  actorId: string;
  provider: GoogleOAuthProvider;
  redirectUri: string;
  verifier: string;
  requestedScopes: string[];
  expiresAt: number;
};

export class GoogleOAuthError extends Error {
  override name = "GoogleOAuthError";
  readonly code:
    | "invalid_input"
    | "invalid_state"
    | "expired_state"
    | "provider_error"
    | "invalid_response"
    | "timeout"
    | "cancelled";
  constructor(
    code:
      | "invalid_input"
      | "invalid_state"
      | "expired_state"
      | "provider_error"
      | "invalid_response"
      | "timeout"
      | "cancelled",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new GoogleOAuthError("invalid_input", `${label} is invalid.`);
  return value.trim();
}

function loopback(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GoogleOAuthError("invalid_input", "OAuth redirect URI is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new GoogleOAuthError(
      "invalid_input",
      "OAuth redirect URI must be an exact loopback URI.",
    );
  return url.toString();
}

function stateKey(state: string): string {
  return `oauth-state:${createHash("sha256").update(state).digest("hex")}`;
}

function parseTokenResponse(
  value: unknown,
  now: number,
): {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  grantedScopes: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new GoogleOAuthError("invalid_response", "Google returned an invalid token response.");
  const row = value as Record<string, unknown>,
    accessToken = bounded(row.access_token, "Google access token", 16_384),
    expiresIn = row.expires_in,
    scope = row.scope === undefined ? "" : bounded(row.scope, "Google granted scopes", 4_096);
  if (!Number.isSafeInteger(expiresIn) || Number(expiresIn) < 1 || Number(expiresIn) > 86_400)
    throw new GoogleOAuthError("invalid_response", "Google returned an invalid token lifetime.");
  const refreshToken =
    row.refresh_token === undefined
      ? undefined
      : bounded(row.refresh_token, "Google refresh token", 16_384);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: now + Number(expiresIn) * 1_000,
    grantedScopes: [...new Set(scope.split(/\s+/).filter(Boolean))].sort(),
  };
}

export class GoogleLoopbackOAuth {
  private readonly vault: HostCredentialVault;
  private readonly fetcher: typeof fetch;
  private readonly clientId: string;
  private readonly clientSecret?: string;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: {
    vault: HostCredentialVault;
    fetcher?: typeof fetch;
    clientId: string;
    clientSecret?: string;
    now?: () => number;
    timeoutMs?: number;
  }) {
    this.vault = options.vault;
    this.fetcher = options.fetcher ?? fetch;
    this.clientId = bounded(options.clientId, "Google client id", 1_000);
    this.clientSecret = options.clientSecret
      ? bounded(options.clientSecret, "Google client secret", 4_096)
      : undefined;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000)
      throw new TypeError("Google OAuth timeout must be 1 through 30000 milliseconds.");
  }

  begin(input: { actorId: string; provider: GoogleOAuthProvider; redirectUri: string }): {
    authorizationUrl: string;
    state: string;
  } {
    const actorId = bounded(input.actorId, "actorId", 200),
      scope = GOOGLE_READONLY_SCOPES[input.provider],
      redirectUri = loopback(input.redirectUri);
    if (!scope) throw new GoogleOAuthError("invalid_input", "Google provider is invalid.");
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url"),
      challenge = createHash("sha256").update(verifier, "ascii").digest("base64url"),
      pending: PendingState = {
        actorId,
        provider: input.provider,
        redirectUri,
        verifier,
        requestedScopes: [scope],
        expiresAt: this.now() + 10 * 60_000,
      },
      authorization = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    this.vault.put(stateKey(state), pending);
    authorization.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    }).toString();
    return { authorizationUrl: authorization.toString(), state };
  }

  cancelAuthorization(state: string): void {
    this.vault.delete(stateKey(bounded(state, "OAuth state", 500)));
  }

  async complete(
    input: { state: string; code: string; redirectUri: string },
    signal?: AbortSignal,
  ): Promise<{
    actorId: string;
    provider: GoogleOAuthProvider;
    credential: GoogleOAuthCredential;
    grantedScopes: string[];
  }> {
    const state = bounded(input.state, "OAuth state", 500),
      pendingKey = stateKey(state),
      pending = this.vault.get<PendingState>(pendingKey);
    if (!pending)
      throw new GoogleOAuthError("invalid_state", "OAuth state is unavailable or already used.");
    // Synchronous get/delete makes every callback attempt one-use before any
    // redirect validation or token request is started.
    this.vault.delete(pendingKey);
    const redirectUri = loopback(input.redirectUri);
    if (redirectUri !== pending.redirectUri)
      throw new GoogleOAuthError("invalid_state", "OAuth state does not match this redirect URI.");
    if (pending.expiresAt <= this.now())
      throw new GoogleOAuthError(
        "expired_state",
        "OAuth state expired. Start the connection again.",
      );
    const code = bounded(input.code, "OAuth authorization code", 16_384),
      { response, token } = await this.tokenRequest(
        new URLSearchParams({
          client_id: this.clientId,
          ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
          code,
          code_verifier: pending.verifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
        signal,
      );
    if (!response.ok)
      throw new GoogleOAuthError("provider_error", "Google rejected the authorization exchange.");
    const parsed = parseTokenResponse(token, this.now());
    if (!parsed.refreshToken)
      throw new GoogleOAuthError(
        "invalid_response",
        "Google did not return offline refresh access.",
      );
    if (pending.requestedScopes.some((scope) => !parsed.grantedScopes.includes(scope)))
      throw new GoogleOAuthError(
        "invalid_response",
        "Google did not grant the requested read scope.",
      );
    if (parsed.grantedScopes.some((scope) => !pending.requestedScopes.includes(scope)))
      throw new GoogleOAuthError("invalid_response", "Google granted an unexpected scope.");
    const credential: GoogleOAuthCredential = {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      clientId: this.clientId,
      ...(this.clientSecret ? { clientSecret: this.clientSecret } : {}),
      grantedScopes: parsed.grantedScopes,
    };
    return {
      actorId: pending.actorId,
      provider: pending.provider,
      credential,
      grantedScopes: parsed.grantedScopes,
    };
  }

  async refreshCredential(
    credential: GoogleOAuthCredential,
    signal?: AbortSignal,
  ): Promise<GoogleOAuthCredential> {
    if (bounded(credential.clientId, "Google client id", 1_000) !== this.clientId)
      throw new GoogleOAuthError("invalid_input", "Credential belongs to another OAuth client.");
    const allowedScopes = new Set<string>(Object.values(GOOGLE_READONLY_SCOPES));
    if (
      !Array.isArray(credential.grantedScopes) ||
      !credential.grantedScopes.length ||
      credential.grantedScopes.some((scope) => !allowedScopes.has(scope))
    )
      throw new GoogleOAuthError("invalid_input", "Credential scopes are invalid.");
    const { response, token } = await this.tokenRequest(
      new URLSearchParams({
        client_id: this.clientId,
        ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
        refresh_token: bounded(credential.refreshToken, "Google refresh token", 16_384),
        grant_type: "refresh_token",
      }),
      signal,
    );
    if (!response.ok)
      throw new GoogleOAuthError("provider_error", "Google rejected token refresh.");
    const parsed = parseTokenResponse(token, this.now());
    const previousScopes = [...new Set(credential.grantedScopes)].sort(),
      grantedScopes = parsed.grantedScopes.length ? parsed.grantedScopes : previousScopes;
    if (
      grantedScopes.length !== previousScopes.length ||
      grantedScopes.some((scope, index) => scope !== previousScopes[index])
    )
      throw new GoogleOAuthError("invalid_response", "Google refresh changed the granted scopes.");
    return {
      ...credential,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? credential.refreshToken,
      expiresAt: parsed.expiresAt,
      grantedScopes,
    };
  }

  private async tokenRequest(
    body: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<{ response: Response; token: unknown }> {
    if (signal?.aborted)
      throw new GoogleOAuthError("cancelled", "Google token request was cancelled.");
    const deadline = new AbortController(),
      combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort(new Error("Google OAuth deadline exceeded."));
    }, this.timeoutMs);
    const work = Promise.resolve()
      .then(() =>
        this.fetcher(GOOGLE_TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          redirect: "error",
          signal: combined,
        }),
      )
      .then(async (response) => ({ response, token: await this.tokenBody(response) }));
    let rejectInterruption!: (error: GoogleOAuthError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    const onAbort = () =>
      rejectInterruption(
        timedOut
          ? new GoogleOAuthError("timeout", "Google token request exceeded its deadline.")
          : new GoogleOAuthError("cancelled", "Google token request was cancelled."),
      );
    combined.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([work, interrupted]);
    } catch (error) {
      if (error instanceof GoogleOAuthError) throw error;
      if (combined.aborted)
        throw timedOut
          ? new GoogleOAuthError("timeout", "Google token request exceeded its deadline.")
          : new GoogleOAuthError("cancelled", "Google token request was cancelled.");
      throw new GoogleOAuthError("provider_error", "Google token request failed.", {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", onAbort);
    }
  }

  private async tokenBody(response: Response): Promise<unknown> {
    if (!response.body)
      throw new GoogleOAuthError("invalid_response", "Google returned an empty token response.");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 64 * 1024) {
          void reader.cancel();
          throw new GoogleOAuthError(
            "invalid_response",
            "Google token response exceeded its limit.",
          );
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(body);
    } catch {
      throw new GoogleOAuthError("invalid_response", "Google returned an invalid token response.");
    }
  }
}

export function isGoogleOAuthProvider(provider: ProviderId): provider is GoogleOAuthProvider {
  return provider === "google-calendar" || provider === "gmail";
}
