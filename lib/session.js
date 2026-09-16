import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { setImmediate as yieldTask } from 'node:timers/promises'
import * as zlib from 'node:zlib'
import { DshDeveloperError } from './errors.js'
import { findSecrets, redactSensitiveOutput } from './security.js'

const LIMITS = Object.freeze({
  compressedBytes: 8 * 1024 * 1024, decodedBytes: 32 * 1024 * 1024,
  frameBytes: 4 * 1024 * 1024, windowBytes: 8 * 1024 * 1024, frames: 4096, lineBytes: 256 * 1024,
  lines: 50000, events: 25000, calls: 100, outputBytes: 64 * 1024,
  valueNodes: 128, valueDepth: 6, valueChars: 4096, textChars: 1024,
})
const REDACTED = '[redacted]'
const OMITTED = '[omitted: value limit]'
const PRIVATE_FIELD = /secret|password|passwd|credential|token|authorization|cookie|api.?key|private.?key|reasoning|thinking|analysis|prompt|messages?|instructions?|system|assistant|chain.?of.?thought/iu
// The scheme must start at a word boundary: starting again at each letter of
// a long non-URL string makes the scan quadratic, even before display clipping.
const PRIVATE_TEXT = /<\/?(?:think|analysis|reasoning|system)>|(?:reasoning_content|system_prompt)|(?:^|\n)[^\S\r\n]*(?:system prompt|assistant reasoning|analysis|reasoning)\s*:|\b(?:bearer|basic)\s+\S+|\b(?:password|token|secret|api[_-]?key)\s*[=:]\s*\S+|\b[a-z]+:\/\/[^\s/:]+:[^\s/@]+@/iu
const IGNORED = new Set(['assistant/message', 'assistant/attempt', 'system/message', 'user/message', 'request/header', 'request/context'])
// Auxiliary title work is log-only and can settle after the agent's turn/end.
const TITLE_EVENTS = new Set(['session/title', 'session/title-llm-request'])
const PRIVATE_ROLES = new Set(['assistant', 'system', 'developer', 'user'])
// Public dsh-session event and dsh-llm AssistantStreamRecord/StreamChunk tags.
const PRIVATE_TYPES = new Set([...IGNORED, ...TITLE_EVENTS, 'reasoning', 'thinking', 'analysis',
  'reasoning-start', 'reasoning-delta', 'reasoning-end', 'reasoning-chunks',
  'text-start', 'text-delta', 'text-end', 'text-chunks', 'tool-call-chunks'])
const PRIVATE_ENVELOPE_TEXT = new RegExp(`"role"\\s*:\\s*"(?:${[...PRIVATE_ROLES].join('|')})"|"type"\\s*:\\s*"(?:${[...PRIVATE_TYPES].join('|')})"`, 'iu')
const COMPLETION_STATES = new Map([['completed', 'completed'], ['error', 'failed'], ['aborted', 'cancelled'],
  ['failed', 'failed'], ['cancelled', 'cancelled']])
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value) => Number.isSafeInteger(value) && value >= 0
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512

function fail(code, message, details = {}) {
  throw new DshDeveloperError(code, message, details)
}

function cancelled(signal) {
  if (signal?.aborted) fail('CANCELLED', 'Session inspection was cancelled.')
}

function bounded(bound, value) {
  if (value > LIMITS[bound]) fail('SESSION_LIMIT', 'Session inspection exceeded its work limit.', { bound, max: LIMITS[bound] })
}

function privateEnvelope(value) {
  return PRIVATE_ROLES.has(value.role) || PRIVATE_TYPES.has(value.type)
}

// Tool stdout/arguments can contain JSON encoded inside JSON strings. Inspect
// those schemas before clipping too. Withhold an encoded value if the bounded
// inspection cannot finish; never fall back to its uninspected original text.
function privateSerialized(value) {
  let nodes = 0
  function visit(input, depth) {
    if (++nodes > LIMITS.valueNodes || depth > LIMITS.valueDepth) return true
    if (typeof input === 'string') {
      if (PRIVATE_TEXT.test(input) || PRIVATE_ENVELOPE_TEXT.test(input) || findSecrets(input).length) return true
      if (!['{', '[', '"'].includes(input.trimStart()[0])) return false
      let decoded
      try { decoded = JSON.parse(input) } catch { return false }
      return visit(decoded, depth + 1)
    }
    if (!input || typeof input !== 'object') return false
    if (privateEnvelope(input)) return true
    for (const key of Object.keys(input)) {
      if (PRIVATE_FIELD.test(key) || visit(input[key], depth + 1)) return true
    }
    return false
  }
  return visit(value, 0)
}

