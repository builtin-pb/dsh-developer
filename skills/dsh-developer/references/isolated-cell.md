# Isolated-agent-cell admission

Use for a separately owned child workspace needing whole-environment containment. DSH retains lifecycle and orchestration.

## Run

DSH Web:

    /dsh-developer-admit-cell {}

CLI:

    node bin/dsh-developer.js admit-cell --dsh <path-to-dsh>

The host selects the provider. Only Windows accepts `--wsl-distro Ubuntu-22.04`; macOS uses the fixed reviewed Apple container image.

This keyless gate reruns capabilities and lab conformance, exercises public `childSessionMeta`, and inspects the sandbox contract. It never runs a model, source, build script, or caller workload.

`--dsh` is trusted input and must match the package-declared CLI; local identity is not registry-integrity proof.

## Interpret

- `Incubate`: all core-gap conditions pass; wire only the named removable boundary.
- `Unsupported`: retain evidence and blocker; expose no executor.
- Preview admission is non-blocking preview evidence.

Lab PASS alone does not admit the feature. Preserve capability, lab, and admission digests. The guarantee covers a disposable workspace, credential-free environment, no network, resource bounds, cancellation, recovery, and cleanup. It excludes lifecycle and orchestration.

## Executor contract

Pass the opaque grant from `inspectIsolatedCellAdmission()` to `openIsolatedCell()` from `dsh-developer/isolated-cell`. Copies, fabrication, unsupported results, and missing providers fail closed. The report fixes provider, image or distro, and policy evidence. Allow one cell per plugin process and one operation per cell.

Import only a bounded ordinary UTF-8 text tree. Run sequentially, call `stageResult()` once, then await `dispose()` in `finally`. Sealing stages a complete tree and changes without altering source. The caller removes the exact `stagingRoot`. On Apple container, cancellation, command timeout/output failures and export rejection dispose before returning. Guest commands may handle hard-quota rejections and continue within the same bounds.

Windows growth threshold: 8 MiB or 2,048 entries. Conformance must prove cgroup termination within 16 MiB and 4,096-entry ceilings for byte and zero-byte-entry attacks, then root removal. On Apple container, hard tmpfs limits bound allocated data to 8 MiB and inodes to 2,048 per workspace or temporary mount; this does not bound aggregate sparse logical size. Both providers export at most 4 MiB logical text, 256 files and 512 KiB per file. Apple export rejection destroys the VM before returning. Never bypass grant, capacity, transfer, staging, serialization, or cleanup checks.

When public DSH is equivalent, adopt it, shim older lanes, deprecate this module, then remove it after approved migration.
