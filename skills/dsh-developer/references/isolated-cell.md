# Isolated-agent-cell admission

Use only for a separately owned child workspace with whole-environment containment. DSH still owns subagent lifecycle, Team roster/mailbox/tasks, and orchestration.

## Run

DSH Web:

    /dsh-developer-admit-cell {"distro":"Ubuntu-22.04"}

CLI:

    node bin/dsh-developer.js admit-cell --dsh <path-to-dsh> --wsl-distro Ubuntu-22.04

This keyless gate reruns capability and lab conformance, exercises only installed public `childSessionMeta`, inspects the sandbox contract, and records dated public evidence. It never runs a model, repository, build script, or caller workload.

`--dsh` is trusted input, not a sandbox subject. Review provenance first. It must match the package's declared CLI; local manifest identity is not registry-integrity proof.

## Interpret

- `Incubate`: all core-gap conditions pass; wire only the named removable boundary.
- `Unsupported`: retain evidence and blocker; expose no executor.
- Preview admission is non-blocking preview evidence.

A passing lab alone does not admit the feature. Preserve capability, lab, and admission digests together. The guarantee covers a disposable workspace, credential-free fixed environment, no child network, resource bounds, cancellation, recovery, and cleanup. It excludes roster, mailbox, task board, ordinary lifecycle, and orchestration.

## Executor contract

`inspectIsolatedCellAdmission()` returns evidence plus an opaque in-process grant. Pass that exact object to `openIsolatedCell()` from `dsh-developer/isolated-cell`; copies, parsed/fabricated data, unsupported results, and missing providers fail closed. The report fixes provider/distro. At most one public cell is active per plugin process and one operation per cell.

Import accepts only a bounded ordinary UTF-8 text tree. Run commands sequentially, call `stageResult()` once, then await `dispose()` in `finally`. Sealing separately stages a complete tree and changes without altering source. The caller must remove the exact `stagingRoot`. Cell cancellation starts disposal; workspace-limit failures dispose before returning.

Growth threshold: 8 MiB or 2,048 entries. Conformance must prove direct cgroup termination within 16 MiB and 4,096-entry ceilings for byte and zero-byte-entry attacks, then root removal. Never bypass grant, capacity lease, transfer checks, staging separation, serialization, or cleanup settlement.

When public DSH is equivalent, adopt it, shim older lanes, deprecate this module, then remove it after approved migration.
