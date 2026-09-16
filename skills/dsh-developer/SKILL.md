---
name: dsh-developer
description: "Use for any DSH plugin idea or development request, including DSH itself. Answer or inspect directly when no change is needed; otherwise implement and verify through the native project workflow."
whenToUse: "For DSH plugin and harness development requests, even when they do not name this skill."
---

# DSH Developer

## Understand and act

Choose **Answer** (advise), **Inspect** (read-only evidence), or **Build** (implement, repair, test, package). For Build, form a compact plan: outcome, files/effects, proof path, and material choices. Then implement, test, diagnose, and repair autonomously, preserving unrelated work.

Inspect existing facilities before creating a plugin. Resolve vague ideas with a small proposal and stated assumptions. Ask only for consequential missing choices or authority; scoped reversible implementation is already authorized.

## Select the workflow

Use `dsh_developer` in DSH. Else use `DSH_DEVELOPER_BIN` or resolve `../../bin/dsh-developer.js` from this directory. Load references as needed.

- Create or change plugins or DSH: [development](references/development.md) owns project inspection, exact-source knowledge and host execution.
- Untrusted-source audit: Doctor first, then [safety](references/safety.md).
- Hooks: Hook Bridge Doctor first; classify exact installed bytes statically. Current and alpha bytes have partial contracts; never run or expand handlers or claim activation.
- Creator export: [contract](references/creator-export.md).
- Reviewed lanes: impact before upgrade edits; preflight before profile install.
- Permissions or delegated authority: [authority safety](references/authority-safety.md).
- Missing harness-wide guarantee incubated inside this plugin: [core-gap rules](references/core-incubation.md), or [lab gate](references/execution-lab.md) for execution.
- Native `cell-plan`/`cell-run`: [native cell](references/native-cell.md). Provider or executor development: [isolated cell](references/isolated-cell.md). Apply or recovery: [transaction](references/cell-apply.md).
- UI: [agent-native route](references/agent-native-ui.md); admit its browser.
- Session failures: [diagnostics](references/session-diagnostics.md).

## Execution and proof

Trusted `run`, `verify` and `dev` use host execution policy. Edit authority, metadata and model fields do not grant execution trust. A disposable profile separates configuration; it is not a sandbox.

DeepSeek runs untrusted source only in the admitted host provider (WSL2/Bubblewrap on Windows; Apple container on supported Macs). Codex/GPT untrusted execution requires proven credential/network/write/process/cleanup isolation. Otherwise use static inspection.

Run relevant behavior tests and project checks; fully validate this product after integration. Ordinary plugins use static Doctor (`skipRuntime: true`, CLI `--skip-runtime`) plus `verify` on the target profile. Product/promoted bundles use `compatibility` and release gates; upstream uses its own checks. Repair failures and rerun that gate and all downstream gates affected by the change. Preserve valid evidence for unchanged code; never weaken safety to obtain a pass.

Runtime lanes: 0.1.5-rc.2 blocking, 0.1.6-alpha.1 advisory; provider admission remains separate. Keep registry knowledge, examples, contracts and CI current together. Historical migration stays bounded; hook contracts pin exact bytes. Other targets use exact-source ordinary development.

## Finish

Publishing, registry/provider/GitHub changes, existing user profiles and wider targets need their own authority. Disposable development profiles belong to the authorized test workflow. Preserve ambiguous staging; schedule nothing after cancellation.

Return the answer or findings with evidence, assumptions and material limits. For Build, return the tested outcome—or an exact blocker and recovery.
