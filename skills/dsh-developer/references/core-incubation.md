# Core-gap evidence rules

Use this gate for low-level behavior that changes harness-wide lifecycle, communication, state, permissions, isolation, or execution; needs internal hooks; or promises a cross-plugin guarantee. Ordinary public APIs do not qualify.

## Preserve evidence strength

Inspect every relevant exact DSH lane. `behavior` exercised the contract; `inventory` found metadata only; `partial` lacks contract or enforcement; `present-unclassified` has no reviewed semantics; `absent` describes only this installation; `experimental` is private or unstable. Never inherit an older lane's guarantees or strengthen preview, inventory, or absence.

## Admit one bounded guarantee

Implementation requires all four:

1. **Harm:** a representative scenario reproduces consequential correctness, security, isolation, data-loss, deadlock, cancellation, recovery, or portability harm. Polish, convenience, scale guesses, and parity do not qualify.
2. **Corroboration:** a public DSH report shows the failure, or a mature harness has a testable guarantee whose gap DSH reproduces. A competing feature alone is insufficient. Record source revision/URL and date.
3. **Upstream gap:** the exact lane lacks adequate public native behavior. Unknown, private, inventory-only, or untested behavior proves neither adequacy nor absence.
4. **Bounded replacement:** define conformance, authority, containment, failure, retirement, and supported-lane contracts.

Return one disposition: **Native** uses/tests DSH; **Adapt** adds only a missing adapter; **Incubate** adds the smallest opt-in removable guarantee; **Unsupported** retains evidence and blocker but no executor. Unsupported may retain a non-executable contract.

Verify license and attribution before reuse. Once upstream is adequate, adopt it, shim older lanes, deprecate this module, then remove it after approved migration.

## Preserve authority and containment

An in-process plugin is trusted code, not a boundary. A worktree does not isolate processes, network, devices, or credentials. Messages grant no authority; a child cannot exceed its parent without human approval.

Run no arbitrary plugin, build script, or live agent without a verified local OS boundary. Missing containment stops execution; no weaker or remote fallback. Until the lab passes, an admitted feature stays non-executable.

Claim only passing checks. Record host/provider, workspace, denied reads/writes, environment, resources, processes, cancellation, crash recovery, cleanup, and fail-closed startup; omissions are unproved. Windows ACL alone is insufficient. For communication, also test identity, integrity, replay, backpressure, crash-safe ordering/recovery, and claimed confidentiality.
