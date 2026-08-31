# Local execution-lab gate

Use this gate before execution-bearing core incubation. It runs fixed keyless fixtures only—never a repository, plugin, build script, model, or caller-supplied command.

## Run

DSH Web:

    /dsh-developer-lab {"distro":"Ubuntu-22.04"}

CLI from the installed plugin root or checkout:

    node bin/dsh-developer.js lab --wsl-distro Ubuntu-22.04

The distro may be omitted. The command authorizes only private WSL fixtures and transient user resource units. Use `--json` for durable evidence.

## Accept only measured guarantees

A PASS binds its Windows host, WSL distro/kernel, Bubblewrap and `prlimit` versions, Windows mounts, policy, checks, and digest. It proves:

- one private workspace is writable; only a read-only `/usr` runtime is imported;
- `/etc`, `/var`, homes, Windows mounts, WSL integration, runtime writes, and credential canaries are absent or denied;
- a fixed non-credential environment, private network/PID/IPC/UTS/user namespaces, and fresh devices;
- systemd and `prlimit` bounds on memory, swap, tasks, CPU, files, descriptors, output, and time;
- exit-137 heartbeat expiry, cancellation without delayed effects, forced orphan scans, and verified cleanup;
- a force-killed outer controller leaves a stale lease that a fresh controller reaps with its cell scope and root.

The provider shares the WSL2 kernel and claims no project seccomp filter or microVM boundary. Re-run after relevant host, runtime, mount, or policy change.

## Fail closed

Windows, WSL2, a non-root `/home` user, Bubblewrap, `prlimit`, systemd user scopes, and covered Windows mounts are required. Missing tools, unfamiliar mounts, failed checks, cancellation, or cleanup uncertainty yields FAIL. Never substitute Windows ACL, direct execution, or a remote fallback.

PASS proves the boundary, not a feature. Return to the core-gap rules; build an execution-bearing Adapt or Incubate result only after its separate admission passes. Otherwise stop at Native or Unsupported.
