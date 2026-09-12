export type KnowledgeTier =
  | "deterministic"
  | "local-router"
  | "local-conversation"
  | "retrieval"
  | "optional-frontier";
export interface KnowledgeRequest {
  text: string;
  needsFreshSources: boolean;
  complexity: "simple" | "deep";
}
export interface ModelProvider {
  id: string;
  locality: "local" | "cloud";
  stream(request: { system: string; text: string; signal: AbortSignal }): AsyncIterable<string>;
}
export interface RetrievalProvider {
  search(query: string, signal: AbortSignal): Promise<Array<{ text: string; source: string }>>;
}
// Streaming/knowledge contracts only. The explicit local inference probe is separate;
// deterministic commands never invoke models, retrieval providers, or cloud services.
