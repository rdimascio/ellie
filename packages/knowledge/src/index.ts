export type KnowledgeTier = 'deterministic' | 'local-router' | 'local-conversation' | 'retrieval' | 'optional-frontier';
export interface KnowledgeRequest { text: string; needsFreshSources: boolean; complexity: 'simple' | 'deep' }
export interface ModelProvider {
  id: string;
  locality: 'local' | 'cloud';
  stream(request: { system: string; text: string; signal: AbortSignal }): AsyncIterable<string>;
}
export interface RetrievalProvider {
  search(query: string, signal: AbortSignal): Promise<Array<{ text: string; source: string }>>;
}
// Contracts only. V1 never invokes a model, retrieval provider, or cloud service.
