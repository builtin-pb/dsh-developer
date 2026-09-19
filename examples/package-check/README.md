# Package version check

A small TypeScript DSH plugin exposing the native tool `check_package_version`.
It checks a supplied version against an npm semver range; it does not query a
registry or inspect installed packages.

```json
{"version":"0.1.1-rc.2","range":">=0.1.1-rc.1 <0.2.0"}
```

The canonical `result.value` is:

```json
{"version":"0.1.1-rc.2","range":">=0.1.1-rc.1 <0.2.0","includePrerelease":false,"satisfies":true}
```

`satisfies: false` is a successful compatibility check. Invalid versions, ranges,
or argument types throw useful errors; DSH returns `isError: true` and no `value`.
Partial versions such as `1.2` are rejected. npm range syntax includes caret,
tilde, wildcard, comparator, hyphen, and alternative ranges; an empty range is
equivalent to `*`. Build metadata does not affect compatibility. Inputs are
preserved in the result. Prereleases follow npm's default exclusion rules unless
the range explicitly admits that version tuple or `includePrerelease: true` is
supplied. Package-manager protocols such as `workspace:*` are not semver ranges.

## Develop and test

Use Node 22.18+ within 22.x, or 24.11+, and start at the repository root.
Create an output directory outside this repository and replace
`/path/to/artifacts` below with that directory:

```sh
npm --prefix examples/package-check ci --ignore-scripts
node bin/dsh-developer.js run --source examples/package-check --script test
cd examples/package-check
npm pack --pack-destination /path/to/artifacts
```

Keep archives outside the inspected source: Doctor rejects a `.tgz` left in
the source tree. Verify the archive itself with `verify --source <archive>`.

`src/check.ts` contains validation and semver behavior. `src/index.ts` registers
one tool with DSH's `tools` service and renders its structured output as JSON.
It imports the real Cordis `Context` and DSH `ToolDefinition` types; no local
substitutes or private files are needed. DSH packages are development-only.
The compiled plugin's sole runtime dependency is `semver`.

This example compiles against DSH `0.1.5-rc.2`. Its exact development pins come
from `knowledge --dsh /path/to/dsh --topic tool --package @deepseek-ai/dsh-tools`
on that installed runtime, including the complete DSH peer closure and Cordis
`4.0.2`. The lockfile also fixes ordinary transitive dependencies. Keep these
pins and the lockfile together; a peer map does not discover every type-only
import or prove installation and runtime compatibility. For another runtime,
inspect its own map, install, build, and verify again.

The `0.1.1-rc.2` values in sample arguments and tests are semver inputs, not the
type baseline. The example's own package version remains `0.1.0`.

Tests cover range boundaries, prereleases, invalid input, canonical results,
and Cordis registration/disposal. To run the registry test against an existing
DSH installation, set `DSH_PACKAGE_ROOT` to its package directory (the directory
containing DSH's `package.json`), then run `npm test`. Without that variable the
test uses the declared development dependencies.

`lib/` is generated and ignored by Git; `prepack` builds it into the distributable
tarball. The package allowlist includes compiled JavaScript, the bundle patch,
this README, and the license. It excludes source, tests, caches, and local paths.

## Install and verify

After `npm pack`, install the resulting tarball into the intended DSH profile:

```sh
dsh plugin --profile headless add /path/to/artifacts/dsh-package-check-0.1.0.tgz --ignore-scripts
```

Restart that profile to load the plugin. `cordis.patch.yml` resolves the package's
compiled entry through its package name. The plugin requires only the native
`tools` service and can also be installed in a Web profile.

To check all eight native cases against the compiled package and its packed
archive, run from the repository root after building and packing:

```sh
node bin/dsh-developer.js doctor --source examples/package-check --dsh /path/to/dsh --skip-runtime
node bin/dsh-developer.js verify --source examples/package-check --cases examples/package-check/tool-cases.json --dsh /path/to/dsh --online
node bin/dsh-developer.js verify --source /path/to/artifacts/dsh-package-check-0.1.0.tgz --cases examples/package-check/tool-cases.json --dsh /path/to/dsh --online
```

Select the executable for DSH `0.1.5-rc.2`. Verification installs into a disposable
profile with lifecycle scripts disabled; `--online` permits fetching the
`semver` runtime dependency. It requires no model credentials.

The case file is an array of `{tool, arguments, expected, isError?}`.
The verifier compares `result.isError` with
`isError ?? false` and `result.value ?? null` with `expected` using structural
equality. Error cases use `expected: null` because JSON cannot encode DSH's absent
failure value; the registry test also checks that failure values are absent.
