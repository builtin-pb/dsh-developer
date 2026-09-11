/**
 * Functional checks for `dsh-recall-local`.
 *
 * Two layers, matching the two layers of the implementation:
 *  - `src/actions.ts` is exercised as plain functions against hand-built queue
 *    snapshots and a scripted removal verb.
 *  - the React strip runs in `react-test-renderer` with a real selector-hook
 *    face, so button wiring, busy propagation, and raced outcomes are observed
 *    on the rendered tree rather than asserted from source.
 *
 * The fake queue data is derived from the installed Session queue contract
 * (placement, content blocks, Host FIFO order) — not from this plugin's output.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createElement } = await import('react');
const { act, create } = await import('react-test-renderer');
const actions = await import('../src/actions.ts');
const { RecallStrip } = await import('./.build/client.mjs');

// --- queue fixtures ---------------------------------------------------------

const text = value => ({ type: 'text', text: value });
const image = () => ({ type: 'image', attachment: { id: 'att-1' } });

const steering = (id, content) => ({ id, messageId: id, placement: 'steering', content, preview: '', text: null });
const queued = (id, content) => ({ id, messageId: id, placement: 'queued', content, preview: '', text: null });
const context = (id, content) => ({ id, messageId: id, placement: 'context', content, preview: '', text: null });

const snapshot = queue => ({ queue });

/** Rejection shaped like the Host's `session/queue-item-not-found` business error. */
const claimedError = () => new Error('conversation.updateQueue failed: session/queue-item-not-found: queued item is no longer pending');
const closedError = () => new Error('conversation.updateQueue failed: session/steer-unavailable: current turn no longer accepts steering');

// --- projection -------------------------------------------------------------

test('only unclaimed user steering with readable text is recallable', () => {
  assert.equal(actions.isRecallable(steering('a', [text('hold on')])), true);
  assert.equal(actions.isRecallable(queued('b', [text('later')])), false);
  assert.equal(actions.isRecallable(context('c', [text('tool note')])), false);
  // Whitespace-only text is not a recallable message.
  assert.equal(actions.isRecallable(steering('d', [text('   \n ')])), false);
  // Attachment-bearing steering is excluded: recalling it would drop unseen work.
  assert.equal(actions.isRecallable(steering('e', [image(), text('see this')])), false);
});

test('a claimed row is simply absent from the queue snapshot', () => {
  const before = snapshot([steering('a', [text('stop')]), steering('b', [text('wait')])]);
  assert.deepEqual(actions.selectRecallItems(before).map(item => item.id), ['a', 'b']);
  const afterClaim = snapshot([steering('b', [text('wait')])]);
  assert.deepEqual(actions.selectRecallItems(afterClaim).map(item => item.id), ['b']);
  assert.deepEqual(actions.selectRecallItems(snapshot([])), []);
});

test('preview joins text, collapses whitespace, and marks non-text blocks', () => {
  assert.equal(actions.previewOf([text('  stop'), text('that\tnow ')]), 'stop that now');
  assert.equal(actions.previewOf([image(), text('look')]), 'look');
  assert.equal(actions.previewOf([text('a'), { type: 'reasoning', text: 'hmm' }]), 'a [reasoning]');
  assert.equal(actions.previewOf([text('x'.repeat(300))]).length, 300, 'truncation is the strip’s CSS job, not the projection’s');
});

test('preview and rows keep Host FIFO order and stable identities', () => {
  const items = actions.selectRecallItems(
    snapshot([queued('q', [text('later')]), steering('s1', [text('first')]), steering('s2', [text('second')])]),
  );
  assert.deepEqual(items, [
    { id: 's1', preview: 'first' },
    { id: 's2', preview: 'second' },
  ]);
});

// --- batch orchestration ----------------------------------------------------

test('recallMany removes oldest first and reports the count', async () => {
  const seen = [];
  const items = [
    { id: 'a', preview: 'one' },
    { id: 'b', preview: 'two' },
  ];
  const feedback = await actions.recallMany(items, async id => {
    seen.push(id);
  });
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(feedback, { level: 'info', text: '2 unread messages recalled.' });
});

