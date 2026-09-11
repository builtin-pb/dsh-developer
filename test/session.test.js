import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'
import { inspectSession, formatSessionReport } from '../lib/session.js'
import { findSecrets } from '../lib/security.js'

// Synthetic DSH format-v3 envelopes for tool diagnostics. Schema references:
// packages/core/session/src/types.ts: TurnEndReasonMap, SurfaceOp, SessionEventMap;
// packages/llm/llm/src/assistant-stream.ts: AssistantStreamRecord.
// No real sessions, configuration files, or installed DSH code are read here.
const header = { type: 'session', version: 3, id: 'session-test', createdAt: 1, cwd: '/unused', isSeeded: false, delegationDepth: 0 }
const event = (type, data, seq = 1) => ({ type, seq, time: 1, data })
const call = (callId, args = { command: 'pwd' }, extra = {}) => event('tool/call', {
  turn: 1, step: 1, callId, name: 'native_example', arguments: JSON.stringify(args), ...extra,
})
const result = (callId, text = 'ok', isError = false, extra = {}) => ({ ...event('tool/result', {
  turn: 1, step: 1, message: { id: `result-${callId}-${extra.turn ?? 1}-${extra.step ?? 1}`, role: 'user', source: { kind: 'tool', callId }, content: [
    { type: 'tool-result', toolCallId: callId, isError, content: [{ type: 'text', text }] },
  ] }, ...extra,
}), surfaceOp: 'append' })
const end = (kind = 'completed', turn = 1) => event('turn/end', { turn, reason: { kind } })
const v3 = (...events) => [header, ...events.map((value, seq) => ({ ...value, seq }))]
const jsonl = (events) => events.map((value) => JSON.stringify(value)).join('\n') + '\n'
const codec = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function'

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'dsh-session-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let counter = 0
  return { root, async write(content, extension = '.jsonl') {
    const path = join(root, `session-${counter++}${extension}`)
    await fs.writeFile(path, Array.isArray(content) ? jsonl(content) : content)
    return path
  } }
}

const limitError = (bound) => (error) => error.code === 'SESSION_LIMIT' && error.details.bound === bound

test('confines native inspection to the selected workspace, including linked parent directories', async (t) => {
  const workspace = await fixture(t)
  const outside = await fixture(t)
  const local = await workspace.write([header, end()])
  const remote = await outside.write([header, end()])
  assert.equal((await inspectSession(local, { sourceRoot: workspace.root })).ok, true)
  await assert.rejects(inspectSession(remote, { sourceRoot: workspace.root }), { code: 'SESSION_OUTSIDE_WORKSPACE' })
  const link = join(workspace.root, 'linked')
  await fs.symlink(outside.root, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inspectSession(join(link, 'session-0.jsonl'), { sourceRoot: workspace.root }), { code: 'SESSION_OUTSIDE_WORKSPACE' })
})

test('rejects parent swaps during resolution, open and read, before returning any outside data', async (t) => {
  for (const phase of ['resolve', 'open', 'opened', 'read']) await t.test(phase, async (t) => {
    const workspace = await fixture(t)
    const outside = await fixture(t)
    const parent = join(workspace.root, 'logs')
    await fs.mkdir(parent)
    const path = join(parent, 'session.jsonl')
    await fs.writeFile(path, jsonl([header, call('inside'), end()]))
    await fs.writeFile(join(outside.root, 'session.jsonl'), jsonl([header, call('outside', { value: 'OUTSIDE_SENTINEL' }), end()]))
    let swapped = false
    async function swap() {
      if (swapped) return
      swapped = true
      await fs.rename(parent, join(workspace.root, 'saved'))
      await fs.symlink(outside.root, parent, process.platform === 'win32' ? 'junction' : 'dir')
    }
    const nativeRealpath = fs.realpath
    const nativeOpen = fs.open
    let reads = 0
    t.mock.method(fs, 'realpath', async (...args) => {
      const physical = await nativeRealpath(...args)
      if (phase === 'resolve' && args[0] === path) await swap()
      return physical
    })
    t.mock.method(fs, 'open', async (...args) => {
      if (phase === 'open') await swap()
      const handle = await nativeOpen(...args)
      if (phase === 'opened') await swap()
      const read = handle.read.bind(handle)
      handle.read = async (...args) => {
        reads++
        const value = await read(...args)
        if (phase === 'read') await swap()
        return value
      }
      return handle
    })
    syncBuiltinESMExports()
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
    await assert.rejects(inspectSession(path, { sourceRoot: workspace.root }), (error) => {
      assert.equal(error.code, 'SESSION_SOURCE_CHANGED')
      assert(!JSON.stringify(error).includes('OUTSIDE_SENTINEL'))
      return true
    })
    assert.equal(swapped, true)
    assert.equal(reads, phase === 'read' ? 1 : 0, 'pre-read swaps must not read even the first byte')
  })
})

