# Safety boundary

Deterministic promotion needs no model or provider key.

Treat Creator exports and repositories as untrusted, read-only input. Use only Doctor's stable snapshot. Reject links, special files, mutation, unsafe paths, dependency trees, credential-bearing configuration, detected secrets, and content outside documented limits.

Promotion creates one absent destination through private staging. It never replaces, merges, installs, publishes, or changes GitHub state.

Do not request a provider credential or improvise model-backed repair. Never put credentials in inputs, plugin trees, child environments, logs, reports, or bundles.