// Scan before clipping so credentials crossing the display boundary cannot leak.
// Drop private fields at every level; never traverse arbitrary message envelopes.
function safeText(value, max = LIMITS.textChars) {
  value = redactSensitiveOutput(value)
  if (privateSerialized(value)) return REDACTED
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, ' ').slice(0, max)
    + (value.length > max ? '…[omitted]' : '')
}

function safeValue(value) {
  const budget = { nodes: 0, chars: 0, truncated: false }
  function visit(input, depth) {
    if (++budget.nodes > LIMITS.valueNodes || depth > LIMITS.valueDepth || budget.chars >= LIMITS.valueChars) {
      budget.truncated = true
      return OMITTED
    }
    if (typeof input === 'string') {
      const max = Math.min(LIMITS.textChars, LIMITS.valueChars - budget.chars)
      const output = safeText(input, max)
      budget.chars += output.length
      if (input.length > max) budget.truncated = true
      return output
    }
    if (!input || typeof input !== 'object') return input
    if (privateEnvelope(input)) return REDACTED
    const output = Array.isArray(input) ? [] : {}
    for (const key of Object.keys(input)) {
      if (budget.nodes >= LIMITS.valueNodes || budget.chars >= LIMITS.valueChars) {
        budget.truncated = true
        break
      }
      if (Array.isArray(input)) output.push(visit(input[key], depth + 1))
      else {
        const safeKey = safeText(key, 128)
        if (safeKey !== key) budget.truncated = true
        budget.chars += safeKey.length
        if (PRIVATE_FIELD.test(key)) budget.nodes++
        Object.defineProperty(output, safeKey, { enumerable: true, configurable: true, writable: true,
          value: PRIVATE_FIELD.test(key) ? REDACTED : visit(input[key], depth + 1) })
      }
    }
    return output
  }
  return { value: visit(value, 0), truncated: budget.truncated }
}

function sameFile(a, b) {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
}

async function sourceLocation(path, sourceRoot) {
  const rootPath = resolve(sourceRoot)
  const [root, physical] = await Promise.all([realpath(rootPath), realpath(path)])
  const offset = relative(root, physical)
  if (offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)) {
    fail('SESSION_OUTSIDE_WORKSPACE', 'Select an exported session file inside the current Agent workspace; use the host CLI for another explicit path.')
  }
  const paths = new Set()
  // Include both lexical aliases and their physical ancestors, including root
  // aliases. Directory timestamps are not identities: unrelated writes may
  // change them while the selected export remains stable.
  for (let parent of [rootPath, root, dirname(path), dirname(physical)]) {
    for (;;) {
      paths.add(parent)
      const next = dirname(parent)
      if (next === parent) break
      parent = next
    }
  }
  const parents = await Promise.all([...paths].map(async (parent) => [parent, await lstat(parent)]))
  return { rootPath, root, physical, parents }
}

async function verifyLocation(path, location) {
  if (!location) return
  const [root, physical] = await Promise.all([realpath(location.rootPath), realpath(path)])
  if (root !== location.root || physical !== location.physical) {
    fail('SESSION_SOURCE_CHANGED', 'The selected session location changed during inspection.')
  }
  for (const [parent, before] of location.parents) {
    if (!sameIdentity(before, await lstat(parent))) {
      fail('SESSION_SOURCE_CHANGED', 'A selected session parent changed during inspection.')
    }
  }
}

