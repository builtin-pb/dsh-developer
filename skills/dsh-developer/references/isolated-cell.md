# Isolated-agent-cell admission

Use for a separately owned child workspace needing whole-environment containment. DSH retains lifecycle and orchestration.

## Run

DSH Web:

    /dsh-developer-admit-cell {"distro":"Ubuntu-22.04"}

CLI:

    node bin/dsh-developer.js admit-cell --dsh <path-to-dsh> --wsl-distro Ubuntu-22.04

This keyless gate reruns capabilities and lab conformance, exercises public `childSessionMeta`, and inspects the sandbox contract. It never runs a model, source, build script, or caller workload.

`--dsh` is trusted input and must match the package-declared CLI; local identity is not registry-integrity proof.

## Interpret

- `Incubate`: all core-gap conditions pass; wire only the named removable boundary.
- `Unsupported`: retain evidence and blocker; expose no executor.
- Preview admission is non-blocking preview evidence.

Lab PASS alone does not admit the feature. Preserve capability, lab, and admission digests. The guarantee covers a disposable workspace, credential-free environment, no network, resource bounds, cancellation, recovery, and cleanup. It excludes lifecycle and orchestration.

## Executor contract

Pass the opaque grant from `inspectIsolatedCellAdmission()` to `openIsolatedCell()` from `dsh-developer/isolated-cell`. Copies, fabrication, unsupported results, and missing providers fail closed. The report fixes provider/distro. Allow one cell per plugin process and one operation per cell.

Import only a bounded ordinary UTF-8 text tree. Run sequentially, call `stageResult()` once, then await `dispose()` in `finally`. Sealing stages a complete tree and changes without altering source. The caller removes the exact `stagingRoot`. Cancellation and limit failures dispose before returning.

Growth threshold: 8 MiB or 2,048 entries. Conformance must prove cgroup termination within 16 MiB and 4,096-entry ceilings for byte and zero-byte-entry attacks, then root removal. Never bypass grant, capacity, transfer, staging, serialization, or cleanup checks.

When public DSH is equivalent, adopt it, shim older lanes, deprecate this module, then remove it after approved migration.
