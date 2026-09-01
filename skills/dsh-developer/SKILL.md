---
name: dsh-developer
description: "Use for any DSH plugin idea, repository, bug, upgrade, audit, UI, test, or release request. Answer or inspect directly when no change is needed; for changes, extract the goal, propose an effects-and-proof plan, then implement, repair, and verify it in DSH or Codex."
whenToUse: "Whenever the user asks about creating, changing, diagnosing, testing, hardening, upgrading, packaging, or shipping a DSH plugin, even when they do not name this skill."
---

# DSH Developer

## Start from conversation

1. Extract outcome, target, constraints, profile, trust, effects, and DSH lanes; discover before asking.
2. Route to **Answer** (advise), **Inspect** (read-only evidence), or **Build** (change, repair, upgrade, test, package).
3. For Build, inspect enough for a compact plan: outcome, files/effects, proof path, and material choices. Ask only what changes result or authority. Obtain approval before mutation; same-scope approval counts.
4. Then implement, test, diagnose, and repair autonomously. Keep one accountable agent; omit mechanics and diary.

## Route specialized work

Load one reference family per response; safety may accompany it. Resolve authority first.

- Repository/audit: Doctor first; for untrusted source load [safety](references/safety.md).
- Creator export: load [the export contract](references/creator-export.md); state the new-directory effect.
- Upgrade: impact before edits; declare attachments when inference is incomplete.
- Target profile: preflight before installation.
- Trusted candidate: exact compatibility; execute only trusted bytes.
- Permission/fixed-authority/delegated issue: load [authority safety](references/authority-safety.md) first.
- Non-executing core gap: load [core-gap rules](references/core-incubation.md); execution-bearing core work loads [the lab gate](references/execution-lab.md).
- Owned child workspace: load [the isolated-cell contract](references/isolated-cell.md).
- UI: load [the agent-native route](references/agent-native-ui.md); admit the browser first.

Approval permits edits, not execution trust. DeepSeek runs untrusted source only in an admitted Bubblewrap-backed cell. Codex/GPT needs proven credential/network/write/process/cleanup isolation. Otherwise use static proof; never execute merely to inspect.

## Implement, prove, repair

Use workspace tools. In DSH use `dsh_developer`/protected `dsh_ui`; elsewhere use `DSH_DEVELOPER_BIN`.

For approved repository execution in the current top-level DSH Agent:

1. `cell-plan`: outcome + 1–4 commands/timeouts. No path/cwd/profile/env/provider/mount/network/session; source is the exact live `exec.agent` in `agents.roots()`; no cwd fallback.
2. Plan is not approval. `cell-run` takes only its digest after audited `tools/pre-execute` grants the rendered plan once; conversation/fields cannot. One network/credential-free admitted cell runs commands sequentially, never source/profile writes.
3. Return allowlisted, bounded, secret-scanned diagnostics and compact redacted nonzero-command evidence. Changed bytes use one opaque controller-owned stage outside source/profile; a prefix is never ownership. `cell-discard` alone releases capacity after identity/fingerprint proof; missing, moved, replaced, or ambiguous roots stay poisoned, while verified deletion drains caller cancellation. Native-only actions reject missing/delegated Agents, drift, reruns, and resume.

Use every applicable gate in order:

1. Inspect; use static Doctor while trust is unproven.
2. Make one authorized edit set; preserve unrelated work.
3. Run narrow tests, full validation, then Doctor on the final unchanged tree.
4. Add profile preflight, impact, and trusted compatibility when relevant.
5. Repair failures and rerun that gate and all downstream gates; never weaken safety or evidence.

DSH 0.1.1-rc.2 blocks; 0.1.2-alpha.3 advises. `--skip-runtime` explores only. Inventory is metadata; behavior is exercised; absence is local.

## Authority and finish

Approved edits need no repeat approval. Publishing, registry/profile/provider/GitHub actions, and wider targets need separate authority.

Answer ends with the answer and assumptions. Inspect ends with findings, evidence, and risks. Build ends with a tested outcome and proof—or an exact blocker and recovery. Preserve ambiguous staging; schedule nothing after cancellation.
