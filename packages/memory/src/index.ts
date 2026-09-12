export interface MemoryStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
// Not wired in V1. Pronoun context is transient, scoped to a paired node, and cleared on restart/revoke.
