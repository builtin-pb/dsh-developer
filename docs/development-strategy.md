# Product development strategy

The product is one DSH development workflow for plugin authors and contributors working on DSH itself. Start from the user's existing project and intended outcome; use configuration or an existing service when sufficient, implement a focused extension when needed, and carry authorized work through tests, diagnosis and repair.

## Complete useful work

The native workflow now connects project inspection, exact-source `knowledge`, host-policy script execution, disposable-profile `verify`, managed Web `dev`, session diagnostics and artifact checks. Keep these operations usable from both the DSH tool registry and the CLI. A user should be able to create or adopt a plugin, diagnose a failure, make a maintenance change, and test the package someone else will install. Follow the upstream checkout's own build and test gates when changing DSH.

Keep examples small enough to understand and realistic enough to expose integration failures. The maintained tool and Client examples compile against DSH `0.1.5-rc.2`. Their dependency pins come from the selected runtime's peer closures plus necessary published type packages, with installation and runtime checks providing separate evidence. New APIs or Client tables need review against actual installed declarations and implementations; package names and version labels alone do not establish compatibility.

## Stay current as one product

The blocking runtime is DSH `0.1.5-rc.2`; `0.1.6-alpha.2` is advisory. Keep native registry integration, public contracts, reviewed Client tables, examples, lockfiles, Creator exports, skill routes, documentation and CI synchronized. Inspect exact consuming package roots, include installed optional peers where required, and verify that proposed versions exist before changing pins. Never substitute current upstream documentation for a different installed version.

Exact audit jobs retain reviewed version pins. Native development CI installs `latest`, `next` and `alpha` and records the resolved package versions with each run. Use that moving coverage to detect changes early; require contract review and relevant runtime evidence before advancing the blocking baseline.

Keep historical contracts explicit. The migration ledger covers only `0.1.1-rc.2` → `0.1.2-alpha.3`; Hook Bridge Doctor independently pins reviewed current, alpha and historical bytes. Historical support is not a recommendation to downgrade. Updating these contracts requires evidence specific to their behavior.

## Match claims to evidence

Current headless/Web preflight and native verification, product compatibility, delegation and approval checks passed on rc.2 and alpha.2. These checks cover the exercised contracts, not every plugin, host, browser behavior or model. Client registry tests and static bundle checks complement rendered browser verification; they cannot replace it.

Ordinary trusted development follows the host's execution policy. Disposable profiles separate configuration and do not provide a sandbox. Untrusted execution requires an admitted provider with explicit credential, network, filesystem, process, transfer and cleanup boundaries. Real Apple integration on rc.2 passed 4/4 checks covering native admission, VM Build/Apply, promotion, and sparse/churn cleanup. That observation requires the [documented Mac provider](macos.md#enable-isolated-build-and-apply) and does not establish alpha isolation or admission on another host.

Distinguish current source from the published Git tag, and native runtime results from provider and rendered-browser results. Keep the [verification record](verification.md) and front-door docs accurate when evidence changes. Preserve failures and skipped checks as such. Publication, external submissions and changes to a user's existing profiles remain separately authorized actions.

## Prioritize demonstrated friction

Improve exact-source navigation, setup and recovery, native tool and Client workflows, and maintenance after upstream changes. Repair a recurring gap in its owning subsystem and callers before adding another abstraction. Extend isolation only when a concrete workload needs it and its boundaries can be demonstrated; keep private evaluation material outside public artifacts.

Evaluate complete tasks and a plausible follow-up change under comparable models, tools, permissions and budgets. Record completion, time to working behavior, interventions, setup failures and maintenance effort. Independent review and repeated agent trials answer questions that deterministic tests cannot. Passing CI establishes the checked contracts; it does not establish adoption or universal reliability.

The [development guide](development.md) owns the execution workflow, [Contributing](contributing.md) owns the maintenance policy, and the [platform guide](platforms.md) records host and provider requirements.