async function readSource(path, compressed, signal, sourceRoot) {
  let handle
  try {
    cancelled(signal)
    const before = await lstat(path)
    if (!before.isFile()) fail('SESSION_SOURCE_INVALID', 'Select a regular session file, not a directory, device, or symbolic link.')
    const bound = compressed ? 'compressedBytes' : 'decodedBytes'
    bounded(bound, before.size)
    // Capture file identity BEFORE resolving containment, then bind it to both
    // the checked physical path and the actual handle before reading any bytes.
    const location = sourceRoot === undefined ? null : await sourceLocation(path, sourceRoot)
    const readPath = location?.physical ?? path
    if (!sameFile(before, await lstat(readPath))) fail('SESSION_SOURCE_CHANGED', 'The selected session file changed during inspection.')
    await verifyLocation(path, location)
    cancelled(signal)
    handle = await open(readPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    if (!sameFile(before, await handle.stat())) fail('SESSION_SOURCE_CHANGED', 'The selected session file changed during inspection.')
    await verifyLocation(path, location)
    const bytes = Buffer.alloc(before.size)
    for (let offset = 0; offset < bytes.length;) {
      cancelled(signal)
      const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
      if (!bytesRead) fail('SESSION_SOURCE_CHANGED', 'The selected session file changed during inspection.')
      offset += bytesRead
    }
    cancelled(signal)
    if (!sameFile(before, await handle.stat()) || !sameFile(before, await lstat(path))) {
      fail('SESSION_SOURCE_CHANGED', 'The selected session file changed during inspection.')
    }
    await verifyLocation(path, location)
    return { bytes, info: before }
  } catch (error) {
    cancelled(signal)
    if (error instanceof DshDeveloperError) throw error
    // Native error messages can contain a credential-bearing filename.
    fail('SESSION_SOURCE_UNREADABLE', 'The selected session file could not be read.')
  } finally {
    try { await handle?.close() } catch { fail('SESSION_SOURCE_UNREADABLE', 'The selected session file could not be closed.') }
  }
}

async function* decodedChunks(bytes, compressed, usage, signal) {
  if (!compressed) {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      cancelled(signal)
      const chunk = bytes.subarray(offset, offset + 64 * 1024)
      usage.decodedBytes += chunk.length
      yield chunk
      await yieldTask()
    }
    return
  }
  if (typeof zlib.zstdDecompressSync !== 'function') {
    fail('SESSION_CODEC_UNAVAILABLE', 'This Node runtime has no native Zstandard decoder; select a plain .jsonl file or use a Node build with zstdDecompressSync.')
  }
  if (!bytes.length) fail('SESSION_ZSTD_INVALID', 'The compressed session is empty or truncated.')
  // Node 22/24 may silently accept incomplete frames at EOF. A one-byte
  // lookahead forces such a frame to consume beyond the selected file (or
  // throw), while a complete frame stops at its own boundary. This checks
  // completeness without a second decode or a hand-written frame parser.
  const input = Buffer.concat([bytes, Buffer.from([0xff])])
  for (let offset = 0; offset < bytes.length;) {
    cancelled(signal)
    bounded('frames', ++usage.frames)
    const remaining = LIMITS.decodedBytes - usage.decodedBytes
    // Allow trailing empty frames at the exact total cap. A one-byte output
    // probe is necessary because the native API requires a positive limit.
    const outputCap = Math.max(1, Math.min(LIMITS.frameBytes, remaining))
    let result
    try {
      // Native decoding returns ONE frame. bytesWritten is compressed input
      // consumed, not decoded output length. Do not ignore the remaining frames.
      result = zlib.zstdDecompressSync(input.subarray(offset), {
        info: true, maxOutputLength: outputCap,
        // If a frame exactly fills Node's output chunk, Node can continue into
        // the next frame. One byte above the output cap preserves the boundary.
        chunkSize: Math.max(64, outputCap + 1),
        params: { [zlib.constants.ZSTD_d_windowLogMax]: 23 },
      })
    } catch (error) {
      if (error.code === 'ZSTD_error_frameParameter_windowTooLarge') bounded('windowBytes', LIMITS.windowBytes + 1)
      if (error.code === 'ERR_BUFFER_TOO_LARGE') {
        const bound = remaining < LIMITS.frameBytes ? 'decodedBytes' : 'frameBytes'
        bounded(bound, LIMITS[bound] + 1)
      }
      fail('SESSION_ZSTD_INVALID', 'The session contains malformed or truncated Zstandard data.', { frame: usage.frames })
    }
    const consumed = result?.engine?.bytesWritten
    if (!Buffer.isBuffer(result?.buffer) || !Number.isSafeInteger(consumed) || consumed <= 0) {
      fail('SESSION_CODEC_UNAVAILABLE', 'The native Zstandard decoder did not provide a valid first-frame byte count.')
    }
    if (consumed > bytes.length - offset) fail('SESSION_ZSTD_INVALID', 'The session ends in a truncated Zstandard frame.', { frame: usage.frames })
    offset += consumed
    usage.decodedBytes += result.buffer.length
    bounded('decodedBytes', usage.decodedBytes)
    yield result.buffer
    await yieldTask()
  }
}

