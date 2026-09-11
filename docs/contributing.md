# Contribute to dsh-developer

Use Node.js `^22.18.0 || >=24.11.0`. Install dependencies with `npm ci --ignore-scripts`, make a focused change, then run:

```sh
node bin/dsh-developer.js run --source . --script validate
npm pack --dry-run
```

The default suite is keyless and deterministic. Process fixtures can also be enabled with `DSH_DEVELOPER_PROCESS_TEST=1` (PowerShell: `$env:DSH_DEVELOPER_PROCESS_TEST='1'`). VM, browser and exact-runtime integration tests have separate opt-in flags; a skipped integration test is not a passing platform claim.

Development CI also tests script arguments on pnpm 11.7.0, Yarn Classic 1.22.22 and Yarn 4.18.0. For the same local checks, enable `DSH_DEVELOPER_PNPM_TEST=1` with that pnpm on PATH and set `DSH_DEVELOPER_YARN_CLASSIC_ROOT` and `DSH_DEVELOPER_YARN_MODERN_ROOT` to disposable npm installation prefixes containing those exact packages. Then run `test:development` through the CLI.

## Test against DSH

Use the exact release `0.1.1-rc.2` for blocking checks and preview `0.1.2-alpha.3` for advisory checks. With DSH installed:

```sh
node bin/dsh-developer.js doctor --source .
node bin/dsh-developer.js preflight --source . --profile headless
node bin/dsh-developer.js preflight --source . --profile web
```

Doctor tests this product's plugin lifecycle in a disposable profile. An ordinary target plugin is inspected under the documented execution restrictions; a static audit is not proof that arbitrary code ran successfully.

CI covers deterministic checks on Windows, macOS and Linux, the certified audit lanes on Windows/macOS, and ordinary development on three hosts. See the [development guide](development.md) for self-hosting and the explicit native-runtime test script. The isolated providers need their own local infrastructure. Run the [Mac integration suite](macos.md#enable-isolated-build-and-apply) on Apple silicon/macOS 26 with the reviewed container service and image installed. Windows provider tests use `DSH_DEVELOPER_WSL_CELL_TEST=1` and the configured WSL distribution.

## Change a boundary carefully

Keep provider conformance, admission, actual execution, transfer, cleanup and the agent-facing workflow consistent. Add regression cases that reproduce consequential failures; include the host, runtime and provider versions with your results. Changes to isolated execution should exercise cancellation, controller termination and adversarial process/file behavior as well as a successful Build/Apply.

Native Mac tests and Linux VM tests establish different things. Report them separately. Generated-plugin promotion must retain atomic no-replace semantics on the host filesystem.

## Work on DSH itself

Follow the [upstream contributing guide](https://github.com/deepseek-ai/deepseek-harness#contributing) and the toolchain pinned by your checkout. The [Mac guide](macos.md#develop-dsh-itself) includes the source setup. Keep the upstream commit and native test results distinct from evidence about this repository's exact release lane.
