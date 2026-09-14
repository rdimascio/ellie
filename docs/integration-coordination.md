# Shared development release coordination

The release and Life tasks work toward one installable development candidate. One active scheduled coordinator resumes work every 30 minutes; the older overnight Life schedule stays paused. Life engineers continue in their existing task. An idle task receives a continuation only when it has an actionable unfinished item.

## Ownership

| Lane                | Owns                                                                                                                                                             | Handoff                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Release coordinator | Service dependency closure, packages, signing and trust, installer lifecycle, release channels, updates, health and rollback; shared integration and merge queue | Exact candidate source and artifact digest, supported runtime contract, acceptance results and remaining rollout gates                                 |
| Life integration    | Authenticated coordinator routes, user binding, native Life client access, Life runtime and UI, focused tests and Life documentation                             | Reviewed PR/head, API and grant contract, runtime entrypoint and dependencies, asset output path, configuration names, readiness and shutdown behavior |

Each task keeps one owner for each file and resumes existing agents before assigning new work. Overlapping files require an explicit handoff. The release coordinator owns this document and the delivery queue; the Life task owns its feature implementation checkpoint. Neither task changes the other's worktree.

## Integration and verification

Each handoff identifies the exact commit and base, owned files, dependencies, checks and retained evidence. Reuse passing evidence only when its source and relevant environment match. Each lane runs focused checks; the release coordinator runs the complete combined gate and serializes shared-main merges. A passing branch does not establish that an untested union passes.

Reserve expensive native builds, Simulator jobs and physical Mac acceptance through the release coordinator to avoid competing runs. Read-only review and focused independent work may continue alongside those gates. Contact the other task for a concrete dependency, blocker or completed handoff; unchanged status does not need another message or another full test run.

Life packaging follows the authenticated API boundary. Paired clients reuse coordinator enrollment and scoped grants; the existing loopback-only Life server is not exposed remotely as a shortcut. The release coordinator adds the reviewed runtime/UI closure to packages and updates trusted inventory definitions when required.

Development artifact preparation does not establish installed-service acceptance. Keep exact source and artifact identities, synthetic tests, physical execution, owner-reported acceptance and deployment evidence distinct. A live migration requires a concrete reviewed rollout with identity preservation, health checks and recovery. Existing identities, credentials, permissions and user work remain preserved.