test('recallMany keeps going past a lost race and reports failure as failure', async () => {
  const attempted = [];
  const feedback = await actions.recallMany(
    [
      { id: 'a', preview: 'one' },
      { id: 'b', preview: 'two' },
      { id: 'c', preview: 'three' },
    ],
    async id => {
      attempted.push(id);
      if (id === 'b') throw claimedError();
      if (id === 'c') throw new Error('gateway/internal: boom');
    },
  );
  assert.deepEqual(attempted, ['a', 'b', 'c'], 'one race never stops the batch');
  assert.equal(feedback.level, 'error');
  assert.match(feedback.text, /1 of the unread messages could not be recalled/);
});

test('recallMany reports a fully lost race as claimed, not as success', async () => {
  const feedback = await actions.recallMany([{ id: 'a', preview: 'one' }], async () => {
    throw claimedError();
  });
  assert.deepEqual(feedback, { level: 'info', text: actions.MESSAGE.claimed });
});

test('recallMany classifies a closed turn distinctly from a lost race', async () => {
  const feedback = await actions.recallMany([{ id: 'a', preview: 'one' }], async () => {
    throw closedError();
  });
  assert.deepEqual(feedback, { level: 'info', text: actions.MESSAGE.closed });
  assert.equal(actions.classifyRecallError(closedError()).kind, 'closed');
  assert.equal(actions.classifyRecallError(claimedError()).kind, 'claimed');
  assert.equal(actions.classifyRecallError(new Error('nope')).kind, 'failed');
  assert.equal(await actions.recallMany([], async () => {}), null, 'empty batch is never a success claim');
});

test('recall actions route the queue mutation and notice to the addressed session scope', async () => {
  const calls = [];
  const notices = [];
  const scope = { marker: 'the session-scoped context' };
  const conversation = {
    updateQueue: async (itemId, action) => {
      calls.push({ itemId, action });
    },
    input: {
      for: subject => {
        notices.push(subject === scope ? 'addressed-to-own-scope' : 'wrong-scope');
        return { notify: (level, message) => notices.push({ level, message }) };
      },
    },
  };
  const face = actions.createRecallActions({ conversation, scope });
  await face.recall('msg-1');
  face.notify('error', 'boom');
  assert.equal(JSON.stringify(calls), JSON.stringify([{ itemId: 'msg-1', action: { kind: 'remove' } }]));
  assert.deepEqual(notices, ['addressed-to-own-scope', { level: 'error', message: 'boom' }]);
});

// --- rendered strip ---------------------------------------------------------

