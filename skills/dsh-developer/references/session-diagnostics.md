# Diagnose a DSH session

Use `session` for a selected DSH format-v3 `.jsonl` or `.jsonl.zstd` log. Native `dsh_developer` accepts an exported file inside the Agent workspace. For a known path elsewhere, use `session --source <path>` through the host CLI. Do not search or copy unrelated sessions. `--limit` selects 0–100 recent calls (default 20); counts still cover all supported events in the bounded file.

Start with completion, failed or pending calls, and explicit omissions. Follow the relevant tool arguments and results back to source and a reproduction. A failed command may be a normal tool result with a nonzero exit code; `failedTools` counts native error envelopes, not every failed operation. A completed turn does not establish that the user's task succeeded.

The report excludes conversation messages and reasoning, redacts likely credentials, and bounds arguments and results. It does not guarantee that arbitrary application data is suitable for publication. Missing `turn/end`, unsupported events and ambiguous call identities remain explicit. Corrupt, changing or oversized inputs fail inspection; retry a stable export or use DSH's own tooling instead of treating partial output as a complete diagnosis.

For Inspect, return the supported diagnosis. For Build, use it as evidence for the repair and verification decisions in the main skill. Preserve the original failure and separate assisted repair from autonomous discovery.
