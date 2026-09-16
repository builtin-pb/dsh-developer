import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { observeDevelopmentReload } from '../lib/development-watch-probe.js'

const deferred = () => Promise.withResolvers()
const entry = (state, disabled = false) => ({ disabled, ...(state === undefined ? {} : { fiber: { state } }) })

function fixture({ entries = [entry(2)], publish, awaitLoader = async () => {} } = {}) {
  const records = [], disposers = [], listeners = new Map()
  const state = { entries, waits: 0, exporter: undefined }
  const ctx = {
    loader: {
      entries: () => state.entries,
      await: () => { state.waits++; return awaitLoader() },
    },
    effect(factory) { disposers.push(factory()) },
    on(name, listener) { listeners.set(name, listener); disposers.push(() => listeners.delete(name)) },
    logger: { exporter(exporter) { state.exporter = exporter; disposers.push(() => { state.exporter = undefined }) } },
  }
  observeDevelopmentReload(ctx, { publish: value => { records.push(value); return publish?.(value) } })
  return { state, ctx, records,
    reload: () => listeners.get('hmr/reload')?.(new Map()),
    log: (name = 'hmr', type = 'warn') => state.exporter?.export({ name, type,
      get args() { assert.fail('log payload must never be read') },
    }),
    dispose: () => disposers.splice(0).reverse().forEach(dispose => dispose()),
  }
}

test('starts with metadata-only counts, excluding disabled entries and treating nonactive states conservatively', () => {
  const f = fixture({ entries: [entry(2), entry(0), entry(1), entry(3), entry(4), entry(undefined), entry(3, true)] })
  assert.deepEqual(f.records, [{ sequence: 1, attempt: 0, warnings: 0, status: 'failed', active: 1, inactive: 5 }])
  assert.equal(f.state.waits, 0, 'caller has already established startup readiness')
  assert.equal(f.state.exporter.levels.hmr, 2, 'native warn level must be enabled')
  assert.equal(f.state.exporter.levels.default, -1, 'unrelated loggers are excluded')
  f.dispose()
})

test('syntax warnings preserve old active counts without claiming that an edit loaded', async () => {
  const pending = deferred()
  const f = fixture({ awaitLoader: () => pending.promise })
  for (const [name, type] of [['other-plugin', 'warn'], ['other-plugin', 'error'], ['hmr', 'info'], ['hmr', 'debug']]) f.log(name, type)
  assert.equal(f.records.length, 1)
  f.log()
  assert.deepEqual(f.records.at(-1), { sequence: 2, attempt: 0, warnings: 1, status: 'warning', active: 1, inactive: 0 })
  f.reload()
  assert.equal(f.records.at(-1).status, 'pending')
  f.log('hmr', 'error')
  pending.resolve()
  await setImmediate()
  assert.deepEqual(f.records.at(-1), { sequence: 4, attempt: 1, warnings: 2, status: 'warning', active: 1, inactive: 0 })
  assert.equal(f.records.length, 4, 'a stale settlement must not clear a later warning')
  f.dispose()
})

test('failed native activation rejects settlement and a later attempt can recover without clearing warning history', async () => {
  const first = deferred(), second = deferred()
  const waits = [first, second]
  const plugin = entry(2)
  const f = fixture({ entries: [plugin], awaitLoader: () => waits.shift().promise })
  f.log()
  f.reload()
  plugin.fiber.state = 3
  first.reject(new Error('PRIVATE_PATH_AND_ERROR_PAYLOAD'))
  await setImmediate()
  assert.deepEqual(f.records.at(-1), { sequence: 4, attempt: 1, warnings: 1, status: 'failed', active: 0, inactive: 1 })
  f.reload()
  plugin.fiber.state = 2
  second.resolve()
  await setImmediate()
  assert.deepEqual(f.records.at(-1), { sequence: 6, attempt: 2, warnings: 1, status: 'settled', active: 1, inactive: 0 })
  assert(!JSON.stringify(f.records).includes('PRIVATE_'))
  f.dispose()
})

test('enumerates after settlement even if the native await resolves despite a failed or newly added entry', async () => {
  const pending = deferred()
  const f = fixture({ awaitLoader: () => pending.promise })
  f.reload()
  f.state.entries.push(entry(3), entry(undefined), entry(0, true))
  pending.resolve()
  await setImmediate()
  assert.deepEqual(f.records.at(-1), { sequence: 3, attempt: 1, warnings: 0, status: 'failed', active: 1, inactive: 2 })
  f.dispose()
})

