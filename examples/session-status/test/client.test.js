import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// The actual DSH bundle format needs just this registration seam in a Node test.
// No slot or Cordis lifecycle implementation is re-created here.
async function readRegistration(path) {
  const registrations = [];
  runInNewContext(await readFile(path, 'utf8'), {
    window: { __ModuleLoader__: { load: entry => registrations.push(entry) } },
    queueMicrotask,
  });
  assert.equal(registrations.length, 1);
  return registrations[0];
}

const registration = await readRegistration(new URL('../lib/client.js', import.meta.url));
const client = registration.factory(require);
const renderer = await readRegistration(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'));
const { SlotRegistry } = renderer.factory(require);
const expectedSlot = 'conversation.session.header.actions';

async function setup(t) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SlotRegistry);
  ctx.provide('uiSession', {});
  return ctx;
}

function declareHeader(ctx) {
  return ctx.slots.register({
    name: 'root',
    children: { [expectedSlot]: { kind: 'list', scope: 'session' } },
  }, () => null);
}

test('manifest and compiled lazy factory use only the DSH React seed', () => {
  assert.equal(registration.id, manifest.name);
  assert.equal(manifest.exports['./client'], './lib/client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-session',
    '@deepseek-ai/dsh-client-ui-conversation',
  ]);
  const requests = [];
  const loaded = registration.factory(id => {
    requests.push(id);
    assert.equal(id, 'react/jsx-runtime');
    return require(id);
  });
  assert.deepEqual(requests, ['react/jsx-runtime']);
  assert.equal(typeof loaded.apply, 'function');
  assert.deepEqual(Array.from(loaded.inject), ['slots', 'uiSession']);
});

test('waits for the native slot, preserves siblings, remounts, and unloads', async t => {
  const ctx = await setup(t);
  const scope = ctx.plugin(client);
  await scope;
  assert.equal(ctx.slots.entries(expectedSlot).length, 0);

  const removeHeader = declareHeader(ctx);
  const removeSibling = ctx.slots.register({ name: expectedSlot, id: 'existing-action', order: 20 }, () => null);
  assert.deepEqual(ctx.slots.entriesOfSlot(expectedSlot).map(entry => entry.options.id), [
    'existing-action', 'dsh-session-status',
  ]);
  removeHeader();
  assert.equal(ctx.slots.entries(expectedSlot).length, 0);
  removeSibling(); // The native disposer remains safe after the parent collapsed.

  const removeReplacement = declareHeader(ctx);
  assert.equal(ctx.slots.entries(expectedSlot).length, 1);
  await scope.dispose();
  assert.equal(ctx.slots.entries(expectedSlot).length, 0);
  removeReplacement();
  declareHeader(ctx);
  assert.equal(ctx.slots.entries(expectedSlot).length, 0);
});

test('unloading before a header exists cancels the pending contribution', async t => {
  const ctx = await setup(t);
  const scope = ctx.plugin(client);
  await scope;
  await scope.dispose();
  declareHeader(ctx);
  assert.equal(ctx.slots.entries(expectedSlot).length, 0);
});

test('renders accessible text from the supplied session on every state change', async t => {
  const ctx = await setup(t);
  declareHeader(ctx);
  await ctx.plugin(client);
  const [{ component }] = ctx.slots.entries(expectedSlot);
  let snapshot;
  let reads = 0;
  const useSession = selector => { reads++; return selector(snapshot); };
  const cases = [
    [{ sessionId: 'a', openState: 'cold', running: false }, 'loading'],
    [{ sessionId: 'a', openState: 'loading', running: true }, 'loading'],
    [{ sessionId: 'a', openState: 'open', running: false }, 'idle'],
    [{ sessionId: 'a', openState: 'open', running: true }, 'running'],
    [{ sessionId: 'b', openState: 'open', running: false }, 'idle'],
    [{ sessionId: 'b', openState: 'error', running: true, openError: { message: '<private detail>' } }, 'unavailable'],
    [{ sessionId: 'b', openState: 'error', running: true, removed: true }, 'removed'],
    [{ sessionId: 'c', openState: 'open', running: true }, 'running'],
  ];
  for (const [next, expected] of cases) {
    snapshot = next;
    const html = renderToStaticMarkup(createElement(component, { useSession }));
    assert.match(html, new RegExp(`Session: ${expected}`));
    assert.match(html, new RegExp(`data-session-status="${expected}"`));
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /aria-atomic="true"/);
    assert.match(html, /aria-hidden="true"/);
    assert.doesNotMatch(html, /private detail/);
  }
  assert.equal(reads, cases.length);
});
