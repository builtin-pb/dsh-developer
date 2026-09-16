# dsh-developer

**English** · [简体中文](README.zh-CN.md)

> **The single plugin you need for DSH**

dsh-developer brings creation, diagnosis, testing and upgrade checks into one workflow inside DSH or Codex. Describe what you want to build, work with your agent, and check that the result actually works with DSH before you share it.

[![CI](https://github.com/builtin-pb/dsh-developer/actions/workflows/ci.yml/badge.svg)](https://github.com/builtin-pb/dsh-developer/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## What can you build?

- **A plugin from an idea.** Turn a local service, tool or workflow into something your DSH agent can use.
- **A plugin people can rely on.** Find installation problems, missing services and broken Web integrations before users encounter them.
- **An upgrade with fewer surprises.** See what changed in DSH and check your plugin against release and preview versions.
- **A contribution to DSH itself.** Investigate a missing capability, test the existing behavior and develop a focused improvement against an upstream checkout.

Already have a plugin? Start there. You don't need to regenerate it or adopt a new project structure.

## Install

Install the published `v0.1.1` tag into DSH Web:

```sh
dsh plugin --profile web add 'github:builtin-pb/dsh-developer#v0.1.1' --ignore-scripts
```

Open or restart DSH Web (`dsh web`). For development from source, use a [checkout installation](docs/contributing.md). [Need DSH first?](docs/install.md) · [Using Codex?](docs/workflows.md#use-it-from-codex)

## Just tell it what you want

> Build a plugin that lets my agent search our local documentation.

> This plugin won't start in DSH Web. Find the problem and fix it.

> Check whether this plugin is ready to share.

The agent picks up the workflow from your request. Describe the goal, answer any questions, and review the changes—no special commands to remember.

## Go further

- [Build and test a project](docs/development.md) — exact-source lookup, native TypeScript tools, packed installs and Web development.
- [Diagnose a session](docs/session-diagnostics.md) — inspect tool calls, failures and completion from a selected log.
- [Workflow guide](docs/workflows.md) — commands, plugin release checks, upgrades and browser testing.
- [Develop on a Mac](docs/macos.md) — installation, isolated Build setup and working on DSH itself.
- [Choose a platform](docs/platforms.md) — Windows, Mac and Linux routes, requirements and tested boundaries.
- [Contribute](docs/contributing.md) — start with `npm test`, then check your changes against DSH.

The current checkout targets **DSH 0.1.5-rc.2** for blocking checks and **0.1.6-alpha.1** for advisory checks. Headless/Web preflight and native verification, product compatibility, delegation and approval checks passed on these exact runtimes. Native development targets Windows, macOS and Linux; these results do not establish every host or isolated provider. Apple isolation on rc.2 also passed four real integration checks; each host still requires provider admission. See [observed results](docs/verification.md) and the [platform guide](docs/platforms.md).

Designed and implemented with [MetaFlow](https://github.com/builtin-pb/metaflow). [MIT licensed](LICENSE).
