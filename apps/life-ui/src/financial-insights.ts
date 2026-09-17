import type { ConnectorConnection } from "./api";
import type { LifeRecord } from "./types";

// Financial context must belong to the person and a current financial connection.
// These are source-backed observations, not balances or a complete transaction ledger.
export function financialInsights(
  records: LifeRecord[],
  connections: ConnectorConnection[],
  profileId: string,
  now = Date.now(),
): LifeRecord[] {
  const active = new Set(
    connections
      .filter((item) => item.provider === "plaid" && item.state === "connected")
      .map((item) => item.id),
  );
  return records.filter((record) => {
    const linked = record.data.connected;
    if (!linked || typeof linked !== "object" || Array.isArray(linked)) return false;
    const { connectionId, expiresAt } = linked as Record<string, unknown>;
    return (
      record.kind === "memory" &&
      record.data.type === "connected-insight-v1" &&
      record.scope.type === "user" &&
      record.scope.id === profileId &&
      typeof connectionId === "string" &&
      active.has(connectionId) &&
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      expiresAt > now &&
      record.provenanceStatus !== "needs-review" &&
      // Full record responses carry provenance, but do not carry provenanceStatus.
      // Summary status alone cannot establish that a memory came from this account.
      record.provenance?.some(
        (item) => item.derived === true && item.sourceId === `connected-source-${connectionId}`,
      ) === true &&
      record.provenance.every((item) => item.invalidatedAt === undefined)
    );
  });
}
