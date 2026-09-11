# Install dsh-developer

## Already using DSH?

Install directly from GitHub into DSH Web:

```sh
dsh plugin --profile web add github:builtin-pb/dsh-developer --ignore-scripts
```

Open or restart `dsh web`, then describe your plugin idea or problem. The installed skill is available to the model automatically. You do not need to clone this repository, install its development dependencies yourself, or run its tests to use it.

DSH forwards installation to pnpm, which fetches the plugin and its dependencies and records the bundle in the selected profile. This package ships JavaScript ready to load, so lifecycle scripts can remain disabled. pnpm may print a generic warning about ignored Git-package build scripts; no build step is needed for dsh-developer.

For another profile, replace `web` with the profile you use, such as `headless`. Installation applies to that profile. Internet access is needed to fetch packages.

## Need DSH first?

With Node.js `^22.18.0 || >=24.11.0` installed, run:

```sh
npm install --global pnpm@11.7.0 @deepseek-ai/dsh@0.1.5-rc.2
dsh plugin --profile web add github:builtin-pb/dsh-developer --ignore-scripts
dsh web
```

Use these commands in a macOS/Linux terminal or Windows PowerShell. Configure your model provider in DSH to chat with an agent. Read-only development checks also work without a model API key.

If DSH reports that pnpm is missing, run the first command above and reopen your terminal. For Mac PATH and developer-tool setup, see [the Mac guide](macos.md).

## Optional development tools

Ordinary conversation and static checks do not need an isolated build environment. When you want isolated Build/Apply, follow the [platform guide](platforms.md). Browser verification has its own [setup](../skills/dsh-developer/references/agent-native-ui.md).

To modify dsh-developer itself, use the checkout-based workflow in [Contributing](contributing.md) or [Mac development](macos.md). A GitHub installation downloads the published repository state; unpublished local edits require a checkout installation.

## Verification

A fresh npm installation of DSH `0.1.5-rc.2` and pnpm `11.7.0` succeeded on macOS ARM64 with Node `24.19.0`. Ordinary development against that DSH version passed native tool verification, packed plugin installation, configuration overrides, Web startup and rendered Client checks. These results concern the local development version of this plugin; they do not update the repository state fetched by GitHub.


The direct GitHub command was tested on macOS with DSH 0.1.1-rc.2 and pnpm 11.7.0 in a fresh disposable profile and empty package store. It installed the dependency graph, registered the bundle, and started DSH Web with an HTTP 200 response. The tested remote revision was `4bf78c2027bd82c9d6e377c2efc3394baa0dd7dd`; the command follows the repository's default branch. Windows uses the same DSH/pnpm installation interface, but this fresh-install trial was run on Mac.
