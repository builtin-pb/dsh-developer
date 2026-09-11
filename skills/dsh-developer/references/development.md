# Develop a DSH project

## Locate the implementation

Use `project`; follow workspace instructions and resolve toolchain conflicts. Install dependencies there. Adapt `examples/package-check` (native tools) or `examples/session-status` (Client slots) as needed.

Use `knowledge` for the relevant topic and exact runtime or upstream checkout. Excerpts are navigation: follow complete declarations, imports, implementations, consumers and tests. Resolve missing evidence and version mismatches. Pin DSH peers from its dependency map; query additional type imports with `packageName` (CLI `--package`). The map covers peers, not every TypeScript import.

## Build useful behavior

Establish behavior from the request, workspace examples and format contracts before choosing a data structure. Identify what makes two things the same, what establishes order or precedence, and which facts justify a result. Keep unknown, incomplete and unsuccessful outcomes distinct from success; do not invent convenient defaults for missing evidence.

Derive expectations from requirements and input contracts. Follow their producers; before using a consumer as an oracle, trace what it omits, defaults or aggregates. Test a case separating competing interpretations. Use a reference calculation independent of the code under test. Vary identity and order, split equivalent input, and change or omit required facts in relevant combinations. Resolve failures against requirements and source evidence; never copy actual output into an assertion to pass.

Observe changing state and interrupted updates in one running process. For retrieval, try ordinary questions in relevant languages. For limits, set `maxResultBytes` in native cases and measure actual read work and returned bytes with one large record and many small records; preserve source pointers and explicit omissions. An incomplete scan cannot support an unqualified empty or successful result. Reuse these executable checks after a plausible follow-up change.

Follow repository conventions and maintained dependencies. Give each service, registration and cleanup one owner. Use native schemas and canonical results; include consumers, cancellation and unload. Make deployment choices configurable; fix upstream problems in their owner.

## Exercise and deliver

Use the CLI through the host shell (`node "$DSH_DEVELOPER_BIN"` in DSH POSIX shells):

- `run --source <package> --script <name> [-- <args...>]` runs declared scripts with exact arguments, host environment, bounded output and cancellation.
- `verify --source <plugin-or-tgz> --cases <json> --dsh <executable>` compares real global tool results in a disposable profile. Cases contain `tool`, `arguments`, `expected`; optional `isError`, JSON Pointer `resultPath`, and `maxResultBytes` assert errors, fields and output budgets. Select `--profile`; use `--online` for uncached dependencies. This does not prove model, Agent or UI behavior.
- `dev --source <plugin-or-tgz> --dsh <executable>` owns a disposable Web profile until cancellation. Exercise rendered UI, reload and errors through the admitted browser; HTTP readiness is insufficient.

Verify the built archive and its documented configuration with `--patch <file>` on `verify`/`dev`. Exercise important failures through the actual entry point; check retained state and caller-visible results against independent expectations. Registration or helper tests alone are insufficient.

For upstream work, locate owners and callers, follow checkout instructions and run its relevant Host/Client builds and tests at a recorded revision. Plugin Doctor is not an upstream gate.

Use this same workflow to develop dsh-developer itself.
