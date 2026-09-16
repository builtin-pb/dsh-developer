# Workflow reference

[Quick start](../README.md) · [简体中文](workflows.zh-CN.md)

## Tell it what you want

Open a DSH or Codex agent in your plugin workspace and talk normally:

```text
Build a DSH plugin that exposes our local search service as a model tool.
Fix this plugin so it cold-boots in the web profile.
Upgrade this repository without breaking the current release lane.
Audit this plugin, repair every blocker, and give me the install command.
Check whether these Claude hooks still deny tools on this DSH install.
```

Natural language is the primary entry. DSH and Codex select dsh-developer, extract the goal and constraints, then act on answers and read-only audits. For implementation requests, the agent gives a compact plan and carries authorized work through testing and repair. It asks only for unresolved consequential choices or additional authority.

`/dsh-developer` in DSH and `$dsh-developer` in Codex pin deterministic selection; users do not need a command vocabulary.

## Develop an ordinary project

Use `project` to select a package and toolchain, `knowledge` to locate exact-version DSH code, and the host shell for `run`, `verify` and `dev`. Dependencies remain in the ordinary workspace. The [development guide](development.md) includes a typed native-tool example, packed-artifact verification, Web server lifecycle, and working on DSH itself.

Inside DSH, use `node "$DSH_DEVELOPER_BIN" <operation>` in a POSIX shell or `node "$env:DSH_DEVELOPER_BIN" <operation>` in PowerShell. DSH supplies the installed entry and its running runtime. Examples below using `node bin/dsh-developer.js` or npm scripts assume the dsh-developer checkout as the working directory; profile installation does not create a global CLI command.

## Ship a plugin

Start with the route that matches what you have:

| You have | Run | You get |
| --- | --- | --- |
| An ordinary plugin | `doctor --skip-runtime`, then `verify` | Static findings and actual native results on the selected DSH |
| A plugin targeting a profile on a reviewed audit lane | `preflight` before install | Proof that every required Cordis service exists before boot |
| A Creator export | `promote` | A new tested DSH + Codex bundle with reproducible bytes |
| A DSH upgrade across the reviewed lanes | `impact` before edits | The exact upstream contracts your plugin must revalidate |
| This product or a promoted release bundle | `compatibility` | Witnessed behavior on release and preview DSH lanes |
| An unfamiliar DSH install | `capabilities` | Exact runtime identity and supported development paths |
| An installed profile | `attest-profile` | Canonical receipt for the exact static bytes you tested |
| Codex or Claude Code hooks | `hook-doctor` | Static compatibility before any hook command runs |

`hook-doctor` binds a config to reviewed bytes without import, execution, expansion, or activation claims. It supports exact reviewed bytes for `0.1.5-rc.2` and `0.1.6-alpha.1`, with partial dialect compatibility. Current `SessionStart` delivery is detached; alpha awaits `agent/created`. Both lack transcript paths. Historical byte contracts remain available; changed bytes require a new review.

Attest an existing physical profile without booting it or loading packages:

```powershell
node bin/dsh-developer.js attest-profile --profile C:\Users\you\.dsh\profiles\web --dsh D:\path\to\dsh.cmd --json
```

The receipt binds the DSH executable to the exact static profile bytes you tested. Two scans catch links, escapes, mutation, unresolved state, and secrets without booting packages. The current blocking runtime is `0.1.5-rc.2`; `0.1.6-alpha.1` is advisory. A static receipt does not prove runtime behavior or provider isolation.

Inspect an ordinary repository from DSH Web:

```text
/dsh-developer-doctor {"source":"C:/path/to/plugin","skipRuntime":true}
```

Then use the [development workflow](development.md) to test the intended runtime with `verify --profile <name>` and rendered Web behavior with `dev`, including the documented configuration via `--patch`. Doctor's default runtime audit and preflight use the reviewed lanes: `0.1.5-rc.2` blocking and `0.1.6-alpha.1` advisory. On other exact versions, use static Doctor and this ordinary verification route. Product and promoted release checks retain their exact-runtime gates; a newer installation alone is not an ordinary plugin defect.

Doctor checks package and bundle contracts, boot-required packages marked optional, Host/Client injection mixups, browser-service collisions, raw plugin-owned Web routes outside the upstream connection service, and invalid Web artifacts. Connection registration alone does not prove authentication: its APIs and protections differ across DSH versions, so verify the exact runtime and configuration. Product/promoted bundle checks also cover reproducibility and the admitted clean-profile lifecycle. The repository stays read-only during inspection; static findings do not prove behavior.

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

