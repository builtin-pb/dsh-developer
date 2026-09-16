# Development verification

These are local and CI observations from 10–16 September 2026. Dated sections distinguish the released version from subsequent checkout work. They describe what was exercised, not a claim that dsh-developer already completes every development task reliably. The [development guide](development.md) explains how to use the capabilities; the [strategy](development-strategy.md) retains the broader goal and unfinished milestones.

## Package-aware source navigation — 16 September, unreleased

The v0.1.1 CLI rejected a source-file selection inside the current DSH checkout's
`ui-layout` package. The revised lookup retains both the selected package and
its checkout, including owners outside the curated topic list. Selecting
`src/client/stores.ts` at upstream revision
`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` returned that file, package identity,
nearby tests and the checkout revision. Root-based topic lookup is unchanged.
Regression tests cover CLI/native parity, conflicting package selections,
workspace and nested-repository boundaries, malformed nearest metadata,
source/test excerpt limits and shared manifest-read accounting.

A fresh actor used this workflow on the real upstream column-geometry helper
and its existing tests. In a private copy, changing `<` to `<=` seeded an
exact-fit regression: two original tests failed. Adding the neighboring
979/980/981px cases produced three failures; repairing the comparator passed
all 19 tests through `dsh-developer run`. This used official Vitest 4.1.8 with
an explicit minimal configuration, not upstream's full GUI/build/typecheck
gates. The released CLI rejected the same file lookup and could not locate
this owner from a root lookup without installed package metadata.

The exercise exposed two navigation omissions: matching tests fell behind the
two-test excerpt cap, and omitted excerpts were not recorded. The lookup now
prioritizes same-name tests and reports source/test excerpt limits. Repeating
the `columns.ts` lookup returned `columns.client.spec.ts` first and recorded
both omissions. Repository-level script selection and toolchain setup still
require the checkout's own instructions. This is one controlled repair exercise,
not a model comparison or a general autonomous-development success rate.

Actual Chrome Computer Use on DSH 0.1.5-rc.2 exercised a local test command that
invoked the native tool with a real Agent. Source-file and matching-package
lookups passed; conflicting packages and workspace escapes returned the
expected errors. All four results rendered in the Web conversation. The test
used a disposable authenticated profile, no model call, and one tab that was
closed afterward; the owning runner removed its profile. The temporary probe
is not a shipped command.