test('revalidates parent identity even when physical path and selected file identity stay the same', async (t) => {
  const f = await fixture(t)
  const exports = join(f.root, 'exports')
  await fs.mkdir(exports)
  await fs.writeFile(join(exports, 'session.jsonl'), jsonl([header, end()]))
  const alias = join(f.root, 'current')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await fs.symlink(exports, alias, linkType)
  const path = join(alias, 'session.jsonl')
  const physical = await fs.realpath(path)
  const before = await fs.stat(path)
  const nativeOpen = fs.open
  let swapped = false
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await nativeOpen(...args)
    const read = handle.read.bind(handle)
    handle.read = async (...args) => {
      const value = await read(...args)
      if (!swapped) {
        swapped = true
        await fs.rename(alias, join(f.root, 'saved-alias'))
        await fs.symlink(exports, alias, linkType)
      }
      return value
    }
    return handle
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(inspectSession(path, { sourceRoot: f.root }), { code: 'SESSION_SOURCE_CHANGED' })
  assert.equal(await fs.realpath(path), physical)
  const after = await fs.stat(path)
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key], key)
})

test('supports stable in-workspace aliases and tolerates unrelated parent-directory writes', async (t) => {
  const f = await fixture(t)
  const path = await f.write([header, end()])
  const alias = join(f.root, 'alias')
  await fs.symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const nativeOpen = fs.open
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await nativeOpen(...args)
    const read = handle.read.bind(handle)
    handle.read = async (...args) => {
      await fs.writeFile(join(f.root, 'unrelated'), 'workspace activity')
      return read(...args)
    }
    return handle
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  assert.equal((await inspectSession('session-0.jsonl', { sourceRoot: alias })).completion.state, 'completed')
  assert.equal((await inspectSession(join(alias, 'session-0.jsonl'), { sourceRoot: f.root })).source.sha256,
    createHash('sha256').update(await fs.readFile(path)).digest('hex'))
})

test('rejects a workspace-root alias retargeted after reading the selected file', async (t) => {
  const f = await fixture(t)
  const outside = await fixture(t)
  const path = await f.write([header, end()])
  const alias = join(f.root, 'root-alias')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await fs.symlink(f.root, alias, linkType)
  const nativeOpen = fs.open
  let swapped = false
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await nativeOpen(...args)
    const read = handle.read.bind(handle)
    handle.read = async (...args) => {
      const value = await read(...args)
      if (!swapped) {
        swapped = true
        await fs.rename(alias, join(f.root, 'saved-root-alias'))
        await fs.symlink(outside.root, alias, linkType)
      }
      return value
    }
    return handle
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(inspectSession(path, { sourceRoot: alias }), { code: 'SESSION_SOURCE_CHANGED' })
})

test('reports selected source identity, parsed arguments, canonical results and turn end', async (t) => {
  const f = await fixture(t)
  const events = [header, call('a', { path: '/tmp/demo', options: { recursive: true } }),
    result('a', JSON.stringify({ args: { count: 2 }, result: { exitCode: 0, stdout: 'verified native call' } })), end()]
  const path = await f.write(events)
  const before = await fs.stat(path)
  const report = await inspectSession(path)
  assert.equal(report.kind, 'dsh-session')
  assert.equal(report.source.path, path)
  assert.equal(report.source.sha256, createHash('sha256').update(jsonl(events)).digest('hex'))
  assert.equal(report.source.bytes, Buffer.byteLength(jsonl(events)))
  assert.equal(report.source.version, 3)
  assert.equal(report.source.sessionId, 'session-test')
  assert.equal(report.source.inode, before.ino)
  assert.equal(report.counts.toolCalls, 1)
  assert.equal(report.counts.toolResults, 1)
  assert.equal(report.counts.failedTools, 0)
  assert.deepEqual(report.calls[0].arguments, { path: '/tmp/demo', options: { recursive: true } })
  assert.equal(report.calls[0].name, 'native_example')
  assert.equal(report.calls[0].status, 'succeeded')
  assert.match(report.calls[0].result.summary, /verified native call/u)
  assert.deepEqual(report.completion, { state: 'completed', turn: 1, reason: 'completed', evidence: 'turn/end' })
  assert.equal((await fs.stat(path)).mtimeMs, before.mtimeMs)
  assert.equal(await fs.readFile(path, 'utf8'), jsonl(events))
  const text = formatSessionReport(report)
  for (const expected of [path, report.source.sha256, 'native_example', 'verified native call', 'Calls: 1', 'completed']) assert(text.includes(expected))
})

