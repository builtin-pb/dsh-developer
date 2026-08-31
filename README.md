# dsh-developer

The single plugin you need for DSH

Proudly designed and implemented by [MetaFlow](https://github.com/builtin-pb/metaflow).

Develop, inspect, test, harden, and ship DSH plugins from one native workflow. dsh-developer works natively in DSH and exposes the same canonical Agent Skill to Codex. It inspects exact DSH capability evidence, proves a strict local execution-lab boundary, promotes fingerprinted Creator exports into deterministic installable bundles, audits Creator exports and existing plugin repositories with Doctor, and proves generated packages against the real DSH lifecycle before handoff.

## What it does

- Guides Creator exports and existing repositories through one accountable development workflow
- Registers natively with DSH and shares one Agent Skill with Codex
- Reports exact DSH release or preview capability evidence without executing an audited repository
- Proves a keyless WSL2/Bubblewrap execution-lab policy without executing user source
- Audits manifests, references, paths, binary content, size bounds, credentials, licensing, and compatibility with Doctor
- Produces deterministic scaffolding with fingerprinted provenance and byte-for-byte reproducibility evidence
- Tests native registration and witnessed clean-profile DSH install, load, discovery, and uninstall with package installation offline and lifecycle scripts disabled
- Creates one new output through private staging and an atomic no-replace commit

No model runs during deterministic promotion or lab conformance, so no API key is needed.

## Five-minute quickstart

Requirements:

- Node.js 22.18 or newer
- pnpm 11.7.0 (the lifecycle package manager pinned in CI)
- DSH 0.1.1-rc.2 available as `dsh` on PATH (or pass `--dsh <path-to-dsh>`)
- Windows on a filesystem that passes the no-replace directory-rename probe

From this repository:

    npm test
    node bin/dsh-developer.js capabilities --dsh D:\path\to\dsh.cmd
    node bin/dsh-developer.js doctor --source examples/hello-dsh.creator.json
    node bin/dsh-developer.js promote --source examples/hello-dsh.creator.json --output ..\hello-dsh
    cd ..\hello-dsh
    npm test

The output basename must match the export name, and the destination must not exist. Promotion retains a named staging directory when a final gate fails.

Install the generated plugin into a profile only after reviewing it:

    dsh plugin --profile headless add .
    dsh --profile headless --dump-config

Installation into your real profile is deliberately separate from promotion.

On Windows, optionally prove the strict local lab when WSL2, systemd, Bubblewrap, and `prlimit` are available:

    node bin/dsh-developer.js lab --wsl-distro Ubuntu-22.04

## Use as a native DSH plugin

Install this repository itself into the DSH Web profile for direct slash commands:

    dsh plugin --profile web add .
    dsh web

The bundle patch loads the package entry (`index.js`), whose named apply export registers `skills/dsh-developer/SKILL.md` through the native skills service plus four direct user commands:

    /dsh-developer-capabilities {}
    /dsh-developer-lab {"distro":"Ubuntu-22.04"}
    /dsh-developer-doctor {"source":"C:/path/plugin","skipRuntime":false}
    /dsh-developer-promote {"source":"C:/path/export.json","output":"C:/path/new-plugin"}

The command itself authorizes its bounded effect: capability inspection, controlled lab fixtures, audit of the named source, or creation of the named output. The shipped headless, ACP, and JSON-RPC surfaces do not consume the command registry. In model-driven DSH surfaces that compose a shell, the plugin contributes DSH_DEVELOPER_BIN as the absolute CLI entry; invoking it remains subject to that surface's normal shell sandbox and approval policy.

Invoke the dsh-developer skill for the guided workflow and decision checks around either native route.

## Use in Codex

Install this directory as a Codex plugin and invoke $dsh-developer. Codex reads the same skills/dsh-developer/SKILL.md instructions as DSH; there is no second workflow implementation.

## CLI

Inspect the exact installed DSH runtime and its capability inventory:

    node bin/dsh-developer.js capabilities [--dsh <path-to-dsh>]

Run keyless conformance for the local execution lab:

    node bin/dsh-developer.js lab [--wsl-distro <name>]

Audit a Creator export or plugin directory:

    node bin/dsh-developer.js doctor --source <path> [--dsh <path-to-dsh>]

Promote a Creator export:

    node bin/dsh-developer.js promote --source <creator.json> --output <absent-directory> [--dsh <path-to-dsh>]

Calculate a draft export fingerprint:

    node bin/dsh-developer.js fingerprint --source <creator-draft.json>

Add --json for machine-readable output. --skip-runtime is accepted by Doctor for exploration but is forbidden during promotion and is not release evidence.

## Capability evidence

Capability inspection exercises the installed CLI contract and reads bounded package metadata adjacent to the official DSH entry. It records the DSH, Node, platform, architecture, compatibility lane, package identity, capability status, evidence strength, and a stable evidence digest.

An installed package is not automatically a complete security boundary. In particular, DSH's current Windows ACL backend is reported as `partial`: it restricts writes but does not fully confine reads, network access, process visibility, credentials, devices, or hard-link aliases.

`behavior` evidence means the named contract was exercised. `inventory` evidence means matching packages are installed; it does not claim that a service is active in every profile. Missing optional or experimental packages are observations, not report failures. Package semantics are classified only for reviewed exact DSH/package versions; other installed versions remain `present-unclassified`.

DSH 0.1.1-rc.2 remains the blocking release lane. DSH 0.1.2-alpha.2 is recognized as preview evidence only. Other versions remain inspectable but receive no compatibility claim.

## Execution-lab evidence

The current strict provider is Windows-to-WSL2 Bubblewrap. It uses an argv-only `wsl.exe --exec` path and imports only a read-only `/usr` runtime into an otherwise minimal root. `/etc`, `/var`, homes, Windows mounts, WSL integration, and a credential canary outside the ordinary masks are absent. The cell receives a fixed credential-free environment, private network/PID/IPC/UTS/user namespaces, fresh devices, systemd cgroup limits, and `prlimit` bounds.

Conformance also proves exit-137 heartbeat expiry, process-tree cancellation without delayed effects, forced orphan scans, and cleanup. A separate controller process is force-killed; after its lease becomes stale, a fresh controller must remove the cell scope and private root.

Conformance executes fixed keyless fixtures only. It does not expose an arbitrary-command CLI, execute an audited repository, or admit a proposed core feature. A PASS applies only to the recorded host, distro, kernel, provider versions, mounts, policy, and evidence digest. The provider shares the WSL2 kernel and claims no project-specific seccomp filter or microVM boundary.

Missing Bubblewrap, root execution, an unfamiliar Windows-backed mount, a failed resource or cancellation probe, or uncertain cleanup fails closed without using the partial Windows ACL provider or a remote fallback.

## Doctor release catalogue

Doctor treats these as blocking where applicable:

- Stable ordinary-file/tree snapshot and portable case-safe paths
- File-count, byte, UTF-8, dependency-tree, config, and credential policy
- npm, DSH bundle, Codex plugin, Agent Skill, and reference integrity
- Exact public DSH 0.1.1-rc.2 compatibility
- Byte-for-byte reproduction from Creator provenance
- Generated native entry invocation
- Witnessed clean-profile install, load, discovery, and uninstall with package installation offline and lifecycle scripts disabled
- Documentation, exact slogan, test guidance, and MIT license
- Fresh final tree fingerprint immediately before commit

Official DSH master is advisory and is never presented as passing release evidence.

## Safety model

Inputs are untrusted and read-only. Promotion reads one stable snapshot, scans model-visible text for likely credentials, generates only manifest-listed text files in a unique sibling staging directory, reruns the complete final gate, and commits with a filesystem-probed no-replace rename. It never modifies a source or existing destination.

The current atomic commit is intentionally Windows-first. On filesystems where renaming a directory can replace an existing empty destination, promotion stops instead of using an unsafe check-then-rename fallback.

## Development

Run:

    npm run validate

The deterministic suite requires no provider credential.

To include the host-bound WSL lab and Windows process-tree integration checks in PowerShell:

    $env:DSH_DEVELOPER_WSL_LAB_TEST='1'
    $env:DSH_DEVELOPER_PROCESS_TEST='1'
    npm test

See skills/dsh-developer/references/creator-export.md for the export contract.

## License

MIT
