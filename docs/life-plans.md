# Life plans

`@ellie/life-plans` stores a checklist as one ordinary `goal` record marked with `data.type = "life-plan-v1"`. A plan has a title of at most 200 characters and one through 24 steps. Each step has a stable opaque ID, a title of at most 500 characters, and a boolean completion value; combined step text is limited to 8,000 characters. The record's top-level `data.completed` value must equal whether every step is complete.

`LifePlans.create`, `get`, `list`, `find`, and `setStep` enforce the actor's current user or group access through `LifeStore`. Step updates replace the checklist in one record revision transaction and require `expectedRevision`. Plans do not enqueue tasks, send reminders, or imply that Ellie performed a step. Ordinary record deletion removes a plan and existing personal export/reset behavior includes it as one record.

Lists filter the plan marker in SQL before applying their bound and return `{ plans, hasMore, unavailableCount }`. Exact-title lookup filters in SQL and rejects ambiguous names. A space may contain at most 64 marker records, including malformed records, so corrupt marker data cannot bypass the cap. `planDetails` is the shared fail-closed projector: malformed marker rows are omitted from plan lists and counted as unavailable instead of hiding valid plans.
