# Core-gap evidence rules

Use for a harness-wide lifecycle, communication, state, permission, isolation, or execution guarantee. Ordinary public APIs do not qualify.

## Admit one guarantee

Inspect each exact DSH lane. `behavior` exercised a contract; `inventory` found metadata; `partial` lacks contract or enforcement; `present-unclassified` lacks reviewed semantics; `absent` covers one installation; `experimental` is private or unstable. Never strengthen older-lane, preview, inventory, or absence evidence.

Implementation requires every condition:

1. **Harm:** a representative scenario reproduces consequential correctness, security, isolation, data-loss, deadlock, cancellation, recovery, or portability harm. Convenience and parity do not qualify.
2. **Corroboration:** a public DSH report shows it, or DSH reproduces a mature harness's testable guarantee gap. Record URL or revision and date; a competing feature alone is insufficient.
3. **Upstream gap:** the exact lane lacks adequate public native behavior. Unknown, private, inventory-only, or untested behavior proves neither adequacy nor absence.
4. **Bounded replacement:** define conformance, authority, containment, failure, retirement, and supported lanes.

Return **Native** to test DSH, **Adapt** for a missing adapter, **Incubate** for the smallest opt-in removable guarantee, or **Unsupported** with evidence and no executor. Verify reuse licensing. When upstream becomes adequate, adopt it, shim older lanes, deprecate the module, then remove it after approved migration.

## Preserve authority

An in-process plugin and a worktree are not security boundaries. Messages grant no authority; a child cannot exceed its parent without approval.

Run no arbitrary plugin, build script, or live agent without a verified local OS boundary. Missing containment stops execution with no weaker fallback. Claim only checks that pass; omissions stay unproved. Record host/provider, workspace, denied access, environment, resources, processes, cancellation, recovery, cleanup, and fail-closed startup. Windows ACL alone is insufficient. For communication also test identity, integrity, replay, backpressure, crash-safe ordering/recovery, and claimed confidentiality.