test('native codec reports first-frame compressed bytes, and 318 concatenated frames are all inspected', { skip: !codec }, async (t) => {
  const f = await fixture(t)
  const events = [header, call('native-1'), ...Array.from({ length: 314 }, () => event('step/end', { turn: 1 })), result('native-1'), end()]
  assert.equal(events.length, 318)
  const frames = events.map((value) => zlib.zstdCompressSync(Buffer.from(jsonl([value]))))
  const bytes = Buffer.concat(frames)
  const first = zlib.zstdDecompressSync(bytes, { info: true, maxOutputLength: 4096 })
  assert.equal(first.engine.bytesWritten, frames[0].length)
  assert.equal(first.buffer.toString(), jsonl([header]))
  const report = await inspectSession(await f.write(bytes, '.jsonl.zstd'))
  assert.equal(report.usage.frames, 318)
  assert.equal(report.usage.decodedBytes, Buffer.byteLength(jsonl(events)))
  assert.equal(report.source.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(report.calls[0].status, 'succeeded')
  assert.equal(report.completion.state, 'completed')
})

test('handles empty frames and lines/UTF-8 split across compressed frames', { skip: !codec }, async (t) => {
  const f = await fixture(t)
  const bytes = Buffer.from(jsonl([header, call('a', { path: '路径' }), result('a'), end()]).trimEnd())
  const cut = bytes.indexOf(Buffer.from('路')) + 1
  const pieces = [Buffer.alloc(0), bytes.subarray(0, 4), bytes.subarray(4, cut), bytes.subarray(cut), Buffer.alloc(0)]
  const compressed = Buffer.concat(pieces.map((piece) => zlib.zstdCompressSync(piece)))
  const report = await inspectSession(await f.write(compressed, '.jsonl.zstd'))
  assert.equal(report.calls[0].arguments.path, '路径')
  assert.equal(report.usage.frames, 5)
  assert.equal(report.completion.state, 'completed')
})

test('rejects every truncated frame boundary, including valid JSON with missing checksum bytes', { skip: !codec }, async (t) => {
  const f = await fixture(t)
  const frame = zlib.zstdCompressSync(Buffer.from(jsonl([header])), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  })
  const path = await f.write('', '.jsonl.zstd')
  for (let n = 0; n < frame.length; n++) {
    await fs.writeFile(path, frame.subarray(0, n))
    await assert.rejects(inspectSession(path), { code: 'SESSION_ZSTD_INVALID' }, `truncation at byte ${n}`)
  }
  const prefix = zlib.zstdCompressSync(Buffer.from(jsonl([header, end()])))
  for (const suffix of [Buffer.from([0xff]), frame.subarray(0, -1), Buffer.from('invalid complete frame')]) {
    await fs.writeFile(path, Buffer.concat([prefix, suffix]))
    await assert.rejects(inspectSession(path), { code: 'SESSION_ZSTD_INVALID' })
  }
  const corrupt = Buffer.from(frame)
  corrupt[corrupt.length - 1] ^= 1
  await fs.writeFile(path, corrupt)
  await assert.rejects(inspectSession(path), { code: 'SESSION_ZSTD_INVALID' })
})

test('rejects malformed complete and truncated JSON and invalid UTF-8 without echoing input', async (t) => {
  const f = await fixture(t)
  const secret = 'sk-' + ['9aBcDeFgHiJk', 'LmNoPqRsTuVw'].join('')
  for (const bad of ['{"type":}\n', '{"type":', `{"secret":"${secret}"`, Buffer.from([0xff, 10])]) {
    const bytes = Buffer.concat([Buffer.from(jsonl([header, end()])), Buffer.from(bad)])
    await assert.rejects(inspectSession(await f.write(bytes)), (error) => {
      assert(['SESSION_JSON_INVALID', 'SESSION_UTF8_INVALID'].includes(error.code))
      assert(!JSON.stringify(error).includes(secret))
      assert(!error.message.includes(secret))
      return true
    })
  }
  const crlf = jsonl([header, call('a'), result('a'), end()]).replaceAll('\n', '\r\n')
  assert.equal((await inspectSession(await f.write(crlf))).counts.toolCalls, 1)
})

test('retains the last requested calls while correlating late, out-of-order and cross-turn results', async (t) => {
  const f = await fixture(t)
  const events = [header, call('old'), result('future', 'arrived before call'), call('b'), call('future'),
    call('b', { turn: 'two' }, { turn: 2 }), result('b', 'second turn', false, { turn: 2 }),
    result('old', 'late evicted call'), result('b', 'first turn'), result('orphan'), end('completed', 2)]
  const path = await f.write(events)
  const report = await inspectSession(path, { limit: 3 })
  assert.deepEqual(report.calls.map((entry) => [entry.callId, entry.turn]), [['b', 1], ['future', 1], ['b', 2]])
  assert.deepEqual(report.calls.map((entry) => entry.result.summary), ['first turn', 'arrived before call', 'second turn'])
  assert.equal(report.counts.toolCalls, 4)
  assert.equal(report.counts.toolResults, 5)
  assert.equal(report.counts.unmatchedResults, 1)
  assert.equal(report.counts.pendingCalls, 0)
  assert.equal(report.omissions.calls, 1)
  const zero = await inspectSession(path, { limit: 0 })
  assert.deepEqual(zero.calls, [])
  assert.equal(zero.counts.toolCalls, 4)
})

test('counts canonical tool failures independently from lifecycle and text containing error words', async (t) => {
  const f = await fixture(t)
  const report = await inspectSession(await f.write([header,
    call('failed'), result('failed', 'permission denied', true),
    call('passed'), result('passed', '0 errors; failure handling verified'), call('pending'), end(),
  ]))
  assert.equal(report.counts.failedTools, 1)
  assert.equal(report.counts.pendingCalls, 1)
  assert.deepEqual(report.calls.map((value) => value.status), ['failed', 'succeeded', 'pending'])
  assert.equal(report.errors[0].summary, 'permission denied')
  assert.equal(report.errors[0].name, 'native_example')
  assert.equal(report.completion.state, 'completed', 'records the observed turn reason, not overall tool success')
  assert.match(formatSessionReport(report), /failed tool results: 1/u)
})

