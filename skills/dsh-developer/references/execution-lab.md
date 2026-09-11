# Local execution-lab gate

Use before execution-bearing core incubation. Run fixed keyless fixtures only—never source, a model, build script or caller command.

Run `/dsh-developer-lab {}` or `node bin/dsh-developer.js lab`. The host selects:

- Windows: WSL2/Bubblewrap; require non-root `/home`, `prlimit`, systemd scopes and covered mounts. Select `--wsl-distro Ubuntu-22.04` if needed. Cells share the WSL kernel.
- Apple silicon/macOS 26+: Apple container 1.4.1 and the pinned image documented in `docs/macos.md`. Each cell has a Linux VM, no host mounts/network, read-only root, capability-free workload and root-owned cgroup cleanup. Native Mac behavior needs host tests.

PASS binds host, provider, image/distro, resource policy, checks and digest. Provider limits differ; preserve the exact policy and claim only passing checks. Re-run after host, runtime or policy changes. Missing tools, failed checks, cancellation or uncertain cleanup fails closed without fallback.

PASS proves a boundary, not a feature. Enforce [core admission](core-admission.md): launch the actual workload through the admitted provider; fixtures alone grant no execution authority.
