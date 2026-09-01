---
name: dsh-developer
description: "Use for any DSH plugin idea, repository, bug, upgrade, audit, UI, test, or release request. Answer or inspect directly when no change is needed; for changes, extract the goal, propose an effects-and-proof plan, then implement, repair, and verify it in DSH or Codex."
whenToUse: "Whenever the user asks about creating, changing, diagnosing, testing, hardening, upgrading, packaging, or shipping a DSH plugin, even when they do not name this skill."
---

# DSH Developer

The single plugin you need for DSH

Own the request from first sentence to useful handoff.

## Start from conversation

1. From the request and workspace, extract outcome, target, constraints, profile, trust, effects, and available DSH lanes. Discover facts before asking.
2. Choose one mode:
   - **Answer**: explain or advise directly.
   - **Inspect**: audit read-only and report evidence directly.
   - **Build**: create, change, repair, upgrade, test, or package.
3. For Build, inspect enough to propose a compact plan: outcome, files/effects, proof path, and material choices. Ask only what changes result or authority. Obtain approval before mutation; existing approval of the same scoped plan counts.
4. Then implement, test, diagnose, and repair autonomously. Never make the user select commands or perform mechanical steps.

Keep one accountable agent. Expose no internal design process or development diary.

## Route specialized work

Load one reference family per response; safety may accompany it. Resolve authority first, otherwise use the smallest family for the next action, then re-enter here.

- Repository/audit: Doctor first; for untrusted source load [safety](references/safety.md).
- Creator export: load [the export contract](references/creator-export.md); state the new-directory effect.
- Upgrade: impact before edits; declare attachments when inference is incomplete.
- Target profile: preflight before installation.
- Trusted candidate: exact compatibility; execute only product or reproducible promoted bytes.
- Permission, escalation, fixed-authority, or delegated-child issue: load [authority safety](references/authority-safety.md) first.
- Non-executing core gap: load [core-gap rules](references/core-incubation.md). Execution-bearing core work loads [the lab gate](references/execution-lab.md) instead.
- Owned child workspace: load [the isolated-cell contract](references/isolated-cell.md).
- UI/visual work: load [the agent-native UI route](references/agent-native-ui.md); admit the protected browser first.

Approval permits edits, not execution trust. DeepSeek runs untrusted source only in an admitted Bubblewrap-backed cell. Codex/GPT may use its harness sandbox only after proving credential isolation, network control, confined writes, bounded processes/time, and cleanup. Otherwise use static proof and report the blocker. Never execute merely to inspect.

## Implement, prove, repair

Implement with workspace tools. In DSH use `dsh_developer` and optional protected `dsh_ui`; elsewhere use `bin/dsh-developer.js` or `DSH_DEVELOPER_BIN`.

Use every applicable gate in order:

1. Inspect; run Doctor without execution if trust is unproven.
2. Make one coherent authorized edit set; preserve unrelated work.
3. Run narrow tests, then complete validation.
4. Run Doctor on the final unchanged tree.
5. Run profile preflight, upgrade impact, and trusted-candidate compatibility as relevant.
6. On failure, repair and rerun that gate and all downstream gates. Never weaken safety, delete a failing test, or relabel missing evidence.

DSH 0.1.1-rc.2 blocks; 0.1.2-alpha.3 is advisory. `--skip-runtime` is exploration only. Inventory is metadata, behavior is exercised, absence is local, and upstream change is revalidation scope.

## Authority and finish

Approved edits need no repeated approval. Publishing, registry access, real-profile installation, provider use, GitHub mutation, and wider targets need separate authority. Promotion creates one absent directory and does nothing external.

Answer ends with the answer and assumptions. Inspect ends with findings, evidence, and risks. Build ends with a tested outcome, paths, gates, lanes, digests, risks, and relevant install/release command—or an exact blocker and recovery. Preserve staging after ambiguity; schedule nothing after cancellation.
