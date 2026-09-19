# Develop plugins and DSH

Start with the existing workspace. dsh-developer can inspect ordinary projects with dependencies, locate DSH declarations at an exact installation or source checkout, run project scripts, verify native tools in a disposable profile, and own a temporary Web server.

You can begin with a rough idea. The development skill uses the request and project context to propose useful behavior, checks whether existing facilities already meet the need, and asks only about choices that materially affect the result. Its shared DeepSeek/GPT guidance makes implementation decisions concrete: follow native ownership and lifetimes, trust established internal contracts, distinguish failed or incomplete evidence from success, and check realistic cases where plausible implementations disagree. Routine fixes need no design ceremony. This guidance supports judgment; passing checks does not guarantee an error-free project.

The development skill closes a task by reviewing the result against your intent and the whole run, including retries and workarounds. It briefly reports meaningful friction or what went smoothly. For an actionable dsh-developer problem, it asks whether to file an issue. After you agree, it prepares, sanitizes and submits the report without another approval round.

Inside a DSH agent's shell, run the installed CLI with `node "$DSH_DEVELOPER_BIN" <operation>` on POSIX or `node "$env:DSH_DEVELOPER_BIN" <operation>` in PowerShell. Profile installation does not create a global CLI command. The examples below use `node bin/dsh-developer.js` from this repository's checkout. In DSH, the native `dsh_developer` tool exposes read-only `project`, `knowledge` and `session` operations; execution uses the host’s normal shell and approval policy.

## Find the right code

```sh
node bin/dsh-developer.js project --source ./my-plugin
node bin/dsh-developer.js knowledge --dsh /path/to/dsh --topic tool
node bin/dsh-developer.js knowledge --upstream /path/to/deepseek-harness --topic core
node bin/dsh-developer.js knowledge --upstream /path/to/deepseek-harness/packages/client/ui-layout/src/client/stores.ts --topic ui
node bin/dsh-developer.js knowledge --dsh /path/to/dsh --topic ui --package @deepseek-ai/dsh-api-session-controller
```

`project` identifies the nearest package, containing DSH checkout, ancestor package-manager declaration and lockfiles, scripts, and instruction files. It does not import the project or traverse `node_modules`. Select a subpackage or source file when working in a monorepo; scripts still run in that package. Instruction files follow the selected path from outermost to innermost, including directories below the package root and new directories without a manifest. Conflicting toolchain metadata needs resolution before running scripts. Read the project’s instructions before editing.

`project` also checks literal `main`, root `exports`, and `dsh.bundle.patch` paths. A missing generated file such as `lib/index.js` prompts consideration of the declared `build` script before native verification. Conditional exports, alternatives, subpaths, links and unsupported paths remain unresolved; declaring `exports` leaves legacy `main` uninspected. These are advisory metadata observations, not runtime-readiness proof, and do not affect `project.ok` or execution gates. Inspection runs no code, builds or installs; ordinary bundle metadata is retained independently of inspection.

`knowledge` returns local version and package identities, source/declaration excerpts, file hashes, and explicit omissions. Topics cover tools, lifecycle, configuration, packaging, UI, core, and testing. Its default is `tool`. The excerpt is a starting point: follow imports and read the relevant implementation, consumer and tests with ordinary file tools. A checkout’s HEAD does not establish that its working files are clean, and equal version strings do not prove equal source. Missing packaged documentation does not mean an API is absent.

`--upstream` (native `source`) accepts a checkout, package directory or file. Selecting a subpackage uses its own manifest and source directory, including packages outside the topic hints. A selected source or test file under the package’s ordinary code directories takes priority within the existing excerpt limits. Checkout-root selection retains topic-based navigation. A conflicting `--package` is rejected; select the checkout root to navigate to another package. Discovery stops at a repository marker or the native Agent workspace boundary, so open the containing checkout as the workspace when developing DSH. It does not search every package, traverse source symlinks during discovery, or inspect configuration, fixtures or dependencies as source.

