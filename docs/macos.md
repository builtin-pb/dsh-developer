# Develop on macOS

Use Node.js `^22.18.0 || >=24.11.0`, pnpm 11.7.0 and DSH 0.1.5-rc.2 for
ordinary development and blocking runtime checks; DSH 0.1.6-alpha.1 is the
advisory lane. Isolated Build/Apply additionally requires Apple-provider setup
and successful local admission against the running agent. Real rc.2 Apple
integration passed 4/4 checks; this does not establish alpha isolation.

## Install DSH and this plugin

Install Apple Command Line Tools (`xcode-select --install`) for the system Python used by atomic promotion. With a supported Node.js installation on PATH:

```sh
npm install --global pnpm@11.7.0 @deepseek-ai/dsh@0.1.5-rc.2
dsh plugin --profile web add 'github:builtin-pb/dsh-developer#v0.1.2' --ignore-scripts
dsh web
```

The Web UI is at `http://127.0.0.1:3080`. Configure your model provider in DSH
when you want to use an agent. The plugin is installed into `~/.dsh/profiles/web`.
Describe your plugin idea or problem in the agent conversation; no slash command is required.
See [installation](install.md) for other profiles and troubleshooting.

If `dsh` is missing from PATH, use your Node version manager's shell setup or
add the npm global bin directory to your shell's PATH:

```sh
export PATH="$(npm prefix --global)/bin:$PATH"
```

Add that line to `~/.zshrc` if needed. npm symlinks and pnpm shell wrappers
are resolved to the package's JavaScript entry, including paths with spaces.
To select another installation explicitly, pass `--dsh /absolute/path/to/dsh`.

## Supported workflows

| Workflow | macOS |
| --- | --- |
| DSH CLI and native dsh-developer plugin | Supported |
| Static Doctor, capabilities, knowledge, verify and dev | Ordinary development on the selected runtime; host execution policy applies |
| Runtime Doctor, profile preflight, impact, compatibility | Exact reviewed audit lanes; runtime execution retains its trusted-source restrictions |
| Static hook inspection, migration and profile attestation | Supported for their documented exact lanes |
| Agent UI controller | Requires separately configured Playwright CLI and browser; not included in this setup |
| Creator promotion | Supported using the native exclusive-rename operation |
| Isolated cell Build/Apply | Reviewed DSH lanes, Apple silicon, macOS 26+ and Apple container 1.4.1; local admission required |

Promotion uses Darwin exclusive rename and refuses to overwrite an existing destination, including a racing empty directory. Isolated execution uses a Linux VM. Test macOS-specific behavior separately on the host. Intel Macs and older macOS releases can use the native plugin workflows; they do not have an admitted isolated Build provider.
You can develop and test an ordinary plugin directly from its checkout on macOS.

Static attestation and hook inspection require physical paths without symlink
ancestors. macOS aliases `/tmp` and `/var`; use the physical path reported by
`realpath` when selecting a temporary profile or source for these strict audits.
Credential detection can also reject high-entropy path text inside inspected
configuration; use a conventional workspace path when creating such fixtures.

## Enable isolated Build and Apply

