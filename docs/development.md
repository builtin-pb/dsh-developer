# Develop plugins and DSH

Start with the existing workspace. dsh-developer can inspect ordinary projects with dependencies, locate DSH declarations at an exact installation or source checkout, run project scripts, verify native tools in a disposable profile, and own a temporary Web server.

These commands are available through the installed `dsh-developer` CLI, or `node bin/dsh-developer.js` from this repository. In DSH, the native `dsh_developer` tool exposes read-only `project`, `knowledge` and `session` operations; execution uses the host’s normal shell and approval policy.

## Find the right code

```sh
node bin/dsh-developer.js project --source ./my-plugin
node bin/dsh-developer.js knowledge --dsh /path/to/dsh --topic tool
node bin/dsh-developer.js knowledge --upstream /path/to/deepseek-harness --topic core
node bin/dsh-developer.js knowledge --dsh /path/to/dsh --topic ui --package @deepseek-ai/dsh-api-session-controller
```

`project` identifies the nearest package, ancestor package-manager declaration and lockfiles, scripts, and instruction files. It does not import the project or traverse `node_modules`. Select a subpackage when working in a monorepo. Conflicting toolchain metadata needs resolution before running scripts. Read the project’s instructions before editing.

`knowledge` returns local version and package identities, source/declaration excerpts, file hashes, and explicit omissions. Topics cover tools, lifecycle, configuration, packaging, UI, core, and testing. Its default is `tool`. The excerpt is a starting point: follow imports and read the relevant implementation, consumer and tests with ordinary file tools. A checkout’s HEAD does not establish that its working files are clean, and equal version strings do not prove equal source. Missing packaged documentation does not mean an API is absent.

The native tool reads its running DSH installation and exposes its entry path. DSH also supplies `DSH_DEVELOPER_DSH` to its shell so CLI verification defaults to that same installation; explicit `--dsh` takes precedence. Use CLI `knowledge --dsh` when targeting another installation, or provide both `--dsh` and `--upstream` to see their mismatch explicitly.

Use each package's reported version, not just `dsh --version`: a package manager can install a launcher whose dependency ranges resolve newer DSH packages. For example, a fresh npm installation of launcher `0.1.5-rc.1` resolved tools and session packages at `0.1.5-rc.2` during development. The declaration identity and dependency map retain those differences.

For a TypeScript project, `knowledge` reports the selected package's installed DSH peer dependency closure under `development.dependencies`. `--package` (native `packageName`) focuses both navigation and the closure on one exact package, including packages outside the topic hints. Pin matching development versions to prevent npm from selecting incompatible prerelease peers and failing with `ERESOLVE`. Check `development.complete` and missing or incompatible peers before using the map. Type-only imports and ordinary dependencies are not automatically discovered: follow declarations and query additional imported packages as needed. Build and invoke on the chosen runtime; metadata alone is not an installation or compatibility guarantee.

## Build and invoke a real plugin

The [TypeScript package-check example](../examples/package-check/README.md) includes a maintained runtime dependency, real DSH type imports, unit and registration tests, and eight native tool cases.

```sh
npm --prefix examples/package-check ci --ignore-scripts
node bin/dsh-developer.js run --source examples/package-check --script test
node bin/dsh-developer.js verify --source examples/package-check --cases examples/package-check/tool-cases.json --dsh /path/to/dsh
```

`run` executes a declared npm, pnpm or Yarn script in the selected package. It preserves the host environment, package-manager hooks and toolchain behavior, including automatic setup. It returns exit status and bounded, credential-checked output and forwards cancellation. Put additional script arguments after `--`; their boundaries, empty strings and flags are preserved. The runner checks the actual Yarn version because Classic and modern Yarn parse script flags differently. Use native package-manager commands for installation. This is authorized execution of trusted project code, not isolation.

```sh
node bin/dsh-developer.js run --source ./my-plugin --script test -- --test-name-pattern "reload behavior"
```

The script must itself accept those flags; a compound script such as `build && test` follows its package manager's usual forwarding rules.

`verify` installs the source directory or a `.tgz` archive into a fresh DSH profile with installation scripts disabled. It invokes the real global tool registry and compares canonical values. A case is `{ "tool": "name", "arguments": {}, "expected": value }`; expected failures use `"isError": true`. Absent values compare as JSON `null`. Use optional `resultPath` (a JSON Pointer such as `/items/0/status`) to compare a stable part of a dynamic result. A missing selected field fails, even when the expected value is null. Successful registration alone cannot pass. Wrong results, failed execution, missing tools or missing receipts fail verification. When the launcher supplies native `appReady`, invocation waits for completed startup; a tool registering early cannot conceal a later startup failure. Older launchers without that signal provide registration and process-outcome evidence only.

Every case reports `valueBytes`, `contentBytes` and their sum, `resultBytes`: UTF-8 JSON bytes of the full canonical value and rendered content array. A selected `resultPath` does not hide the rest of the response. Set optional `maxResultBytes` to a positive integer to fail a result that exceeds the task's output budget, even if its selected value is correct. These are output checks; they do not bound the plugin's memory or input work.

