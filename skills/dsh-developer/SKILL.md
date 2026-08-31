---
name: dsh-developer
description: "Develop DSH plugins through exact capability inspection, Doctor audits, and deterministic promotion of Creator exports into tested native DSH and Codex bundles. Use for plugin creation, packaging, compatibility, safety, testing, release readiness, or evidence-based evaluation of a missing DSH capability."
---

# DSH Developer

The single plugin you need for DSH

Own one accountable workflow from source snapshot through handoff. Never claim a releaseable bundle after a blocking failure.

## Route the request

- Saved Creator export: use **Promote**.
- Existing repository: run **Audit**, then propose a bounded change; edit only with separate user authorization.
- DSH runtime or core-level feature: inspect capabilities, then use [the core-gap rules](references/core-incubation.md).
- Exact release-to-preview compatibility: run the compatibility matrix; behavior execution is limited to product source or reproducible promoted bytes.
- DSH upgrade scoping: run upstream impact before compatibility; declare attachment packages and Cordis services in `package.json` when inference is incomplete.
- Execution-bearing core incubation: also use [the local lab gate](references/execution-lab.md). PASS proves a boundary, not feature admission or permission to execute caller code.
- Isolated child workspace or whole-environment isolation: run [the isolated-cell admission](references/isolated-cell.md) after both gates.
- Unstructured idea: shape it in Creator and stop at a canonical export.

If repository work and a core feature overlap, inspect capabilities before Doctor, audit before edits, and propose one bounded change-set. New evidence or a materially broader effect needs new approval.

Read [the Creator contract](references/creator-export.md) only for export creation, diagnosis, or promotion. Read [the safety boundary](references/safety.md) before untrusted source.

For CLI use in Codex, resolve the installed plugin root two levels above this skill and run `bin/dsh-developer.js` with Node. Checkout examples below assume that root. In a DSH shell, use the injected absolute `DSH_DEVELOPER_BIN` under its normal sandbox and approval policy.

## Inspect capabilities

DSH Web:

    /dsh-developer-capabilities {}

CLI:

    node bin/dsh-developer.js capabilities --dsh <path-to-dsh>

This inspects the installed DSH without loading an arbitrary repository. Record exact DSH, Node, platform, lane, package identity, and digest. `behavior` means exercised; `inventory` means installed only. Absence does not cover other profiles. Prefer adequate native behavior; never promote preview or inventory evidence to a blocking claim.

## Exercise compatibility

First locate changed upstream surfaces without executing either DSH lane:

    node bin/dsh-developer.js impact --source <plugin-directory> --release-dsh <path> --preview-dsh <path>

Treat package exports, declarations, entries, dependency contracts, DSH metadata, and service-owner mappings as change facts, not behavioral proof. Preserve inferred-but-undeclared warnings. Then run the behavior matrix.

DSH Web (the running DSH is the release lane unless `releaseDsh` is supplied):

    /dsh-developer-compatibility {"source":"<plugin-directory>","previewDsh":"<path-to-preview-dsh>"}

CLI:

    node bin/dsh-developer.js compatibility --source <plugin-directory> --release-dsh <path> --preview-dsh <path>

The matrix first runs non-runtime Doctor, establishes both package-declared official entries, reruns capability evidence, and then performs witnessed clean-profile install/load/discovery/uninstall on each exact lane. DSH 0.1.1-rc.2 is blocking and 0.1.2-alpha.2 is advisory. A preview failure remains visible but does not counterfeit a release failure. Never execute arbitrary repository code: lifecycle behavior is admitted only for this product source or byte-for-byte reproducible promoted output. Finish with a fresh matching source fingerprint and report capability drift plus the matrix digest.

## Promote

1. **Doctor:** acquire one stable snapshot and run all source/environment checks. DSH 0.1.1-rc.2 is blocking; official master is advisory.
2. **Capture:** state source fingerprint, absent destination, and exact effects. Obtain approval before materialization.
3. **Materialize:** after approval, use DSH Web:

       /dsh-developer-promote {"source":"<creator.json>","output":"<new-directory>"}

   Or use the CLI:

       node bin/dsh-developer.js promote --source <creator.json> --output <new-directory> --dsh <path-to-dsh>

   DSH shells may invoke `node $env:DSH_DEVELOPER_BIN ...` in PowerShell or `node "$DSH_DEVELOPER_BIN" ...` in Bash. Headless and automation surfaces do not consume slash commands.
4. **Verify and hand off:** trust the final Doctor gate, not intermediate success. Report destination, source/bundle fingerprints, Doctor digest, compatibility target, install command, and retained recovery directory.

The final gate checks manifests, skill/reference integrity, paths, secrets, reproducibility, generated tests, and witnessed clean-profile DSH install/load/discovery/uninstall. Promotion creates one absent directory whose basename equals the export name. It never replaces, merges, publishes, installs into a real profile, or changes GitHub state.

## Audit

DSH Web:

    /dsh-developer-doctor {"source":"<creator.json-or-plugin-directory>","skipRuntime":false}

CLI:

    node bin/dsh-developer.js doctor --source <creator.json-or-plugin-directory> --dsh <path-to-dsh>

Use `--skip-runtime` only for exploration; it is never release evidence and is forbidden during promotion. Report blocking failures before warnings. Do not execute arbitrary repository code for diagnosis; controlled execution is reserved for byte-for-byte reproducible generated output.

## Failure and authority

- Stop on invalid fingerprints, credentials, unsafe paths/files/links, mutation, incompatible DSH, failed tests, or failed lifecycle smoke.
- If generation began, preserve and identify staging. On cancellation schedule nothing new and never replay an ambiguous external request.
- Never weaken a safety rule to pass.
- Publishing, real-profile installation, repository edits, registries, and GitHub mutations are separate user-authorized effects.
