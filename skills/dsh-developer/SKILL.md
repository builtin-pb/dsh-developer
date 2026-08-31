---
name: dsh-developer
description: "Develop DSH plugins through capability inspection, Doctor audits, deterministic promotion, compatibility evidence, and evidence-gated core incubation."
---

# DSH Developer

The single plugin you need for DSH

Own one attempt from stable snapshot through handoff. Return verified results or the blocker.

## Route the request

- Creator export: use **Promote** and load [the export contract](references/creator-export.md).
- Existing repository: use **Audit**, then propose one bounded change. Edit only when authorized.
- Core lifecycle, communication, permission, or isolation: inspect capabilities and load [the core-gap rules](references/core-incubation.md). For execution, load [the lab gate](references/execution-lab.md), which includes core admission.
- Whole-environment containment for a separately owned child workspace: load [the isolated-cell contract](references/isolated-cell.md); it invokes its own admission gate.
- Exact release-to-preview behavior: run compatibility only on this product or reproducible promoted bytes.
- DSH upgrade: run impact before compatibility; declare attached packages and services when static inference is incomplete.
- Target profile: run preflight before installation.
- Local UI or visual quality: load [the agent-native UI route](references/agent-native-ui.md); admit DSH MCP tools before use.
- Unstructured idea: shape it in Creator and stop at a canonical export.

Load [the safety boundary](references/safety.md) before untrusted source. For repository-plus-core work, inspect capabilities before Doctor, audit before edits, and keep one authorized change-set.

In DSH agents, prefer `dsh_developer` for six evidence operations; it cannot promote or control a browser. Otherwise use `bin/dsh-developer.js` (`DSH_DEVELOPER_BIN` in DSH shells).

## Inspect and compose

DSH Web:

    /dsh-developer-capabilities {}

DSH agent:

    dsh_developer {"operation":"capabilities"}

CLI:

    node bin/dsh-developer.js capabilities --dsh <path-to-dsh>

Record exact runtime, lane, identity, evidence strength, and digest. `behavior` is exercised; `inventory` is metadata. Absence covers one installation. Prefer native behavior; preview and inventory are not blocking proof.

Before installing an unfamiliar plugin into a profile, preflight its service contract without loading or installing repository code:

    node bin/dsh-developer.js preflight --source <plugin-directory> --profile headless --dsh <path>

PASS proves clean-profile composition, not activation, behavior, or a customized profile. Reject dynamic required-service contracts and profile-local copies of host service owners.

First locate changed upstream surfaces without executing either DSH lane:

    node bin/dsh-developer.js impact --source <plugin-directory> --release-dsh <path> --preview-dsh <path>

Treat changed exports, declarations, entries, dependency contracts, metadata, and service owners as scope facts, not behavior. Preserve undeclared inferred surfaces. Then run:

    node bin/dsh-developer.js compatibility --source <plugin-directory> --release-dsh <path> --preview-dsh <path>

The matrix verifies official entries, capabilities, and clean-profile install/load/discovery/uninstall. DSH 0.1.1-rc.2 is blocking; 0.1.2-alpha.2 is advisory. Keep preview failure visible without making it release failure. Finish with source fingerprint, drift, and digest.

## Promote

1. Run Doctor on one stable snapshot. The release lane is blocking; preview is advisory.
2. State the source fingerprint, absent destination, and exact effects. Obtain approval before materialization.
3. After approval, use DSH Web:

       /dsh-developer-promote {"source":"<creator.json>","output":"<new-directory>"}

   Or CLI:

       node bin/dsh-developer.js promote --source <creator.json> --output <new-directory> --dsh <path-to-dsh>

4. Trust the final Doctor gate, not intermediate success. Report destination, source and bundle fingerprints, Doctor digest, compatibility target, install command, and retained recovery directory.

Promotion creates one absent directory named for the export. It never replaces, merges, publishes, installs, or changes GitHub state.

## Audit

    node bin/dsh-developer.js doctor --source <export-or-plugin> --dsh <path-to-dsh>

Use `--skip-runtime` only for exploration; it is never release evidence and is forbidden during promotion. Report blocking failures before warnings. Do not execute arbitrary repository code for diagnosis; controlled execution is reserved for byte-for-byte reproducible generated output.

## Failure and authority

- Stop on invalid fingerprints, credentials, unsafe paths/files/links, mutation, incompatible DSH, failed tests, or failed lifecycle evidence.
- If generation began, preserve and identify staging. On cancellation, schedule nothing new and never replay an ambiguous request.
- Never weaken a safety rule to pass.
- Publishing, real-profile installation, repository edits, registries, provider use, and GitHub mutations require separate authority.