For an installed DSH package, omit `--upstream` and use `--package` (native: omit `source`, use `packageName`). An installed package directory is not an upstream checkout. The skill's bundled examples are under `../../../examples/` relative to its `references/development.md` file.

Same-name tests, including DSH's `.client.spec` and `.host.spec` variants, are prioritized for a selected file. Names are navigation hints, not coverage evidence. Omitted source/test excerpts appear in `missing`; inspect the complete owning tests before editing. Many DSH subpackages declare only build/watch scripts: inspect the reported checkout root for repository test commands, then follow its instructions to select the relevant suite.

The native tool reads its running DSH installation and exposes its entry path. DSH also supplies `DSH_DEVELOPER_DSH` to its shell so CLI verification defaults to that same installation; explicit `--dsh` takes precedence. Use CLI `knowledge --dsh` when targeting another installation, or provide both `--dsh` and `--upstream` to see their mismatch explicitly.

Use each package's reported version, not just `dsh --version`: a package manager can install a launcher whose dependency ranges resolve newer DSH packages. For example, a fresh npm installation of launcher `0.1.5-rc.1` resolved tools and session packages at `0.1.5-rc.2` during development. The declaration identity and dependency map retain those differences.

For a TypeScript project, `knowledge` reports the selected package's installed DSH peer dependency closure under `development.dependencies`. `--package` (native `packageName`) focuses both navigation and the closure on one exact package, including packages outside the topic hints. Pin matching development versions to prevent npm from selecting incompatible prerelease peers and failing with `ERESOLVE`. Check `development.complete` and missing or incompatible peers before using the map. Type-only imports and ordinary dependencies are not automatically discovered. To follow an installed declaration import, pass `--package <imported-name> --consumer-root <originating-package-root>` (native `packageName` and `consumerRoot`). Use the physical root in the preceding knowledge report: nested dependencies can differ from the launcher's copy. Without a consumer, lookup starts at the selected DSH package. Build and invoke on the chosen runtime; metadata alone is not an installation or compatibility guarantee.

## Build and invoke a real plugin

The [TypeScript package-check example](../examples/package-check/README.md) includes a maintained runtime dependency, real DSH type imports, unit and registration tests, and eight native tool cases. When packing, use `npm pack --pack-destination <output-directory>` with an existing directory outside the inspected source. Doctor rejects archives left in the source tree; `verify --source <archive.tgz>` exercises the packaged artifact.

```sh
npm --prefix examples/package-check ci --ignore-scripts
node bin/dsh-developer.js run --source examples/package-check --script test
node bin/dsh-developer.js verify --source examples/package-check --cases examples/package-check/tool-cases.json --dsh /path/to/dsh
```

`run` executes a declared npm, pnpm or Yarn script in the selected package. It preserves the host environment, package-manager hooks and toolchain behavior, including automatic setup. It returns the actual exit status and credential-checked output and forwards cancellation. Verbose scripts keep running while only the last 512 KiB of each output stream is retained; `output.truncated` and the human report identify omitted output. A clipped first line is withheld; if a private-key marker appeared in either stream, both streams are withheld even when its header has left the retained tail. `output.withheld` records that omission. Put additional script arguments after `--`; their boundaries, empty strings and flags are preserved. The runner checks the actual Yarn version because Classic and modern Yarn parse script flags differently. Use native package-manager commands for installation. This is authorized execution of trusted project code, not isolation.

```sh
node bin/dsh-developer.js run --source ./my-plugin --script test -- --test-name-pattern "reload behavior"
```

The script must itself accept those flags; a compound script such as `build && test` follows its package manager's usual forwarding rules. The `run` CLI exits with the package-manager process's actual status, including nonzero statuses other than 1. This lets calling scripts distinguish their project's own failure modes; cancellation still exits 130, and launcher or inspection errors exit 1.

