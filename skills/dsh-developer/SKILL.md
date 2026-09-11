---
name: dsh-developer
description: "Use for any DSH plugin idea or development request, including DSH itself. Answer or inspect directly when no change is needed; otherwise implement and verify through the native project workflow."
whenToUse: "For DSH plugin and harness development requests, even when they do not name this skill."
---

# DSH Developer

## Understand and act

Establish the outcome from conversation and workspace. Choose **Answer** (advise), **Inspect** (read-only evidence), or **Build** (implement, repair, test, package). For Build, form a compact plan: outcome, files/effects, proof path, and material choices. Then implement, test, diagnose, and repair autonomously, preserving unrelated work.

For a vague idea, propose the capability and state assumptions. Inspect existing configuration, skills, integrations and services before creating a plugin. Try a plausible follow-up change before inventing a framework. Ask only for consequential unresolved choices or missing authority. Implementation requests authorize scoped reversible edits; do not ask again.

## Select the workflow

Use `dsh_developer` in DSH. Else use `DSH_DEVELOPER_BIN` or resolve `../../bin/dsh-developer.js` from this directory. Load references as needed.

- Create or change plugins or DSH: [development](references/development.md) owns project inspection, exact-source knowledge and host execution.
- Untrusted-source audit: Doctor first, then [safety](references/safety.md).
- Hooks: Hook Bridge Doctor first; classify exact installed bytes statically, never run or expand handlers or claim activation.
- Creator export: [contract](references/creator-export.md).
- Reviewed lanes: impact before upgrade edits; preflight before profile install. Other targets: inspect exact-source changes with `knowledge`, then `verify`.
- Permissions or delegated authority: [authority safety](references/authority-safety.md).
- Missing harness-wide guarantee incubated inside this plugin: [core-gap rules](references/core-incubation.md), or [lab gate](references/execution-lab.md) for execution.
- Native `cell-plan`/`cell-run`: [native cell](references/native-cell.md). Provider or executor development: [isolated cell](references/isolated-cell.md). Apply or recovery: [transaction](references/cell-apply.md).
- UI: [agent-native route](references/agent-native-ui.md); admit its browser.
- Session failures: [diagnostics](references/session-diagnostics.md).

## Execution and proof

Edit authority does not itself grant execution trust. Ordinary trusted development uses the calling host’s real execution policy. `run`, `verify` and `dev` are CLI execution, never permission supplied by metadata or model fields. A disposable profile separates configuration; it is not a sandbox.

DeepSeek runs untrusted source only in the admitted host provider (WSL2/Bubblewrap on Windows; Apple container on supported Macs). Codex/GPT untrusted execution requires proven credential/network/write/process/cleanup isolation. Otherwise use static inspection.

Run relevant behavior tests and project checks; complete this product’s full validation after integration. Ordinary plugins use static Doctor (`skipRuntime: true`, CLI `--skip-runtime`) plus `verify` on the target profile. Product/promoted bundles use `compatibility` and release gates; upstream uses its own checks. Repair failures and rerun that gate and all downstream gates affected by the change. Preserve valid evidence for unchanged code; never weaken safety to obtain a pass.

Audit/isolated lanes: DSH 0.1.1-rc.2 (blocking) and 0.1.2-alpha.3 (advisory). Other exact versions use ordinary development without certification.

## Finish

Publishing, registry/provider/GitHub changes, existing user profiles and wider targets need their own authority. Disposable development profiles belong to the authorized test workflow. Preserve ambiguous staging; schedule nothing after cancellation.

Return the answer or findings with evidence, assumptions and material limits. For Build, return the tested outcome—or an exact blocker and recovery.