test('duplicates stay ambiguous; a result from another step leaves the call pending and result unmatched', async (t) => {
  const f = await fixture(t)
  const report = await inspectSession(await f.write([header,
    call('duplicate'), call('duplicate'), result('duplicate'),
    call('twice'), result('twice'), result('twice', 'again'),
    call('wrong-step'), result('wrong-step', 'bad step', false, { step: 2 }), end(),
  ]))
  assert.equal(report.counts.duplicateCalls, 1)
  assert.equal(report.counts.duplicateResults, 1)
  assert.equal(report.counts.ambiguousCalls, 3)
  assert.equal(report.counts.pendingCalls, 1)
  assert.equal(report.counts.unmatchedResults, 1)
  assert(report.calls.slice(0, 3).every((value) => value.status === 'ambiguous' && value.result === null))
  assert.equal(report.calls[3].status, 'pending')
  assert.equal(report.calls[3].result, null)
})

test('normalizes public DSH terminal reasons while preserving raw reasons and inspection success', async (t) => {
  const f = await fixture(t)
  const reasons = [
    [{ kind: 'completed' }, 'completed'],
    [{ kind: 'error', error: { code: 'UNKNOWN', message: 'PRIVATE_FAILURE_DETAIL' } }, 'failed'],
    ...['user', 'parent', 'disposed', 'legacy'].map((kind) => [{ kind: 'aborted', reason: { kind } }, 'cancelled']),
    [{ kind: 'aborted', reason: { kind: 'hook', reason: 'PRIVATE_HOOK_DETAIL' } }, 'cancelled'],
    ...['blocked', 'max-tokens', 'interrupted', 'future-reason'].map((kind) => [{ kind }, 'unknown']),
  ]
  for (const [reason, state] of reasons) {
    const events = v3(event('turn/start', { turn: 1 }), event('turn/end', { turn: 1, reason }))
    const report = await inspectSession(await f.write(events))
    assert.equal(report.ok, true)
    assert.deepEqual(report.completion, { state, turn: 1, reason: reason.kind, evidence: 'turn/end' })
    assert(!JSON.stringify(report).includes('PRIVATE_'))
    assert.equal((await inspectSession(await f.write([...events, event('turn/start', { turn: 2 }, 2)]))).completion.state, 'unknown')
  }
})

test('late public title metadata preserves completion without exposing title requests or hiding later activity', async (t) => {
  const f = await fixture(t)
  // packages/session/session-title/src/types.ts and session-title-llm/src/index.ts:
  // both title records are log-only auxiliary work, not another agent turn.
  const title = event('session/title', { title: 'HIDDEN_TITLE', messageSeqs: [], source: { kind: 'user' } })
  const request = event('session/title-llm-request', {
    titleProvider: 'title-test', messageSeqs: [1], route: { provider: 'mock', model: 'mock' },
    system: 'HIDDEN_SYSTEM', maxTokens: 64, messages: [{
      id: 'title-input', role: 'user', source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
      content: [{ type: 'text', text: 'HIDDEN_CONVERSATION' }],
    }],
  })
  const user = event('user/message', { id: 'user-input', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'HIDDEN_USER' }],
  })
  user.surfaceOp = 'append'
  const events = [event('turn/start', { turn: 1 }), user, end(), request, title]
  const report = await inspectSession(await f.write(v3(...events)))
  assert.equal(report.completion.state, 'completed')
  assert.equal(report.counts.ignoredEvents, 3)
  assert(!JSON.stringify(report).includes('HIDDEN_'))
  for (const activity of [event('turn/start', { turn: 2 }), event('future-event', {})]) {
    assert.equal((await inspectSession(await f.write(v3(...events, activity, title)))).completion.state, 'unknown')
  }
  const nested = await inspectSession(await f.write([header, call('title', { value: title }),
    result('title', JSON.stringify({ value: JSON.stringify(request) })), end()]))
  assert(!JSON.stringify(nested).includes('HIDDEN_'))
})

test('correlates public step-scoped call IDs independently, including retained errors and call selection', async (t) => {
  const f = await fixture(t)
  const events = v3(event('turn/start', { turn: 1 }),
    event('step/start', { turn: 1, step: 1 }), call('reused', {}, { name: 'first_tool' }), result('reused', 'first failure', true),
    event('step/end', { turn: 1, step: 1 }), event('step/start', { turn: 1, step: 2 }),
    call('reused', {}, { step: 2, name: 'second_tool' }), result('reused', 'second success', false, { step: 2 }),
    event('step/end', { turn: 1, step: 2 }), end())
  const path = await f.write(events)
  const report = await inspectSession(path)
  assert.deepEqual(report.calls.map((value) => [value.step, value.status, value.result.summary]), [
    [1, 'failed', 'first failure'], [2, 'succeeded', 'second success'],
  ])
  for (const key of ['duplicateCalls', 'duplicateResults', 'ambiguousCalls', 'pendingCalls', 'unmatchedResults']) assert.equal(report.counts[key], 0, key)
  assert.equal(report.errors[0].name, 'first_tool')
  const selected = await inspectSession(path, { limit: 1 })
  assert.equal(selected.calls[0].step, 2)
  assert.equal(selected.calls[0].status, 'succeeded')
  assert.equal(selected.omissions.calls, 1)
  assert.equal(selected.errors[0].name, 'first_tool')
})

