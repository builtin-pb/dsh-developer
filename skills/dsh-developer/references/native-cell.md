# Native isolated Build and Apply


In the current top-level DSH Agent, `cell-plan` takes an outcome and 1–4 exact commands/timeouts. It accepts no path, cwd, profile, environment, provider, mount, network or session: source is the verified live `exec.agent` in `agents.roots()` and its `session.header.cwd`, never caller or process cwd.

Call these tools directly. Nested calls, including through code-only `run_code` presentation, are unsupported. A plan is not approval. `cell-run` accepts only its digest after audited `tools/pre-execute` grants the displayed plan once; conversation and fields cannot grant it. One admitted offline, credential-free cell runs the commands without source/profile writes. Changed runs stay in a controller stage. Apply only through the exact-digest next action with fresh allowed-once approval and the transaction reference from the main skill. Discard exits; caller paths grant nothing.


For provider admission, bounds and executor API work, use the isolated-cell reference routed by the main skill.