For the current reviewed `0.1.5-rc.2` and `0.1.6-alpha.1` lanes, run impact analysis before upgrade edits:

```powershell
node bin/dsh-developer.js impact --source C:\path\to\plugin --release-dsh D:\release\dsh.cmd --preview-dsh D:\preview\dsh.cmd
```

It follows the packages and Cordis services your plugin actually touches, then compares their public declarations, entries, dependencies, and DSH metadata across both lanes. It proves offline whether declared DSH peer and development ranges admit the exact installed release and preview versions under npm prerelease semantics; registry publication and the project lock remain separate install evidence.

For other targets, inspect both exact installations or checkouts with `knowledge` and follow the affected source and consumers before editing. Then use static Doctor and `verify`/`dev` on each intended runtime. That ordinary route does not extend the reviewed audit lanes.

The migration ledger is a separate bounded historical contract for the exact source corridor `0.1.1-rc.2` to `0.1.2-alpha.3`. It supplies advisory file-and-line actions for that corridor only; it is not the current upgrade recommendation:

```powershell
node bin/dsh-developer.js migration --source C:\path\to\plugin --from-dsh 0.1.1-rc.2 --to-dsh 0.1.2-alpha.3
```

The v1 ledger reports two installed-contract families: removed Web Client runtime dependency, Client inject, and literal-module touchpoints with owner mappings; and named `CallId` → `ToolCallId` bindings. It never edits source. Other corridors fail before source reads, unmapped symbols stay pending, and changes absent at the target emit no action.

For this product or a promoted bundle, compatibility runs the same trusted bytes through both exact runtimes. Verify ordinary plugins separately on each target:

```powershell
node bin/dsh-developer.js compatibility --source C:\path\to\plugin --release-dsh D:\release\dsh.cmd --preview-dsh D:\preview\dsh.cmd
```

Every report ends with a stable digest tied to the final unchanged source tree.

## One workflow for every DSH agent

The global `dsh_developer` tool reaches Web, headless, ACP, Code Mode, and JSON-RPC agents through DSH's native tool registry:

```json
{"operation":"doctor","source":"C:/path/to/plugin","skipRuntime":true}
```

One schema covers every audit, Build, and Apply operation. Blocked results add at most three closed `nextActions`; text shows one. They cannot execute, grant authority, alter digests, or promote previews.

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

Run `node "$DSH_DEVELOPER_BIN" ui-setup` in the DSH POSIX shell (PowerShell: `node "$env:DSH_DEVELOPER_BIN" ui-setup`), then restart DSH before admission. Setup finds normal Chrome/Edge installations and an installed pinned CLI. If the CLI is missing, append `--install-cli` to explicitly install `@playwright/cli@0.1.18` into dedicated local storage. No installation occurs during normal startup or admission.

Configuration defaults to `~/.dsh-developer/ui/config.json`. For disposable storage, use `ui-setup --config <absolute-file>` and set `DSH_DEVELOPER_UI_CONFIG` to that file for both DSH startup and shell UI. `--cli-entry` and `--browser-executable` accept explicit absolute paths when discovery is insufficient. Existing entry/browser/state environment overrides still take precedence. Setup does not launch a browser or prove UI behavior; exercise the rendered page after admission. The [Agent-native UI](../skills/dsh-developer/references/agent-native-ui.md) reference gives the agent operation and evidence loop.

Setup discovery inspects only dedicated provider storage, conventional global CLI roots associated with Node/system installations, and normal Chrome/Edge locations (including user Applications on macOS and Program Files/AppData on Windows). It never scans project repositories, searches arbitrary PATH entries, executes candidate binaries, or launches a browser. Discovery resolves installation links; explicit entry/browser overrides must name ordinary files. The CLI package name and exact version are checked statically.

The default setup directory contains `config.json`, optional `provider` installation storage, and `runtime` browser evidence. Installation uses npm from the running Node installation, with lifecycle scripts and browser downloads disabled. Its npm configuration, cache and home are isolated inside the new provider directory. No global installation or existing home configuration is modified; public setup reports omit local paths.

`DSH_DEVELOPER_PLAYWRIGHT_CLI_ENTRY`, `DSH_DEVELOPER_BROWSER_EXECUTABLE` and `DSH_DEVELOPER_UI_CLI_ROOT` override saved fields individually. A complete entry/browser environment pair uses the legacy route independently of saved configuration. Invalid overrides fail closed. Unset all three to exercise saved configuration alone. If using `--config`, retain the matching `DSH_DEVELOPER_UI_CONFIG` for both routes.

