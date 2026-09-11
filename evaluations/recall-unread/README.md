# dsh-recall-local

A small native DSH Web plugin: it takes back **unread steering messages** before
the model picks them up.

When you steer a follow-up while the agent is still working, DSH records it as a
pending steering occurrence. This plugin shows those occurrences in a compact
strip directly above the composer — one readable, single-line preview and one
**Recall** button each, plus **Recall all** when more than one is waiting.
Recalling removes the occurrence from the Host Agent inbox, so the model never
sees it. Only all-text messages appear: a steering message that carries an image
or file is left to the normal dock controls, because the strip cannot preview
those attachments.

Once the model has claimed a message it leaves the pending queue, so it stops
being recallable: the row disappears from the strip and the removal request is
refused with a named "already picked up" outcome rather than a false success.
The native queued-message dock keeps working unchanged; this strip only adds the
steering rows the dock lists under their own Steer/Edit/Remove controls.

Supported runtime: **DSH 0.1.5-rc.2** with its Web profile, Node
`^22.18.0 || >=24.11.0`.

## Install

Use the prebuilt archive included with this local evaluation. To regenerate it
from this package directory, first install the development dependencies:

```sh
npm ci --ignore-scripts
npm pack            # builds and writes dsh-recall-local-0.1.1.tgz
```

