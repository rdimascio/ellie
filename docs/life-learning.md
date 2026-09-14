# Feedback and evaluation data

`@ellie/life-learning` captures explicit helpfulness ratings, corrections, and optional examples as ordinary scoped feedback records. A feedback submission writes no preference and runs no training job. Tone recognition remains temporary; durable preference changes require an explicit setting or teaching instruction.

`LifeLearning.record(actor, {scope, message, rating?, example?, trainingEligible?, relatedRecordId?})` returns a record with revision, authorship and optional same-scope relationship. Ratings are -1, 0 or 1. Examples contain an input prompt, the observed response, and an optional preferred response. They are retained only when explicitly supplied as feedback. The inspection window covers the latest 500 feedback records and reports possible truncation.

Examples default to excluded from export. `selectForExport` uses the record revision to change the selection. `exportExamples(actor, ids)` validates all selected records before returning up to 100 JSONL examples in the provider-neutral `ellie-feedback-v1` format. Only the actor’s own personal examples can be exported. Group records, other members’ records, deleted records and unselected examples are rejected. Revoking selection blocks future exports; it cannot recall a file already downloaded.

This provides a concrete collection and review step for evaluation, preference optimization, or a future reinforcement-learning pipeline. It does not alter model weights, run gradient training, upload a corpus, or claim that user satisfaction alone proves correctness. The export format is an Ellie interchange format and needs an explicit conversion and evaluation stage before use by a model-training provider.
