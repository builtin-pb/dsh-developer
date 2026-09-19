---
name: dsh-developer
description: "Use for any DSH plugin idea or development request, including DSH itself. Answer or inspect directly when no change is needed; otherwise implement and verify through the native project workflow."
whenToUse: "For DSH plugin and harness development requests, even when they do not name this skill."
---

# DSH Developer

## Understand and act

Choose **Answer** (advise), **Inspect** (read-only evidence), or **Build** (implement, repair and verify). Diagnosis supports Build when a repair is requested; support routes do not replace the mode. For Build, form a compact plan: outcome, files/effects, proof path, and material choices. Then implement, test, diagnose, and repair autonomously, preserving unrelated work.

Separate the user's purpose and explicit requirements from your interpretation, using project context. Ask only for consequential missing choices or authority; scoped reversible implementation is already authorized. Use conventions and reversible defaults for routine details; continue independent work while a necessary answer is pending. Answer and Inspect do not require a Build plan or authorize edits.

## Build decisions

Apply these decisions at the depth the uncertainty requires. They are not compulsory report sections.

### Choose a useful change

Start from what the person does and what should improve. Read project instructions, existing behavior and nearby implementations. Before creating a plugin, check whether configuration, an existing feature or an upstream correction meets the need. Treat a suggested mechanism as a candidate while preserving explicit requirements.

For vague intent or consequential design uncertainty, propose a useful shape and an everyday use. Challenge it with a grounded variation: could it work as specified yet leave the original frustration unresolved? Compare a different approach when consequential. Seek shared behavior that preserves useful variations and differences. One request can justify generality; hypothetical reuse cannot. Compare implementation, maintenance and effort left to the user; revise the design and success criteria accordingly.

### Implement coherent behavior

Trace a representative action through its entry point, authoritative state, owner and caller-visible result. Preserve important distinctions in the user's view and actions as well as state. Resolve relevant identity, order and precedence. Distinguish missing, incomplete and unsuccessful outcomes from success.

Reuse native owners and repository conventions. Give each resource, registration and cleanup one owner. Keep coupled behavior together; separate independently changing responsibilities. Extract shared rules or independent lifetimes. Judge simplicity by assumptions, exceptions and maintenance, not line count. Trust established internal contracts; validate uncertain boundaries. Error handling must recover usefully or report failure: `catch { return [] }` can turn an unavailable source into false success. Avoid speculative fallbacks; use maintained dependencies, native schemas and canonical results.

### Prove the useful result

Where interpretations disagree, construct a realistic distinguishing case. Derive its expected result from intent and the input producer's contract before implementation. A successful retry changes the latest outcome but need not erase failure history; establish which the user needs. Trace a consumer's omissions and defaults before using it as an oracle. Resolve contradictions against that evidence, not by copying actual output into assertions.

Exercise important contract-allowed failures and relevant state transitions through the public entry point; check retained state and caller-visible results. For stateful behavior, exercise changes in one running process, including relevant replacement, cancellation or unload. Look for a plausible way tests could pass while the original use still fails, and check it. When a failure changes your understanding, repair the responsible assumption and affected code, checks and documentation. Reuse revealing checks after changes; scale scrutiny to the uncertainty.

For installable deliverables, verify the documented setup and use from the recipient's starting state, using only delivered files and stated prerequisites.

## Native support

Use `dsh_developer` in DSH. Else use `DSH_DEVELOPER_BIN` or resolve `../../bin/dsh-developer.js` from this directory. Load references as needed.

- For Build, read [development](references/development.md) for project inspection, exact-source knowledge and host execution.
- Untrusted-source audit: Doctor first, then [safety](references/safety.md).
- Hooks: Hook Bridge Doctor first; classify exact installed bytes statically. Current and alpha bytes have partial contracts; never run or expand handlers or claim activation.
- Creator export: [contract](references/creator-export.md).
- Reviewed lanes: impact before upgrade edits; preflight before profile install.
- Permissions or delegated authority: [authority safety](references/authority-safety.md).
- Missing harness-wide guarantee incubated inside this plugin: [core-gap rules](references/core-incubation.md), or [lab gate](references/execution-lab.md) for execution.
- Native `cell-plan`/`cell-run`: [native cell](references/native-cell.md). Provider or executor development: [isolated cell](references/isolated-cell.md). Apply or recovery: [transaction](references/cell-apply.md).
- Before browser work: [agent-native route](references/agent-native-ui.md); admit its browser.
- Session failures: [diagnostics](references/session-diagnostics.md).

## Execution and proof

Trusted `run`, `verify` and `dev` follow host policy. Edit permission and metadata do not grant execution trust; disposable profiles isolate configuration only.

DeepSeek runs untrusted source only in the admitted host provider (WSL2/Bubblewrap on Windows; Apple container on supported Macs). Codex/GPT untrusted execution requires proven credential/network/write/process/cleanup isolation. Otherwise use static inspection.

Run relevant behavior tests and project checks; fully validate this product after integration. Ordinary plugins use static Doctor (`skipRuntime: true`, CLI `--skip-runtime`) plus `verify` on the target profile. Product/promoted bundles use `compatibility` and release gates; upstream uses its own checks. Repair failures and rerun that gate and all downstream gates affected by the change. Preserve valid evidence for unchanged code; never weaken safety to obtain a pass.

Runtime lanes: 0.1.5-rc.2 blocking, 0.1.6-alpha.1 advisory; providers need separate admission. Keep runtimes, examples, contracts and CI aligned. Historical migration and exact hook pins stay bounded. Other targets use exact-source development.

## Finish

Publishing, registry/provider/GitHub changes, personal profiles and wider targets need authority. Disposable profiles are in scope. Preserve ambiguous staging; schedule nothing after cancellation.

At completion, review the whole run against the user's intent: retries, setup friction, workarounds and verification gaps. Fix in-scope problems. Report material friction or a smooth result with evidence. Distinguish dsh-developer problems from target-code, upstream or environment problems. Offer to [report actionable dsh-developer friction](references/feedback.md); prepare and submit it after consent.

Return the answer or findings with evidence, assumptions and material limits. For Build, return the tested outcome—or an exact blocker and recovery.