`verify` installs the source directory or a `.tgz` archive into a fresh DSH profile with installation scripts disabled. It invokes the real global tool registry and compares canonical values. A case is `{ "tool": "name", "arguments": {}, "expected": value }`; expected failures use `"isError": true`. Absent values compare as JSON `null`. Use optional `resultPath` (a JSON Pointer such as `/items/0/status`) to compare a stable part of a dynamic result. A missing selected field fails, even when the expected value is null. Successful registration alone cannot pass. Wrong results, failed execution, missing tools or missing receipts fail verification. Invocation waits for the official CLI entry to finish startup, including native readiness where available. This also covers older launchers without `appReady`: a tool registering early cannot conceal a later startup failure.

On Windows, `verify` and `dev` preserve spaces and shell punctuation in source and temporary-store paths through DSH's native pnpm forwarding. The selected CLI's installer determines whether paths need shell quoting or direct argument forwarding. Older shell-based installers reject `%` and `!` because the shell can expand them; select a different path on those runtimes. Current direct-argument installers retain them literally.

To distinguish the intended error from an unrelated failure, add `errorContains` alongside `isError: true`. It requires a nonblank literal of at most 512 characters and matches case-sensitively within one rendered text block, before clipping or credential protection. It is not a regular expression, and it does not inspect image metadata or join separate blocks. For example, `{"tool":"lookup","arguments":{"id":"missing"},"isError":true,"errorContains":"NOT_FOUND"}` asserts a particular error message. Keep structured domain-result assertions on `resultPath`; that pointer selects from the canonical value, not the native error envelope.

Every case reports `valueBytes`, `contentBytes` and their sum, `resultBytes`: UTF-8 JSON bytes of the full canonical value and rendered content array. A selected `resultPath` does not hide the rest of the response. Set optional `maxResultBytes` to a positive integer to fail a result that exceeds the task's output budget, even if its selected value is correct. These are output checks; they do not bound the plugin's memory or input work.

```json
{"tool":"summarize_checks","arguments":{"path":"checks.jsonl"},"resultPath":"/summary/failures","expected":1,"maxResultBytes":16384}
```

Comparisons use full values. The receipt omits individual value, content or pointer fields over 1 KiB and marks them with `valueOmitted`, `contentOmitted` or `resultPathOmitted`. Counts, byte measurements and pass/fail remain available; omission does not turn a failing assertion into a pass. This keeps up to 32 large-result observations readable without losing their verdicts.

Give a case an optional `name` (up to 128 characters) to identify its purpose. Every result includes its one-based `index` and all applicable `failures`: `unexpected-error`, `expected-error`, `error-message-mismatch`, `missing-result-path`, `value-mismatch`, or `result-budget-exceeded`. A value mismatch also includes the expected value, or `expectedOmitted` when too large. Names and retained result fields share a 3 KiB allowance per case; the individual 1 KiB field limit still applies, including `errorContains`/`errorContainsOmitted`. The human report explains each failure so repeated calls to the same tool remain distinguishable. Expectations must come from the intended behavior; do not change them simply to match the observed result.

Verification checkpoints completed cases and the active invocation. If a later tool hangs, the launcher exits, or you cancel, earlier observations remain available and `activeCase` identifies the interrupted case. `complete: false` means the batch did not finish, even if all retained cases passed. The verifier does not retry interrupted calls or run the remaining cases. Cancellation keeps its normal exit status 130; its JSON diagnostic includes the partial report under `verification`. A checkpoint is diagnostic evidence, not a resumable transaction or proof that the interrupted tool made no changes.

Before invoking cases, verification requires every enabled entry in the disposable profile to activate. Some newer DSH versions keep healthy siblings running after optional plugins fail; that does not satisfy this development check. Explicitly disabled entries are allowed. By default, the verifier observes global native tools without an Agent. Use the workspace option below for Agent-scoped tools, and project tests or an actual session for model turns, approval interactions and rendered UI. Disposable profiles are removed after success, failure and cancellation. Verification selects `patchReload: startup` when the profile declares live reload: one-shot checks compose the initial configuration without starting development watchers. The receipt reports that mode. On POSIX it also signals the owned process group after launcher exit and waits for the termination sequence. Windows plugins must stop and await their workers before normal exit; post-exit descendant cleanup is unavailable. `processCleanup` records the platform and these limits. They separate configuration and are **not sandboxes**; use the existing admitted cell workflow for untrusted execution.