test('omits public content-replacement chains without recounting or hiding the original execution', async (t) => {
  const f = await fixture(t)
  const original = result('pruned', 'original failure', true)
  const rewrite = (startSeq) => ({
    ...structuredClone(original), surfaceOp: { op: 'replace', startSeq, endSeq: startSeq }, sourceEventSeqs: [startSeq],
    data: { ...original.data, message: { ...original.data.message,
      content: [{ ...original.data.message.content[0], content: [{ type: 'text', text: 'pruned content' }] }],
    } },
  })
  // A later turn can prune a prior turn's result; data.turn/step and message
  // identity remain unchanged. The second rewrite cites the first rewrite.
  const events = v3(event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 }), call('pruned'), original,
    event('step/end', { turn: 1, step: 1 }), end(), event('turn/start', { turn: 2 }), rewrite(3), rewrite(7), end('completed', 2))
  const report = await inspectSession(await f.write(events))
  assert.equal(report.counts.toolCalls, 1)
  assert.equal(report.counts.toolResults, 1)
  assert.equal(report.counts.failedTools, 1)
  assert.equal(report.counts.duplicateResults, 0)
  assert.equal(report.counts.ambiguousCalls, 0)
  assert.equal(report.counts.ignoredEvents, 2)
  assert.equal(report.calls[0].status, 'failed')
  assert.equal(report.calls[0].result.summary, 'original failure')
  assert.equal(report.errors.length, 1)
  assert.equal(report.completion.state, 'completed')
  assert(report.warnings.some((value) => value.includes('Omitted 2 tool-result content replacements')))
  const malformed = rewrite(3)
  delete malformed.sourceEventSeqs
  const invalid = await inspectSession(await f.write([...events, { ...malformed, seq: 10 }]))
  assert.equal(invalid.counts.unsupportedEnvelopes, 1)
  assert.equal(invalid.counts.toolResults, 1)
})

test('missing end, later activity, missing/future headers and unsupported envelopes stay explicit', async (t) => {
  const f = await fixture(t)
  for (const events of [[header, call('a'), result('a')], [header, end(), event('turn/start', { turn: 2 })],
    [header, end(), event('assistant/message', { content: 'DO_NOT_SHOW' })]]) {
    const report = await inspectSession(await f.write(events))
    assert.equal(report.completion.state, 'unknown')
    assert(!JSON.stringify(report).includes('DO_NOT_SHOW'))
  }
  for (const events of [[call('a'), end()], [{ ...header, version: 999 }, call('a'), end()], []]) {
    const report = await inspectSession(await f.write(events))
    assert.equal(report.completion.state, 'unknown')
    assert.equal(report.counts.toolCalls, 0)
    assert(report.warnings.some((value) => /header/u.test(value)))
  }
  const wrongRole = result('a')
  wrongRole.data.message.role = 'assistant'
  const wrongId = result('a')
  wrongId.data.message.content[0].toolCallId = 'other'
  const unsupported = [event('tool/call', { payload: call('hidden') }), wrongRole, wrongId,
    event('tool/result', { turn: 1, step: 1, callId: 'a', result: 'DO_NOT_SHOW' }), event('turn/end', { turn: 1, reason: 'completed' })]
  const report = await inspectSession(await f.write([header, ...unsupported, { type: 'future', body: 'DO_NOT_SHOW' }, null, 42]))
  assert.equal(report.counts.unsupportedEnvelopes, 5)
  assert.equal(report.counts.unknownEvents, 3)
  assert.equal(report.completion.state, 'unknown')
  assert(!JSON.stringify(report).includes('DO_NOT_SHOW'))
  assert.equal((await inspectSession(await f.write([header, end('new-reason')]))).completion.state, 'unknown')
})

test('invalid argument JSON and non-object arguments are reported without falling back to raw strings', async (t) => {
  const f = await fixture(t)
  for (const args of ['{bad', '[]', 'null', '"raw text"', null, 3]) {
    const report = await inspectSession(await f.write([header, call('a', {}, { arguments: args })]))
    assert.equal(report.counts.invalidArguments, 1)
    assert.equal(report.calls[0].arguments, null)
    assert.equal(report.calls[0].argumentsValid, false)
  }
  const report = await inspectSession(await f.write([header, call('a', {}, { arguments: { count: 3 } })]))
  assert.deepEqual(report.calls[0].arguments, { count: 3 })
})

test('prioritizes native results over echoed args and bounds summaries across many text blocks', async (t) => {
  const f = await fixture(t)
  const manyBlocks = result('blocks')
  manyBlocks.data.message.content[0].content = Array.from({ length: 2000 }, () => ({ type: 'text', text: 'x' }))
  const report = await inspectSession(await f.write([header, call('native'),
    result('native', JSON.stringify({ args: { code: 'x'.repeat(10000) }, result: { exitCode: 7, stderr: 'native failure' } }), true),
    call('blocks'), manyBlocks, end(),
  ]))
  assert.match(report.calls[0].result.summary, /"exitCode":7/u)
  assert.match(report.calls[0].result.summary, /native failure/u)
  assert(!report.calls[0].result.summary.includes('xxxx'))
  assert(report.calls[1].result.summary.length <= report.limits.textChars)
  assert.equal(report.calls[1].result.truncated, true)
})

