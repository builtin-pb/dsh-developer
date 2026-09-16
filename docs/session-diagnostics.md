# Diagnose a DSH session

Read one selected DSH log without replaying tools or sending a model request. From a DSH agent's POSIX shell:

```sh
node "$DSH_DEVELOPER_BIN" session --source /path/to/session.v3.jsonl.zstd
node "$DSH_DEVELOPER_BIN" session --source /path/to/export.jsonl --limit 10 --json
```

In PowerShell, use `node "$env:DSH_DEVELOPER_BIN"`; from this repository's checkout, use `node bin/dsh-developer.js`. Profile installation does not create a global CLI command.

The report correlates calls and results by turn, step and call ID, parses JSON arguments, samples failures, and reports the last observed `turn/end`. DSH's `error` and `aborted` reasons become `failed` and `cancelled`; the original reason remains available. Later title metadata does not invalidate completion. It supports DSH format 3 in plain JSONL or concatenated Zstandard frames using Node's native decoder. `--limit` selects 0–100 recent calls, default 20. Counts cover all supported events read from the selected file; result-pruning replacements are reported as omissions, not additional executions.

`ok` means inspection succeeded. A completed turn does not prove the development task succeeded. `failedTools` counts native error envelopes. Separately, `counts.processFailures` counts recognized shell failure/interruption observations, and `processFailures` retains the latest ten samples with command, turn, step, call ID and result sequence. These samples survive the recent-call limit, including `--limit 0`; `omissions.processFailures` reports samples dropped by the sample or report-size cap. A recent call's `status` still describes its tool envelope; `result.process` carries the separate process observation. A nonzero shell exit can therefore have a successful tool envelope.

Process detection follows the public DSH **0.1.5-rc.2** renderers for `bash` and `pwsh`, including their persistent variants. Session format 3 retains rendered tool content, not the canonical shell result object. Detection requires one text block, a non-error envelope, and an unambiguously matched foreground shell call with a command. It recognizes terminal nonzero-exit and signal markers, foreground timeout markers, and persistent shell nonzero-exit/reset and timeout-or-OOM forms. A shell reset with exit code zero or no known status is not counted as a process failure. Missing markers are not proof of process success. Result-pruning replacements do not create additional observations.

The report records the emitted status, not its cause: a Windows interruption can appear as exit code 1, and a timeout-or-OOM message does not distinguish those causes. A sandbox denial can also accompany a nonzero exit. Inspect the protected result summary and reproduce the behavior before deciding on a repair. Output ending with an identical marker is indistinguishable from renderer output; logs do not authenticate which plugin registered a tool name. Observations carry `evidence: "dsh-shell-rendered-status"` to make this limitation explicit.

Arbitrary JSON `exitCode` fields, other tool names, ambiguous or unmatched calls, multi-block content, generic background-job controls/notices and nested `run_code` calls are not classified as shell process outcomes. Unknown or changed renderers remain ordinary tool summaries. Shell infrastructure errors and cancellation error envelopes remain in `failedTools`; process observations do not infer missing exit information from them.

Conversation messages and reasoning are omitted. Likely credentials are redacted from tool arguments and results; these can still contain private application data, so review a report before sharing it. Unsupported event shapes, ambiguous identities, missing completion, and display omissions remain explicit. Malformed, changing or oversized files fail inspection instead of appearing complete.

Hard limits include 8 MiB compressed input, 32 MiB decoded input, 4 MiB per frame, 25,000 events and a 64 KiB report. Cancellation is checked between bounded reads, frames and event batches. A stable exported log is preferable to a file being actively written.

The native `dsh_developer` operation `session` accepts `source` and optional `limit`. It reads an exported file inside the current Agent workspace. Use the CLI under the host's execution policy for a known session path outside that workspace. Neither route discovers or copies unrelated sessions.

Native inspection checks the resolved path, opened file identity and parent identities before and after reading. These portable Node checks detect observed changes; they are not atomic OS filesystem confinement against hostile concurrent writers. Use a stable exported file under the host's actual execution policy.
