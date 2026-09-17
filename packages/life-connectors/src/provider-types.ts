export type BuiltInProviderId = "google-calendar" | "gmail" | "plaid";
/** Validated by the trusted host registry, so new integrations do not require a core union edit. */
export type ProviderId = string;

/** Host-only secret material. Adapters never include it in results or errors. */
export interface ProviderCredential {
  accessToken: string;
  clientId?: string;
  clientSecret?: string;
}

export interface EvidenceRef {
  connectionId: string;
  sourceKey: string;
  sourceRevision: string;
}

interface ObservationBase {
  sourceKey: string;
  sourceRevision: string;
  observedAt: number;
  title: string;
  deleted?: boolean;
}

export type ProviderObservation = ObservationBase &
  (
    | {
        kind: "event";
        data: {
          startAt?: number;
          endAt?: number;
          startDate?: string;
          endDate?: string;
          timeZone?: string;
          status: "confirmed" | "tentative" | "cancelled";
          location?: string;
          organizerIsSelf?: boolean;
        };
      }
    | {
        kind: "message";
        data: {
          sentAt: number;
          from: string;
          to: string[];
          subject: string;
          snippet?: string;
          direction: "incoming" | "outgoing" | "unknown";
          labels?: string[];
        };
      }
    | {
        kind: "transaction";
        data: {
          postedAt: number;
          amountDecimal: string;
          currency: string;
          merchant?: string;
          category?: string;
          pending: boolean;
        };
      }
    | { kind: "deleted"; data: { previousKind: "event" | "message" | "transaction" } }
  );

export interface ProviderPullInput {
  credential: ProviderCredential;
  /** Selected resource within a provider account; absent retains legacy primary behavior. */
  resourceId?: string;
  cursor?: string;
  continuation?: string;
  window: { from: number; to: number };
  limit: number;
  signal: AbortSignal;
}

export interface ProviderPullResult {
  accountId: string;
  items: ProviderObservation[];
  /** Present only after the provider's complete incremental batch was read. */
  cursor?: string;
  /** Opaque non-secret page state for a durably ingested partial batch. */
  continuation?: string;
  complete: boolean;
}

export interface LifeProviderAdapter {
  readonly id: ProviderId;
  /** Read-only resource picker for providers with multiple calendars. */
  calendars?(
    credential: ProviderCredential,
    signal: AbortSignal,
  ): Promise<{ id: string; label: string; primary: boolean }[]>;
  identity(
    credential: ProviderCredential,
    signal: AbortSignal,
  ): Promise<{ accountId: string; label?: string }>;
  pull(input: ProviderPullInput): Promise<ProviderPullResult>;
}

export type ProviderErrorCode =
  | "unavailable"
  | "revoked"
  | "rate_limited"
  | "expired_cursor"
  | "restart_batch"
  | "not_ready"
  | "invalid_response"
  | "provider_error"
  | "timeout"
  | "cancelled"
  | "limit_exceeded";

export class ProviderError extends Error {
  override name = "ProviderError";
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}