// Lines can cross frame and UTF-8 boundaries. Decode only complete byte lines,
// and reject a malformed final record rather than silently ignoring it.
async function* jsonLines(chunks, usage, signal) {
  let parts = []
  let length = 0
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  function parse(bytes) {
    bounded('lines', ++usage.lines)
    let text
    try { text = decoder.decode(bytes) } catch { fail('SESSION_UTF8_INVALID', 'The session contains invalid UTF-8.', { line: usage.lines }) }
    if (!text.trim()) return undefined
    bounded('events', ++usage.events)
    try { return JSON.parse(text) } catch { fail('SESSION_JSON_INVALID', 'The session contains malformed or truncated JSON.', { line: usage.lines }) }
  }
  for await (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length;) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      const piece = chunk.subarray(offset, end)
      length += piece.length
      bounded('lineBytes', length)
      parts.push(piece)
      if (newline >= 0) {
        cancelled(signal)
        const event = parse(parts.length === 1 ? parts[0] : Buffer.concat(parts, length))
        parts = []
        length = 0
        if (event !== undefined) yield event
        if (usage.lines % 64 === 0) { await yieldTask(); cancelled(signal) }
      }
      offset = end + 1
    }
  }
  if (length) {
    const event = parse(Buffer.concat(parts, length))
    if (event !== undefined) yield event
  }
}

function resultSummary(block) {
  const texts = []
  let omittedBlocks = 0
  let truncated = false
  let remaining = LIMITS.textChars
  for (const part of block.content) {
    if (!record(part) || part.type !== 'text' || typeof part.text !== 'string') { omittedBlocks++; continue }
    if (!remaining) { truncated = true; continue }
    let text
    try {
      let value = JSON.parse(part.text)
      // Native tools can echo {args, result}; arguments already have a separate
      // diagnostic. Do not let a long echo hide the actual native result.
      if (record(value) && Object.hasOwn(value, 'args') && Object.hasOwn(value, 'result')
          && Object.keys(value).every((key) => key === 'args' || key === 'result')) value = value.result
      const safe = safeValue(value)
      text = JSON.stringify(safe.value)
      truncated ||= safe.truncated
    } catch { text = safeText(part.text) }
    if (!text) continue
    if (texts.length) text = ' ' + text
    texts.push(text.slice(0, remaining))
    truncated ||= text.length > remaining || part.text.length > LIMITS.textChars
    remaining -= Math.min(remaining, text.length)
  }
  return { isError: block.isError, summary: texts.join(''), omittedBlocks, truncated }
}

