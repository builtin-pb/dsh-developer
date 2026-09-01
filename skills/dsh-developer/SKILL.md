---
name: dsh-developer
description: "Develop DSH plugins with Doctor, promotion, compatibility proof, fixed-authority safety, and evidence-gated core work."
---

# DSH Developer

The single plugin you need for DSH

Own through handoff; return evidence or blocker.

## Route the request

- Creator export: **Promote**; load [the export contract](references/creator-export.md).
- Existing repository: **Audit**; propose one bounded, authorized change.
- Permission-argument failure, escalation loop, Full Access, disabled approvals, or delegated-child verification: load [the fixed-authority route](references/authority-safety.md) first; it overrides core incubation.
- Other core lifecycle, communication, permission, or isolation: inspect and load [the core-gap rules](references/core-incubation.md). For execution, load [the lab gate](references/execution-lab.md) instead.
- Separately owned child workspace: load [the isolated-cell contract](references/isolated-cell.md), which includes admission.
- Exact release/preview: compatibility only for product or reproducible output.
- DSH upgrade: impact first; declare attachments if inference is incomplete.
- Target profile: preflight before installation.
- Local UI or visual quality: load [the agent-native UI route](references/agent-native-ui.md); admit it first.
- Unstructured idea: shape in Creator; stop at canonical export.

Load [the safety boundary](references/safety.md) before untrusted plugins or exports. For repository-plus-core work: inspect, Doctor, one authorized edit set. UI content follows its route.

In DSH use `dsh_developer` for evidence and optional `dsh_ui` for protected UI. Else use `bin/dsh-developer.js` (`DSH_DEVELOPER_BIN` in shells).

## Inspect and compose

Use `/dsh-developer-capabilities {}` in DSH Web, `dsh_developer {"operation":"capabilities"}` in an agent, or:

    node bin/dsh-developer.js capabilities --dsh <path-to-dsh>

Record runtime, lane, identity, evidence strength, and digest. `behavior` is exercised; `inventory` is metadata. Absence is local; preview is advisory.

Preflight before installation without loading source:

    node bin/dsh-developer.js preflight --source <plugin-directory> --profile headless --dsh <path>

PASS proves composition, not activation or behavior. Reject dynamic requirements and profile-local host-service copies.

Locate changed upstream surfaces without executing either lane:

    node bin/dsh-developer.js impact --source <plugin-directory> --release-dsh <path> --preview-dsh <path>

Treat changes as scope, not behavior; preserve undeclared inference. Then run:

    node bin/dsh-developer.js compatibility --source <plugin-directory> --release-dsh <path> --preview-dsh <path>

The matrix verifies entries, capabilities, and clean-profile lifecycle. DSH 0.1.1-rc.2 blocks; 0.1.2-alpha.3 is advisory. Keep preview failure visible; finish with fingerprint, drift, and digest.

## Promote

1. Run Doctor on one stable snapshot. The release lane is blocking; preview is advisory.
2. State fingerprint, absent destination, and effects. Obtain approval before materialization.
3. After approval, use DSH Web:

       /dsh-developer-promote {"source":"<creator.json>","output":"<new-directory>"}

   Or CLI:

       node bin/dsh-developer.js promote --source <creator.json> --output <new-directory> --dsh <path-to-dsh>

4. Trust final Doctor. Report destination, fingerprints, digest, target, install command, and retained recovery directory.

Promotion creates one absent export-named directory. It never replaces, merges, publishes, installs, or changes GitHub state.

## Audit

    node bin/dsh-developer.js doctor --source <export-or-plugin> --dsh <path-to-dsh>

Use `--skip-runtime` only for exploration, never release or promotion. Report failures first. Do not execute arbitrary repositories; controlled execution is only for byte-reproducible generated output.

## Failure and authority

- Stop on invalid fingerprints, credentials, unsafe paths/files/links, mutation, incompatible DSH, failed tests, or failed lifecycle evidence.
- Preserve started staging. On cancellation, schedule nothing new or replay an ambiguous request.
- Never weaken a safety rule to pass.
- Publishing, real-profile installation, repository edits, registries, provider use, and GitHub mutations require separate authority.
