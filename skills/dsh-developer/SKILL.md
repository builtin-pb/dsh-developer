---
name: dsh-developer
description: "Promote a canonical DSH Creator export into a tested, installable native DSH and Codex plugin bundle, or audit an existing DSH plugin with Doctor. Use for DSH plugin creation, packaging, compatibility, safety, testing, and release-readiness work."
---

# DSH Developer

The single plugin you need for DSH

Own one accountable workflow from source snapshot through handoff. Never claim a releaseable bundle when a blocking check failed.

## Choose the journey

- For a saved DSH Creator export, use the promotion journey below.
- For an existing plugin repository, run Doctor first and propose a bounded change-set; do not modify the repository unless the user separately authorizes it.
- For an unstructured idea, help shape it in Creator and stop at a canonical export before promotion.

Read [the Creator export contract](references/creator-export.md) only when creating, diagnosing, or promoting an export. Read [the safety boundary](references/safety.md) before processing untrusted source.

## Promote

1. Doctor: acquire one stable snapshot and run all source and environment checks before materialization. The blocking public target is DSH 0.1.1-rc.2; official master is advisory.
2. Capture: state the exact source fingerprint, absent destination, and intended actions. Obtain approval before materialization.
3. Materialize: in the DSH Web app, use the native user command after approval:

       /dsh-developer-promote {"source":"<creator.json>","output":"<new-directory>"}

   Headless and automation surfaces do not consume DSH slash commands. When a DSH shell tool is composed, use the plugin's injected absolute launcher under the normal DSH sandbox and approval policy:

       PowerShell: node $env:DSH_DEVELOPER_BIN promote --source <creator.json> --output <new-directory> --dsh <path-to-dsh>
       Bash: node "$DSH_DEVELOPER_BIN" promote --source <creator.json> --output <new-directory> --dsh <path-to-dsh>

   In Codex, resolve the installed plugin root as two parent directories above this SKILL.md resource and run its bin/dsh-developer.js with Node. In a repository checkout, the equivalent command is:

       node bin/dsh-developer.js promote --source <creator.json> --output <new-directory> --dsh <path-to-dsh>

4. Verify: trust the final Doctor gate, not intermediate success. It checks manifests, skill and reference integrity, paths, secrets, reproducibility, generated tests, and clean-profile DSH install/discovery/uninstall.
5. Handoff: report the new destination, source and bundle fingerprints, Doctor digest, compatibility target, install command, and any retained recovery directory.

Promotion creates one new directory only. The output basename must equal the export name. It never replaces, merges, publishes, installs into a user profile, or changes GitHub state.

## Audit

In the DSH Web app, run:

    /dsh-developer-doctor {"source":"<creator.json-or-plugin-directory>","skipRuntime":false}

In a model-driven DSH surface with a shell, use DSH_DEVELOPER_BIN as above with the doctor subcommand. In Codex, resolve the installed plugin root from this skill resource. In a repository checkout, run:

    node bin/dsh-developer.js doctor --source <creator.json-or-plugin-directory> --dsh <path-to-dsh>

Use --skip-runtime only for an exploratory audit. A skipped runtime check is never release evidence and is forbidden during promotion.

Summarize blocking failures first, then advisory warnings. Do not execute arbitrary repository code merely to diagnose it; controlled execution is reserved for byte-for-byte reproducible generated output.

## Failure and cancellation

- Stop on an invalid fingerprint, detected credential, unsafe path/link/file, mutable source, incompatible DSH runtime, failed generated test, or failed lifecycle smoke.
- If candidate generation began, preserve and identify its staging directory for recovery.
- On cancellation, schedule no new work. Do not replay an ambiguous external request.
- Never weaken a check or safety rule to make a candidate pass.

## Separate authority

Publishing, installing into a real user profile, applying changes to an existing repository, registry actions, and GitHub mutations are separate user-authorized actions.
