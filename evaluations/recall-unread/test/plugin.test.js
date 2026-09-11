/**
 * Lifecycle and packaging checks for `dsh-recall-local`.
 *
 * These drive the real DSH slot registry: the entry must wait for the native
 * `conversation.input.dock` declaration, contribute exactly one list entry, and
 * disappear when the plugin (or the declaring parent) unloads. The compiled
 * browser bundle is loaded through DSH's own `__ModuleLoader__` seam, so the
 * artifact under test is the one that ships.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/** Load one DSH client artifact through its real loader registration seam. */
async function readRegistration(path) {
  const registrations = [];
  runInNewContext(await readFile(path, 'utf8'), {
    window: { __ModuleLoader__: { load: entry => registrations.push(entry) } },
    queueMicrotask,
  });
  assert.equal(registrations.length, 1, `${path} registers exactly one module`);
  return registrations[0];
}

const registration = await readRegistration(new URL('../lib/client.js', import.meta.url));
const client = registration.factory(require);
const renderer = await readRegistration(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'));
const { SlotRegistry } = renderer.factory(require);

const SLOT = 'conversation.input.dock';

async function setup(t, sessions = {}) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SlotRegistry);
  // `apply` declares `sessions` as a required service; the real client composes
  // it before this plugin loads, so each test supplies its own stand-in.
  ctx.provide('sessions', sessions);
  return ctx;
}

/** Declare the slot the way the native conversation plugin does. */
function declareDock(ctx) {
  return ctx.slots.register({ name: 'root', children: { [SLOT]: { kind: 'list', scope: 'session' } } }, () => null);
}

test('manifest declares a Web client with the native conversation edges', () => {
  assert.equal(manifest.name, 'dsh-recall-local');
  assert.equal(manifest.exports['./client'], './lib/client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-session',
    '@deepseek-ai/dsh-client-ui-conversation',
  ]);
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
});

test('the mounted Host entry exports name and apply', async () => {
  const host = await import(new URL('../lib/index.js', import.meta.url));
  assert.equal(host.name, 'recall-local');
  assert.equal(typeof host.apply, 'function');
  assert.equal(host.apply(), undefined);
});

test('compiled browser bundle uses only the DSH React seed and the package name as its id', () => {
  assert.equal(registration.id, manifest.name);
  const requests = [];
  const loaded = registration.factory(id => {
    requests.push(id);
    assert.match(id, /^react(\/jsx-runtime)?$/);
    return require(id);
  });
  assert.deepEqual([...new Set(requests)].sort(), ['react', 'react/jsx-runtime']);
  assert.equal(typeof loaded.apply, 'function');
  assert.deepEqual(Array.from(loaded.inject), ['slots', 'sessions']);
  assert.equal(loaded.slot, SLOT);
  assert.equal(loaded.entryId, 'recall-unread');
});

test('registration waits for the native dock declaration and then contributes one entry', async t => {
  const ctx = await setup(t);
  const scope = ctx.plugin(client);
  await scope;
  assert.equal(ctx.slots.entries(SLOT).length, 0, 'nothing is contributed before the owner declares the slot');

  const removeDock = declareDock(ctx);
  const entries = ctx.slots.entriesOfSlot(SLOT);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].options.id, 'recall-unread');
  assert.equal(entries[0].options.order, 10, 'the strip sits above the native queue dock (order 20)');
  assert.equal(typeof entries[0].component, 'function');
  assert.equal(typeof entries[0].inject, 'function');
  removeDock();
  assert.equal(ctx.slots.entries(SLOT).length, 0, 'a collapsed declaration removes the contribution');
});

test('disabling the plugin removes the strip from the dock', async t => {
  const ctx = await setup(t);
  const scope = ctx.plugin(client);
  await scope;
  const removeDock = declareDock(ctx);
  assert.equal(ctx.slots.entriesOfSlot(SLOT).length, 1);

  await scope.dispose();
  assert.equal(ctx.slots.entriesOfSlot(SLOT).length, 0, 'unload leaves no entry behind');
  removeDock();
});

test('the injected face removes through the addressed session scope and notices on that session', async t => {
  const calls = [];
  const notices = [];
  const sessionCtx = {
    scopeId: 'session-a',
    // Stand-in for `ctx.sessions.scope(sessionId)`: only `.get('conversation')` is consumed.
    get: service => {
      assert.equal(service, 'conversation');
      return {
        updateQueue: async (itemId, action) => {
          calls.push({ itemId, action, scope: sessionCtx.scopeId });
        },
        input: {
          for: subject => {
            notices.push(subject === sessionCtx ? 'addressed-to-session' : 'wrong-scope');
            return { notify: (level, message) => notices.push({ level, message }) };
          },
        },
      };
    },
  };
  const ctx = await setup(t, { scope: id => (id === 'session-a' ? sessionCtx : undefined) });
  const scope = ctx.plugin(client);
  await scope;
  declareDock(ctx);

  const entry = ctx.slots.entriesOfSlot(SLOT)[0];
  const face = entry.inject('session-a');
  await face.recall('msg-9');
  face.notify('error', 'boom');
  // The injected face is built inside the DSH module realm, so compare the
  // wire-shaped payload structurally rather than by cross-realm identity.
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([{ itemId: 'msg-9', action: { kind: 'remove' }, scope: 'session-a' }]),
  );
  assert.deepEqual(notices, ['addressed-to-session', { level: 'error', message: 'boom' }]);

  assert.throws(() => entry.inject('ghost-session'), /resolved no scope/, 'an unresolvable session fails loud');
});

test('a missing conversation service fails loud instead of rendering an inert strip', async t => {
  const ctx = await setup(t, { scope: () => ({ get: () => undefined }) });
  const scope = ctx.plugin(client);
  await scope;
  declareDock(ctx);
  const entry = ctx.slots.entriesOfSlot(SLOT)[0];
  assert.throws(() => entry.inject('session-a'), /conversation service unavailable/);
});
