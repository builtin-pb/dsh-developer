---
name: dsh-developer
description: "Use for any DSH plugin idea, repository, bug, upgrade, audit, UI, test, or release request. Answer or inspect directly when no change is needed; otherwise plan effects and proof, then implement, repair, and verify."
whenToUse: "For requests to create, change, diagnose, test, harden, upgrade, package, or ship a DSH plugin, even when they do not name this skill."
---

# DSH Developer

## Start from conversation

1. Extract outcome, target, constraints, profile, trust, effects, and DSH lanes; discover first.
2. Choose **Answer** (advise), **Inspect** (read-only evidence), or **Build** (change, repair, upgrade, test, package).
3. For Build, inspect for a compact plan: outcome, files/effects, proof path, and material choices. Ask only what changes result or authority. Obtain approval before mutation; same-scope approval counts.
4. Then implement, test, diagnose, and repair autonomously; keep one accountable agent and omit mechanics.

## Route specialized work

Load one reference family per response; safety may join it. Resolve authority first.

- Audit: Doctor first; load [safety](references/safety.md) for untrusted source.
- Creator export: load [the contract](references/creator-export.md); state its new-directory effect.
- Upgrade: impact before edits; declare attachments when inference is incomplete.
- Target profile: preflight before installation.
- Trusted candidate: exact compatibility; execute trusted bytes only.
- Permission/fixed-authority/delegated issue: load [authority safety](references/authority-safety.md).
- Core gap: load [core-gap rules](references/core-incubation.md), or [the lab gate](references/execution-lab.md) if execution-bearing.
- Owned child: load [the isolated-cell contract](references/isolated-cell.md).
- UI: load [the agent-native route](references/agent-native-ui.md); admit its browser.

Approval covers edits, not execution trust. DeepSeek runs untrusted source only in an admitted Bubblewrap-backed cell. Codex/GPT requires proven credential/network/write/process/cleanup isolation. Otherwise use static proof; never execute to inspect.

## Implement, prove, repair

Use workspace tools: `dsh_developer`/protected `dsh_ui` in DSH, otherwise `DSH_DEVELOPER_BIN`.

For approved execution in the current top-level DSH Agent:

1. `cell-plan`: outcome plus 1–4 exact commands/timeouts. It accepts no path/cwd/profile/env/provider/mount/network/session; source is the exact live `exec.agent` in `agents.roots()`, never cwd.
2. A plan is not approval. `cell-run` accepts only its digest after audited `tools/pre-execute` grants the displayed plan once; conversation/fields cannot. One admitted offline, credential-free cell runs commands in order without source/profile writes.
3. Return allowlisted, bounded, secret-scanned diagnostics and redacted nonzero-command evidence. Changes use one opaque controller-owned stage outside source/profile; prefixes never prove ownership. Only `cell-discard` releases capacity after identity/fingerprint proof. Missing, moved, replaced, or ambiguous roots stay poisoned; verified deletion ignores caller cancellation. Native actions reject missing/delegated Agents, drift, reruns, and resume.

Use every applicable gate in order:

1. Inspect; use static Doctor until trust is proven.
2. Make one authorized edit set; preserve unrelated work.
3. Run narrow tests, full validation, then Doctor on the unchanged tree.
4. Add preflight, impact, and trusted compatibility when relevant.
5. Repair and rerun that gate and all downstream gates; never weaken safety or evidence.

DSH 0.1.1-rc.2 blocks; 0.1.2-alpha.3 advises. `--skip-runtime` only explores. Inventory is metadata; behavior is exercised; absence is local.

## Authority and finish

Approved edits need no repeat approval. Publishing, registry/profile/provider/GitHub, and wider targets need separate authority.

Answer ends with the answer and assumptions. Inspect ends with findings, evidence, and risks. Build ends with a tested outcome and proof—or an exact blocker and recovery. Preserve ambiguous staging; schedule nothing after cancellation.