test('redacts secrets, private-key blocks and private fields without exposing unrelated message bodies', async (t) => {
  const f = await fixture(t)
  const secret = 'sk-' + ['9aBcDeFgHiJk', 'LmNoPqRsTuVw'].join('')
  const privateKey = ['-----BEGIN', 'PRIVATE KEY-----\nKEY_BODY_MUST_DISAPPEAR\n-----END', 'PRIVATE KEY-----'].join(' ')
  const args = { safe: 'keep this', password: 'short', nested: { authorization: 'short auth', systemPrompt: 'HIDDEN_SYSTEM',
    reasoning: 'HIDDEN_REASONING', token: 'tiny', prompt: 'HIDDEN_PROMPT' }, key: secret, pem: privateKey,
    url: 'https://user:short@host.invalid', shell: 'token=short', control: '\u001b[31mhello',
    embedded: { type: 'assistant/message', data: { text: 'HIDDEN_EMBEDDED' } },
    conversation: { role: 'system', content: 'HIDDEN_SYSTEM' },
    afterClip: 'a'.repeat(1020) + secret }
  const mixed = result('a', `useful line\n${secret}\n${privateKey}\nfinished`, true)
  mixed.data.message.content.push({ type: 'text', text: 'HIDDEN_USER' })
  mixed.data.message.content[0].content.push({ type: 'reasoning', text: 'HIDDEN_REASONING' })
  mixed.data.meta = { password: ['HIDDEN', 'META'].join('_') }
  const events = [{ ...header, cwd: 'HIDDEN_CWD', systemPrompt: 'HIDDEN_SYSTEM' },
    ...['assistant/message', 'system/message', 'user/message', 'request/header', 'request/context'].map((type) => event(type, { text: 'HIDDEN_MESSAGE', secret })),
    call('a', args), mixed, call('json'), result('json', JSON.stringify({ stdout: 'retained', password: 'short',
      nested: { messages: ['HIDDEN_MESSAGE'], reasoning_content: 'HIDDEN_REASONING' } })), end()]
  const report = await inspectSession(await f.write(events))
  const text = JSON.stringify(report) + formatSessionReport(report)
  for (const forbidden of [secret, 'KEY_BODY_MUST_DISAPPEAR', 'HIDDEN_', 'short auth', 'token=short', 'user:short@', '\u001b']) assert(!text.includes(forbidden), forbidden)
  assert.match(report.calls[0].result.summary, /useful line/u)
  assert.match(report.calls[0].result.summary, /finished/u)
  assert.equal(report.calls[0].arguments.safe, 'keep this')
  assert.equal(report.calls[0].arguments.password, '[redacted]')
  assert.equal(report.counts.ignoredEvents, 5)
  assert.equal(report.calls[0].result.omittedBlocks, 1)
  assert(findSecrets(secret).length > 0, 'fixture exercises the shared credential detector')
})

test('redacts source identity, tool names, ids, reasons and malicious keys too', async (t) => {
  const f = await fixture(t)
  const secret = 'ghp_' + '1234567890abcdefghijklmnop'
  const path = join(f.root, `${secret}.jsonl`)
  const args = JSON.parse('{"__proto__":{"polluted":true},"constructor":"safe"}')
  args[secret] = 'value'
  await fs.writeFile(path, jsonl([{ ...header, id: secret }, call(secret, args, { name: secret }), result(secret, secret, true), end(secret)]))
  const report = await inspectSession(path)
  assert(!JSON.stringify(report).includes(secret))
  assert(!formatSessionReport(report).includes(secret))
  assert.equal({}.polluted, undefined)
})

test('excludes public conversation and reasoning schemas, including nested serialized envelopes before clipping', async (t) => {
  const f = await fixture(t)
  const reasoning = { type: 'reasoning-chunks', time0: 1, index: 0, dt: [], texts: ['HIDDEN_REASONING'] }
  const user = { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: {
    id: 'user-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'HIDDEN_CONVERSATION' }],
  } }
  const values = [user, event('assistant/attempt', { turn: 1, step: 1, stream: [reasoning] }), reasoning,
    { type: 'reasoning-delta', index: 0, text: 'HIDDEN_REASONING' },
    { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['HIDDEN_CONVERSATION'] },
    { type: 'chunk', time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'HIDDEN_REASONING' } },
  ]
  const events = [header]
  let id = 0
  for (const value of values) {
    let encoded = value
    for (let depth = 0; depth < 4; depth++) {
      events.push(call(`c${id}`, { safe: 'retained', payload: encoded }),
        result(`c${id++}`, JSON.stringify({ exitCode: 0, stdout: encoded })))
      encoded = JSON.stringify(encoded)
    }
  }
  const escaped = JSON.stringify(user).replace('user/message', 'user\\/message').replace('"role"', '"r\\u006fle"')
  events.push(call('escaped', { payload: escaped }), result('escaped', JSON.stringify({ stdout: escaped })))
  // A private envelope beyond the display boundary still withholds the text.
  const late = 'safe prefix '.repeat(100) + JSON.stringify(user)
  events.push(call('late', { payload: late }), result('late', late), end())
  const report = await inspectSession(await f.write(events), { limit: 100 })
  const output = JSON.stringify(report) + formatSessionReport(report)
  assert(!output.includes('HIDDEN_'))
  assert(report.calls.every((value) => value.status === 'succeeded'))
  assert.equal(report.calls[0].arguments.safe, 'retained')
  assert.match(report.calls[0].result.summary, /"exitCode":0/u)
  // Bounded serialized inspection must withhold instead of returning unchecked text.
  let deep = user
  for (let n = 0; n < 12; n++) deep = { nested: deep }
  const bounded = await inspectSession(await f.write([header, call('deep', { payload: JSON.stringify(deep) }),
    result('deep', JSON.stringify({ stdout: JSON.stringify(Array.from({ length: 200 }, () => user)) })), end()]))
  assert(!JSON.stringify(bounded).includes('HIDDEN_'))
})

