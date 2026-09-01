# Transactional Apply

Load after an isolated run retains changes, and for Apply, discard, or recovery. The controller owns every path and lifecycle; `nextActions` is the continuation interface.

## Continue

- For a successful changed run, show the exact staged paths and offer both alternatives: `cell-apply` or `cell-discard`. Never invent a digest, path, or third route.
- Apply only from the owning live top-level Agent. It re-proves source, stage, checks, and effects, then requires a fresh audited allowed-once decision. Denial grants nothing; stop without retrying.
- Apply executes no repository code. It moves a verified backup and candidate, final-Doctors the result, and removes controller state before releasing capacity. Concurrent and repeated calls fail closed.

## Recover

After cancellation or failure, trust report state, not the attempted operation:

- Verified rollback with a retained stage may exit only through the exact owner-bound `cell-discard` action; it applies nothing.
- Verified post-commit cleanup debt may use that action only when the report marks cleanup `resumable: true`; it removes retained controller state. The source remains applied; never call or describe this as discarding changes.
- Unverified rollback, stage missing/mutation/identity/cleanup ambiguity, or a recovery instruction is terminal for automation. Preserve source and retained state. Do not call discard; do not delete, move, restore, or reconstruct any path manually.

Durable `state-minted`, `state-prepared`, `state-committing`, and `state-committed` markers are crash evidence. `committing` means source mutation may be partial; `committed` means final verification passed before cleanup. Multi-file Apply is not power-loss atomic. A fresh plan for that workspace blocks while matching evidence remains.

Return the marker state and bounded report to the owner/operator. Resume only after an authorized recovery proves the exact source bytes and physical identity; never infer recovery from a clean-looking tree.

## Finish

Applied means the source fingerprint equals the sealed stage, final Doctor/preflight match, cleanup is verified, and capacity is released. Discarded means pre-commit identity-verified cleanup released capacity without applying. Cleanup after `state-committed` remains Applied even when the operation name is `cell-discard`. Anything else is an exact blocker, not success.
