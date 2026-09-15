# Install dsh-developer

## Already using DSH?

Install directly from GitHub into DSH Web:

```sh
dsh plugin --profile web add 'github:builtin-pb/dsh-developer#v0.1.1' --ignore-scripts
```

Open or restart `dsh web`, then describe your plugin idea or problem. The installed skill is available to the model automatically. You do not need to clone this repository, install its development dependencies yourself, or run its tests to use it.

DSH forwards installation to pnpm, which fetches the plugin and its dependencies and records the bundle in the selected profile. This package ships JavaScript ready to load, so lifecycle scripts can remain disabled. pnpm may print a generic warning about ignored Git-package build scripts; no build step is needed for dsh-developer.

For another profile, replace `web` with the profile you use, such as `headless`. Installation applies to that profile. Internet access is needed to fetch packages.

## Need DSH first?

With Node.js `^22.18.0 || >=24.11.0` installed, run:

```sh
npm install --global pnpm@11.7.0 @deepseek-ai/dsh@0.1.5-rc.2
dsh plugin --profile web add 'github:builtin-pb/dsh-developer#v0.1.1' --ignore-scripts
dsh web
```

Use these commands in a macOS/Linux terminal or Windows PowerShell. Configure your model provider in DSH to chat with an agent. Read-only development checks also work without a model API key.

If DSH reports that pnpm is missing, run the first command above and reopen your terminal. For Mac PATH and developer-tool setup, see [the Mac guide](macos.md).

## Optional development tools

Ordinary development uses the host execution policy and does not need an isolated build environment. The recommended DSH 0.1.5-rc.2 supports that route; certified audits and isolated Build/Apply require the separate reviewed lanes, 0.1.1-rc.2 and advisory 0.1.2-alpha.3. For isolation, follow the [platform guide](platforms.md) and [Mac runtime setup](macos.md#enable-isolated-build-and-apply). Browser verification has its own [setup](../skills/dsh-developer/references/agent-native-ui.md).

Inside a DSH agent's shell, invoke the installed CLI as `node "$DSH_DEVELOPER_BIN" <operation>` on POSIX or `node "$env:DSH_DEVELOPER_BIN" <operation>` in PowerShell. DSH supplies that absolute entry and defaults CLI checks to its running installation. Profile installation does not add a global `dsh-developer` command. Examples using `node bin/dsh-developer.js` require this repository's checkout as the working directory.

To modify dsh-developer itself, use the checkout-based workflow in [Contributing](contributing.md) or [Mac development](macos.md). The installation commands above select the v0.1.1 Git tag; unpublished local edits require a checkout installation.

## Verification

The release review exercised both a public Git-tag installation (`v0.1.0`)
and the `v0.1.1` archive in disposable profiles on macOS ARM64 with Node
24.19.0, pnpm 11.7.0 and DSH 0.1.5-rc.2. Installed native tools reported the
selected runtime and resolved declarations from the actual consuming package.
Browser opening was explicitly disabled; no model request or personal profile
was used. Tagged-installation evidence accompanies the [GitHub release](https://github.com/builtin-pb/dsh-developer/releases/tag/v0.1.1).

See [verification results](verification.md) for native runtime and platform
checks, rendered Web observations and the distinction between deterministic
tests and agent development trials.