test('redacts long valid arguments in linear time and scans secrets beyond the display cutoff', async (t) => {
  const f = await fixture(t)
  const secret = 'sk-' + ['9aBcDeFgHiJk', 'LmNoPqRsTuVw'].join('')
  const path = await f.write([header,
    call('letters', { code: 'a'.repeat(200000) }),
    call('whitespace', { code: '\n'.repeat(50000) }),
    call('late-secret', { code: 'a'.repeat(100000) + ' ' + secret }), end()])
  // Isolate the old multi-second event-loop stall so a regression fails promptly.
  const script = `import { inspectSession } from ${JSON.stringify(new URL('../lib/session.js', import.meta.url).href)};
    const r = await inspectSession(${JSON.stringify(path)});
    process.stdout.write(JSON.stringify({ calls: r.counts.toolCalls, secret: JSON.stringify(r).includes(${JSON.stringify(secret)}),
      clipped: r.calls[0].argumentsTruncated, late: r.calls[2].arguments.code }));`
  const output = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2500 }))
  assert.deepEqual(output, { calls: 3, secret: false, clipped: true, late: '[redacted: possible credential]' })
})

test('bounds compressed/plain source, decoded totals, per-frame expansion, lines and events', { skip: !codec }, async (t) => {
  const f = await fixture(t)
  const baseline = await inspectSession(await f.write([header]))
  const limits = baseline.limits
  for (const [extension, bound] of [['.jsonl.zstd', 'compressedBytes'], ['.jsonl', 'decodedBytes']]) {
    const path = await f.write('', extension)
    await fs.truncate(path, limits[bound] + 1)
    await assert.rejects(inspectSession(path), limitError(bound))
  }
  await assert.rejects(inspectSession(await f.write(' '.repeat(limits.lineBytes + 1))), limitError('lineBytes'))
  await assert.rejects(inspectSession(await f.write('\n'.repeat(limits.lines + 1))), limitError('lines'))
  await assert.rejects(inspectSession(await f.write(jsonl([header]) + '{}\n'.repeat(limits.events))), limitError('events'))
  const bomb = zlib.zstdCompressSync(Buffer.alloc(limits.frameBytes + 1, 32))
  await assert.rejects(inspectSession(await f.write(bomb, '.jsonl.zstd')), limitError('frameBytes'))
  const largeWindow = zlib.zstdCompressSync(Buffer.alloc(9 * 1024 * 1024, 32), {
    params: { [zlib.constants.ZSTD_c_windowLog]: 24, [zlib.constants.ZSTD_c_contentSizeFlag]: 0 },
  })
  await assert.rejects(inspectSession(await f.write(largeWindow, '.jsonl.zstd')), limitError('windowBytes'))
  // Long but bounded lines keep the decoded total as the first exhausted bound.
  const chunk = Buffer.from((' '.repeat(128 * 1024 - 1) + '\n').repeat(32))
  const frame = zlib.zstdCompressSync(chunk)
  const total = Buffer.concat(Array.from({ length: 9 }, () => frame))
  await assert.rejects(inspectSession(await f.write(total, '.jsonl.zstd')), limitError('decodedBytes'))
  const empty = zlib.zstdCompressSync(Buffer.alloc(0))
  const exact = await inspectSession(await f.write(Buffer.concat([...Array.from({ length: 8 }, () => frame), empty]), '.jsonl.zstd'))
  assert.equal(exact.usage.decodedBytes, limits.decodedBytes)
  assert.equal(exact.usage.frames, 9)
  await assert.rejects(inspectSession(await f.write(Buffer.concat(Array.from({ length: limits.frames + 1 }, () => empty)), '.jsonl.zstd')), limitError('frames'))
})

test('caps deep/wide argument work, retained errors and both JSON/text output', async (t) => {
  const f = await fixture(t)
  const wide = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`field${n}`, '界'.repeat(1000)]))
  // Keep fixture lines below the line bound while making displayed values large.
  const args = Object.fromEntries(Object.entries(wide).slice(0, 20))
  const events = [header, ...Array.from({ length: 100 }, (_, n) => [call(`c${n}`, args), result(`c${n}`, '界'.repeat(1024), true)]).flat(), end()]
  const report = await inspectSession(await f.write(events), { limit: 100 })
  assert.equal(report.counts.toolCalls, 100)
  assert.equal(report.counts.failedTools, 100)
  assert(report.calls.length > 0 && report.calls.length < 100)
  assert.equal(report.calls.at(-1).callId, 'c99')
  assert(report.calls.every((value) => value.argumentsTruncated))
  assert.equal(report.errors.length, 10)
  assert.equal(report.omissions.errors, 90)
  assert.equal(report.omissions.outputBound, true)
  assert(Buffer.byteLength(JSON.stringify(report)) <= report.limits.outputBytes)
  assert(Buffer.byteLength(formatSessionReport(report)) <= report.limits.outputBytes)
  let deep = { leaf: 'ok' }
  for (let n = 0; n < 500; n++) deep = { child: deep }
  const nested = await inspectSession(await f.write([header, call('deep', deep)]))
  assert.equal(nested.calls[0].argumentsTruncated, true)
})

