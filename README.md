# dsh-developer

**English** · [简体中文](README.zh-CN.md)

> **The single plugin you need for DSH**

Proudly designed and implemented by [MetaFlow](https://github.com/builtin-pb/metaflow), **dsh-developer** turns DSH plugin development into one native workflow: create, diagnose, verify, isolate, and ship from inside DSH or Codex.

DSH plugins fail in places ordinary linters never see: Host and Client contracts get mixed up, browser services collide, Web bundles load the wrong modules, and a DSH upgrade changes the ground underneath a working checkout. dsh-developer catches those failures before users do, proves the result against exact DSH release and preview lanes, and gives agents the same structured evidence humans get.

[![CI](https://github.com/builtin-pb/dsh-developer/actions/workflows/ci.yml/badge.svg)](https://github.com/builtin-pb/dsh-developer/actions/workflows/ci.yml) [![Node.js 22.18+](https://img.shields.io/badge/Node.js-22.18%2B-339933?logo=nodedotjs&logoColor=white)](package.json) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

```text
idea or repository  ->  Doctor + profile proof  ->  tested DSH plugin
trusted plugin      ->  release + preview lanes ->  upgrade-ready evidence
DSH or Codex agent  ->  one native workflow     ->  safe autonomous iteration
```

No model or provider key is required for Doctor, promotion, profile preflight, compatibility, upstream impact, capability inspection, or isolation checks.

## Install

The verified path uses Windows, Node.js 22.18+, pnpm 11.7.0, and DSH 0.1.1-rc.2.

```powershell
git clone https://github.com/builtin-pb/dsh-developer.git
cd dsh-developer
npm test
dsh plugin --profile web add .
dsh web
```

That installs a real DSH bundle. It registers the shared Agent Skill, one compact `dsh_developer` tool for every agent surface, and direct commands in DSH Web.

## Ship a plugin

Start with the route that matches what you have:

| You have | Run | You get |
| --- | --- | --- |
| An existing plugin | `doctor` | A read-only release audit with concrete fixes |
| A plugin targeting a profile | `preflight` | Proof that every required Cordis service exists before boot |
| A Creator export | `promote` | A new tested DSH + Codex bundle with reproducible bytes |
| A DSH upgrade ahead | `impact` | The exact upstream contracts your plugin must revalidate |
| A trusted release candidate | `compatibility` | Witnessed behavior on release and preview DSH lanes |
| An unfamiliar DSH install | `capabilities` | Exact runtime identity and supported development paths |

Audit a repository from DSH Web:

```text
/dsh-developer-doctor {"source":"C:/path/to/plugin","skipRuntime":false}
/dsh-developer-preflight {"source":"C:/path/to/plugin","profile":"web"}
```

Doctor catches the failures that brick real DSH profiles: broken package and bundle contracts, unsafe repository content, Host/Client injection mixups, browser-service collisions, invalid Web artifacts, unreproducible output, and failed clean-profile lifecycle proof. The repository stays read-only during inspection.

Turn a saved Creator export into an installable bundle:

```text
/dsh-developer-promote {"source":"C:/path/to/hello-dsh.creator.json","output":"C:/path/to/hello-dsh"}
```

Promotion creates one new destination, reproduces every output byte from the export, runs the release gates, and keeps a failed staging directory for diagnosis. Install the result when you are ready:

```powershell
dsh plugin --profile headless add C:\path\to\hello-dsh
dsh --profile headless --dump-config
```

## Keep shipping as DSH moves

Run impact analysis before an upgrade:

```powershell
node bin/dsh-developer.js impact --source C:\path\to\plugin --release-dsh D:\release\dsh.cmd --preview-dsh D:\preview\dsh.cmd
```

It follows the packages and Cordis services your plugin actually touches, then compares their public declarations, entries, dependencies, and DSH metadata across both lanes. Compatibility takes the next step and runs the same trusted bytes through both exact runtimes:

```powershell
node bin/dsh-developer.js compatibility --source C:\path\to\plugin --release-dsh D:\release\dsh.cmd --preview-dsh D:\preview\dsh.cmd
```

Every report ends with a stable digest tied to the final unchanged source tree.

## One workflow for every DSH agent

The global `dsh_developer` tool reaches Web, headless, ACP, Code Mode, and JSON-RPC agents through DSH's native tool registry:

```json
{"operation":"doctor","source":"C:/path/to/plugin","skipRuntime":true}
```

Its operation is one of `authority`, `capabilities`, `doctor`, `preflight`, `impact`, `compatibility`, `delegation`, or `ui`. One schema keeps the model-visible tool catalogue small while returning canonical structured evidence everywhere.

Delegated and fixed-authority agents also receive truthful shell and file schemas. Impossible escalation arguments disappear, stale arguments are removed before execution, and real denials explain the fixed boundary instead of sending the model into another retry loop.

```text
dsh_developer {"operation":"authority"}
dsh_developer {"operation":"delegation"}
```

## Agent-native UI verification

dsh-developer gives each agent its own compact, protected browser session for local plugin UI work. The route uses the pinned Playwright CLI, exposes semantic actions instead of arbitrary browser code, keeps navigation on loopback, and stores bounded visual evidence.

```text
dsh_developer {"operation":"ui"}
dsh_ui {"operation":"open","url":"http://127.0.0.1:4173/"}
dsh_ui {"operation":"snapshot","depth":6}
dsh_ui {"operation":"fill","target":"e5","text":"Ada"}
dsh_ui {"operation":"click","target":"e6"}
dsh_ui {"operation":"wait","text":"Saved"}
dsh_ui {"operation":"close"}
```

Configure the exact Playwright CLI entry, Chrome or Edge executable, and an absolute state directory before DSH starts. The full setup and operation contract lives in [Agent-native UI](skills/dsh-developer/references/agent-native-ui.md).

Codex and other shell-capable agents use the same controller directly:

```powershell
node bin/dsh-developer.js ui --session codex-task --action open --url http://127.0.0.1:4173/ --json
node bin/dsh-developer.js ui --session codex-task --action snapshot --depth 6 --json
node bin/dsh-developer.js ui --session codex-task --action close --json
```

## Isolation built for autonomous development

Read-only analysis never executes the target repository. Controlled lifecycle execution is reserved for this product and byte-for-byte reproducible promoted output. Credentials stay out of child environments and evidence.

Execution-bearing work can use the admitted WSL2 + Bubblewrap cell: a disposable, network-free, credential-free workspace with bounded input, serialized commands, sealed output, and verified cleanup.

```powershell
node bin/dsh-developer.js lab --wsl-distro Ubuntu-22.04
node bin/dsh-developer.js admit-cell --dsh D:\path\to\dsh.cmd --wsl-distro Ubuntu-22.04
```

Read the [execution-lab](skills/dsh-developer/references/execution-lab.md), [isolated-cell](skills/dsh-developer/references/isolated-cell.md), and [safety](skills/dsh-developer/references/safety.md) contracts before embedding the JavaScript APIs.

## Use it from Codex

This repository is a native Codex plugin too. Add the existing folder to a personal marketplace with `$plugin-creator`, install **dsh-developer**, then invoke `$dsh-developer`. DSH and Codex share one workflow and one set of safety rules.

## Compatibility

- Release lane: DSH 0.1.1-rc.2.
- Preview lane: DSH 0.1.2-alpha.3.
- Node.js: 22.18 or newer.
- Platform: Windows-first, with WSL2 + Bubblewrap for the strongest execution boundary.

Release failures block. Preview drift stays visible so it gets fixed before the next DSH release lands.

## Develop dsh-developer

The full suite is deterministic and keyless:

```powershell
npm run validate
npm pack --dry-run
```

## License

[MIT](LICENSE)
