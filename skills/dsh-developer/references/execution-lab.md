# Local execution-lab gate

Use before execution-bearing core incubation. It runs fixed keyless fixtures only—never source, a build script, model, or caller command.

Run `/dsh-developer-lab {"distro":"Ubuntu-22.04"}` in DSH Web, or:

    node bin/dsh-developer.js lab --wsl-distro Ubuntu-22.04

PASS binds host, WSL distro/kernel, Bubblewrap/`prlimit`, mounts, policy, checks, and digest. It proves a private workspace; denies host state, Windows integration, credentials, network, and runtime writes; fixes environment/namespaces; bounds memory, tasks, CPU, files, output, and time; terminates byte/entry growth; and verifies cancellation, expiry, orphan cleanup, and controller recovery.

The provider shares the WSL2 kernel; it claims neither project seccomp nor a microVM. Re-run after host, runtime, mount, or policy change.

Require Windows, WSL2, non-root `/home`, Bubblewrap, `prlimit`, systemd user scopes, and covered mounts. Missing tools, unfamiliar mounts, failed checks, cancellation, or uncertain cleanup is FAIL with no fallback.

PASS proves a boundary, not a feature. Enforce [core admission and authority](core-admission.md): the actual workload—not only fixtures—must run through the admitted provider.
