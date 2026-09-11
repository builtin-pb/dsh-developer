# Develop a DSH project

## Locate the implementation

Use `project`, read its instructions and resolve toolchain conflicts. Install dependencies in the native workspace. Use bundled `examples/package-check` (native tools) or `examples/session-status` (Client slots) as executable examples; adapt only the needed parts.

Use `knowledge` for the relevant topic and exact runtime or upstream checkout. Excerpts are navigation: follow complete declarations, imports, implementations, consumers and tests. Resolve missing evidence and version mismatches. Pin DSH peers from its dependency map; query additional type imports with `packageName` (CLI `--package`). The map covers peers, not every TypeScript import.

## Build useful behavior

Establish behavior from the request, workspace examples and format contracts before choosing a data structure. Identify what makes two things the same, what establishes order or precedence, and which facts justify a result. Keep unknown, incomplete and unsuccessful outcomes distinct from success; do not invent convenient defaults for missing evidence.

Derive expectations independently of production code. Compare small deterministic transformations against a plain reference calculation or table derived from the input contract. Challenge its distinctions: rearrange or split equivalent input, make similar-looking identities differ, and change a required fact. Exercise relevant combinations. When an expectation fails, check both code and contract; never copy actual output into an assertion merely to pass.

Observe changing state and interrupted updates in one running process. For retrieval, try ordinary questions in relevant languages. For limits, set `maxResultBytes` in native cases and measure actual read work and returned bytes with one large record and many small records; preserve source pointers and explicit omissions. An incomplete scan cannot support an unqualified empty or successful result. Reuse these executable checks after a plausible follow-up change.

Follow repository conventions and maintained dependencies. Give each service, registration and cleanup one owner. Use native schemas and canonical results; include consumers, cancellation and unload. Make deployment choices configurable; fix upstream problems in their owner.

## Exercise and deliver

Use the CLI through the host shell (`node "$DSH_DEVELOPER_BIN"` in DSH POSIX shells):

- `run --source <package> --script <name> [-- <args...>]` runs declared scripts with exact arguments, host environment, bounded output and cancellation.
- `verify --source <plugin-or-tgz> --cases <json> --dsh <executable>` compares real global tool results in a disposable profile. Cases contain `tool`, `arguments`, `expected`; optional `isError`, JSON Pointer `resultPath`, and `maxResultBytes` assert errors, fields and output budgets. Select `--profile`; use `--online` for uncached dependencies. This does not prove model, Agent or UI behavior.
- `dev --source <plugin-or-tgz> --dsh <executable>` owns a disposable Web profile until cancellation. Exercise rendered UI, reload and errors through the admitted browser; HTTP readiness is insufficient.

Verify the built archive and boot its documented configuration using `--patch <file>` on `verify`/`dev`. Inspect results against the independent expectations; registration alone is insufficient. Fix causes and repeat affected checks.

For upstream work, locate owners and callers, follow checkout instructions and run its relevant Host/Client builds and tests at a recorded revision. Plugin Doctor is not an upstream gate.

Use this same workflow to develop dsh-developer itself.
