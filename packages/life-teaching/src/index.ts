import { LifeAccessError, LifeConflictError, LifeStore } from "../../life-core/src/index.ts";
import type { LifeActor, LifeRecord, LifeScope } from "../../life-core/src/index.ts";

export interface TeachingSource {
  id: string;
  revision: number;
}
export interface TeachingVersion {
  version: number;
  instructions: string;
  sources: TeachingSource[];
  adoptedBy: string;
  adoptedAt: number;
}
export interface TeachingInput {
  scope: LifeScope;
  title: string;
  instructions: string;
  sources?: TeachingSource[];
  enabled?: boolean;
}
export interface TeachingGuide {
  record: LifeRecord;
  version: number;
  enabled: boolean;
  status: "active" | "paused" | "source-changed";
  versions: TeachingVersion[];
}
export interface AdoptedGuidance {
  id: string;
  title: string;
  instructions: string;
  version: number;
  sources: TeachingSource[];
}

const TYPE = "teaching-guide-v1";
const IMPROVEMENT_TYPE = "learning-improvement-v1";
const MAX_INSTRUCTIONS = 4_000;
function bounded(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new TypeError(`Teaching text must contain 1 through ${limit} characters.`);
  return value.trim();
}
function sameScope(a: LifeScope, b: LifeScope): boolean {
  return a.type === b.type && a.id === b.id;
}
function sourceRefs(value: unknown): TeachingSource[] {
  if (!Array.isArray(value) || value.length > 12)
    throw new TypeError("Choose up to twelve sources for one guide.");
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new TypeError("Invalid teaching source.");
    const row = item as Record<string, unknown>;
    const id = bounded(row.id, 200);
    if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || ids.has(id))
      throw new TypeError("Invalid teaching source revision.");
    ids.add(id);
    return { id, revision: Number(row.revision) };
  });
}
function versions(record: LifeRecord): TeachingVersion[] {
  const value = record.data.versions;
  if (
    record.kind !== "routine" ||
    record.data.type !== TYPE ||
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 8 ||
    typeof record.data.enabled !== "boolean"
  )
    throw new LifeAccessError("Teaching guide unavailable.");
  const result = value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new LifeAccessError("Teaching guide unavailable.");
    const row = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.version) ||
      Number(row.version) < 1 ||
      !Number.isSafeInteger(row.adoptedAt) ||
      Number(row.adoptedAt) < 0
    )
      throw new LifeAccessError("Teaching guide unavailable.");
    return {
      version: Number(row.version),
      instructions: bounded(row.instructions, MAX_INSTRUCTIONS),
      sources: sourceRefs(row.sources),
      adoptedBy: bounded(row.adoptedBy, 200),
      adoptedAt: Number(row.adoptedAt),
    };
  });
  if (
    result.some((item, index) => index > 0 && item.version !== result[index - 1]!.version + 1) ||
    result.at(-1)!.version !== record.data.version ||
    result.at(-1)!.instructions !== record.body
  )
    throw new LifeAccessError("Teaching guide needs explicit review.");
  return result;
}