// Verified against public @deepseek-ai/dsh-tool-{bash,pwsh} and their
// persistent variants, 0.1.5-rc.2. The agent loop logs rendered content, not
// the canonical ShellRunResult. Only interpret these terminal markers, before
// display clipping; JSON exitCode fields and generic job output are not evidence.
function shellProcessOutcome(block) {
  if (block.isError || block.content.length !== 1) return undefined
  const part = block.content[0]
  if (!record(part) || part.type !== 'text' || typeof part.text !== 'string') return undefined
  let text = part.text
  let tool
  for (const name of ['bash', 'pwsh']) {
    const reset = `\nThe persistent ${name} shell was reset; the next ${name} call starts from the workspace with a fresh current directory and environment.`
    if (text.endsWith(reset)) { tool = name; text = text.slice(0, -reset.length); break }
  }
  const last = text.slice(text.lastIndexOf('\n') + 1)
  const previous = text.slice(0, Math.max(0, text.lastIndexOf('\n')))
  const outcome = { evidence: 'dsh-shell-rendered-status' }
  if (tool && /^Your command timed out after \d+ seconds or experienced an OOM error\. Below is partial output:\n/u.test(text)
      && (tool === 'pwsh' || last === '[Command timed out or OOM]')) {
    return { tool, outcome: { ...outcome, kind: 'timeout-or-oom' } }
  }
  let match
  if (tool && (match = /^\[shell exited: code (-?\d+)\]$/u.exec(last))) {
    outcome.kind = 'shell-exited'
    outcome.exitCode = Number(match[1])
  } else if (tool && (match = /^\[shell killed by signal: (SIG[A-Z0-9]{1,32})\]$/u.exec(last))) {
    outcome.kind = 'signal'
    outcome.signal = match[1]
  } else if (!tool && (match = /^\[Command finished with exit code (-?\d+)\]$/u.exec(last))) {
    tool = 'bash'
    outcome.kind = 'nonzero-exit'
    outcome.exitCode = Number(match[1])
  } else if (!tool && (match = /^\[exit code: (-?\d+)\]$/u.exec(last))) {
    // Persistent PowerShell can return a marker without any preceding output.
    if (!text.includes('\n')) tool = 'pwsh'
    outcome.kind = 'nonzero-exit'
    outcome.exitCode = Number(match[1])
  } else if (!tool && text.includes('\n') && (match = /^\[killed by signal: (SIG[A-Z0-9]{1,32})\]$/u.exec(last))) {
    outcome.kind = 'signal'
    outcome.signal = match[1]
  }
  if (!tool) {
    const timeout = /^\[timed out after (\d+(?:\.\d+)?)ms\]$/u.exec(outcome.kind ? previous.slice(previous.lastIndexOf('\n') + 1) : last)
    if (timeout && Number(timeout[1]) > 0 && Number(timeout[1]) <= Number.MAX_SAFE_INTEGER) {
      outcome.kind = 'timeout'
      outcome.timeoutMs = Number(timeout[1])
    }
  }
  if (!outcome.kind || (Object.hasOwn(outcome, 'exitCode') && !Number.isSafeInteger(outcome.exitCode))
      || (['nonzero-exit', 'shell-exited'].includes(outcome.kind) && outcome.exitCode === 0)) return undefined
  return { tool, outcome }
}

/** Inspect only the selected regular .jsonl / .jsonl.zstd file. Format v3 is
 * supported. limit (0..100, default 20) selects recent calls, not scan depth.
 * Hard input/work bounds reject with SESSION_LIMIT; display omissions are
 * explicit. Cancellation yields between read chunks, frames and 64 lines;
 * an individual bounded synchronous decode / JSON parse cannot be interrupted.
 * sourceRoot verifies containment, file identity and stable parent/path samples
 * before and after reading. Portable Node path operations are not an atomic
 * adversarial filesystem boundary; hostile concurrent filesystem writers need
 * OS-enforced confinement (or host CLI selection instead of native inspection).
 */