Credential-like result fields are withheld with explicit `valueWithheld` or `contentWithheld` flags and an `outputProtection` summary. Comparisons, case verdicts and completion remain available. The detector is conservative: an ordinary long path can also be withheld. A private-key marker in the full result suppresses payloads across the batch even if the marker itself falls outside the displayed excerpt. These protections do not turn a failed assertion into a pass or change the output-size measurement.

### Verify tools that need an Agent

```sh
node bin/dsh-developer.js verify --source ./my-plugin --cases ./tool-cases.json --workspace ./test-workspace --profile web --dsh /path/to/dsh
```

`--workspace` selects an existing directory and creates one real, fresh DSH Agent for the batch. DSH mounts the selected profile's default Agent preset when available. Lookup and invocation use that Agent's actual tool scope and native policies. Relative paths handled by native filesystem tools resolve from its workspace, and cases share the Agent's state. This also exercises workspace-bound `dsh_developer` operations such as `project` and `session`. The report records the canonical workspace, Agent identity and preset; the profile's launcher directory stays separate.

Invalid case files identify the one-based case number, field and expected format before installing the plugin. Incomplete verification and startup failures show a bounded, credential-checked process excerpt in the normal terminal report. Error headers take priority over long stacks; omissions and withheld streams remain explicit. `--json` retains the structured diagnostic and any larger protected process capture.

The verifier submits no model turn, supplies no fake Agent, and changes no permission policy. A tool requiring interactive approval can fail outside an open turn; keep that result and test the interaction in a real session. Tools or trusted plugin lifecycle listeners can themselves initiate network or model work. Preset composition failures propagate rather than falling back to a different tool scope.

Agent setup and disposal are part of verification. `phase` distinguishes startup, Agent setup, cases, Agent disposal and completion. All results may have returned while disposal remains incomplete; `complete: true` requires awaited disposal as well. An invocation error and a separate disposal error are retained independently. The selected workspace is real and writes there persist; use disposable fixture directories for mutating tests. Profile removal does not roll back workspace changes.

Build before packing, then verify what users will install:

```sh
npm --prefix examples/package-check pack --pack-destination /path/to/artifacts
node bin/dsh-developer.js verify --source /path/to/artifacts/dsh-package-check-0.1.0.tgz --cases examples/package-check/tool-cases.json --dsh /path/to/dsh --online
```

`--online` permits dependency downloads into a temporary store, still without install scripts. The default is offline. Each profile owns a fresh store, so use `--online` when an archive needs registry dependencies; the host’s global package cache is not reused. Use `--profile` to select the composition under test. The default is a fresh base-backed `developer-test` profile. For shipped `headless`, verification disables the native `headless-startup` and `headless-runner` rows and reports them; it does not run a model task. For `web`, it requests a temporary port and disables browser opening. Other compositions may require a trusted `--patch` to disable their application driver; tools depending on that driver need an application-specific integration test. The existing `compatibility` command remains restricted to this product and reproducible promoted bundles; verify ordinary plugins separately on every version you intend to support.

Test the configuration instructions you plan to ship, too:

```sh
node bin/dsh-developer.js verify --source ./my-plugin.tgz --cases ./tool-cases.json --patch ./example-config.patch.yml --dsh /path/to/dsh
```

`--patch` selects one ordinary Cordis patch file for `verify` or `dev`. Native DSH applies it after the installed bundle/profile and before the development probe, during both configuration preparation and actual boot. To change a bundled plugin's configuration, override its existing row by `id` and `config`; inserting the same ID again can compose successfully but fail at boot. Test the actual documented file in a fresh profile. Patch loading uses the same trusted host execution policy as the plugin.

Use `doctor --source <plugin> --skip-runtime` for static package checks during ordinary development, then `verify` for the selected runtime. Native Doctor uses `skipRuntime: true` for the same purpose. Doctor's default blocking runtime lane belongs to the release audit workflow; a newer DSH version is not by itself a defect in an ordinary plugin. Static Doctor alone is never release or execution proof.

