# Develop a DSH project

## Locate the implementation

Use `project`; read instructions, resolve toolchain conflicts and install dependencies. Examples: `examples/package-check` (tools), `examples/session-status` (Client slots).

Use `knowledge` for the topic and exact runtime. `source` (CLI `--upstream`) selects a checkout, package or file; its checkout must be inside the Agent workspace. Follow excerpts to declarations, imports, consumers and tests; resolve omissions and version mismatches. Pin DSH peers from its map. Follow imports with `packageName` and `consumerRoot` set to the originating physical package root (CLI `--package`, `--consumer-root`); nested versions can differ. The map covers peers, not every import.

## Build useful behavior

Establish behavior from the request, workspace examples and format contracts before choosing a data structure. Identify what makes two things the same, what establishes order or precedence, and which facts justify a result. Keep unknown, incomplete and unsuccessful outcomes distinct from success; do not invent convenient defaults for missing evidence.

Derive expectations from requirements and input contracts. Follow their producers; before using a consumer as an oracle, trace what it omits, defaults or aggregates. Test a case separating competing interpretations. Calculate reference results independently. Vary identity and order, split equivalent input, and change or omit required facts in relevant combinations. Resolve failures against requirements and source evidence; never copy actual output into an assertion to pass.

Observe changing state and interrupted updates in one running process. For retrieval, try ordinary questions in relevant languages. For limits, set `maxResultBytes` in native cases and measure actual read work and returned bytes with one large record and many small records; preserve source pointers and explicit omissions. An incomplete scan cannot support an unqualified empty or successful result. Reuse these executable checks after a plausible follow-up change.

Follow repository conventions and maintained dependencies. Give each service, registration and cleanup one owner. Use native schemas and canonical results; include consumers, cancellation and unload. Make deployment choices configurable; fix upstream problems in their owner.

## Exercise and deliver

In DSH POSIX shells use `node "$DSH_DEVELOPER_BIN"`:

- `run --source <package> --script <name> [-- <args...>]` runs declared scripts with exact arguments, host environment, bounded output and cancellation.
- `verify --source <plugin-or-tgz> --cases <json> --dsh <executable>` compares native tool results in a disposable profile. Cases contain `tool`, `arguments`, `expected`; optional `isError`, JSON Pointer `resultPath`, and `maxResultBytes` assert errors, fields and output budgets. Add `--workspace <dir>` for one real Agent under native policies. Select `--profile`; use `--online` for registry dependencies. This does not prove model or UI behavior.
- `dev --source <plugin-or-tgz> --dsh <executable>` owns a disposable Web profile until cancellation; `--watch` reloads Host modules from source directories. Exercise rendered UI and errors; HTTP readiness is insufficient.

Verify the built archive and its documented configuration with `--patch <file>` on `verify`/`dev`. Exercise important failures through the actual entry point; check retained state and caller-visible results against independent expectations. Registration or helper tests alone are insufficient.

For upstream work, follow checkout instructions and run the owning Host/Client builds and tests at a recorded revision. Plugin Doctor is not an upstream gate.
