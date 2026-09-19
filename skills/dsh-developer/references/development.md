# Develop a DSH project

## Locate the implementation

Use `project`; resolve toolchain conflicts. Examples: `examples/package-check` (tools), `examples/session-status` (Client slots).

Use `knowledge` for the topic and exact runtime. `source` (CLI `--upstream`) selects a checkout, package or file inside the Agent workspace. Follow excerpts to declarations, producers, consumers and tests; resolve omissions and version mismatches. Pin DSH peers from its map. Follow imports with `packageName` and `consumerRoot` set to the originating physical package root (CLI `--package`, `--consumer-root`); nested versions can differ. The map covers peers, not every import.

## Exercise and deliver

In POSIX shells use `node "$DSH_DEVELOPER_BIN"`:

- `run --source <package> --script <name> [-- <args...>]` runs scripts with exact arguments, host environment, bounded output and cancellation. Install dependencies with the project's package manager.
- `verify --source <plugin-or-tgz> --cases <json> --dsh <executable>` compares native results in a disposable profile. Cases use `tool`, `arguments`, `expected`; optional `isError`, `errorContains`, JSON Pointer `resultPath`, and `maxResultBytes` assert errors, fields and budgets. Add `--workspace <dir>` for one real Agent under native policies. Select `--profile`; use `--online` for registry dependencies.
- `dev --source <plugin-or-tgz> --dsh <executable>` owns a disposable Web profile; `--workspace <dir>` selects a sample project and `--watch` reloads Host source modules. Exercise rendered UI and errors; HTTP readiness is insufficient.

Pack outside the source audited by Doctor (`npm pack --pack-destination <directory>`); a `.tgz` left inside fails its ordinary-tree check. Verify the built archive and documented configuration with `--patch <file>` on `verify`/`dev`. Registration or helper tests alone do not prove user-visible behavior. Check model behavior separately.

For retrieval, try ordinary questions in relevant languages. For limits, measure actual read work and returned bytes with one large record and many small records; retain source links and explicit omissions. Incomplete scans cannot justify unqualified empty results. Use `maxResultBytes` for native output limits.

For upstream work, follow checkout instructions and run owning Host/Client builds and tests at a recorded revision. Plugin Doctor is not an upstream gate.