A failed/cancelled installation removes only the fresh provider directory created by that invocation after its child settles, allowing retry. Preexisting unusable provider storage is preserved for an explicit operator decision. Setup can repair malformed ordinary owned configuration after validating replacement paths; runtime rejects malformed configuration, and setup refuses linked/nonordinary destinations.

Shell-capable agents can use the same `ui --session <name> --action <operation>` controller directly. For a running `dev` server, pass its returned `ui` object to `dsh_ui`, or use `ui --session <name> --action open --development-server <home>`. Authentication is handled privately; ordinary `url` navigation continues to reject credentials. Keep `dev` running and close the browser when finished. See [Web development](development.md#work-with-web) for the trust boundary and hot-reload behavior.

## Isolation built for autonomous development

Read-only analysis never executes target code. Restricted runtime audits execute only this product and byte-identical promoted output; credentials stay out of their child environments and evidence. Ordinary trusted development uses the host execution policy described above.

Isolated Build/Apply requires a running reviewed DSH lane (`0.1.5-rc.2`, or advisory `0.1.6-alpha.1`) plus separate successful host-provider admission: WSL2 + Bubblewrap on Windows, Apple container on supported Macs. The provider must establish disposable, offline, credential-free, bounded execution, sealed transfer and cleanup. Headless/Web, compatibility, delegation and approval passes do not establish provider admission. Separate real Apple integration on rc.2 passed 4/4 checks, covering native admission, VM Build/Apply, promotion and sparse/churn cleanup. That observation does not establish alpha isolation or admission on another host. See [Mac provider setup](macos.md#enable-isolated-build-and-apply). Selecting another `--dsh` for a CLI audit does not change the running agent's runtime.

In a top-level DSH Agent, isolated Build is native and path-free. The controller derives source from the live root Agent, binds the commands and safety policy into an expiring digest, and asks DSH for audited one-time approval:

```json
{"operation":"cell-plan","outcome":"Run focused tests and the repository check","commands":[{"command":"node --test","timeoutMs":60000},{"command":"npm run check","timeoutMs":60000}]}
{"operation":"cell-run","planDigest":"sha256:<digest returned by cell-plan>"}
```

If the run seals changes, choose exactly one:

```json
{"operation":"cell-apply","planDigest":"sha256:<same digest>"}
```

or

```json
{"operation":"cell-discard","planDigest":"sha256:<same digest>"}
```

`cell-run` seals approved isolated changes. `cell-apply` re-proves owner, source, stage, checks, and paths, then asks again. A private backup applies without execution; failure restores verified bytes, success final-Doctors and cleans. Discard is idempotent. After a committed Apply it only finishes cleanup—it never undoes source. Ambiguous rollback or crash evidence blocks reuse. Caller paths grant nothing.

```powershell
node bin/dsh-developer.js lab --wsl-distro Ubuntu-22.04
node bin/dsh-developer.js admit-cell --dsh D:\path\to\dsh.cmd --wsl-distro Ubuntu-22.04
```

Read the [execution-lab](../skills/dsh-developer/references/execution-lab.md), [isolated-cell](../skills/dsh-developer/references/isolated-cell.md), and [safety](../skills/dsh-developer/references/safety.md) contracts before embedding the JavaScript APIs.

## Use it from Codex

This repository is a native Codex plugin too. Add the existing folder to a personal marketplace with `$plugin-creator`, install **dsh-developer**, then invoke `$dsh-developer`. DSH and Codex share one workflow and one set of safety rules.

## Compatibility

- Ordinary development: selected exact runtimes, including DSH 0.1.5-rc.2; see [observed results](verification.md).
- Reviewed runtime audit lanes: DSH 0.1.5-rc.2 (blocking) and 0.1.6-alpha.1 (advisory). Headless/Web preflight and native verification, product compatibility, delegation and approval checks passed on both exact runtimes.
- Isolated providers require separate local admission and execution evidence; runtime audit passes do not supply it.
- Node.js: `^22.18.0 || >=24.11.0`.
- Native development: Windows, macOS and Linux. See [platform support](platforms.md) for tested boundaries and the separate Windows/macOS isolated Build requirements.

Release failures block. Preview drift stays visible so it gets fixed before the next DSH release lands.

## Develop dsh-developer

The full suite is deterministic and keyless:

```powershell
npm run validate
npm pack --dry-run
```

## License

[MIT](../LICENSE)
