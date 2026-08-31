# Delegated-child authority

Use this route only for a durable DSH child whose session header identifies a `subagent`, a positive delegation depth, and a parent session. Do not infer delegation from a name, prompt, or model.

## Admit the scope

Run from the affected agent:

    dsh_developer {"operation":"delegation"}

If the current caller is the parent or another top-level agent, ask the affected child through DSH's supported subagent-control path to run the operation and return its report. If that path or child is unavailable, return `DELEGATION_EVIDENCE_UNAVAILABLE` and stop. Never substitute parent-scoped evidence.

Always require `applies: true`, `ok: true`, at least one covered target, and `fixed-scope` for every reported shell or mutating-file tool. For an incident, also require the implicated tool to be present. A proactive audit has no implicated tool. Evidence is scoped to the caller and current registry; a top-level PASS only says the correction is not applicable.

## Work inside fixed authority

dsh-developer corrects a current contract mismatch: a delegated child can have fixed authority while `bash`, `pwsh`, `edit`, or `write` still advertise `sandbox_permissions` and `justification`. For that child only, the plugin removes both impossible fields and their escalation guidance. A runtime guard also denies hidden attempts to supply either field.

This does not grant permission, request approval, change DSH's permission mode, create an agent team, or alter parent tools. Ordinary calls keep the upstream implementation and output contract. On a sandbox denial, stop retrying escalation arguments and report the denied operation to the parent with the smallest useful context.

Treat missing lineage, an empty target set, an incident's absent implicated tool, a partial field pair, an uninspectable schema, or any remaining escalation field as blocking. Do not weaken the classifier or shadow an unfamiliar schema to pass.

## Follow upstream

This is a narrow compatibility correction, not a replacement for DSH agent lifecycle or team primitives. Recheck exact release and preview lanes when DSH changes child policy or tool schemas. Prefer the upstream contract once fixed authority is represented directly in child-visible schemas; retire the correction only after real-lifecycle evidence shows the impossible fields are absent and hidden escalation attempts still cannot widen authority.