export async function inspectSession(source, { signal, limit = 20, sourceRoot } = {}) {
  cancelled(signal)
  if (typeof source !== 'string' || !source || source.includes('\0') || source.length > 4096
      || !/\.jsonl(?:\.zstd)?$/u.test(source)) {
    fail('SESSION_SOURCE_INVALID', 'Select a .jsonl or .jsonl.zstd session path.')
  }
  if (!integer(limit) || limit > LIMITS.calls) fail('SESSION_LIMIT_INVALID', 'limit must be an integer from 0 through 100.')
  const path = resolve(sourceRoot ?? process.cwd(), source)
  const compressed = path.endsWith('.zstd')
  const { bytes, info } = await readSource(path, compressed, signal, sourceRoot)
  const usage = { readBytes: bytes.length, decodedBytes: 0, frames: 0, lines: 0, events: 0 }
  const counts = { toolCalls: 0, toolResults: 0, failedTools: 0, processFailures: 0, turnEnds: 0, pendingCalls: 0,
    unmatchedResults: 0, duplicateCalls: 0, duplicateResults: 0, unknownEvents: 0, ignoredEvents: 0,
    unsupportedEnvelopes: 0, invalidArguments: 0, ambiguousCalls: 0 }
  const report = {
    kind: 'dsh-session', ok: true, source: { path: path.split(/([/\\])/u).map((part) => safeText(part, 4096)).join(''), sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length, device: info.dev, inode: info.ino, modifiedMs: info.mtimeMs,
      encoding: compressed ? 'jsonl.zstd' : 'jsonl', version: null, sessionId: null },
    counts, completion: { state: 'unknown', turn: null, reason: null, evidence: null },
    calls: [], errors: [], processFailures: [], warnings: [], omissions: { calls: 0, errors: 0, processFailures: 0, outputBound: false },
    limits: { ...LIMITS, selectedCalls: limit }, usage,
  }
  const entries = new Map()
  const recent = []
  const errorSamples = []
  let supported = false
  let headerSeen = false
  let lastEnd = null
  let lastActivity = 0
  let resultReplacements = 0
  function entry(turn, step, callId) {
    const key = JSON.stringify([turn, step, callId])
    if (!entries.has(key)) entries.set(key, { turn, step, callId: safeText(callId), calls: 0, results: 0, result: null })
    return entries.get(key)
  }
  for await (const event of jsonLines(decodedChunks(bytes, compressed, usage, signal), usage, signal)) {
    cancelled(signal)
    if (!record(event)) { counts.unknownEvents++; lastActivity = usage.events; continue }
    if (usage.events === 1 && event.type === 'session') {
      headerSeen = true
      report.source.version = integer(event.version) ? event.version : null
      report.source.sessionId = identifier(event.id) ? safeText(event.id) : null
      supported = event.version === 3 && identifier(event.id)
      if (!supported) report.warnings.push('Unsupported session header; only format version 3 envelopes are summarized.')
      continue
    }
    // Never inspect the bodies of these events, even on an unsupported version.
    if (TITLE_EVENTS.has(event.type)) { counts.ignoredEvents++; continue }
    if (IGNORED.has(event.type)) { counts.ignoredEvents++; lastActivity = usage.events; continue }
    const data = event.data
    if (!supported || !['tool/call', 'tool/result', 'turn/end'].includes(event.type)) {
      counts.unknownEvents++
      lastActivity = usage.events
      continue
    }
    if (!record(data) || !integer(event.seq) || !integer(data.turn)) {
      counts.unsupportedEnvelopes++; lastActivity = usage.events; continue
    }
    if (event.type === 'turn/end') {
      if (!record(data.reason) || !identifier(data.reason.kind)) { counts.unsupportedEnvelopes++; lastActivity = usage.events; continue }
      counts.turnEnds++
      lastEnd = { turn: data.turn, reason: safeText(data.reason.kind), event: usage.events }
      continue
    }
    lastActivity = usage.events
    if (!integer(data.step)) { counts.unsupportedEnvelopes++; continue }
    if (event.type === 'tool/call') {
      if (!identifier(data.callId) || !identifier(data.name)) { counts.unsupportedEnvelopes++; continue }
      counts.toolCalls++
      const item = entry(data.turn, data.step, data.callId)
      if (++item.calls > 1) counts.duplicateCalls++
      item.name = safeText(data.name)
      let args = data.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = null } }
      if (!record(args)) { counts.invalidArguments++; args = null }
      item.shell = ['bash', 'pwsh'].includes(data.name) && typeof args?.command === 'string'
        && args.command.trim().length > 0 && (args.run_in_background === undefined || args.run_in_background === false)
      if (item.shell) item.command = safeText(args.command)
      const safe = safeValue(args)
      const call = { callId: item.callId, name: item.name, turn: data.turn, step: data.step, seq: event.seq,
        arguments: safe.value, argumentsTruncated: safe.truncated, argumentsValid: args !== null,
        status: 'pending', result: null }
      recent.push({ item, call })
      if (recent.length > limit) recent.shift()
    } else {
      // Surface rewrites (e.g. DSH's result pruner) change model-facing content,
      // not execution outcomes. Keep the original diagnostic and explicitly
      // omit rewrites instead of inventing duplicate calls or failures.
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') {
        const op = event.surfaceOp
        if (record(op) && op.op === 'replace' && integer(op.startSeq) && op.startSeq === op.endSeq
            && op.startSeq < event.seq && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.includes(op.startSeq)) {
          counts.ignoredEvents++
          resultReplacements++
        } else counts.unsupportedEnvelopes++
        continue
      }
      const message = data.message
      const source = message?.source
      const blocks = message?.content
      // DSH tool results have role=user. Only canonical tool-result blocks are
      // summarized, never neighboring user text, metadata, or reasoning blocks.
      if (!record(message) || message.role !== 'user' || !record(source) || source.kind !== 'tool'
          || !identifier(source.callId) || !Array.isArray(blocks)) { counts.unsupportedEnvelopes++; continue }
      const canonical = blocks.filter((block) => record(block) && block.type === 'tool-result')
      if (canonical.length !== 1 || canonical[0].toolCallId !== source.callId
          || typeof canonical[0].isError !== 'boolean' || !Array.isArray(canonical[0].content)) {
        counts.unsupportedEnvelopes++; continue
      }
      counts.toolResults++
      const item = entry(data.turn, data.step, source.callId)
      if (++item.results > 1) counts.duplicateResults++
      item.result = resultSummary(canonical[0])
      item.processCandidate = shellProcessOutcome(canonical[0])
      item.resultSeq = event.seq
      item.resultOrder = usage.events
      if (item.result.isError) {
        counts.failedTools++
        errorSamples.push({ item, seq: event.seq, result: item.result })
        if (errorSamples.length > 10) { errorSamples.shift(); report.omissions.errors++ }
      }
    }
  }
  cancelled(signal)
  report.errors = errorSamples.map(({ item, seq, result }) => ({ callId: item.callId, name: item.name ?? null,
    turn: item.turn, seq, summary: result.summary, truncated: result.truncated }))
  if (!headerSeen) report.warnings.push('No supported session header was found; event bodies were not summarized.')
  const processSamples = []
  for (const item of entries.values()) {
    if (!item.results) counts.pendingCalls += item.calls
    if (!item.calls) counts.unmatchedResults += item.results
    if (item.calls > 1 || item.results > 1) counts.ambiguousCalls += item.calls
    const candidate = item.processCandidate
    // Resolve after the complete scan: duplicate identities, results before
    // calls and pruned replacements must not invent an attributed process exit.
    if (item.calls !== 1 || item.results !== 1 || !item.shell || !candidate
        || (candidate.tool !== undefined && candidate.tool !== item.name)) continue
    item.result.process = candidate.outcome
    counts.processFailures++
    processSamples.push(item)
    processSamples.sort((a, b) => a.resultOrder - b.resultOrder)
    if (processSamples.length > 10) { processSamples.shift(); report.omissions.processFailures++ }
  }
  report.processFailures = processSamples.map(item => ({ callId: item.callId, name: item.name,
    turn: item.turn, step: item.step, seq: item.resultSeq, command: item.command,
    ...item.result.process, summary: item.result.summary, truncated: item.result.truncated }))
  for (const { item, call } of recent) {
    const ambiguous = item.calls > 1 || item.results > 1
    call.status = ambiguous ? 'ambiguous' : !item.result ? 'pending' : item.result.isError ? 'failed' : 'succeeded'
    call.result = ambiguous ? null : item.result
    report.calls.push(call)
  }
  if (lastEnd) {
    const settled = lastEnd.event > lastActivity
    report.completion = { state: settled ? COMPLETION_STATES.get(lastEnd.reason) ?? 'unknown' : 'unknown',
      turn: lastEnd.turn, reason: lastEnd.reason, evidence: 'turn/end' }
    if (!settled) report.warnings.push('Events follow the last turn/end; current completion is unknown.')
  } else report.warnings.push('No supported turn/end was observed; completion is unknown.')
  if (counts.unknownEvents || counts.unsupportedEnvelopes) report.warnings.push('Unknown events and unsupported envelopes were counted without summarizing their bodies.')
  if (counts.ambiguousCalls) report.warnings.push('Duplicate identities within the same turn and step make call/result correlation ambiguous.')
  if (resultReplacements) report.warnings.push(`Omitted ${resultReplacements} tool-result content replacements; execution counts and summaries use original results.`)
  report.omissions.calls = counts.toolCalls - report.calls.length
  while (Buffer.byteLength(JSON.stringify(report)) > LIMITS.outputBytes) {
    report.omissions.outputBound = true
    if (report.calls.length) { report.calls.shift(); report.omissions.calls++ }
    else if (report.errors.length) { report.errors.shift(); report.omissions.errors++ }
    else if (report.processFailures.length) { report.processFailures.shift(); report.omissions.processFailures++ }
    else fail('SESSION_LIMIT', 'Session report exceeded its output limit.', { bound: 'outputBytes', max: LIMITS.outputBytes })
  }
  return report
}

