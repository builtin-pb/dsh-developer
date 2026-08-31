# dsh-developer

The single plugin you need for DSH

Proudly designed and implemented by [MetaFlow](https://github.com/builtin-pb/metaflow).

Develop, inspect, test, harden, and ship DSH plugins from one native workflow. dsh-developer works natively in DSH and exposes the same canonical Agent Skill to Codex. Its current release promotes fingerprinted Creator exports into deterministic installable bundles, audits Creator exports and existing plugin repositories with Doctor, and proves generated packages against the real DSH lifecycle before handoff.

## What it does

- Guides Creator exports and existing repositories through one accountable development workflow
- Registers natively with DSH and shares one Agent Skill with Codex
- Audits manifests, references, paths, binary content, size bounds, credentials, licensing, and compatibility with Doctor
- Produces deterministic scaffolding with fingerprinted provenance and byte-for-byte reproducibility evidence
- Tests native registration and clean-profile DSH install, discovery, and uninstall with network and lifecycle scripts disabled
- Creates one new output through isolated staging and an atomic no-replace commit

No model runs during deterministic promotion, so no API key is needed.

## Five-minute quickstart

Requirements:

- Node.js 22.18 or newer
- DSH 0.1.1-rc.2 available as `dsh` on PATH (or pass `--dsh <path-to-dsh>`)
- Windows on a filesystem that passes the no-replace directory-rename probe

From this repository:

    npm test
    node bin/dsh-developer.js doctor --source examples/hello-dsh.creator.json
    node bin/dsh-developer.js promote --source examples/hello-dsh.creator.json --output ..\hello-dsh
    cd ..\hello-dsh
    npm test

The output basename must match the export name, and the destination must not exist. Promotion retains a named staging directory when a final gate fails.

Install the generated plugin into a profile only after reviewing it:

    dsh plugin --profile headless add .
    dsh --profile headless --dump-config

Installation into your real profile is deliberately separate from promotion.

## Use as a native DSH plugin

Install this repository itself into the DSH Web profile for direct slash commands:

    dsh plugin --profile web add .
    dsh web

The bundle patch loads index.js, whose named apply export registers skills/dsh-developer/SKILL.md through the native skills service plus two direct user commands:

    /dsh-developer-doctor {"source":"C:/path/plugin","skipRuntime":false}
    /dsh-developer-promote {"source":"C:/path/export.json","output":"C:/path/new-plugin"}

The command itself is the user's authorization to audit or create the named output. The shipped headless, ACP, and JSON-RPC surfaces do not consume the command registry. In model-driven DSH surfaces that compose a shell, the plugin contributes DSH_DEVELOPER_BIN as the absolute CLI entry; invoking it remains subject to that surface's normal shell sandbox and approval policy.

Invoke the dsh-developer skill for the guided workflow and decision checks around either native route.

## Use in Codex

Install this directory as a Codex plugin and invoke $dsh-developer. Codex reads the same skills/dsh-developer/SKILL.md instructions as DSH; there is no second workflow implementation.

## CLI

Audit a Creator export or plugin directory:

    node bin/dsh-developer.js doctor --source <path> [--dsh <path-to-dsh>]

Promote a Creator export:

    node bin/dsh-developer.js promote --source <creator.json> --output <absent-directory> [--dsh <path-to-dsh>]

Calculate a draft export fingerprint:

    node bin/dsh-developer.js fingerprint --source <creator-draft.json>

Add --json for machine-readable output. --skip-runtime is accepted by Doctor for exploration but is forbidden during promotion and is not release evidence.

## Doctor release catalogue

Doctor treats these as blocking where applicable:

- Stable ordinary-file/tree snapshot and portable case-safe paths
- File-count, byte, UTF-8, dependency-tree, config, and credential policy
- npm, DSH bundle, Codex plugin, Agent Skill, and reference integrity
- Exact public DSH 0.1.1-rc.2 compatibility
- Byte-for-byte reproduction from Creator provenance
- Generated native entry invocation
- Clean-profile install, discovery, and uninstall with network and scripts disabled
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

See skills/dsh-developer/references/creator-export.md for the export contract.

## License

MIT
