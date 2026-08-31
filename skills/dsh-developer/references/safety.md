# Safety boundary

Deterministic promotion does not call a model and needs no provider key.

Treat every Creator export and plugin repository as untrusted, read-only input. Work only from the stable snapshot accepted by Doctor. Reject links, special files, mutable inputs, unsafe paths, dependency trees, credential-bearing configuration, detected secrets, and content outside the documented limits.

Promotion creates one new destination through a unique staging directory. It does not replace or merge an existing destination, install into a user profile, publish a package, or change GitHub state.

Do not request a provider credential or improvise model-backed generation or repair. Those operations are not part of the current release. If asked, explain the unsupported boundary and stop before disclosing source or credentials.

Never place credentials in Creator exports, plugin trees, child-process environments, logs, reports, or generated bundles.
