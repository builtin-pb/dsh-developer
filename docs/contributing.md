# Contribute to dsh-developer

Use Node.js `^22.18.0 || >=24.11.0`. Install dependencies with `npm ci --ignore-scripts`, make a focused change, then run:

```sh
node bin/dsh-developer.js run --source . --script validate
npm pack --dry-run
```

The default suite is keyless and deterministic. Process fixtures can also be enabled with `DSH_DEVELOPER_PROCESS_TEST=1` (PowerShell: `$env:DSH_DEVELOPER_PROCESS_TEST='1'`). VM, browser and exact-runtime integration tests have separate opt-in flags; a skipped integration test is not a passing platform claim.

Development CI also tests script arguments on pnpm 11.7.0, Yarn Classic 1.22.22 and Yarn 4.18.0. For the same local checks, enable `DSH_DEVELOPER_PNPM_TEST=1` with that pnpm on PATH and set `DSH_DEVELOPER_YARN_CLASSIC_ROOT` and `DSH_DEVELOPER_YARN_MODERN_ROOT` to disposable npm installation prefixes containing those exact packages. Then run `test:development` through the CLI.

## Install the current checkout

The README's `v0.1.3` Git tag is a published artifact, not this working tree. To exercise current changes from a checkout:

```sh
npm ci --ignore-scripts
dsh plugin --profile web add . --ignore-scripts
```

Restart DSH after Host code changes. Use a development profile for iteration; install into an existing personal profile only when that is intended.

## Test against DSH

Use exact DSH `0.1.5-rc.2` for blocking checks and `0.1.6-alpha.1` for advisory checks. Select the intended installed entry with `--dsh`; do not infer a runtime from a tag name. With the blocking DSH on PATH:

```sh
node bin/dsh-developer.js doctor --source .
node bin/dsh-developer.js preflight --source . --profile headless
node bin/dsh-developer.js preflight --source . --profile web
```

Doctor tests this product's plugin lifecycle in a disposable profile. An ordinary target plugin is inspected under the documented execution restrictions; a static audit is not proof that arbitrary code ran successfully.

See the [development guide](development.md) for self-hosting and native-runtime tests, and [verification](verification.md) for results tied to their revision, runtime and host.

Isolated providers need separate local infrastructure and admission. The [Mac integration suite](macos.md#enable-isolated-build-and-apply) passed 4/4 real checks on rc.2 with Apple silicon/macOS 26, Apple container 1.4.1 and the pinned image: native admission, VM Build/Apply, promotion, and sparse/churn cleanup. This does not prove alpha isolation. Windows provider tests use `DSH_DEVELOPER_WSL_CELL_TEST=1` and the configured WSL distribution.

## Keep the plugin current

Treat an upstream update as one maintenance change across runtime constants, native registry/schema integration, Client contract tables, examples and their lockfiles, Creator exports, skill routes, documentation and CI. A version-string replacement alone is not an upgrade. Use `knowledge` against the exact installation and actual consuming package roots, check published package versions and peer closure, then install with scripts disabled and run example builds/tests through `dsh-developer run`. Exercise the compiled and packed artifacts where their behavior is claimed.

Exact audit jobs must use `0.1.5-rc.2` as blocking and `0.1.6-alpha.1` as advisory. Native development CI installs npm `latest`, `next` and `alpha` on each run and records the resolved package versions with the results. That moving matrix detects drift; it does not silently change the reviewed audit targets or admit an isolated provider.

Refresh front-door claims when contracts change. Keep English and Chinese entry points aligned, identify the tested revision/runtime/host, and distinguish source, published tag, native registry, rendered browser and isolated-provider results. Update only affected historical claims: the `0.1.1-rc.2` → `0.1.2-alpha.3` migration ledger remains a bounded historical contract. Hook Bridge Doctor pins exact current, alpha and historical bytes independently; advancing either contract requires its own evidence.

Run documentation and skill-route checks after edits. Every routed skill set must fit within 7,850 UTF-8 bytes with CRLF line endings, including linked references; keep detail in the relevant reference without expanding unrelated routes.

## Change a boundary carefully

Keep provider conformance, admission, actual execution, transfer, cleanup and the agent-facing workflow consistent. Add regression cases that reproduce consequential failures; include the host, runtime and provider versions with your results. Changes to isolated execution should exercise cancellation, controller termination and adversarial process/file behavior as well as a successful Build/Apply.

Native Mac tests and Linux VM tests establish different things. Report them separately. Generated-plugin promotion must retain atomic no-replace semantics on the host filesystem.

## Work on DSH itself

Follow the [upstream contributing guide](https://github.com/deepseek-ai/deepseek-harness#contributing) and the toolchain pinned by your checkout. The [Mac guide](macos.md#develop-dsh-itself) includes the source setup. Keep the upstream commit and native test results distinct from evidence about this repository's exact release lane.
