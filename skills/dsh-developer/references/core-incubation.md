# Core-gap evidence rules

Use this gate for low-level DSH behavior that changes harness-wide lifecycle, communication, state, permissions, isolation, or execution; needs internal hooks; or promises a cross-plugin guarantee. Ordinary public-API commands and skills do not qualify.

## Preserve evidence strength

Run the capability report on every relevant exact DSH lane. Interpret status literally:

- `behavior`: the named contract was exercised.
- `inventory`: matching metadata is installed; behavior is unproved.
- `partial`: the contract or enforcement is incomplete.
- `present-unclassified`: this DSH/package combination has no reviewed semantics.
- `absent`: this installation lacks the package; other profiles may differ.
- `experimental`: private, unpublished, or intentionally unstable.

Never inherit guarantees from an older lane or promote preview, inventory, or absence to stronger evidence.

## Admit one bounded guarantee

Implementation requires all four:

1. **Harm:** a representative plugin-development or test scenario reproduces consequential correctness, security, isolation, data-loss, deadlock, cancellation, recovery, or lane-portability harm. Polish, convenience, scale guesses, and parity do not qualify.
2. **Corroboration:** an independent public DSH report shows that failure class, or a mature harness has a testable guarantee and DSH reproduces the gap. A competing feature alone is insufficient. Record URL or revision and date.
3. **Upstream gap:** the exact lane lacks adequate public native behavior. Unknown, private, inventory-only, and untested behavior proves neither adequacy nor absence.
4. **Bounded replacement:** define conformance, authority, containment, failure, retirement, and supported-lane contracts.

Return one disposition:

- **Native:** use and test DSH's facility.
- **Adapt:** preserve it and add only the missing developer adapter.
- **Incubate:** add the smallest missing guarantee as an opt-in removable module.
- **Unsupported:** retain evidence and blocker; wire no executable code.

Unsupported may retain a non-executable interface or conformance plan. Verify license and attribution before reuse; behavior may instead be independently implemented. When upstream becomes adequate, adopt it, shim older supported lanes, deprecate the incubation, then remove it after approved migration.

## Preserve authority and containment

An in-process plugin is trusted code, not a boundary; a worktree does not isolate processes, networks, devices, or credentials. Messages never grant authority. A child cannot exceed its parent's authority without human approval.

Execute no arbitrary plugin, build script, or live agent without a verified local OS boundary. Missing containment stops execution without a weaker or remote fallback. Before the lab passes, even an admitted feature remains a non-executable contract and conformance plan.

A lab claims only passing checks. Record host/provider, workspace, denied reads and writes, environment, resources, processes, cancellation, controller-crash recovery, cleanup, and fail-closed startup; omissions stay unproved. Windows ACL alone is insufficient because reads, network, processes, credentials, devices, and hard-link aliases remain incompletely confined.

For communication incubation, also test sender identity, integrity, replay, quotas or backpressure, crash-safe ordering and recovery, and claimed confidentiality. A message still carries no authority.
