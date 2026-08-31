# Local execution-lab gate

Use this before execution-bearing core incubation. It runs fixed keyless fixtures only—never a repository, plugin, build script, model, or caller command.

## Run

DSH Web:

    /dsh-developer-lab {"distro":"Ubuntu-22.04"}

CLI from the plugin root:

    node bin/dsh-developer.js lab --wsl-distro Ubuntu-22.04

The distro is optional. This authorizes only private WSL fixtures and transient user units. Use `--json` for durable evidence.

## Accept only measured guarantees

PASS binds the Windows host, WSL distro/kernel, Bubblewrap/`prlimit` versions, mounts, policy, checks, and digest. It proves:

- one private workspace; read-only `/usr`; denied `/etc`, `/var`, homes, Windows mounts/integration, runtime writes, and credential canaries;
- a fixed non-credential environment, private network/PID/IPC/UTS/user namespaces, and fresh devices;
- systemd/`prlimit` bounds on memory, swap, tasks, CPU, file size, descriptors, output, and time;
- external byte/entry watchdog and direct cgroup freeze/kill, exercised by blocking byte and zero-byte-entry growth inside observed ceilings;
- exit-137 heartbeat expiry, cancellation without delayed effects, forced orphan scans, and verified cleanup;
- a killed outer controller leaves a lease that a fresh controller reaps with its scope and root.

The provider shares the WSL2 kernel and claims neither project seccomp nor a microVM. Re-run after relevant host, runtime, mount, or policy change.

## Fail closed

Require Windows, WSL2, a non-root `/home` user, Bubblewrap, `prlimit`, systemd user scopes, and covered Windows mounts. Missing tools, unfamiliar mounts, failed checks, cancellation, or uncertain cleanup yields FAIL. No ACL, direct, or remote fallback.

PASS proves a boundary, not a feature. Return to core-gap rules; execution needs separate Adapt/Incubate admission. Otherwise stop at Native or Unsupported.
