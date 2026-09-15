# Native session status

A small additive DSH Web plugin. It puts **Session: running** or **Session: idle**
beside the current session title. The text changes through DSH's supplied
`useSession` selector hook. A loading, unavailable, or removed session gets that
explicit label instead of appearing idle. The decorative marker is hidden from
assistive technology; the text is a polite, atomic status region.

Supported runtimes: **DSH 0.1.5-rc.1 and 0.1.5-rc.2**, with their Web profiles, and Node
**22.18+ within 22.x, or 24.11+**. The exact installed declarations and client
implementation define this example's contract. Compilation uses `0.1.5-rc.1`
declarations; the packed client has been exercised in both installed runtimes.

## Build and test

From this repository:

```sh
cd examples/session-status
npm ci --ignore-scripts
npm test
```

If the host policy restricts npm’s default cache, pass `--cache /writable/cache`
to npm. Keep generated caches outside the source tree used for static audits.

`npm test` type-checks the source, rebuilds both entries with esbuild, and runs
Node's built-in test runner. Tests materialize the compiled client factory and
use the real pinned Cordis and DSH `SlotRegistry`: deferred registration,
preserving another action, parent collapse/remount, plugin unload, and cancellation
before declaration. React server rendering checks successive supplied session
snapshots and accessible text. These tests do not exercise browser subscriptions,
transport reconnection, visual layout, or screen-reader announcements.

The DSH development dependencies include the exact `0.1.5-rc.1` type peer closure
(including installed optional peers and transitive DSH dependencies), with Cordis
`4.0.2`. Pinning only the UI
packages allows npm to choose incompatible prerelease peers and can cause
`ERESOLVE`. Keep the pins and lockfile together; update them against a selected
runtime as a unit. `skipLibCheck` skips checking upstream declaration bodies;
our source is still checked in strict mode against their exported types.

## Run in DSH Web

From the repository root, select one of the supported executables:

```sh
node bin/dsh-developer.js knowledge --dsh /path/to/dsh --topic ui
node bin/dsh-developer.js run --source examples/session-status --script test
node bin/dsh-developer.js dev --source examples/session-status --dsh /path/to/dsh
```

The development CLI installs into a disposable Web profile and reports a clean
URL plus a `ui` handoff. Pass that object to the native `dsh_ui` tool, or use the
shell UI route with the reported `home`:

```sh
node bin/dsh-developer.js ui --session status-preview --action open --development-server <home-from-dev> --json
```

Complete the [browser setup](../../docs/development.md#work-with-web) first.
The handoff authenticates the isolated browser; opening the clean URL alone in
another browser does not supply its login cookie. No personal browser opens
automatically. Keep the owning development command running.

Select a session and look beside its title. With a working model configured in
that disposable instance, send a prompt to observe running → idle. Switch
sessions, reload, and check narrow layouts and your preferred theme. No label
is mounted without a resolved session header.

Stop the owning command with Ctrl+C to remove the disposable profile. For a
predictable edit loop, rebuild with `npm --prefix examples/session-status run
build`, then restart the development command and open its new handoff. See the
repository's [development guide](../../docs/development.md) for the native CLI
workflow. No real user profile needs to be modified.

## How it fits

- `src/index.ts` is the empty Host plugin that makes this package discoverable.
- `src/client.tsx` derives component props from the public slot declaration and
  reads only session lifecycle state. Its runtime injection waits for `slots`
  and `uiSession`. `slots.inject()` follows each header declaration lifetime;
  `slots.register()` contributes the fresh list id `dsh-session-status` at order
  100. Native disposal removes the entry and its pending declaration wait.
- `build.mjs` emits `lib/index.js` and `lib/client.js`. The latter registers a
  lazy factory with `window.__ModuleLoader__.load`, as required by this runtime.
  React's JSX runtime is the only external runtime import and comes from DSH's
  seed table. DSH feature imports are type-only.
- `package.json` exports `./client` and declares `dsh.client.platform: "web"`
  plus the renderer, session adapter, and conversation package edges.
  `cordis.patch.yml` inserts the Host entry when DSH installs the package.

The indicator owns no remote calls, credentials, polling, timers, React root,
or global styles. It uses native theme variables with inherited fallbacks.
Running/idle describes the latest public session snapshot; idle does not assert
that a previous turn succeeded or that all background jobs have finished.
Connection recovery remains DSH's responsibility. Labels are English only.

## Packaging and verification limits

The built `lib` files are included so installation needs no build script. To
produce a local archive from the example directory:

```sh
npm pack --dry-run
npm pack
```

`prepack` rebuilds the entries. The package allowlist includes the compiled
entries, source, build configuration, tests, native patch, README, and MIT
license. It excludes development dependencies and cache contents. Nothing in
this workflow publishes to a registry.

Verified on macOS ARM64 with Node 24.19.0 and DSH `0.1.5-rc.1`: clean dependency
installation, strict compilation, registration/state tests, and source and
packed-archive Web loading. In the rendered browser, real DSH sessions with a
local keyless test adapter exercised running → idle, selection between two
sessions, cancellation and reload. The indicator remained visible at a 760 ×
640 desktop viewport, with no client errors in that test instance. A missing
provider credential was also shown as a native turn failure while the indicator
correctly returned to idle. These observations do not establish screen-reader
announcements, every theme/viewport, other DSH versions, or model quality.

The same packed client also passed rendered running/idle, selection between two
sessions, cancellation and reload checks on `0.1.5-rc.2`, using a local keyless
adapter supplied with `dev --patch`. No client warnings or errors were observed
in that instance. Its source checkout was not needed to load the archive.
