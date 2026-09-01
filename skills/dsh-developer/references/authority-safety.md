# Fixed-authority safety

Use this route for permission-argument failures or escalation loops in the current DSH agent. Fixed authority means at least one durable fact holds: the caller is a delegated child, approval policy is `never`, or sandbox mode is already `danger-full-access`.

## Admit the scope

Run in the affected agent:

    dsh_developer {"operation":"authority"}

Require `applies: true`, `ok: true`, a nonempty `authority.reasons`, at least one covered target, and `fixed-scope` for every reported shell or mutating-file tool. For an incident, also require the implicated tool. A proactive audit has no implicated tool. Evidence belongs only to the caller and current registry.

For child-lineage proof, run `dsh_developer {"operation":"delegation"}` in the child. If the caller is its parent, ask that child through DSH's supported subagent-control path to return the report. If the path or child is unavailable, return `DELEGATION_EVIDENCE_UNAVAILABLE` and stop. Never substitute parent evidence. Require durable `subagent` origin, positive delegation depth, parent session, and `applies: true`.

## Work inside fixed authority

dsh-developer projects effective authority onto `bash`, `pwsh`, `edit`, and `write` in the affected agent scope. It removes impossible escalation fields and guidance, strips stale `sandbox_permissions` and `justification` before invoking the upstream operation, and replaces an upstream denial hint with fixed-authority guidance. A top-level switch back to approval-capable, non-maximum authority restores the original tools.

This does not grant permission, request approval, change a preset, create a team, or alter another agent's tools. Canonical execution stays upstream and never receives stripped arguments. On denial, report the operation and smallest useful context; do not retry escalation arguments.

Treat an empty target set, absent incident tool, partial field pair, uninspectable schema, remaining escalation field or guidance, missing authority reason, or stale correction after a mutable switch as blocking. An unfamiliar schema is guarded rather than guessed.

## Follow upstream

This is a retirable compatibility correction, not a replacement for DSH lifecycle, approval, sandbox, or team primitives. Recheck exact release and preview lanes when those contracts change. Retire only after real-lifecycle evidence shows effective per-agent schemas, stale arguments cannot trigger no-op escalation failures, denial guidance is truthful, and permission switching restores the ordinary approval path.
