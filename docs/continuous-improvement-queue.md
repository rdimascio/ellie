# Continuous improvement queue foundation

Ellie's first continuous-improvement controller slice is a private durable queue, not an autonomous release system. It accepts one reviewed input format and policy: the `memory` scenario in a version 1 Life browser-quality report, lane `life-quality`, scope `repository:ellie`. Only `fail` and `error` observations enter the queue. A passing mechanical check is never converted into semantic acceptance.

The queue stores the report reference and SHA-256, source commit, runner, fixture/evaluator and built-UI hashes, scenario and observed status. Its deduplication key covers the lane, scope, scenario, source, runner, evaluator and built artifact, so a repeated observation of the same inputs keeps one item. It deliberately omits report checks, commands, diagnostics, screenshots, snapshots and other raw trace content. The adapter reads a canonical, regular owner-only file no larger than 1 MiB and fails on malformed or unsupported evidence.

The queue requires an explicit canonical private state directory outside every Git checkout and outside `~/.ellie`, so it does not share coordinator, node or household identities. Opening and every operation revalidate the state directory and database device/inode identities plus any SQLite journal, WAL or shared-memory sidecars. Symlink ancestors and unsafe sidecars fail closed. These checks protect trusted local-owner operation from accidental redirection and replacement. They are not an isolation boundary against malicious code already running as the same user.

Use Node 24 and pass the private directory on every operation:

```sh
bun run improvement:queue enqueue \
  --state-dir /absolute/private/improvement-state \
  --receipt /absolute/private/quality-run/report.json

bun run improvement:queue status --state-dir /absolute/private/improvement-state

bun run improvement:queue claim \
  --state-dir /absolute/private/improvement-state \
  --owner worker-1 --lease-ms 1200000
```

`record-result` requires the item, owner and lease identifiers, a stable result key, the originating receipt SHA-256 and a separate private result evidence file and SHA-256. The queue safely opens the canonical owner-only file within the same 1 MiB bound and verifies its hash before storing only the reference and digest. Candidate outcomes additionally require an asserted commit and HTTPS review reference. The queue does not contact Git or GitHub, verify that assertion or treat it as merge evidence. Repeating the identical result is idempotent; changing any recorded outcome field fails. A candidate ends in `candidate_recorded` with `awaiting_release_owner`, an unverified proposal that is never merge admission.

Claims are transactionally serialized. A restart retains the same item and unexpired owner lease. An expired, failed or timed-out lease moves to `reconciliation_required`, keeps its owner and lease identifiers, and cannot be claimed again. The original owner may still use the manual result operation to record a verified local evidence file against that exact lease. A local operator may use `mark-blocked` with another safely hashed private evidence file; its role and identifier are audit attribution, not authentication or authorization. There is no requeue operation in this slice. A timeout, lease expiry or user-supplied evidence string can never free uncertain work for another dispatch.

The `ImprovementWorker` interface receives only fixed queue metadata: item, lane, scope, selected scenario, source and evidence hashes, bounded attempt/runtime data and lease identity. It never receives report commands, arbitrary instructions or shell text. `runClaimedWork` races the worker against the durable lease deadline, aborts at the boundary and returns even when a worker ignores its signal. Failure, timeout and invalid result evidence quarantine the same lease; late settlement is observed and discarded. Worker registration, process creation and resource reservation remain controller-host responsibilities.

Remaining work is explicit: add separately reviewed adapters and policy entries for other scenarios or evidence formats; implement event discovery and periodic reconciliation; add a registered reconciler that can establish worker settlement and external-effect state before any retry; add isolated checkout allocation and registered worker launch; add evaluator and held-out evidence handling; create candidate PRs through a reviewed adapter; and define promotion records tied to exact tested commits and artifacts. The stored attempt budget reserves a bound for that future reconciled retry path but cannot trigger another attempt today. Merge, packaging, deployment, rollback, permission-policy changes and acceptance remain protected release-owner operations. No automatic promotion is enabled by this foundation.
