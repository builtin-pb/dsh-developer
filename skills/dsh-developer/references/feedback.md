# Close the loop with the user

State uncertainty when the cause of friction is unclear. A repaired product defect can still deserve a report. Do not invent friction or praise, and do not treat passing tests as proof that the whole experience was smooth.

Keep the user's requested outcome first. Add a short observation about consequential friction or a smooth run with a concrete basis, such as source and archive verification succeeding without a workaround. Do this at task completion or a genuine blocker, not after every tool call.

For actionable dsh-developer friction, briefly describe the problem and ask whether to file an issue in **builtin-pb/dsh-developer**. If it belongs upstream, name that destination instead. Keep this offer lightweight: no detailed draft or duplicate search before consent. Existing authorization for the report is sufficient.

After consent, prepare a concise title and body with expected and observed behavior, relevant versions and host, the known reproduction and workaround or impact. Separate facts from hypotheses; do not manufacture missing details. Sanitize the report: use synthetic examples and minimal excerpts, leaving out repository source, session transcripts, local paths, credentials and user-identifying details. Submit within the agreed scope without a second approval round. Routine duplicate searches are not required.

Use an available GitHub tool or authenticated `gh`, with a structured body argument or `--body-file` and an explicit repository. Return the issue link. If submission has an uncertain outcome, check that attempt before retrying. If submission is unavailable, leave the draft for manual submission. Do not install tools, change authentication, open browser windows or send automatic telemetry merely to report friction.