An `INCOMPLETE_UPSTREAM_ATTACHMENTS` result identifies context or activation expressions the static analyzer could not fully follow. Its evidence separates discovered injection validity from analysis coverage and names the affected files. It does not establish that a literal `inject` declaration is invalid. Inspect the reported expressions and retain the unresolved coverage finding; native verification supplies separate runtime evidence and does not turn that static gate into a pass.

When a development session fails unexpectedly, use [session diagnostics](session-diagnostics.md) to inspect its tool calls and results without replaying them.

## Work with Web

The [native session-status example](../examples/session-status/README.md) shows a real Client bundle, typed slots, session hooks and disposal. Its tests use DSH's actual registry, and its packed artifact has also been exercised in a rendered Web session.

On DSH 0.1.5-rc.2, a slash command in an otherwise empty session can run successfully while its result remains hidden on the landing page. Run the built-in `/goal` once to show the conversation, then use developer commands. This upstream display issue does not lose command results or require a model call; avoid repeating a command just because its result is hidden.

`knowledge --topic ui` includes the selected runtime's `@deepseek-ai/dsh-client-modules` package for client loading contracts. For browser externals, follow the selected checkout's `packages/client/web/src/platform.ts` and compare the example's build. For placement, inspect the package declaring the intended slot: `@deepseek-ai/dsh-client-ui-layout` for main panels, `@deepseek-ai/dsh-client-ui-settings` for settings sections, or the relevant feature owner. Focus the lookup with `--package`. A package bundled into the Web frontend may be absent from the host's installed dependency graph; that absence does not establish missing browser capability.

```sh
node bin/dsh-developer.js dev --source ./my-plugin --dsh /path/to/dsh
```

The command creates a disposable Web profile, registers the source project with DSH's native workspace service, requests an available port, and reports the bound process’s URL after checking its page and, where available, receiving native startup readiness. An archive uses an empty temporary workspace. It reports a clean URL and a `ui` action for the owned server. The private launch token stays in its temporary profile. It does not automatically open a browser.

Use `--workspace` to preview either a source directory or an archive against a separate, existing project:

```sh
node bin/dsh-developer.js dev --source ./my-plugin --workspace ./sample-project --watch --dsh /path/to/dsh
```

The selected directory becomes the registered workspace and the server's working directory, so a new Web session defaults to it and native relative file tools operate there. Host watching still follows the plugin source. Workspace changes persist after the temporary profile is removed; use a disposable sample project when testing writes.

Add `--watch` for native Host hot reload from a source directory:

```sh
node bin/dsh-developer.js dev --source ./my-plugin --watch --dsh /path/to/dsh
```

This enables DSH's Cordis HMR service and its required Node loader support for the disposable server. Changes to loaded Host modules inside the selected package reload their dependent plugin entries in the same process. Keep the project's build/watch command running when the Host entry uses compiled output. Client bundling still follows the project's own workflow; this option does not provide browser HMR. Packed archives cannot be watched. Dependencies outside the selected directory, ignored files and changes to package installation require a restart.

Reload notifications report native attempts, activation state and cumulative HMR warnings. A syntax error can leave the previous code running even when every entry remains active; a warning makes that uncertainty visible. A later settled attempt means the enabled entries activated, not that the changed behavior is correct. Exercise it in the browser or rerun `verify`. Notifications contain only status metadata, not raw plugin logs. JSON consumers may receive readiness, reload and shutdown objects; `sequence` orders observed status updates, not source edits, and rapid intermediate updates may be coalesced.

Native HMR can start replacement activation before an old asynchronous disposer finishes. If a plugin must release a port, lock or other exclusive resource before reactivation, restart the server or coordinate the resource's lifetime explicitly. The [upstream reproduction](https://github.com/deepseek-ai/deepseek-harness/discussions/6883) covers a file lock on DSH 0.1.5-rc.2; dsh-developer reports the resulting failed activation but does not replace the native reload lifecycle.