DSH disables GitHub Issues and directs bug reports to Discussions. Our
independent reproduction of invisible first-command results was added to the
[existing upstream report](https://github.com/deepseek-ai/deepseek-harness/discussions/6157#discussioncomment-18463219),
including affected-version evidence and the keyless `/goal` workaround.
An upstream repair has not been verified.

## v0.1.1 developer rollout review — 15 September

A fresh install of the public v0.1.0 Git tag booted on DSH 0.1.5-rc.2 and invoked
the native knowledge tool. Independent code reviews then found several
connections the earlier gates missed: unresolved toolchain metadata could
select npm, verbose builds could be stopped by the output cap, and following a
nested dependency import could select another installed version. The revised
runner retains bounded log tails; knowledge follows an explicit physical
consumer and accounts for manifest reads within its shared budget.
Output protection observes private-key headers before truncation and withholds
both streams, including when a header spans process-output chunks.

Verification now uses an explicit temporary pnpm store and startup-only patch
loading where the profile supports it. It preserves the first cancellation
cause, distinguishes failed assertions from startup errors, and attempts owned
process-group cleanup after exit on POSIX. Windows post-exit worker cleanup is
not claimed; plugins must dispose their workers. Native UI admission now checks
the calling Agent's tool catalog. A harmless shell assignment in documentation
no longer triggers the entropy heuristic; independent review also retained
padded-token detection. The AST dependencies were updated to 8.0.5; npm reported
no known production dependency advisories on this date.

A fresh Codex actor, limited to the installed skill, public examples and exact
DSH packages, implemented a Git TODO/FIXME overview and then configurable tags
and team exclusions. The first version passed seven tests and ten archive cases;
the maintenance version passed ten tests and eighteen archive cases. Independent
native checks confirmed Unicode references, live edits, bounded results and
explicit partial status at the 20,000-file and 32 MiB read limits. The team
configuration also passed eight cases using the repaired default verification
profile. These are assisted development observations, not a DeepSeek comparison
or a reliable-autonomy estimate. Neither generated plugin is shipped.

That trial exposed the documentation false positive and unnecessary verifier
watchers. Its claim that failed CLI checks returned success was investigated
and disproved: trailing shell commands had masked the CLI's actual exit status.
Private first artifacts and corrections were preserved before follow-up work.

A second fresh actor built a read-only package-script panel using native DSH
Web slots. Its archive passed four tests and rendered refresh, empty states,
malformed/missing/unreadable-file recovery, keyboard use and two viewport
checks on 0.1.5-rc.2. An unauthenticated request returned 401; displayed script
text was not executed. Independent archive checks covered Unicode, unusual
script keys, live rereads and the exact 1 MiB input boundary. One configured
project was the declared scope; dark mode and broad accessibility coverage were
not assessed. Neither actor used a model API or a personal browser profile.

The Web trial exposed unsupported native Fetch registration in static analysis
and navigation-generated browser references rejected by the action validator.
Both were repaired. Doctor now distinguishes Connection registration from
authentication evidence: the older reviewed runtime and current runtime have
different protections, so exact-runtime authentication still needs execution
evidence. The panel's static audit passes after the parser repair; its rendered
checks remain separate from the native-tool-only verifier.

Further failure-path review found nested directory-to-file Apply, early provider
disposal rejection and cancellation during transaction preparation defects.
Regression checks cover directory identity restoration, observed asynchronous
cleanup failure and truthful transaction cleanup/retention. Injected failures
establish those controller paths, not universal provider reliability.

Cross-platform CI exposed an additional startup boundary on the advisory alpha:
DSH can keep healthy siblings serving after another enabled plugin fails.
Development now checks the settled enabled composition before announcing Web
readiness or invoking tool cases, and rechecks entries mounted before native
application readiness. Tokened failure receipts preserve activation errors even
when readiness never arrives. Timeout and cancellation retain protected output;
incomplete pipe drainage withholds both streams and explicitly leaves descendant
cleanup unverified. Independent real-Cordis checks covered late entries, disabled
entries and disposal.

Archive previews now create an empty workspace separate from the disposable
profile and package store; source-directory previews retain the selected project.
Native checks exercise both paths. An alpha macOS CI startup-failure case still
timed out in one follow-up run and passed in the next without a runtime change;
its intermittent cause remains unresolved. The check never announced readiness
for the failed plugin, and the alpha lane remains advisory.

Integrated local validation passed **649 tests**, with **31 optional checks
skipped**, on macOS ARM64 and Node 24.19.0. A clean tracked-source copy passed
static Doctor and both reviewed product lifecycle lanes. The product's Codex
manifest must match its package version; generated bundles retain their fixed
version contract. Mismatched product metadata was separately rejected.

The native development suite passed 14 checks on each of DSH 0.1.1-rc.2,
0.1.5-rc.2 and advisory 0.1.6-alpha.1 on macOS ARM64. Two real headless-browser
checks passed authentication, interaction, reload, network restrictions and
cleanup. A separate real browser regression used returned frame-qualified refs
after two reloads to fill and click successfully. Four real Apple VM checks passed Build/Apply, oversized export
rejection, promotion and timeout cleanup. The alpha observation does not add a
certified audit or isolated-execution lane. The [rollout CI run at
`1a3c3c4`](https://github.com/builtin-pb/dsh-developer/actions/runs/35033208568)
passed all 18 jobs, including all three development versions on Windows,
macOS and Ubuntu. The archive workspace correction was separately exercised
on all three local runtimes before its final CI run.

An additional Computer Use pass through actual Chrome checked native onboarding,
skill and slash-command discovery, the running plugin inventory, capability
inspection, missing-browser-provider guidance and retained results after reload.
It found an upstream 0.1.5-rc.2 display defect: generic command nodes do not
activate an otherwise empty conversation. Two successful developer commands
were persisted but hidden until the built-in `/goal` added a visible command-input
node. Inspection of the installed Chat and conversation predicates confirmed
the cause; the development guide documents the observed keyless workaround.
An initial accessibility edit also produced a Lexical editor error; reloading
and entering the complete command through the supported browser input path
recovered. This run does not establish error-free browser automation or model
behavior. Capability text now distinguishes unreviewed audit lanes from ordinary
development support without changing the machine-readable lane classification.

## Release coherence review

The v0.1.0 review found and repaired interactions missed by earlier checks. Native audits now resolve relative paths from the attached Agent's workspace. Static Doctor skips all plugin execution, including generated smoke tests. Invalid optional browser configuration leaves core commands available; Agent disposal cancels, drains and closes only its owned browser, with failed cleanup retained for retry.

Isolated Apply now uses exclusive file publication and rolls back only controller-owned moves. A concurrent edit or unverified rollback preserves source and recovery evidence instead of restoring the entire old snapshot. Disposal rechecks recovery after an active Apply settles. Failed provider creation with unverified cleanup retains capacity and identifiable recovery information; it cannot be cleared by a misleading successful discard. Recovery in these ambiguous states requires operator inspection, not automatic replay.

Integrated local validation passed **603 tests**, with **33 optional checks skipped**. Four real Apple-container checks separately passed: admitted VM Build/Apply, oversized-export rejection, generated promotion through DSH, and fork/exit churn with timeout cleanup. Failure-combination regressions use injected filesystem/provider faults; they do not establish live Windows provider coverage. The packaged candidate passed release/preview lifecycle checks and two native knowledge cases on DSH 0.1.5-rc.2. Browser lifecycle changes have deterministic coverage; no new rendered-browser trial was performed for this review.

Setup and workflow instructions now distinguish ordinary current-runtime development from the exact reviewed audit and isolated-execution lanes. At that release, installation examples selected the v0.1.0 tag. These repairs strengthen the implemented workflow; they do not guarantee correctness of arbitrary generated projects.

The first release CI run then exposed a Windows verification race on DSH 0.1.1-rc.2: native cases passed, but an early exit interrupted the launcher's unfinished startup. Verification now waits for the official CLI entry to complete startup before invoking tools or requesting exit. Older launchers evaluate that entry directly; current launchers expose `runCli`. Real delayed-startup and failed-startup fixtures cover both versions, including the older lane that previously lacked readiness coverage. This does not change the separately observed Web readiness boundary.

## Follow-up fixes from the Chrome evaluation

The recall-plugin reconstruction exposed two Doctor syntax false positives, both repaired by DeepSeek through Chrome and independently reviewed. Subsequent diagnosis found that inherited `NODE_PATH` could make an older DSH installation appear to contain a newer installation's hooks. Shared package lookup now stays within the selected installation's local dependency graph, preserves real package-manager links, and reports incomplete local installations without certifying absence. Comparison against actual 0.1.1-rc.2 and 0.1.5-rc.2 installations preserved their legitimate inventories.

Browser onboarding now has `ui-setup`, including an explicit pinned-provider install option and shared saved configuration for native and shell UI. A fresh temporary setup automatically found system Chrome and installed the pinned CLI. With entry/browser environment overrides absent, the actual DSH tool registry admitted the native route and exercised a local page through snapshot, fill, click, state assertions, diagnostics, screenshot, forbidden remote redirect, and cleanup; the shell route used the same saved configuration. A generated artifact path initially triggered the credential detector. The repair validates canonical local artifact references and their names separately while retaining checks on page content and explicit credential patterns.

The initial setup checks used a credential-free local fixture on macOS ARM64, Node 24.19.0 and DSH 0.1.5-rc.2. Discovery layouts for Windows/Linux have fixture coverage only. The subsequent native authentication checks below close the DSH Web login gap; they do not establish independent model use of the browser.

## Native Web authentication

The existing native and shell UI routes now open the `ui` reference returned by a running `dev` command. A live private IPC handoff confirms the owning process and keeps the browser’s lifetime attached to it. The fixed browser initializer performs DSH’s own token exchange and installs only its validated native cookie in the isolated in-memory browser; public development reports, tool arguments and tool results omit the login token. Upstream URL printing is disabled in the disposable development overlay.

The real DSH 0.1.5-rc.2 Web application, with the recall-unread evaluation plugin installed, was exercised through the actual native tool registry and separately through the shell UI route using saved configuration. The check loaded workspace state over authenticated RPC, dismissed onboarding without configuring credentials, filled and cleared the composer, inspected diagnostics, captured a screenshot, reloaded, closed both browser sessions and rejected the stopped server’s reference. No model call was made. Browser console errors were absent.

A separate live Chrome fixture received a continuing SSE update, ran a browser worker, observed its cross-port HTTP and WebSocket requests fail, rejected an HTTP redirect to another server, and stopped outgoing requests after the private owner closed while its PID and HTTP server remained alive. Chromium’s exact-port proxy policy supplies this network restriction, including worker and redirect traffic that frame routing alone misses. Native HTTP streaming needs no special endpoint exception. Unit regressions exercise private filesystem records, native cookie validation, owner watching, cancellation and withheld diagnostics. A real DSH exit with a descendant retaining its log pipes revoked the handoff, preserved the nonzero failure, terminated the descendant and removed the profile. A second forced-exit check confirmed that readiness is not announced if DSH exits during handoff creation. Startup, overlay, foreign-port and cancellation checks also passed. A private negative control restored the old all-loopback proxy bypass and failed the worker test with two requests reaching the foreign listener; the final configuration recorded zero. This is a trusted development workflow, not hostile-plugin containment.

The opt-in `test/ui-development.integration.test.js` requires `DSH_DEVELOPER_UI_DEV_TEST=1`, an exact `DSH_DEVELOPER_DSH`, its `DSH_DEVELOPER_DSH_MODULES` directory, and saved browser setup or explicit provider/browser settings. `DSH_DEVELOPER_UI_DEV_SOURCE` can select a built local plugin. These are observed macOS browser checks; Windows browser automation and independent autonomous development remain unverified.

### Background browser startup correction

A later host observation disproved the earlier claim that development never opened the default browser. Cordis replaces a row's entire `config`: the development overlay's `printUrl: false` discarded the native `openBrowser` binding that carries `--no-open`, restoring the schema's `true` default. Development and Web verification now share an overlay that explicitly sets both values to `false`, after the caller's overlay.

A native regression on macOS with DSH 0.1.1-rc.2 and 0.1.5-rc.2 inspects the running Web runtime's validated configuration and intercepts its browser launcher. Both development and verification reported `openBrowser: false` and zero launch attempts, even when the caller requested opening. A private negative control restored the old overlay and detected one attempted launch without opening a browser. This corrects the automatic-startup claim; the earlier isolated-browser authentication observations remain applicable.

## Native development

| Surface | Observed behavior | Scope |
| --- | --- | --- |
| Project inspection and scripts | Finds the selected package and toolchain; executes declared scripts with flags, spaces, Unicode, empty arguments and nonzero exit status preserved | npm, pnpm 11.7.0, Yarn 1.22.22 and 4.18.0 on macOS/Linux ARM64 |
| DSH knowledge | Locates installed declarations and upstream source with identities, hashes and bounded excerpts; follows each package's actual peer resolution | Old and current installations, custom packages, monorepo source, nested/pnpm dependency layouts; metadata is navigation, not compatibility proof |
| Native tools | Invokes real global tool results, rejects wrong expectations and oversized responses, verifies source and installed archives with dependencies | Ten integration tests passed on macOS/Linux DSH 0.1.5-rc.2; nine passed on Mac 0.1.1-rc.2 with the startup-readiness case skipped because that release lacks `appReady` |
| Configuration | Applies an ordinary Cordis overlay to source/archive verification and Web boot; malformed and duplicate-row configuration fails with cleanup | Native DSH composition and boot, including an override that changes the result and current-runtime delayed startup failure |
| Web development | Owns startup, native local authentication, source workspace registration, cancellation and cleanup; rejects a foreign server on an occupied port | Real local HTTP lifecycle on macOS/Linux; no automatic browser opening |
| Session diagnostics | Reads plain and concatenated-Zstandard v3 logs, groups calls correctly, separates result replacements from executions, normalizes completion and bounds/redacts output | Seven actual DSH sessions checked against independent decoding, plus malformed/oversized/racing-file fixtures; no conversation or reasoning replay |
| Upstream work | Completed the inspected harness Host build and 163 focused core-tools tests through the normal project workflow | Source revision `c291e7961a515f6d7af9304e7fd1d257929aef26`; no completed upstream bug fix or external submission |

The [package-check example](../examples/package-check/README.md) builds against real TypeScript declarations and uses the maintained `semver` library. Its five tests and eight native source/archive cases passed. The [session-status example](../examples/session-status/README.md) uses DSH's actual slot registry and session hooks. Its four tests passed; its packed Client was also checked in a browser on macOS with DSH 0.1.5-rc.1 and 0.1.5-rc.2: running/idle state, switching between two sessions, cancellation, reload, and no browser warnings/errors. This is not a screen-reader, every-theme or every-runtime claim.

A fresh npm installation of DSH 0.1.5-rc.2 and pnpm 11.7.0 succeeded in a temporary prefix. Another fresh installation demonstrated why exact package identities matter: launcher 0.1.5-rc.1 resolved several internal packages at 0.1.5-rc.2. Native development checks passed on that mixed installation too.

The packed dsh-developer artifact also installed into a disposable `headless` profile and invoked its own native knowledge tool successfully. It identified the running DSH version and completed the selected session package's peer map, with both full results below a 64 KiB case budget. This exercises the distributed artifact and native metadata integration, independently of an agent choosing when to call it.

## Host coverage and reproducibility

Integrated validation on macOS passed **442 tests**, with **24 skipped**, on both Node 22.18.0 and 24.19.0. The Node 22 run selected that runtime for child package scripts as well as the outer CLI. Real npm/pnpm/Yarn and process-cancellation checks were enabled with `CI=1`.

A fresh Linux ARM64 run on Debian 12, Node 24.19.0, UID/GID 1000 and zero Linux capabilities passed **447 tests**, with **22 skipped**, including real manager forwarding, process cancellation and Linux exclusive-rename failures. It separately passed all nine then-current native DSH tests, both examples and the packed eight-case verification. An independently written byte-boundary check also passed: a 67-byte result passed a cap of 67 and failed a cap of 66; a small selected field could not conceal oversized rendered content. The source manifest SHA-256 was `5614e9a66ea6df91efb6aaba5cb24900d7fe3d884884eb568e91565c9972260e`. The later headless/Web profile correction and its tenth integration test are outside that full-validation snapshot.

The profile correction was prompted by a real `headless` verification failing before any case could run. The verifier disables the two native headless application-driver rows and reports that modification; Web verification requests a temporary port and `--no-open`. The later background-startup regression above checks the effective browser setting rather than inferring it from that flag. These checks establish global tool behavior in those compositions, not a model task or application-driver behavior.

A fresh Linux follow-up verified the exact three-file profile change: **10/10 native tests**, **22/22 focused development/documentation checks**, and actual CLI runs with **eight passing cases each in headless and Web**. Its source manifest SHA-256 was `0f17d89a7d83c19368722a5f47ba36bf2c311353c88813db2d3d014f1022a04a`. Independent process observations confirmed the Web flags, headless disclosure and cleanup. The full suite was not repeated on this delta; later edits changed only documentation.

The complete product Doctor passed its blocking release-runtime and disposable lifecycle checks. Its remaining warnings concern incomplete static loader/route coverage, advisory packaging and the advisory master comparison; they are not claims of complete absence of unsafe routes or compatibility with every runtime.

The skipped tests require separately configured exact release lanes, isolated providers or a live browser. Passing ordinary native development does not admit an isolated execution provider. The early local snapshots did not establish native Windows or remote CI coverage. The later CI run below supplies ordinary native Windows evidence; rendered Windows UI, musl and broader architecture coverage remain outside these checks. [Platforms](platforms.md) records the supported routes and limits.

### Remote CI follow-up

The [run at `09e896c`](https://github.com/builtin-pb/dsh-developer/actions/runs/34555142751) passed all six native development jobs on Windows, macOS and Ubuntu: 13 tests on DSH 0.1.5-rc.2, and 12 with one expected readiness skip on 0.1.1-rc.2. Each job used Node 24.19.0. The current-runtime jobs also exercised real npm, pnpm and both Yarn families. The Windows release-to-preview product matrix passed separately.

CI exposed real Windows probe-import failures, test fixtures that assumed Unix directory/process semantics, an entropy false positive on a public repository URL, and an exhausted source-graph budget. Native probes now use file URLs; fixtures exercise equivalent host behavior; GitHub owner/repository identifiers are scanned separately; and the shared graph budget is bounded at 8,192 records. The complete product needed 4,119 records, exceeding the old 4,096 cap. Complete-graph and cap-plus-one regressions retain fail-closed behavior.

Two remaining failures in that run were a UI fixture emitting non-native path separators and a macOS authority probe assuming PowerShell. The correction follows the pinned browser provider's actual `path.relative()` output and exercises the shell exposed by native DSH. The authority assertions are unchanged; bounded, redacted errors now survive the logger-free test profile. The redactor's equivalent array callback keeps that newly activated path within the scanner's supported syntax, and a regression checks the entire shipped activation graph. Local integrated validation passed 582 tests with 29 skips; the repaired authority probe, actual product preflight and release-to-preview compatibility gates passed on macOS.

To reproduce ordinary checks from this checkout:

```sh
npm ci --ignore-scripts
npm --prefix examples/package-check ci --ignore-scripts
npm --prefix examples/session-status ci --ignore-scripts
node bin/dsh-developer.js run --source examples/package-check --script test
node bin/dsh-developer.js run --source examples/session-status --script test
node bin/dsh-developer.js run --source . --script validate
node bin/dsh-developer.js run --source . --script test:development:dsh
```

Select the intended installation with `DSH_DEVELOPER_DSH` for native integration. The last command needs DSH/pnpm, local sockets and package-download access. See [Contributing](contributing.md) for optional real-manager and process checks. Example development dependencies retain their documented exact type versions; testing another runtime is a separate operation.

## Agent behavior and remaining work

Real DeepSeek sessions selected the installed skill and used project/source guidance to construct installable plugins in synthetic workspaces. A maintenance follow-up repaired mixed-input handling, and five independently derived native cases passed afterward. That was a cued repair. An earlier run accessed additional trial context, so it is retained only as an assisted development observation.

Independent assessment of two documentation-search artifacts found useful native installation, citations, configuration overrides and live file updates, but also multilingual retrieval, output-size, incomplete-scan and documented-configuration defects. The baseline accessed its trial runner; this pair cannot support a controlled claim that the plugin improves quality or speed.

Two subsequent log-triage tasks exercised the revised guidance, including an empty project requiring dependency setup. Both produced installable native plugins, preserved Unicode and observed appended records. Independent native probes still found incorrect retry aggregation or run selection, missing-data defaults, inadequate response limits and a configuration example that failed boot. These artifacts were not adopted as shipped examples. The findings led to guidance that derives expectations from data contracts and checks identity, precedence, missing evidence and live updates independently of the implementation.

A third run with contract-derived expectations guidance handled ordinary retry ordering, multiple files and runs, missing required fields, live Unicode updates and incomplete input correctly in independent native checks. It still returned unbounded messages/metadata and merged two distinct identities containing escaped NUL characters. This reused task informed the guidance, so it is development evidence, not a held-out or controlled improvement estimate. No generated triage implementation was added to the shipped examples.

That oversized response drove a deterministic workflow improvement: native cases can now set `maxResultBytes`, measured over complete canonical and rendered JSON before selecting `resultPath`. The same generated plugin returned a correct selected summary but **702,518 result bytes**; the uncapped case passed and a 16 KiB budget correctly failed. Large result fields are omitted from the receipt with explicit markers while comparison still uses their full values. This catches the observed output defect; it does not fix the plugin's aggregation logic or bound its input work and memory.

These sessions show useful activation and integration, with defects in the generated artifacts. Those defects support specific repairs; they do not by themselves measure the plugin's benefit or establish a model capability limit. Assess development utility using the [strategy's comparative criteria](development-strategy.md), with stated task scope and budget. Representative completion rates, human intervention, maintenance effort and repeated-user adoption have not yet been established. The repository is developed through its own project runner and native verification now; a model independently editing this repository remains unproven. Real user tasks, a completed upstream repair, further independent semantic evaluation and rendered Windows browser automation remain the next consequential evidence.

Private authoring material, provider credentials and raw model traces are not part of the repository or package. The public guidance consists of development-specific decisions and checks. A repository/history/package scan can detect particular unwanted material; it cannot prove that every possible disclosure is absent.