/** User-adopted guidance is versioned configuration; it never grants tools or executes source text. */
export class LifeTeaching {
  private readonly store: LifeStore;
  private readonly now: () => number;
  constructor(store: LifeStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  create(actor: LifeActor, input: TeachingInput): TeachingGuide {
    const instructions = bounded(input.instructions, MAX_INSTRUCTIONS);
    const sources = sourceRefs(input.sources ?? []);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean")
      throw new TypeError("Enabled must be a boolean.");
    this.checkSources(actor, input.scope, sources);
    const version: TeachingVersion = {
      version: 1,
      instructions,
      sources,
      adoptedBy: actor.userId,
      adoptedAt: this.now(),
    };
    const record = this.store.createRecord(actor, {
      kind: "routine",
      scope: input.scope,
      title: bounded(input.title, 200),
      body: instructions,
      data: { type: TYPE, enabled: input.enabled === true, version: 1, versions: [version] },
      provenance: sources.map((source) => ({ sourceId: source.id, derived: true })),
      relationships: sources.map((source) => ({ type: "taught-by", targetId: source.id })),
    });
    return this.describe(actor, record);
  }

  /** Atomically turns a reviewed private improvement proposal into enabled guidance. */
  adoptImprovement(actor: LifeActor, id: string, expectedRevision: number): TeachingGuide {
    const proposal = this.store.getRecord(actor, id);
    if (
      !proposal ||
      proposal.kind !== "routine" ||
      proposal.scope.type !== "user" ||
      proposal.scope.id !== actor.userId ||
      proposal.data.type !== IMPROVEMENT_TYPE ||
      proposal.data.status !== "ready"
    )
      throw new LifeAccessError("Improvement proposal unavailable.");
    if (proposal.revision !== expectedRevision)
      throw new LifeConflictError("Improvement proposal changed.");
    const instructions = bounded(proposal.body, MAX_INSTRUCTIONS);
    const adoptedAt = this.now();
    const version: TeachingVersion = {
      version: 1,
      instructions,
      sources: [],
      adoptedBy: actor.userId,
      adoptedAt,
    };
    const record = this.store.updateRecord(actor, id, expectedRevision, {
      body: instructions,
      data: {
        type: TYPE,
        enabled: true,
        version: 1,
        versions: [version],
        improvementAudit: {
          ...proposal.data,
          candidateInstructions: instructions,
          status: "adopted",
          adoptedBy: actor.userId,
          adoptedAt,
        },
      },
      provenance: [],
      relationships: [],
    });
    return this.describe(actor, record);
  }

  get(actor: LifeActor, id: string): TeachingGuide {
    const record = this.store.getRecord(actor, id);
    if (!record) throw new LifeAccessError("Teaching guide unavailable.");
    return this.describe(actor, record);
  }

  list(actor: LifeActor, scope: LifeScope): TeachingGuide[] {
    return this.store
      .listRecords(actor, { scope, kinds: ["routine"], limit: 500 })
      .filter((record) => record.data.type === TYPE)
      .flatMap((record) => {
        try {
          return [this.describe(actor, record)];
        } catch {
          return [];
        }
      });
  }

  revise(
    actor: LifeActor,
    id: string,
    expectedRevision: number,
    input: { instructions: string; sources?: TeachingSource[] },
  ): TeachingGuide {
    const guide = this.get(actor, id);
    if (guide.record.revision !== expectedRevision)
      throw new LifeConflictError("Teaching guide changed.");
    const instructions = bounded(input.instructions, MAX_INSTRUCTIONS);
    const sources = sourceRefs(input.sources ?? guide.versions.at(-1)!.sources);
    this.checkSources(actor, guide.record.scope, sources);
    const version: TeachingVersion = {
      version: guide.version + 1,
      instructions,
      sources,
      adoptedBy: actor.userId,
      adoptedAt: this.now(),
    };
    const record = this.store.updateRecord(actor, id, expectedRevision, {
      body: instructions,
      data: {
        type: TYPE,
        enabled: guide.enabled,
        version: version.version,
        versions: [...guide.versions, version].slice(-8),
        ...(guide.record.data.improvementAudit === undefined
          ? {}
          : { improvementAudit: guide.record.data.improvementAudit }),
      },
      provenance: sources.map((source) => ({ sourceId: source.id, derived: true })),
      relationships: sources.map((source) => ({ type: "taught-by", targetId: source.id })),
    });
    return this.describe(actor, record);
  }

  setEnabled(
    actor: LifeActor,
    id: string,
    expectedRevision: number,
    enabled: boolean,
  ): TeachingGuide {
    if (typeof enabled !== "boolean") throw new TypeError("Enabled must be a boolean.");
    const guide = this.get(actor, id);
    if (enabled) this.checkSources(actor, guide.record.scope, guide.versions.at(-1)!.sources);
    const record = this.store.updateRecord(actor, id, expectedRevision, {
      data: { ...guide.record.data, enabled },
    });
    return this.describe(actor, record);
  }

  rollback(
    actor: LifeActor,
    id: string,
    expectedRevision: number,
    targetVersion: number,
  ): TeachingGuide {
    const guide = this.get(actor, id);
    const previous = guide.versions.find((item) => item.version === targetVersion);
    if (!previous) throw new LifeAccessError("Teaching version is no longer retained.");
    return this.revise(actor, id, expectedRevision, previous);
  }

  /** Bounded model input. Source updates/deletion or manual record-body edits disable stale guidance. */
  resolve(actor: LifeActor, scope: LifeScope): AdoptedGuidance[] {
    let remaining = 16_000;
    return this.list(actor, scope)
      .filter((guide) => guide.status === "active")
      .slice(0, 8)
      .flatMap((guide) => {
        const current = guide.versions.at(-1)!;
        if (current.instructions.length > remaining) return [];
        remaining -= current.instructions.length;
        return [
          {
            id: guide.record.id,
            title: guide.record.title,
            instructions: current.instructions,
            version: current.version,
            sources: current.sources,
          },
        ];
      });
  }

  private describe(actor: LifeActor, record: LifeRecord): TeachingGuide {
    const history = versions(record);
    let fresh = !record.provenance.some((item) => item.invalidatedAt !== undefined);
    try {
      this.checkSources(actor, record.scope, history.at(-1)!.sources);
    } catch {
      fresh = false;
    }
    const enabled = record.data.enabled === true;
    return {
      record,
      version: history.at(-1)!.version,
      enabled,
      status: !fresh ? "source-changed" : enabled ? "active" : "paused",
      versions: history,
    };
  }

  private checkSources(actor: LifeActor, scope: LifeScope, sources: TeachingSource[]): void {
    for (const reference of sources) {
      const source = this.store.getRecord(actor, reference.id);
      if (!source || source.kind !== "source" || !sameScope(source.scope, scope))
        throw new LifeAccessError("Teaching source unavailable in this space.");
      if (source.revision !== reference.revision)
        throw new LifeConflictError("Teaching source changed; review the current version first.");
    }
  }
}