Use the current checkout installation for the updated runtime contracts (see [Test changes against DSH](#test-changes-against-dsh)). Confirm the running DSH is rc.2. If you need a separate exact installation, launch it through its own entry using the profile where that checkout is installed:

```sh
npm install --prefix "$HOME/.local/share/dsh-reviewed" --ignore-scripts @deepseek-ai/dsh@0.1.5-rc.2
"$HOME/.local/share/dsh-reviewed/node_modules/.bin/dsh" --version
"$HOME/.local/share/dsh-reviewed/node_modules/.bin/dsh" web
```

Stop an existing Web server before launching this one. The blocking version is exactly 0.1.5-rc.2; selecting `--dsh` for a CLI check does not change the runtime of an already running agent. The advisory 0.1.6-alpha.1 runtime lane does not by itself establish provider admission.

Install the signed [Apple container 1.4.1 release](https://github.com/apple/container/releases/tag/1.4.1) using its official installer. It requires Apple silicon and macOS 26 or later. Then start the service and pull the reviewed image:

```sh
container system start --enable-kernel-install
container image pull docker.io/library/node@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b
```

These commands download the Linux kernel and image. Subsequent cells run offline. The image contains Node.js 24.19.0, Python and standard Linux utilities. Dependencies are not downloaded during a Build.

In the reviewed DSH agent's POSIX shell, check the installed plugin and that running DSH installation:

```sh
node "$DSH_DEVELOPER_BIN" lab
node "$DSH_DEVELOPER_BIN" admit-cell
```

DSH supplies this absolute plugin entry; no dsh-developer checkout is required. In an external terminal, use `node bin/dsh-developer.js` only from a plugin checkout, with `--dsh` selecting the reviewed entry for admission.

For a manual installation under `~/.local`, start the service with the **physical** binary path and `--install-root` pointing at the extracted payload root; Apple locates its helper executables beside that binary. For example:

```sh
~/.local/share/apple-container-1.4.1/bin/container system start --install-root ~/.local/share/apple-container-1.4.1 --enable-kernel-install
```

Restart the reviewed DSH entry after setup. After successful local admission, in a top-level agent request an isolated Build; review its command plan, then separately approve Apply to copy verified changes back. The original checkout remains untouched during execution. A failed admission exposes its blocker and runs no workload.

The VM is intentionally bounded: small text workspaces, no host mounts, no credentials and no network. It is suitable for focused plugin edits and tests with the bundled tools. A complete DSH checkout with dependency trees needs the native upstream workflow below. See the [provider comparison](platforms.md) and [execution contract](../skills/dsh-developer/references/execution-lab.md).

From a dsh-developer checkout, run the real local integration suite after changing the provider:

```sh
DSH_DEVELOPER_APPLE_LAB_TEST=1 node --test test/apple-container.integration.test.js
```

This creates disposable VMs and temporary plugin fixtures. On DSH `0.1.5-rc.2`, all four real Apple integration checks passed: actual native admission, VM Build/Apply, generated-plugin promotion, sparse-export rejection and churn cleanup. Controller cases use fixture approval tokens; native approval checks are separate. These observations require Apple silicon, macOS 26+, Apple container 1.4.1 and the pinned image above. They do not admit another machine or prove the alpha provider path.

## Test changes against DSH

To change dsh-developer itself, create a development checkout and link it into your profile:

```sh
git clone https://github.com/builtin-pb/dsh-developer.git
cd dsh-developer
npm ci --ignore-scripts
dsh plugin --profile web add . --ignore-scripts
```

Restart DSH after editing host JavaScript. From the checkout, run the checks below, replacing `/absolute/path/to/reviewed/dsh` with the exact 0.1.5-rc.2 entry for blocking runtime audits (for example, the entry installed above):

```sh
npm run validate
node bin/dsh-developer.js doctor --source . --dsh /absolute/path/to/reviewed/dsh
node bin/dsh-developer.js preflight --source . --profile headless --dsh /absolute/path/to/reviewed/dsh
node bin/dsh-developer.js preflight --source . --profile web --dsh /absolute/path/to/reviewed/dsh
npm pack --dry-run
```

Doctor exercises a disposable profile to prove installation, registration,
discovery and uninstall for this product. Current headless/Web preflight and
native verification, product compatibility, delegation and approval checks
passed on rc.2 and alpha.1. Release failures block; preview behavior remains
advisory. See [verification](verification.md) for revision-specific local and CI results.

## Develop DSH itself

Keep an upstream checkout beside your plugin workspace. Follow its own
[contributing guide](https://github.com/deepseek-ai/deepseek-harness#contributing)
and toolchain pins; upstream development may require a different toolchain
from this repository's release evidence.

The [official source workflow](https://github.com/deepseek-ai/deepseek-harness#run-from-source) is:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

For an ordinary plugin, use static Doctor (`--skip-runtime`) and native
`verify`/`dev` against the intended DSH installation; see [the development guide](development.md).
Use impact and compatibility for this product's exact release audit lanes.
An upstream checkout needs its own builds and tests: record the commit and
working changes, and report those results separately from plugin verification.