Stopping the development server uses bounded process termination. It does not guarantee that every plugin's shutdown disposer completes; keep persistent writes explicit and await them during normal operation.

Prepare the browser once with the CLI's `ui-setup` operation (explicit `--install-cli` if the pinned CLI is missing), then restart DSH for native registration. For disposable setup storage and environment overrides, see [Agent-native UI](../skills/dsh-developer/references/agent-native-ui.md). Shell UI reads saved configuration immediately.

Invalid UI configuration leaves core developer commands available and `dsh_ui` unregistered. DSH logs the configuration error code and setup instruction; repair it and restart before using native UI. Unexpected activation errors still propagate.

Native Agent disposal cancels and drains that owner's browser calls before closing its browser. Plugin unload does this for all owners. Close attempts have a five-second timeout. A failed close retains ownership and reports the failure; an explicit controller cleanup retry can try again, while ordinary calls remain blocked for the ended owner. Shell sessions require an explicit `close`.

Pass the reported `ui` object directly to `dsh_ui`. Its `developmentServer` field selects the private home directory returned by the running `dev` command. The browser completes native DSH authentication internally and opens the clean URL. Keep the owning terminal running; expired references are rejected. Do not paste launch tokens or disable DSH authentication.

Shell agents use the same handoff:

```sh
node bin/dsh-developer.js ui --session plugin-preview --action open --development-server <home-returned-by-dev> --json
```

Exercise the plugin’s actual UI, reload, state and errors, then close the browser. HTTP readiness is not UI proof. Browser observations include the rendered results of `find`, `console` and `requests`; diagnostic lines that may contain credentials are withheld without discarding the browser.

This route executes trusted local development code. The isolated browser keeps its login cookie in memory, restricts networking to the selected DSH server, and closes when that server or its owning `dev` process ends. Native streaming and same-server redirects keep their normal behavior; requests to other servers are blocked, including requests from browser workers. This is not containment for a hostile plugin. Personal profiles, arbitrary cookie imports and generic token-bearing navigation remain unavailable.

Web readiness also requires all enabled profile entries to activate. The observer listens for failed entries before Web services are available and preserves their errors through unrelated startup rollback. Failures before observation starts, import failures without a fiber, or a failing plugin stuck in its own cleanup can still reach the startup timeout. Timeouts retain bounded, protected process diagnostics after attempted owned cleanup. If inherited pipes do not close, both streams are withheld and the report warns that descendants may remain alive. The server runs until cancellation; `--timeout-ms` can set an explicit lifetime. Logs retain a bounded tail without terminating the server for accumulated output. Stop the owning terminal with Ctrl+C to terminate its process group and remove its profile. The CLI prints a final shutdown report, including incomplete cleanup observations. Without `--watch`, restart after Host changes.

## Develop the harness and this plugin

For upstream DSH, follow its checkout instructions and owning package’s tests. Install the pinned toolchain before builds. Plugin Doctor is not an upstream source gate. Preserve the commit, relevant working changes, command and result with a reproduction. Use source-aware knowledge to locate native services before implementing a workaround.

Develop dsh-developer through its own supported workflow:

```sh
node bin/dsh-developer.js project --source .
node bin/dsh-developer.js run --source . --script test:development
node bin/dsh-developer.js run --source . --script validate
node bin/dsh-developer.js run --source . --script test:development:dsh
```

The last script needs DSH and pnpm on PATH, the example built with dependencies installed, loopback sockets, and dependency-download access. Set `DSH_DEVELOPER_DSH` to select a different exact installation. It exercises this plugin’s native knowledge tool, correct and incorrect expectations, packed installation, Web authentication, cancellation and occupied-port rejection.

Using these commands is the first stage of self-hosting. A real model must still select the skill, navigate code, implement and repair a task before autonomous development is demonstrated. Keep that evidence separate from deterministic and runtime tests.

See [verification results](verification.md) for observed environments, model-task findings and remaining gaps.
