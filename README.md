# dsh-developer

The single plugin you need for DSH

Proudly designed and implemented by [MetaFlow](https://github.com/builtin-pb/metaflow).

Develop, inspect, test, harden, and ship DSH plugins from one native workflow. dsh-developer works natively in DSH and exposes the same canonical Agent Skill to Codex. It inspects exact DSH capability evidence, proves a strict local execution-lab boundary, promotes fingerprinted Creator exports into deterministic installable bundles, audits Creator exports and existing plugin repositories with Doctor, and proves generated packages against the real DSH lifecycle before handoff.

## What it does

- Guides Creator exports and existing repositories through one accountable development workflow
- Registers natively with DSH and shares one Agent Skill with Codex
- Reports exact DSH release or preview capability evidence without executing an audited repository
- Runs a dated admission gate for the isolated-agent-cell gap against exact installed DSH behavior and public evidence
- Proves a keyless WSL2/Bubblewrap execution-lab policy without executing user source
- Opens an admitted disposable command workspace, stages a sealed full result separately, and leaves the source untouched
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
    node bin/dsh-developer.js admit-cell --dsh D:\path\to\dsh.cmd --wsl-distro Ubuntu-22.04
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

The bundle patch loads the package entry (`index.js`), whose named apply export registers `skills/dsh-developer/SKILL.md` through the native skills service plus five direct user commands:

    /dsh-developer-admit-cell {"distro":"Ubuntu-22.04"}
    /dsh-developer-capabilities {}
    /dsh-developer-lab {"distro":"Ubuntu-22.04"}
    /dsh-developer-doctor {"source":"C:/path/plugin","skipRuntime":false}
    /dsh-developer-promote {"source":"C:/path/export.json","output":"C:/path/new-plugin"}

The command itself authorizes its bounded effect: capability inspection, controlled lab fixtures, audit of the named source, or creation of the named output. The shipped headless, ACP, and JSON-RPC surfaces do not consume the command registry. In model-driven DSH surfaces that compose a shell, the plugin contributes DSH_DEVELOPER_BIN as the absolute CLI entry; invoking it remains subject to that surface's normal shell sandbox and approval policy.

Invoke the dsh-developer skill for the guided workflow and decision checks around either native route.

## Use in Codex

Install this directory as a Codex plugin and invoke $dsh-developer. Codex reads the same skills/dsh-developer/SKILL.md instructions as DSH; there is no second workflow implementation.

## CLI

Run the evidence gate for the isolated-agent-cell candidate:

    node bin/dsh-developer.js admit-cell [--dsh <path-to-dsh>] [--wsl-distro <name>]

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

## Isolated-cell admission evidence

`admit-cell` executes DSH's installed `childSessionMeta` contract twice and confirms that representative children inherit one parent workspace and alias the same write target. It also reads the exact public sandbox contract, reruns capability and local-lab conformance, and binds the result to dated public DSH and cross-harness reports. It never runs a model, repository, build script, or caller-supplied workload.

The selected `--dsh` installation is trusted executable input, not a sandboxed subject: review how it was installed before running the gate. Admission first requires the selected entry to resolve to the public package's declared `@deepseek-ai/dsh` CLI entry, but local manifest identity is not registry-integrity or provenance proof.

The current reviewed release and preview lanes return `Incubate`: DSH's native subagent lifecycle remains authoritative, experimental Team remains out of scope, and only the missing disposable workspace plus whole-environment boundary is admitted. The report explicitly excludes roster, mailbox, task-board, ordinary child-lifecycle, and generic orchestration replacements. Unknown lanes, failed containment, or unclassified behavior return `Unsupported` and wire no executor.

### Use the admitted isolated-cell API

The public executor requires the exact report object returned by `inspectIsolatedCellAdmission()` in the same process. A copied, parsed, fabricated, unsupported, or provider-less report is not a grant. The admitted provider and distro are taken from that report; callers cannot substitute either at cell-open time.

    import { rm } from 'node:fs/promises'
    import { inspectIsolatedCellAdmission } from 'dsh-developer/cell-admission'
    import { openIsolatedCell } from 'dsh-developer/isolated-cell'

    const admission = await inspectIsolatedCellAdmission('D:/path/to/dsh.cmd', {
      distro: 'Ubuntu-22.04',
    })
    const cell = await openIsolatedCell('D:/path/to/plugin', { admission })
    let result
    try {
      const command = await cell.exec('/usr/bin/find . -type f -print')
      result = await cell.stageResult()
      // Review or copy result.staging. It is a complete result tree, not a patch.
    } finally {
      await cell.dispose()
    }
    if (result?.stagingRoot) {
      await rm(result.stagingRoot, { recursive: true, force: true })
    }

One public cell may be active per plugin process, and one operation may be active in that cell. `stageResult()` is single-use: it acquires two matching bounded snapshots, seals the cell, and returns created, modified, and deleted path lists. A changed result is materialized in a new private host temporary directory; it never overwrites the source. Cell disposal verifies removal of the WSL workspace but deliberately preserves the staged host result. The caller owns the exact `stagingRoot` returned and must remove it after review, copy, or promotion. If staging and its cleanup both fail, the error identifies the retained root.

Transfer accepts bounded ordinary UTF-8 text trees only. Binary files, links, special files, dependency trees, credential-shaped paths or content, nonportable names, case collisions, mutation during capture, and tar omissions fail closed. Cell-wide and per-operation cancellation signals are combined. Aborting the cell-wide signal starts disposal automatically; awaiting the interrupted operation or `dispose()` also waits for verified cleanup. Disposal stops admission of new work, cancels and settles an in-flight command or snapshot, reaps its process scope, and releases capacity only after cleanup is verified.

The current provider admits an 8 MiB or 2,048-entry workspace-growth threshold and proves termination within conservative 16 MiB and 4,096-entry observed ceilings. A controller outside the private PID namespace monitors logical size and entries, freezes and kills the complete systemd cgroup directly, and fails the admission lab if either stop ceiling is exceeded. The same scope also enforces a 512 KiB per-file limit, 256 MiB memory ceiling, zero swap, 32 tasks, fixed CPU quota, and systemd write bandwidth and IOPS controls. Byte-growth and zero-byte entry-growth fixtures are part of blocking conformance, followed by verified root removal.

DSH remains responsible for model inference and its provider connection. The isolated cell is the credential-free, network-free boundary for model-visible plugin files and commands; provider credentials are never copied into it.

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