```json
{"tool":"summarize_checks","arguments":{"path":"checks.jsonl"},"resultPath":"/summary/failures","expected":1,"maxResultBytes":16384}
```

Comparisons use full values. The receipt omits individual value, content or pointer fields over 1 KiB and marks them with `valueOmitted`, `contentOmitted` or `resultPathOmitted`. Counts, byte measurements and pass/fail remain available; omission does not turn a failing assertion into a pass. This keeps up to 32 large-result observations readable without losing their verdicts.

This verifier observes global native tools, not a model turn, Agent-specific permissions, arbitrary services, or rendered UI. Use project tests or a real DSH agent session for those behaviors. Disposable profiles are removed after success, failure and cancellation. They separate configuration and are **not sandboxes**; use the existing admitted cell workflow for untrusted execution.

Build before packing, then verify what users will install:

```sh
npm --prefix examples/package-check pack --pack-destination /path/to/artifacts
node bin/dsh-developer.js verify --source /path/to/artifacts/dsh-package-check-0.1.0.tgz --cases examples/package-check/tool-cases.json --dsh /path/to/dsh --online
```

`--online` permits dependency downloads into a temporary store, still without install scripts. The default is offline; an archive with uncached dependencies needs `--online`. Use `--profile` to select the composition under test. The default is a fresh base-backed `developer-test` profile. For shipped `headless`, verification disables the native `headless-startup` and `headless-runner` rows and reports them; it does not run a model task. For `web`, it requests a temporary port and disables browser opening. Other compositions may require a trusted `--patch` to disable their application driver; tools depending on that driver need an application-specific integration test. The existing `compatibility` command remains restricted to this product and reproducible promoted bundles; verify ordinary plugins separately on every version you intend to support.

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

`knowledge --topic ui` includes the selected runtime's `@deepseek-ai/dsh-client-modules` package for client loading contracts. For browser externals, follow the selected checkout's `packages/client/web/src/platform.ts` and compare the example's build. For placement, inspect the package declaring the intended slot: `@deepseek-ai/dsh-client-ui-layout` for main panels, `@deepseek-ai/dsh-client-ui-settings` for settings sections, or the relevant feature owner. Focus the lookup with `--package`. A package bundled into the Web frontend may be absent from the host's installed dependency graph; that absence does not establish missing browser capability.

```sh
node bin/dsh-developer.js dev --source ./my-plugin --dsh /path/to/dsh
```

The command creates a disposable Web profile, registers the source project with DSH's native workspace service, requests an available port, and reports the bound process’s URL after checking its page and, where available, receiving native startup readiness. An archive uses an empty temporary workspace. It reports a clean URL and a `ui` action for the owned server. The private launch token stays in its temporary profile. It does not automatically open a browser.

Prepare the browser once with `dsh-developer ui-setup` (explicit `--install-cli` if the pinned CLI is missing), then restart DSH for native registration. For disposable setup storage and environment overrides, see [Agent-native UI](../skills/dsh-developer/references/agent-native-ui.md). Shell UI reads saved configuration immediately.

Invalid UI configuration leaves core developer commands available and `dsh_ui` unregistered. DSH logs the configuration error code and setup instruction; repair it and restart before using native UI. Unexpected activation errors still propagate.

Native Agent disposal cancels and drains that owner's browser calls before closing its browser. Plugin unload does this for all owners. Close attempts have a five-second timeout. A failed close retains ownership and reports the failure; an explicit controller cleanup retry can try again, while ordinary calls remain blocked for the ended owner. Shell sessions require an explicit `close`.

Pass the reported `ui` object directly to `dsh_ui`. Its `developmentServer` field selects the private home directory returned by the running `dev` command. The browser completes native DSH authentication internally and opens the clean URL. Keep the owning terminal running; expired references are rejected. Do not paste launch tokens or disable DSH authentication.

Shell agents use the same handoff:

```sh
node bin/dsh-developer.js ui --session plugin-preview --action open --development-server <home-returned-by-dev> --json
```

Exercise the plugin’s actual UI, reload, state and errors, then close the browser. HTTP readiness is not UI proof. Browser observations include the rendered results of `find`, `console` and `requests`; diagnostic lines that may contain credentials are withheld without discarding the browser.

This route executes trusted local development code. The isolated browser keeps its login cookie in memory, restricts networking to the selected DSH server, and closes when that server or its owning `dev` process ends. Native streaming and same-server redirects keep their normal behavior; requests to other servers are blocked, including requests from browser workers. This is not containment for a hostile plugin. Personal profiles, arbitrary cookie imports and generic token-bearing navigation remain unavailable.

The server runs until cancellation; `--timeout-ms` can set an explicit lifetime. Logs retain a bounded tail without terminating the server for accumulated output. Stop the owning terminal with Ctrl+C to terminate its process group and remove its profile. Restart after Host changes; build/watch Client assets through the project’s own workflow.

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