/** Format an inspectSession report; keep both JSON and text diagnostics bounded. */
export function formatSessionReport(report) {
  const lines = [
    `DSH session: ${report.source.path}`,
    `Source: ${report.source.bytes} bytes, ${report.source.encoding}, format ${report.source.version ?? 'unknown'}, session ${report.source.sessionId ?? 'unknown'}`,
    `SHA-256: ${report.source.sha256}`,
    `Last observed turn: ${report.completion.state} (turn/end reason: ${report.completion.reason ?? 'not observed'})`,
    `Calls: ${report.counts.toolCalls}; results: ${report.counts.toolResults}; failed tool results: ${report.counts.failedTools}; pending: ${report.counts.pendingCalls}; unmatched results: ${report.counts.unmatchedResults}; ambiguous calls: ${report.counts.ambiguousCalls}`,
    `Shell process failure/interruption observations: ${report.counts.processFailures}`,
    `Events: ${report.usage.events}; unknown: ${report.counts.unknownEvents}; unsupported envelopes: ${report.counts.unsupportedEnvelopes}; ignored events: ${report.counts.ignoredEvents}`,
  ]
  for (const call of report.calls) {
    lines.push(`- ${call.name} [${call.callId}] turn ${call.turn}, step ${call.step}: ${call.status}${call.result?.process ? ' (tool envelope); process ' + call.result.process.kind : ''}`)
    lines.push(`  Arguments: ${call.argumentsValid ? JSON.stringify(call.arguments) : '(invalid JSON argument object)'}${call.argumentsTruncated ? ' [truncated]' : ''}`)
    if (call.result) lines.push(`  Result: ${call.result.summary || '(no supported text)'}${call.result.truncated ? ' [truncated]' : ''}${call.result.omittedBlocks ? ' [unsupported blocks omitted]' : ''}`)
  }
  for (const error of report.errors) lines.push(`Error ${error.name ?? '(unmatched tool)'} [${error.callId}]: ${error.summary || '(no supported text)'}${error.truncated ? ' [truncated]' : ''}`)
  for (const failure of report.processFailures) {
    const status = failure.kind + (failure.exitCode === undefined ? '' : `; exit code ${failure.exitCode}`)
      + (failure.signal === undefined ? '' : `; signal ${failure.signal}`)
      + (failure.timeoutMs === undefined ? '' : `; timeout ${failure.timeoutMs}ms`)
    lines.push(`Process ${failure.name} [${failure.callId}] turn ${failure.turn}, step ${failure.step}: ${status}`)
    lines.push(`  Command: ${failure.command}`)
    lines.push(`  Result: ${failure.summary || '(no supported text)'}${failure.truncated ? ' [truncated]' : ''}`)
  }
  if (report.omissions.calls || report.omissions.errors || report.omissions.processFailures) lines.push(`Omitted: ${report.omissions.calls} calls, ${report.omissions.errors} error samples, ${report.omissions.processFailures} process samples${report.omissions.outputBound ? ' (output bound)' : ''}. Counts cover all scanned supported events.`)
  for (const warning of report.warnings) lines.push(`Note: ${warning}`)
  const text = lines.join('\n')
  if (Buffer.byteLength(text) <= LIMITS.outputBytes) return text
  // This is a display bound, never a claim that unread source was validated.
  return Buffer.from(text).subarray(0, LIMITS.outputBytes - 64).toString('utf8') + '\n[Report text truncated at output limit]'
}
