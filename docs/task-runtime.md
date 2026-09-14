# Durable task runtime

`@ellie/task-runtime` is the local coordinator for background tasks, reminders, routines, event watches, and handler-backed subagent jobs. It is separate from compute workers: a compute worker supplies machine capacity, while a task is a logical unit of authorized work. The runtime does not invoke a model or tool executor by itself.

Create `TaskRuntime` with a private `directory` and register a fixed set of typed handlers. Handler names are the only persisted executable references. Inputs are JSON data and are never interpreted as commands or shell text. The service is responsible for validating handler-specific input before enqueueing it.

```ts
const tasks = new TaskRuntime({
  directory: privateStateDirectory,
  capabilityResolver: (scope) => grants.forScope(scope),
});

tasks.registerHandler({
  name: "reminder.notify",
  requiredCapabilities: ["notification.record.create"],
  async run(context, input: { recordId: string; scope: string; userId: string }) {
    context.progress({ message: "Recording reminder delivery" });
    return notifications.record(input, context.idempotencyKey, context.signal);
  },
  checkOutcome: (_context, result) => result.persisted === true,
});

const task = tasks.schedule({
  owner: "user:alice",
  handler: "reminder.notify",
  input: { recordId: "reminder-1", scope: "user:alice", userId: "alice" },
  schedule: { kind: "daily", time: "08:30", timeZone: "America/Los_Angeles" },
});
```

All timestamps are integer Unix milliseconds. Owner scopes are canonical `user:<id>` or `group:<id>` strings. Callers must pass the authenticated active scope to `get`, `list`, `pause`, `resume`, `cancel`, and `runNow`; a mismatched scope reveals no task. HTTP clients should select operations and inputs only. They must not supply capability claims: the service maps approved operations to internal handler requirements, and `capabilityResolver` reloads current grants immediately before every dispatch.

`enqueue` and `schedule` return a `TaskRecord`. The lifecycle states are `queued`, `running`, `waiting`, `scheduled`, `paused`, `succeeded`, `failed`, `cancelled`, `expired`, and `unknown`. A successful handler return is not sufficient for success: handlers need `checkOutcome`, otherwise the record ends as `failed` with `outcome_unverified`. Progress is durable and available with `progress(taskId, owner)`.

Schedules support one-shot Unix times, anchored intervals, and daily or weekly wall-clock recurrence in an IANA time zone. `nextOccurrence(schedule, after)` is a pure helper. Recurrence uses exact local calendar fields, including zones with half-hour DST transitions, skips nonexistent spring-forward wall times, and chooses the earlier instant once during a repeated fall-back wall time. Persisted occurrence keys and a unique index make concurrent or repeated ticks idempotent. Missed runs can be skipped, collapsed to the latest occurrence, or caught up to an explicit limit.

`watch` persists an owner-scoped topic subscription. `publish` durably deduplicates an event by owner, topic, and caller-provided key, then enqueues matching handler work. Watch payloads remain inert JSON. Event adapters decide which external changes are trustworthy and normalize their keys.

Parent and child tasks share the root task-count and concurrency budget and an explicit capability ceiling. A child handler cannot require authority outside its parent’s `allowedCapabilities`, even when the current scope resolver has a broader grant. `maxRuntimeMs` bounds each handler invocation; an explicit root `deadlineAt` bounds elapsed time across the whole tree and is inherited by children. Dependencies and global concurrency add further bounds. Each recurring occurrence starts an independent bounded subtree, so a long-lived routine does not exhaust its lifetime budget merely by firing normally. Cancelling a parent marks descendants cancelled and aborts running handlers through `AbortSignal`; this stops future work but does not undo side effects already applied. Child agents are implemented only by registering a scoped handler backed by the service's model/tool executor.

Watch templates are owner scoped and capped at 1,000 per owner. `listWatches`, `pauseWatch`, `resumeWatch`, and `removeWatch` provide scoped lifecycle controls. Template inputs, capabilities, retry policy, deadlines, and budgets are validated before persistence.

`enqueueWorkflow({ root, children })` atomically creates a root aggregation task and its bounded children. The root depends on every child, while each child belongs to the root for shared budgets, deadline inheritance, and cancellation propagation. A validation failure rolls back the entire tree.

The SQLite store uses a private exclusively owned file, transactions, dispatch compare-and-set, task leases, a stable logical-operation idempotency key, and durable progress. A second coordinator cannot open the live store. On restart, an interrupted external or unsafe handler becomes `unknown` and is not replayed. A task is requeued only when its handler is explicitly `resumable` and the task has an explicit retry policy with attempts remaining. Handlers should reconcile uncertain downstream state before retrying and pass the stable idempotency key to systems that support it.

Inputs and results are limited to 256 KB of JSON, capability and dependency lists are bounded, progress messages are limited to 4 KB, and each task retains at most 1,000 progress rows. Queries return at most 500 tasks. Terminal task records and watch-event deduplication keys expire after 90 days and are capped at 10,000 rows. Active and scheduled work is never removed by retention.

`personalSummary` uses SQL counts and stored payload byte lengths for tasks, watches, deduplicated watch events, and progress without decoding rows. `exportPersonal` pages the complete `user:<id>` task, watch, watch-event, and progress data in `ellie-task-runtime-v1` records, with at most four items per page. Since task input and result are each capped at 256 KB, this also bounds a page to a few megabytes without building a whole archive in memory. Cursors are capped at 1,000 bytes and offsets at one million. Every page is bound to the exact owner and owner generation; ordinary scheduler progress can invalidate a cursor, in which case export restarts from page one. Group-owned rows are never included.

Personal deletion is a journaled multi-store operation. `beginPersonalDeletion` optionally requires the generation shown during review, then durably freezes admission, removes watches, redacts persisted task input/results/progress, cancels pending work, marks running work `unknown`, reports those task IDs, and aborts their signals. `drainPersonalDeletion` waits up to five seconds per call and purges only after callbacks settle; the frozen operation resumes after restart. `completePersonalDeletion` releases the freeze only after the caller has deleted other stores. Repeated calls with the same operation ID are idempotent. A completed journal retains only minimal operational identity and timestamps; task IDs are cleared. This cannot undo or determine external side effects whose outcomes are unknown.

Call `tick()` for deterministic tests or host-driven scheduling. `start()` installs one unref'ed interval, `stop()` clears it and waits for active handlers, and `close()` stops and closes SQLite. A sleeping coordinator cannot deliver a timer; device-local alerts require a native scheduler. The runtime does not provide encryption, cross-device replication, distributed leases, OS notifications, or exactly-once external side effects.

`runNow` advances only active queued or scheduled work. It rejects terminal tasks rather than implying that succeeded, failed, cancelled, expired, or unknown work was repeated. A product-level rerun creates a new task or workflow with fresh inputs, authority checks, idempotency keys, and deadlines.

One-shot reminder changes use a durable replacement protocol. `prepareReplacement` creates a paused replacement and atomically holds the old task, so neither can dispatch during a cross-store record update. `activateReplacement` atomically cancels the old task and schedules the replacement. `discardReplacement` restores the held task when the record update fails. Each operation is scoped and idempotent by `operationId`; `getReplacement` supports restart recovery. The application journal must verify that the reminder record points at the replacement task before activation. An interrupted external effect still cannot be inferred from this protocol.
