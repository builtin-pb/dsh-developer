# Diagnose a DSH session

Read one selected DSH log without replaying tools or sending a model request:

```sh
dsh-developer session --source /path/to/session.v3.jsonl.zstd
dsh-developer session --source /path/to/export.jsonl --limit 10 --json
```

The report correlates calls and results by turn, step and call ID, parses JSON arguments, samples failures, and reports the last observed `turn/end`. DSH's `error` and `aborted` reasons become `failed` and `cancelled`; the original reason remains available. Later title metadata does not invalidate completion. It supports DSH format 3 in plain JSONL or concatenated Zstandard frames using Node's native decoder. `--limit` selects 0–100 recent calls, default 20. Counts cover all supported events read from the selected file; result-pruning replacements are reported as omissions, not additional executions.

`ok` means inspection succeeded. A completed turn does not prove the development task succeeded. `failedTools` counts native error envelopes; an ordinary shell result can still report a nonzero exit code. Examine the relevant result and reproduce the behavior before deciding on a repair.

Conversation messages and reasoning are omitted. Likely credentials are redacted from tool arguments and results; these can still contain private application data, so review a report before sharing it. Unsupported event shapes, ambiguous identities, missing completion, and display omissions remain explicit. Malformed, changing or oversized files fail inspection instead of appearing complete.

Hard limits include 8 MiB compressed input, 32 MiB decoded input, 4 MiB per frame, 25,000 events and a 64 KiB report. Cancellation is checked between bounded reads, frames and event batches. A stable exported log is preferable to a file being actively written.

The native `dsh_developer` operation `session` accepts `source` and optional `limit`. It reads an exported file inside the current Agent workspace. Use the CLI under the host's execution policy for a known session path outside that workspace. Neither route discovers or copies unrelated sessions.

Native inspection checks the resolved path, opened file identity and parent identities before and after reading. These portable Node checks detect observed changes; they are not atomic OS filesystem confinement against hostile concurrent writers. Use a stable exported file under the host's actual execution policy.