Then install it into the profile that runs your Web GUI and restart `dsh web`:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-recall-local-0.1.1.tgz --ignore-scripts
```

DSH forwards this to pnpm in the profile directory, records the bundle in
`package.json`, and mounts the Host entry from `cordis.patch.yml`. The shipped
`lib/` files are prebuilt, so `--ignore-scripts` is enough. Remove it with:

```sh
dsh plugin --profile web remove dsh-recall-local
```

The strip disappears as soon as the plugin is unloaded; nothing is persisted and
no other control is replaced.

## Use

1. Start a turn.
2. Send a second message while the agent is working.
   - With the composer's busy-Enter preference set to **Steer**, the message goes
     straight to the pending steering list and appears in the strip.
   - With the default **Queue** preference, the message first waits as an
     ordinary queued turn. It shows in the native queue dock, not here, with
     **Edit**, **Remove**, and **Steer queued message** controls. Pressing
     **Steer queued message** is the native action that moves it to the pending
     steering list — only then does it appear in this strip and become
     recallable.
3. A strip titled `1 unread message` (or `N unread messages`) appears above the
   composer.
4. Press **Recall** on a row, or **Recall all** for the whole batch.

Feedback is inline in the strip and mirrored into the composer notice channel
(the notice survives if the strip has no visible rows before the request settles):

| Outcome | What you see |
| --- | --- |
| Removed before the model claimed it | `Unread message recalled.` / `N unread messages recalled.` |
| The model claimed it first | `Already picked up by the model — nothing to recall.` |
| The turn stopped accepting steering | `The turn stopped accepting steering messages.` |
| Transport or Host failure | `Could not recall “…”` (the row stays offered) |

While a batch is running, every row and the batch button are disabled, so no
message is submitted twice.

## Develop

```sh
npm ci --ignore-scripts      # installs exactly the lockfile this package ships
npm test                     # type-check, build both entries, run the checks
```

`npm test` does three things:

- `tsc --noEmit` type-checks `src/` plus `test/contract-check.ts`, which asserts
  that the real installed `IConversation` and slot declarations satisfy this
  plugin's narrow faces.
- `build.mjs` copies the Host entry to `lib/index.js` and bundles the Web Client
  to `lib/client.js` (`window.__ModuleLoader__.load`, React as the only
  external), plus a loader-free test bundle under `test/.build/`.
- `node --test` runs 28 checks: projection and batch logic against hand-built
  queue snapshots, the rendered strip under `react-test-renderer` (including a
  lost claim race, that same race arriving after the queue has emptied and the
  strip has no visible rows, a partially failed `Recall all`, and the dock geometry),
  and the real DSH `SlotRegistry` lifecycle — deferred registration until
  `conversation.input.dock` is declared, one entry at order 10, per-session
  injection, and removal on unload.

`build.mjs` writes `lib/` from `src/`; do not edit `lib/` by hand.

### Two known dsh-developer Doctor defects in the evaluated version

The packaged spelling is retained for historical compatibility with the
`dsh-developer` version that was evaluated. **Both spellings are valid DSH
syntax**, and nothing here should be read as a requirement of DSH itself. The
two recognizer limitations below are defects in `dsh-developer` Doctor as
evaluated (its `dsh.entrypoint` and `web.client-bundle` checks), not properties
of the DSH runtime, and both have since been fixed in the local `dsh-developer`
source:

- A bundled Host entry that esbuild emits as `var name = …; function apply() {}
  export { apply, name }` is valid ESM and DSH mounts it. The evaluated Doctor's
  `dsh.entrypoint` recognizer matched inline `apply` declarations such as
  `export function apply` and `export const apply =`, and reported
  `INVALID_DSH_ENTRY` for the export table, so this build copies the Host entry
  verbatim (`src/host-entry.js` → `lib/index.js`) instead of letting esbuild
  rewrite the declarations.
- A loader registration using the object **method** form
  `factory(require) { … }` is also valid and DSH's client module system executes
  it (`registration.factory(specifier => …)`). The evaluated Doctor's
  registration recognizer only walked `factory: (require) => …` /
  `factory: function (require) { … }` and reported
  `CLIENT_BUNDLE_REGISTRATION_INVALID` for the method form, so the banner keeps
  the arrow-property form.

These are the only two reasons for the current spelling. Since both forms are
valid and the recognizers now accept them, switching between the two is
cosmetic; this package stays on the spelling it has already shipped and verified
rather than spending a new version on a cosmetic rewrite.

## How it fits

- `src/host-entry.js` (copied to `lib/index.js`) is the module the bundle patch
  mounts. It exports only `name` and `apply` and owns no Host services.
- `src/client.ts` is the Web Client plugin: `inject: ['slots', 'sessions']` and
  one `install(ctx)` call.
- `src/install.ts` waits for the native `conversation.input.dock` declaration
  (with `ctx.slots.inject`) and registers a single list entry at order 10, above
  the native queue dock at order 20. The injected face is built from the
  addressed Session scope, so rows, notices, and removals always belong to the
  Session on screen.
- `src/strip.tsx` is the presentation: a `useSession` selector over
  `snapshot.queue`, one-line CSS truncation for previews, and per-row busy state.
  Its outer rectangle follows the native dock geometry — `box-sizing:
  border-box`, `width: calc(100% - 2 × --dsh-composer-side-clearance - 2 ×
  --dsh-composer-dock-inset)`, `max-width: calc(--dsh-composer-card-max-width -
  2 × --dsh-composer-dock-inset)`, and `margin: 0 auto` — the same convention
  `conversation.input.dock` occupants use, so the card and its controls stay
  inside the composer content box.
- `src/actions.ts` holds the transport-free logic: which rows are recallable,
  how a preview is read, and the sequential batch walk.

A row is recallable exactly when it is an authoritative queue occurrence with
`placement: 'steering'` and all-text, non-blank content. The snapshot source
list from `src/actions.ts`:

```ts
export function isRecallable(row: QueueRow): boolean {
  if (row.placement !== 'steering') return false;
  const text = textOf(row.content);
  return text !== null && text !== '';
}
```

Attachment-bearing steering is deliberately **not** recallable here. Only
all-text messages are included: `textOf` returns `null` as soon as any content
block is not text, so a message with an image or file is excluded even when it
also has text. The strip previews text only, and silently removing a message
whose images you cannot see would lose work. Those rows keep their normal dock
controls.

Each included row shows a **single-line** preview: whitespace is collapsed, the
line is truncated with an ellipsis, and the full text is available through the
`title` attribute. The preview is not wrapped and not multi-line.

Removal uses the native per-session `conversation.updateQueue(itemId, { kind:
'remove' })` verb — the same one the dock's own Remove button uses. DSH answers a
lost race with `session/queue-item-not-found` and a closed turn with
`session/steer-unavailable`; both are classified, while any other failure is
reported as a failure and the row stays actionable.

Every outcome is written to the composer notice channel as well as rendered
inline. That matters because removing the last pending row empties the queue,
which hides the strip mid-request; a race lost at that instant can no longer
be rendered inline, and the notice is what still reaches you.

## Verified behavior and limits

Observed in this workspace on macOS with DSH `0.1.5-rc.2` and Node `24.19.0`:

- `npm test`: 28/28 passing (build, type-check, projection, rendered strip
  including the dock geometry and the empty-queue race ordering, slot
  lifecycle).
- `dsh-developer doctor --source . --skip-runtime`: every blocking check passes
  (`dsh.entrypoint`, `web.client-bundle`, `dsh.host-client-inject`,
  `compatibility.upstream-attachments`, `dependencies.cold-boot`, and the rest).
  The remaining warnings are the advisory packaging/official-master notes and a
  static route-coverage warning about the copied Host entry. Two blocking
  failures at first were the `dsh-developer` Doctor recognizer defects described
  above, not runtime defects; the retained spelling avoids them.
- `dsh plugin --profile <disposable> add dsh-recall-local-0.1.1.tgz` installs
  from the packed archive, and `dsh --profile <disposable> --dump-config` lists
  the plugin row.
- Booting that disposable profile with the installed archive serves the boot
  graph containing `dsh-recall-local` with the expected `inject` edges, and
  `/plugins/??dsh-recall-local/client.js` returns the built bundle that
  registers `id: "dsh-recall-local"`.

The evaluator exercised the frozen `0.1.0` tarball in Chrome with real DeepSeek
sessions and reported: single recall, **Recall all**, ordinary queued messages
preserved, switching to another session and back, reload, and disappearance of
the strip once the model claimed the remaining message all worked; native
session events confirmed the recalled A/B/C never became `user/message` events
while the unrecalled D did. That review also found two defects in the frozen
tarball, both repaired here:

- At a 1470px viewport the strip's outer rectangle spanned x=280…1478 (width
  1198) with content-box sizing, clipping the right-hand controls. The layout
  now uses the native border-box dock geometry.
- With exactly one pending message, a `session/queue-item-not-found` rejection
  that arrived **after** the authoritative queue had already emptied rendered
  `null` with no notice, so the promised race-loss feedback vanished. Every
  outcome now also goes to the composer notice channel, and the exact ordering
  is covered by a behavioral regression (the removal promise is left in flight,
  the snapshot is emptied, and only then does the request reject).

The evaluator subsequently installed the repaired `0.1.1` archive and verified
single/bulk recall and the fixed layout in Chrome. At a 1470px viewport, the
card and buttons stayed inside the composer, including beside a long unbroken
preview. Separate replay probes verified the final-row rejection notice and
session isolation during an in-flight batch. The coding agent's own browser
route was not configured; these browser observations came from the evaluator.

The repository's adjacent `REPORT.md` records the full evaluation and its
assistance boundaries. Still unverified here: screen-reader output, other themes
and viewports, Windows/Linux, DSH versions other than `0.1.5-rc.2`, and a live
Host-side stale-click race.

## License

MIT.
