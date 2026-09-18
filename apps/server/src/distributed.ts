import { randomUUID } from "node:crypto";
import { distributedGroupProblem, distributedMemberEligible } from "@ellie/compute";
import { distributedMlxGroups, VERSION } from "@ellie/protocol";
import type {
  DistributedMlxGroup,
  InferenceJob,
  InferenceRequest,
  NodeInfo,
  Result,
} from "@ellie/protocol";
import type { JobStore, JobOutcomeCode } from "./jobs.ts";

interface Member {
  nodeId: string;
  task: InferenceJob;
  delivered: boolean;
  ready: boolean;
  stopped: boolean;
  outcome?: Result;
  lease: Lease;
}
interface Lease {
  id: string;
  group: DistributedMlxGroup;
  members: Member[];
  cancelled: boolean;
  cancellationCode?: JobOutcomeCode;
  released: boolean;
  replied: boolean;
  timer: NodeJS.Timeout;
  reply: (
    outcome: Result & { groupId: string; workerId: string; workerIds: string[]; jobIds: string[] },
  ) => void;
}

/** Reservations survive cancellation until every delivered process acknowledges teardown. */
export class DistributedScheduler {
  private slots = new Map<string, Member>();
  private groups: DistributedMlxGroup[];
  private store: JobStore;
  private nodes: () => NodeInfo[];
  private invalidate: (nodeId: string) => void;
  constructor(options: {
    groups: DistributedMlxGroup[];
    store: JobStore;
    nodes: () => NodeInfo[];
    invalidate: (nodeId: string) => void;
  }) {
    this.groups = distributedMlxGroups(options.groups);
    this.store = options.store;
    this.nodes = options.nodes;
    this.invalidate = options.invalidate;
  }
  busy(): Set<string> {
    return new Set(this.slots.keys());
  }
  member(nodeId: string): Member | undefined {
    return this.slots.get(nodeId);
  }
  status(busy: ReadonlySet<string>) {
    return this.groups.map((group) => ({
      id: group.id,
      model: group.model,
      planId: group.planId,
      nodeIds: group.nodeIds,
      backend: group.backend,
      strategy: group.strategy,
      problem: distributedGroupProblem(group, this.nodes(), busy) ?? null,
      jobs: [...this.slots.values()]
        .filter((m) => m.lease.group.id === group.id)
        .map((m) => ({
          id: m.task.id,
          nodeId: m.nodeId,
          ready: m.ready,
          stopped: m.stopped,
          cancelling: m.lease.cancelled,
        })),
    }));
  }
  submit(request: InferenceRequest, busy: ReadonlySet<string>, reply: Lease["reply"]): () => void {
    if (request.mode !== "distributed-mlx") throw new Error("Explicit distributed mode required.");
    const group = this.groups.find((g) => g.id === request.groupId && g.model === request.model);
    if (!group) throw new Error("This distributed group and model are not explicitly enabled.");
    const problem = distributedGroupProblem(
      group,
      this.nodes(),
      new Set([...busy, ...this.slots.keys()]),
    );
    if (problem) throw new Error(problem);
    const now = Date.now();
    const lease: Lease = {
      id: randomUUID(),
      group,
      members: [],
      cancelled: false,
      released: false,
      replied: false,
      reply,
      timer: setInterval(() => this.check(lease), 1000),
    };
    lease.members = group.nodeIds.map((nodeId, rank) => ({
      nodeId,
      lease,
      delivered: false,
      ready: false,
      stopped: false,
      task: {
        version: VERSION,
        kind: "inference",
        id: `${lease.id}-${rank}`,
        expiresAt: now + group.timeoutMs,
        request,
        assignment: { plan: group, rank, leaseId: lease.id },
      },
    }));
    try {
      this.store.createBatch(
        lease.members.map((m) => ({
          id: m.task.id,
          kind: "inference",
          target: m.nodeId,
          createdAt: now,
          expiresAt: m.task.expiresAt,
        })),
      );
    } catch (error) {
      clearInterval(lease.timer);
      throw error;
    }
    // No await between admission and installing all reservations.
    for (const m of lease.members) this.slots.set(m.nodeId, m);
    return () =>
      this.cancel(lease, "Distributed inference was cancelled; all members are stopping.");
  }
  deliver(nodeId: string): InferenceJob | undefined {
    const m = this.slots.get(nodeId);
    if (!m || m.delivered || m.stopped || m.lease.cancelled) return undefined;
    this.check(m.lease);
    if (m.lease.cancelled) return undefined;
    try {
      this.store.markDelivered(m.task.id);
    } catch {
      this.cancel(
        m.lease,
        "Distributed delivery failed; the group is stopping.",
        "operation_failed",
      );
      return undefined;
    }
    m.delivered = true;
    return m.task;
  }
  start(nodeId: string, id: string): { cancel: boolean; ready: boolean } {
    const m = this.match(nodeId, id);
    if (!m.delivered || m.stopped) throw new Error("No delivered distributed job.");
    this.check(m.lease);
    if (m.lease.cancelled) return { cancel: true, ready: false };
    if (!m.ready) {
      try {
        this.store.markRunning(id);
      } catch (error) {
        this.cancel(
          m.lease,
          "Distributed start failed; the group is stopping.",
          "operation_failed",
        );
        throw error;
      }
      m.ready = true;
    }
    return { cancel: false, ready: m.lease.members.every((other) => other.ready) };
  }
  report(nodeId: string, id: string, outcome: Result): void {
    const m = this.match(nodeId, id);
    if (m.stopped) return;
    if (!m.delivered) throw new Error("Distributed job was not delivered.");
    this.check(m.lease);
    if (outcome.ok && !m.lease.members.every((other) => other.ready))
      outcome = { ok: false, message: "A rank completed before the group was ready." };
    try {
      this.store.finish(
        id,
        m.lease.cancelled ? "cancelled" : outcome.ok ? "completed" : "failed",
        m.lease.cancelled
          ? m.lease.cancellationCode!
          : outcome.ok
            ? "succeeded"
            : "operation_failed",
        outcome.ok && !m.lease.cancelled,
      );
    } catch (error) {
      this.cancel(
        m.lease,
        "Distributed result could not be committed; the group is stopping.",
        "operation_failed",
      );
      throw error;
    }
    m.outcome = outcome;
    m.stopped = true;
    if (!outcome.ok)
      this.cancel(
        m.lease,
        "A distributed member failed; the entire group is stopping. No rank was retried.",
        "operation_failed",
      );
    this.release(m.lease);
  }
  cancelJob(nodeId: string, id: string): void {
    const m = this.match(nodeId, id);
    this.cancel(m.lease, "Distributed inference was cancelled; all members are stopping.");
  }
  changed(nodeId: string, code: JobOutcomeCode = "operation_failed"): void {
    const m = this.slots.get(nodeId);
    if (m)
      this.cancel(
        m.lease,
        "A distributed member reconnected or was revoked; the group is stopping.",
        code,
      );
  }
  checkNode(nodeId: string): void {
    const m = this.slots.get(nodeId);
    if (m) this.check(m.lease);
  }
  private check(lease: Lease): void {
    if (lease.cancelled) return;
    const now = Date.now();
    if (lease.members.some((m) => m.task.expiresAt <= now))
      return this.cancel(
        lease,
        "Distributed inference exceeded its deadline; all members are stopping.",
        "timed_out",
      );
    const nodes = this.nodes();
    if (
      lease.members.some(
        (m) =>
          !m.stopped &&
          !nodes.some(
            (n) => n.id === m.nodeId && distributedMemberEligible(n, lease.group, now, m.delivered),
          ),
      )
    )
      this.cancel(
        lease,
        "A distributed member lost eligibility or disconnected; the group is stopping.",
        "operation_failed",
      );
  }
  private match(nodeId: string, id: string): Member {
    const m = this.slots.get(nodeId);
    if (!m || m.task.id !== id) throw new Error("No matching distributed job.");
    return m;
  }
  private respond(lease: Lease, outcome: Result): void {
    if (lease.replied) return;
    lease.replied = true;
    lease.reply({
      ...outcome,
      groupId: lease.group.id,
      workerId: lease.group.nodeIds[0]!,
      workerIds: lease.group.nodeIds,
      jobIds: lease.members.map((m) => m.task.id),
    });
  }
  private cancel(
    lease: Lease,
    message: string,
    code: JobOutcomeCode = "cancelled_by_caller",
  ): void {
    if (lease.released) return;
    lease.cancelled = true;
    lease.cancellationCode ??= code;
    for (const m of lease.members) {
      if (m.stopped) continue;
      // Cancellation is also retained in memory if storage fails. Keep the slot occupied.
      try {
        this.store.requestCancellation(m.task.id, Date.now(), lease.cancellationCode);
        if (!m.delivered) m.stopped = true;
      } catch {}
    }
    this.respond(lease, { ok: false, message });
    this.release(lease);
  }
  private release(lease: Lease): void {
    if (lease.released || !lease.members.every((m) => m.stopped)) return;
    lease.released = true;
    clearInterval(lease.timer);
    for (const m of lease.members) {
      if (this.slots.get(m.nodeId) === m) {
        this.slots.delete(m.nodeId);
        this.invalidate(m.nodeId);
      }
    }
    if (!lease.cancelled) this.respond(lease, lease.members[0]!.outcome!);
  }
  shutdown(): void {
    for (const lease of new Set([...this.slots.values()].map((m) => m.lease))) {
      this.cancel(
        lease,
        "Coordinator stopping; all distributed members must stop.",
        "coordinator_stopped",
      );
      clearInterval(lease.timer);
    }
  }
}
