# Local execution-lab gate

Use before execution-bearing core incubation. It runs fixed keyless fixtures only—never source, a build script, model, or caller command.

DSH Web:

    /dsh-developer-lab {"distro":"Ubuntu-22.04"}

CLI:

    node bin/dsh-developer.js lab --wsl-distro Ubuntu-22.04

PASS binds the host, WSL distro/kernel, Bubblewrap/`prlimit`, mounts, policy, checks, and digest. It proves a private workspace; denied host state, Windows integration, credentials, network, and runtime writes; fixed environment and private namespaces; bounded memory, tasks, CPU, files, output, and time; cgroup termination of byte and entry growth; cancellation, heartbeat expiry, orphan scans, cleanup, and fresh-controller recovery.

The provider shares the WSL2 kernel and claims neither project seccomp nor a microVM. Re-run after host, runtime, mount, or policy change.

Require Windows, WSL2, a non-root `/home` user, Bubblewrap, `prlimit`, systemd user scopes, and covered Windows mounts. Missing tools, unfamiliar mounts, failed checks, cancellation, or uncertain cleanup yields FAIL with no fallback.

PASS proves a boundary, not a feature. Also require the core gate's harm, corroboration, upstream-gap, bounded-replacement, authority, and retirement conditions. Admit only Adapt or Incubate; otherwise stop at Native or Unsupported.
