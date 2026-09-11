# Chrome reconstruction evaluation

On September 10, 2026, DeepSeek using dsh-developer produced a working local recreation of the persistent static edition of [dsh-recall-unread](https://github.com/hg1048596-pixel/dsh-recall-unread). The first package handled the core interaction in real DSH Web. Browser inspection and independent review found two defects; a subsequent repair fixed both.

The reference had **125 GitHub stars** when checked, an MIT license, and a compact native feature. Stars helped select a visible community example; they do not establish implementation quality. Reference commit: `e9a22bad1f246584ac153a250436732c754b7e72`. This evaluation covers pending text-message recall, not the reference's optional dynamic-plugin installation route.

## Conditions

- macOS ARM64, Node 24.19.0, official DSH 0.1.5-rc.2.
- Chrome interface controlled through Computer Use. Every task request and corrective message to the coding agent went through that interface.
- DSH displayed **DeepSeek-V41-Flash**, **High** reasoning. dsh-developer was installed from a frozen local archive.
- The agent received a behavior description, installed DSH APIs, and dsh-developer's documentation/examples. It was instructed not to retrieve or copy the reference implementation.
- The evaluator prepared an empty workspace and temporary profile. Candidate implementation and repairs were written by DeepSeek. The evaluator independently installed, inspected, tested, and reviewed the output.
- One setup intervention occurred during the first run: the evaluator had accidentally named ancestor packaging metadata `package.json`. Renaming that file repaired project discovery; no candidate code changed. The agent was informed through Chrome.

The first run completed in **18m04s**, with 282 displayed steps and 24 passing tests. DSH displayed 40.3M tokens with a 99.6% cache-hit figure; this is the interface's usage accounting, not a billing estimate. The informed repair took **4m16s** and increased the suite to 28 passing tests. A final documentation correction took **1m11s**. The evaluator then corrected installation prerequisites, an inaccurate description of the old export recognizer, and the documentation's validation account. Implementation, tests, dependencies, version, and built JavaScript remained unchanged after the repaired package was exercised.

## What the exact packages demonstrated

| Behavior | Observation |
| --- | --- |
| Native installation and startup | The packed plugin installed into a fresh evaluation profile alongside dsh-developer and loaded after a real DSH restart. |
| Single recall | With three pending steering messages and one ordinary queued message, recalling the middle steering message removed only that occurrence. |
| Bulk recall | The remaining steering messages disappeared; the ordinary queued message retained its native controls. |
| Model boundary | Native session events recorded the recalled messages' inbox admissions and removals, but no corresponding `user/message` events. A deliberately unrecalled message did enter user-message history after the model claimed it. |
| Session switching and reload | Another session did not display the pending messages. Switching back and reloading restored the appropriate controls while the messages remained pending. |
| Enable/disable | The disabled configuration omitted the strip while a steering message remained pending. Re-enabling plus a page reload restored one working control. Immediate hot-enable without reload was not established. |
| Layout | The first package overflowed its available width. Version 0.1.1 aligned with the native composer and kept every action visible, including beside a long unbroken preview. At a 1470px viewport, the repaired card occupied x489.2–1250.8; its dock and rows used border-box sizing without horizontal overflow. |
| Last-row rejection | Independent replay emptied the authoritative queue before rejecting a pending recall. The first package lost its notice; the repaired shipped bundle produced exactly one composer notice. |
| In-flight session change | A controlled replay switched from A to B during A's bulk recall. Both removals and the result notice stayed on A; B remained actionable. |

Real-model tests used a foreground local sleep to create a pending-message window. Messages were sent and recalled through Chrome. Busy Enter defaults to **Queue** in this DSH version, so the evaluator explicitly used the native **Steer** control. No artificial model adapter was used for those observations.

The last-row rejection and in-flight session-ordering checks used the shipped bundle, real React/Cordis components, and scripted transports. They supplement the live browser observations; they are not live network-race measurements. Independent builds reproduced the frozen artifacts byte-for-byte, and the final candidate passed all **28/28** tests.

## Findings and interpretation

The first implementation made useful native integration choices: authoritative queue state, occurrence IDs, the existing session-addressed remove operation, and a normal client slot. It did not create a second message store or rewrite Host inbox behavior. Queue classification, session injection, and presentation are separately understandable.

Two candidate defects needed feedback: content-box overflow clipped the controls, and a failed single recall lost its explanation when the final row disappeared. The agent repaired them after concrete browser/reviewer reports and added the relevant regression. This establishes successful informed repair, not independent discovery of both defects.

The run also exposed **two defects in dsh-developer's Doctor**, independently reproduced on its own shipped session-status example. Doctor rejected a callable local `apply` exported through an ESM export list and rejected an object-method `factory(require) { ... }` in the client loader registration. Both forms are valid at the native runtime boundary. The agent spent substantial time adapting its output to the auditor and initially misdescribed these as DSH requirements. The final candidate documentation identifies the Doctor defects and records why the existing build spellings were retained.

### Development through dsh-developer itself

The evaluator gave DeepSeek a separate copy of the public dsh-developer source and the two reproduced failures, again through Chrome. In **4m06s**, it repaired the two recognizers and added regression coverage in four files. The entrypoint check now reuses existing Babel module analysis to recognize callable local exports and aliases without executing the audited module. The client registration parser accepts method factories while retaining the checks inside their bodies. The stricter generated-template contract remains unchanged.

Independent review compared the fixed files with the frozen source basis, exercised the actual compiled session-status example, and challenged non-callable/reassigned exports, malformed code, unsafe/dynamic imports, and duplicate registrations. Its **46 focused tests passed**, with no blocking findings. The evaluator adopted the four reviewed files into this repository. Integrated `npm run validate` completed with **441 passed, 0 failed, 30 skipped** (471 total), and Doctor from the packed product passed both formerly failing checks on the shipped example.

DeepSeek's DSH-shell validation had reported two failures. A controlled comparison reproduced both on the original and repaired trees when using the exact `NODE_PATH` exported by the installed DSH launcher; both passed without that variable. The failures concerned an absence fixture that found globally available DSH dependencies and a hook inventory check that found an external hooks package. This establishes that the Doctor patch did not introduce them. A subsequent repository fix confined installed-package lookup to the selected local dependency graph and added contaminated-environment coverage; it also distinguishes damaged installations from confirmed absence. The original evaluation artifacts and counts above remain unchanged.

This is encouraging evidence of useful development and repair on one real community-derived task. It does not estimate reliability, prove superiority over the same model without the plugin, or imply error-free development at arbitrary scale. There was no matched control. The actor's own browser route was not configured, so the evaluator supplied the real Chrome observations. Windows, Linux, mobile layouts, screen-reader behavior, and a live stale-click rejection race were not exercised in this case.

## Local deliverable

The adjacent [README](README.md), source, build script, lockfile, and tests are the reviewed **dsh-recall-local 0.1.1** package. It has not been published. Install the generated archive into a disposable Web profile to try it; the package README gives the commands. The final archive differs from the browser-tested repaired archive only in `README.md`; its executable contents are identical.

- First frozen archive SHA-256: `e0762b5b02dde5dc816ce5a8d9a8d0b5576c8f5d434fe0f820b5341b696aa599`.
- Repaired archive SHA-256: `ec761e296f9f829102deaddbcb91fa97d4edf4130edf012701d05eae94172205`.
- Final archive after documentation corrections SHA-256: `631dd5b15a1af18b12b02df7c5c7b9ba0c08ca82c2af4a144d777899a6ba5ebb`.

Detailed private session records, diagnostic snapshots, and evaluator probes remain outside the distributable package. The report contains no credentials or private framework material.