test('checks cancellation before I/O, during reads, and while processing decoded lines/frames', { skip: !codec }, async (t) => {
  const f = await fixture(t)
  await assert.rejects(inspectSession(join(f.root, 'missing.jsonl'), { signal: AbortSignal.abort() }), { code: 'CANCELLED' })
  const path = await f.write([header])
  const controller = new AbortController()
  const pending = inspectSession(path, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { code: 'CANCELLED' })
  const bytes = Buffer.from(jsonl([header]) + '{}\n'.repeat(20000))
  const compressed = await f.write(zlib.zstdCompressSync(bytes), '.jsonl.zstd')
  for (const source of [await f.write(bytes), compressed]) {
    let checks = 0
    const signal = { get aborted() { return ++checks > 150 } }
    await assert.rejects(inspectSession(source, { signal }), { code: 'CANCELLED' })
    assert(checks > 150, 'cancellation remains observable after reading the source')
  }
  const native = zlib.zstdDecompressSync
  const abort = new AbortController()
  t.mock.method(zlib, 'zstdDecompressSync', (...args) => {
    const decoded = native(...args)
    setImmediate(() => abort.abort())
    return decoded
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(inspectSession(compressed, { signal: abort.signal }), { code: 'CANCELLED' })
})

test('codec unavailability is explicit and does not affect plain JSONL', async (t) => {
  const f = await fixture(t)
  const original = zlib.zstdDecompressSync
  zlib.zstdDecompressSync = undefined
  syncBuiltinESMExports()
  t.after(() => { zlib.zstdDecompressSync = original; syncBuiltinESMExports() })
  await assert.rejects(inspectSession(await f.write(Buffer.from([1]), '.jsonl.zstd')), { code: 'SESSION_CODEC_UNAVAILABLE' })
  assert.equal((await inspectSession(await f.write([header, end()]))).completion.state, 'completed')
})

test('reports an unsupported native info contract instead of guessing compressed offsets', { skip: !codec }, async (t) => {
  const f = await fixture(t)
  const path = await f.write(zlib.zstdCompressSync(Buffer.from(jsonl([header]))), '.jsonl.zstd')
  t.mock.method(zlib, 'zstdDecompressSync', () => ({ buffer: Buffer.from(jsonl([header])), engine: { bytesWritten: 0 } }))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(inspectSession(path), { code: 'SESSION_CODEC_UNAVAILABLE' })
})

test('rejects named pipes without opening or blocking', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t)
  const fifo = join(f.root, 'pipe.jsonl')
  execFileSync('mkfifo', [fifo])
  t.mock.method(fs, 'open', () => { assert.fail('a non-regular file must not be opened') })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(inspectSession(fifo), { code: 'SESSION_SOURCE_INVALID' })
})

test('rejects unsafe inputs, symlinks and non-files; opens only the selected file read-only', async (t) => {
  const f = await fixture(t)
  for (const source of ['', null, 42, [], 'bad\0.jsonl', 'data.js', 'https://host.invalid/file.json']) {
    await assert.rejects(inspectSession(source), { code: 'SESSION_SOURCE_INVALID' })
  }
  const path = await f.write([header])
  for (const limit of [-1, 101, 1.5, NaN, '3', null]) await assert.rejects(inspectSession(path, { limit }), { code: 'SESSION_LIMIT_INVALID' })
  const dir = join(f.root, 'directory.jsonl')
  await fs.mkdir(dir)
  await assert.rejects(inspectSession(dir), { code: 'SESSION_SOURCE_INVALID' })
  const link = join(f.root, 'link.jsonl')
  try {
    await fs.symlink(path, link)
    await assert.rejects(inspectSession(link), { code: 'SESSION_SOURCE_INVALID' })
  } catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error }
  const marker = join(f.root, 'executed')
  await fs.writeFile(join(f.root, 'key'), 'PRIVATE_SIBLING')
  await fs.writeFile(path, jsonl([header, call('a', { code: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')` })]))
  const opened = []
  const nativeOpen = fs.open
  t.mock.method(fs, 'open', async (target, flags, ...rest) => {
    opened.push({ target, flags })
    return nativeOpen(target, flags, ...rest)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const report = await inspectSession(path)
  assert.equal(opened.length, 1)
  assert.equal(opened[0].target, path)
  assert.equal(opened[0].flags & (fsConstants.O_WRONLY | fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC), 0)
  assert(!JSON.stringify(report).includes('PRIVATE_SIBLING'))
  await assert.rejects(fs.access(marker), { code: 'ENOENT' })
})

test('detects source replacement/growth and masks native file error messages', async (t) => {
  const f = await fixture(t)
  const path = await f.write([header])
  const nativeOpen = fs.open
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await nativeOpen(...args)
    const stat = handle.stat.bind(handle)
    handle.stat = async () => { const info = await stat(); info.size++; return info }
    return handle
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await assert.rejects(inspectSession(path), { code: 'SESSION_SOURCE_CHANGED' })
  const secret = 'sk-' + ['9aBcDeFgHiJk', 'LmNoPqRsTuVw'].join('')
  await assert.rejects(inspectSession(join(f.root, `${secret}.jsonl`)), (error) => {
    assert.equal(error.code, 'SESSION_SOURCE_UNREADABLE')
    assert(!error.message.includes(secret))
    assert(!JSON.stringify(error).includes(secret))
    return true
  })
})
