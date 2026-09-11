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

From this directory, using Node 22.18+ or 24.11+:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm pack
```

`src/check.ts` contains validation and semver behavior. `src/index.ts` registers
one tool with DSH's `tools` service and renders its structured output as JSON.
It imports the real Cordis `Context` and DSH `ToolDefinition` types; no local
substitutes or private files are needed. DSH packages are development-only.
The compiled plugin's sole runtime dependency is `semver`.

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
dsh plugin --profile headless add ./dsh-package-check-0.1.0.tgz --ignore-scripts
```

Restart that profile to load the plugin. `cordis.patch.yml` resolves the package's
compiled entry through its package name. The plugin requires only the native
`tools` service and can also be installed in a Web profile.

For the ordinary-project verifier, select this directory as the project, run
`build` and `test`, and pass `tool-cases.json` to the tool-case runner. The file is
an array of `{tool, arguments, expected, isError?}`. Compare `result.isError` with
`isError ?? false` and `result.value ?? null` with `expected` using structural
equality. Error cases use `expected: null` because JSON cannot encode DSH's absent
failure value; the registry test also checks that failure values are absent.