/** Render the strip with a controllable session feed and scripted removal verb. */
function renderStrip(queue, recall) {
  // react's useSyncExternalStore needs a stable subscribe/getSnapshot pair;
  // the selector-hook contract is "read the current snapshot through use", so
  // a version counter is enough to re-render on change.
  let version = 0;
  const listeners = new Set();
  let current = snapshot(queue);
  const hook = selector => {
    return useSelected(selector, () => current, () => version, listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
  };
  hook.set = next => {
    current = snapshot(next);
    version += 1;
    for (const listener of listeners) listener();
  };
  const notices = [];
  let tree;
  act(() => {
    tree = create(
      createElement(RecallStrip, {
        useSession: hook,
        recall,
        notify: (level, message) => notices.push({ level, message }),
      }),
    );
  });
  return {
    tree,
    notices,
    set: next => {
      act(() => hook.set(next));
    },
    text: () => JSON.stringify(tree.toJSON()),
    buttons: () => tree.root.findAllByType('button'),
  };
}

const { useRef, useSyncExternalStore } = await import('react');
function useSelected(selector, getSnapshotRef, getVersion, subscribe) {
  const version = useSyncExternalStore(subscribe, getVersion);
  const cache = useRef({ version: -1, value: undefined });
  if (cache.current.version !== version) {
    cache.current = { version, value: selector(getSnapshotRef()) };
  }
  return cache.current.value;
}

const liveQueue = [steering('s1', [text('wait, use the other file')]), steering('s2', [text('also update the README')])];

/** A removal promise whose settlement this test controls. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('strip layout is border-box and fits the composer content box', () => {
  const view = renderStrip(liveQueue, async () => {});
  // The defect: content-box sizing plus intrinsic padding/border pushed the
  // right-hand controls past the content edge (measured 1198px wide in a 1470px
  // viewport with the outer rectangle starting at x=280).
  const root = view.tree.root;
  const outer = root.findAll(node => node.props['data-dsh-recall-local'] === '')[0];
  const card = root.findAll(node => node.props['data-dsh-recall-local-card'] === '')[0];
  assert.ok(outer, 'the strip root renders');
  assert.ok(card, 'the strip card renders');
  const outerStyle = outer.props.style;
  const cardStyle = card.props.style;

  assert.equal(outerStyle.boxSizing, 'border-box');
  assert.equal(cardStyle.boxSizing, 'border-box');
  // Width is the dock row reserved by the conversation shell, not 100% of the
  // unpadded stack, and both side variables are subtracted twice.
  assert.match(outerStyle.width, /^calc\(100% - var\(--dsh-composer-side-clearance, 16px\) - var\(--dsh-composer-side-clearance, 16px\) - var\(--dsh-composer-dock-inset, 8px\) - var\(--dsh-composer-dock-inset, 8px\)\)$/);
  assert.match(outerStyle.maxWidth, /var\(--dsh-composer-card-max-width, 100%\)/);
  assert.equal(outerStyle.padding, '0 var(--dsh-composer-dock-inset, 8px)');
  assert.equal(cardStyle.width, '100%', 'the card fills the dock row content box');
  assert.equal(outerStyle.flex, 'none', 'the dock row keeps its intrinsic height in the composer stack');

  // Every row is a border-box flex line whose preview may shrink; the controls
  // never do, which is what keeps them inside the card.
  const rows = root.findAll(node => typeof node.props['data-recall-item'] === 'string');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.props.style.boxSizing, 'border-box');
    assert.equal(row.props.style.width, '100%');
    assert.equal(row.props.style.minWidth, 0);
  }
  const list = root.findByType('ul');
  assert.equal(list.props.style.maxHeight, '180px');
  assert.equal(list.props.style.overflowY, 'auto', 'a long inbox scrolls instead of growing the strip');
});

test('strip shows one readable preview and a Recall button per unclaimed steering message', () => {
  const view = renderStrip(liveQueue, async () => {});
  const rendered = view.text();
  assert.match(rendered, /2 unread messages/);
  assert.match(rendered, /wait, use the other file/);
  assert.match(rendered, /also update the README/);
  assert.equal(view.buttons().length, 3, 'two row buttons plus Recall all');
  assert.match(rendered, /Recall all/);
});

test('strip renders nothing when nothing is unclaimed', () => {
  const view = renderStrip([queued('q1', [text('later')])], async () => {});
  assert.equal(view.tree.toJSON(), null);
});

test('a single unclaimed message gets a singular header and no Recall all', () => {
  const view = renderStrip([steering('s1', [text('hold on')])], async () => {});
  assert.match(view.text(), /1 unread message/);
  assert.doesNotMatch(view.text(), /Recall all/);
});

test('recalling one row removes it through the injected verb and reports success', async () => {
  const removed = [];
  const view = renderStrip(liveQueue, async id => {
    removed.push(id);
  });
  const rowButton = view.buttons().find(button => button.props['aria-label']?.startsWith('Recall wait'));
  await act(async () => {
    rowButton.props.onClick();
  });
  assert.deepEqual(removed, ['s1']);
  assert.deepEqual(view.notices, [{ level: 'info', message: 'Unread message recalled.' }]);
  // The Host snapshot still lists the row in this test, so the row stays but is
  // no longer actionable; the success line is visible.
  assert.match(view.text(), /Unread message recalled\./);
  const remaining = view.buttons().find(button => button.props['aria-label']?.startsWith('Recall wait'));
  assert.equal(remaining.props.disabled, true, 'a recalled row cannot be submitted twice');
});

test('a recall that loses the claim race says so instead of claiming success', async () => {
  const view = renderStrip(liveQueue, async () => {
    throw claimedError();
  });
  const rowButton = view.buttons().find(button => button.props['aria-label']?.startsWith('Recall wait'));
  await act(async () => {
    rowButton.props.onClick();
  });
  assert.match(view.text(), /Already picked up by the model/);
  assert.deepEqual(view.notices, [{ level: 'info', message: 'Already picked up by the model — nothing to recall.' }]);
  assert.equal(view.buttons().find(b => b.props['aria-label']?.startsWith('Recall wait')).props.disabled, false);
});

test('a lost race still reports once the queue empties and the strip unmounts', async () => {
  // Defect: with exactly one pending message, the authoritative queue can empty
  // before the removal rejects with session/queue-item-not-found. The strip then
  // renders null, so inline feedback is gone and the promised race-loss message
  // never reached the user at all.
  const pending = deferred();
  const view = renderStrip([steering('only', [text('never mind')])], () => pending.promise);
  const rowButton = view.buttons().find(button => button.props['aria-label']?.startsWith('Recall never'));
  assert.ok(rowButton, 'the single row offers Recall');

  await act(async () => {
    rowButton.props.onClick(); // starts the request; it stays in flight
  });
  view.set([]); // the model claimed it: the snapshot no longer lists the row
  assert.equal(view.tree.toJSON(), null, 'the strip unmounts with the empty queue');

  await act(async () => {
    pending.reject(claimedError());
    await Promise.resolve();
  });
  assert.deepEqual(
    view.notices,
    [{ level: 'info', message: 'Already picked up by the model — nothing to recall.' }],
    'the composer notice is the surviving feedback channel',
  );
});

test('an unclassified failure also survives the strip unmounting', async () => {
  const pending = deferred();
  const view = renderStrip([steering('only', [text('never mind')])], () => pending.promise);
  const rowButton = view.buttons().find(button => button.props['aria-label']?.startsWith('Recall never'));
  await act(async () => {
    rowButton.props.onClick();
  });
  view.set([]);
  assert.equal(view.tree.toJSON(), null);
  await act(async () => {
    pending.reject(new Error('gateway/internal: boom'));
    await Promise.resolve();
  });
  assert.deepEqual(view.notices, [{ level: 'error', message: 'Could not recall “never mind”.' }]);
});

test('a successful recall still reports after the strip unmounts it', async () => {
  const pending = deferred();
  const view = renderStrip([steering('only', [text('never mind')])], () => pending.promise);
  const rowButton = view.buttons().find(button => button.props['aria-label']?.startsWith('Recall never'));
  await act(async () => {
    rowButton.props.onClick();
  });
  view.set([]);
  await act(async () => {
    pending.resolve();
    await Promise.resolve();
  });
  assert.deepEqual(view.notices, [{ level: 'info', message: 'Unread message recalled.' }]);
});

test('Recall all walks the visible rows and keeps a failed row offered', async () => {
  const removed = [];
  const view = renderStrip(liveQueue, async id => {
    removed.push(id);
    if (id === 's2') throw new Error('gateway/internal: boom');
  });
  const all = view.buttons().find(button => button.props.children === 'Recall all');
  await act(async () => {
    all.props.onClick();
  });
  assert.deepEqual(removed, ['s1', 's2']);
  assert.match(view.text(), /1 of the unread messages could not be recalled/);
  assert.deepEqual(view.notices, [{ level: 'error', message: '1 of the unread messages could not be recalled.' }]);
  assert.equal(view.buttons().find(b => b.props['aria-label']?.startsWith('Recall also')).props.disabled, false);
});

test('a claimed row disappears from the strip when the session snapshot updates', async () => {
  const view = renderStrip(liveQueue, async () => {});
  assert.match(view.text(), /also update the README/);
  view.set([liveQueue[0]]); // the model claimed s2: it left the queue snapshot
  assert.doesNotMatch(view.text(), /also update the README/);
  assert.match(view.text(), /1 unread message/);
  assert.doesNotMatch(view.text(), /Recall all/, 'the batch affordance follows the visible count');
});

test('switching sessions shows that session’s own unclaimed messages', async () => {
  const view = renderStrip([steering('a1', [text('session A note')])], async () => {});
  assert.match(view.text(), /session A note/);
  assert.doesNotMatch(view.text(), /session B note/);
  view.set([steering('b1', [text('session B note')])]);
  assert.match(view.text(), /session B note/);
  assert.doesNotMatch(view.text(), /session A note/);
});