test('coalesces overlapping attempts with one native wait and prevents an older check publishing for the latest attempt', async () => {
  const first = deferred(), latest = deferred()
  const waits = [first, latest]
  const f = fixture({ awaitLoader: () => waits.shift().promise })
  f.reload()
  f.reload()
  f.reload()
  assert.equal(f.state.waits, 1)
  assert.deepEqual(f.records.map(value => [value.attempt, value.status]), [[0, 'settled'], [1, 'pending'], [2, 'pending'], [3, 'pending']])
  first.resolve()
  await setImmediate()
  assert.equal(f.state.waits, 2)
  assert.equal(f.records.length, 4, 'the old wait is not evidence that the latest attempt settled')
  latest.resolve()
  await setImmediate()
  assert.deepEqual(f.records.at(-1), { sequence: 5, attempt: 3, warnings: 0, status: 'settled', active: 1, inactive: 0 })
  f.dispose()
})

test('a warning cancels queued settlement but a subsequent attempt still recovers', async () => {
  const first = deferred(), recovery = deferred()
  const waits = [first, recovery]
  const f = fixture({ awaitLoader: () => waits.shift().promise })
  f.reload()
  f.reload()
  f.log()
  first.reject(new Error('discarded old failure'))
  await setImmediate()
  assert.equal(f.state.waits, 1, 'the warned-about queued attempt cannot publish a clean settlement')
  assert.equal(f.records.at(-1).status, 'warning')
  f.reload()
  recovery.resolve()
  await setImmediate()
  assert.deepEqual(f.records.at(-1), { sequence: 6, attempt: 3, warnings: 1, status: 'settled', active: 1, inactive: 0 })
  f.dispose()
})

test('disposal suppresses late settlement, queued checks and retained event/exporter callbacks', async () => {
  for (const reject of [false, true]) {
    const pending = deferred()
    const f = fixture({ awaitLoader: () => pending.promise })
    const retainedExporter = f.state.exporter
    f.reload()
    f.reload()
    f.dispose()
    const count = f.records.length
    retainedExporter.export({ name: 'hmr', type: 'warn', get args() { assert.fail('payload accessed') } })
    f.reload()
    if (reject) pending.reject(new Error('disposed failure'))
    else pending.resolve()
    await setImmediate()
    assert.equal(f.records.length, count)
    assert.equal(f.state.waits, 1)
  }
})

test('publisher completion does not gate observation; synchronous and asynchronous publisher errors disclose nothing', async () => {
  const publishing = deferred()
  const f = fixture({ publish: value => {
    if (value.sequence === 1) return publishing.promise
    if (value.status === 'pending') throw new Error('PRIVATE_PUBLISHER_FAILURE')
    return Promise.reject(new Error('PRIVATE_PUBLISHER_REJECTION'))
  } })
  f.reload()
  await setImmediate()
  assert.deepEqual(f.records.map(value => value.status), ['settled', 'pending', 'settled'])
  f.dispose()
  publishing.reject(new Error('PRIVATE_LATE_PUBLISHER_FAILURE'))
  await setImmediate()
  assert.equal(f.records.length, 3)
  assert(!JSON.stringify(f.records).includes('PRIVATE_'))
})

test('inspection and synchronous native settlement errors cannot appear as successful reloads', async () => {
  const broken = entry(2)
  Object.defineProperty(broken, 'disabled', { get() { throw new Error('PRIVATE_CONFIG_EXPRESSION') } })
  const f = fixture({ entries: [entry(2), broken], awaitLoader() { throw new Error('PRIVATE_NATIVE_FAILURE') } })
  assert.equal(f.records[0].inactive, 1)
  f.reload()
  await setImmediate()
  assert.equal(f.records.at(-1).status, 'failed')
  f.ctx.loader.entries = () => { throw new Error('PRIVATE_INSPECTION_FAILURE') }
  f.log()
  assert.deepEqual(f.records.at(-1), { sequence: 4, attempt: 1, warnings: 1, status: 'failed', active: 0, inactive: 0 })
  assert(!JSON.stringify(f.records).includes('PRIVATE_'))
  f.dispose()
})
