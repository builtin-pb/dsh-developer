import assert from 'node:assert/strict'
import test from 'node:test'
import { LIMITS } from '../lib/constants.js'
import { decodeTextTree, encodeTextTree } from '../lib/lab/text-tar.js'

function rewriteChecksum(header) {
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148)
}

function emptyHeader(path, type = '0') {
  const archive = encodeTextTree([{ path: 'placeholder', content: '' }])
  const header = Buffer.from(archive.subarray(0, 512))
  header.fill(0, 0, 100)
  Buffer.from(path, 'utf8').copy(header, 0)
  header[156] = type.charCodeAt(0)
  rewriteChecksum(header)
  return header
}

test('round-trips a deterministic bounded UTF-8 plugin tree', () => {
  const longPrefix = Array.from({ length: 12 }, (_, index) => 'directory-' + index).join('/')
  const entries = [
    { path: 'index.js', content: 'export const answer = 42\n' },
    { path: longPrefix + '/说明.md', content: '# safe\n' },
    { path: 'test/example.test.js', content: '' },
  ]
  const first = encodeTextTree(entries)
  const second = encodeTextTree([...entries].reverse())
  assert.deepEqual(first, second)
  assert.deepEqual(decodeTextTree(first), [...entries].sort((left, right) => left.path.localeCompare(right.path, 'en')))
})

test('rejects links and special files returned by an execution cell', () => {
  const archive = encodeTextTree([{ path: 'link', content: 'target' }])
  archive[156] = '2'.charCodeAt(0)
  rewriteChecksum(archive.subarray(0, 512))
  assert.throws(
    () => decodeTextTree(archive),
    (error) => error.code === 'CELL_ARCHIVE_UNSAFE_TYPE',
  )
})

test('rejects binary output and credential-shaped content', () => {
  const binary = encodeTextTree([{ path: 'value.txt', content: 'safe' }])
  binary[512] = 0xff
  assert.throws(
    () => decodeTextTree(binary),
    (error) => error.code === 'CELL_ARCHIVE_BINARY',
  )
  assert.throws(
    () => encodeTextTree([{ path: 'config.txt', content: 'api_' + 'key=abcdefghijk' }]),
    (error) => error.code === 'SECRET_DETECTED',
  )
})

test('rejects non-UTF-8 ustar path fields instead of renaming them', () => {
  const archive = encodeTextTree([{ path: 'index.js', content: 'safe\n' }])
  archive[0] = 0xff
  rewriteChecksum(archive.subarray(0, 512))
  assert.throws(
    () => decodeTextTree(archive),
    (error) => error.code === 'CELL_ARCHIVE_INVALID' && /non-UTF-8/u.test(error.message),
  )
})

test('accepts a maximum-file-count non-aligned tree within the transfer bound', () => {
  const contentBytes = Math.floor(LIMITS.treeBytes / LIMITS.fileCount) - 1
  const entries = Array.from({ length: LIMITS.fileCount }, (_, index) => ({
    path: 'tree/file-' + String(index).padStart(3, '0') + '.txt',
    content: 'x'.repeat(contentBytes),
  }))
  const archive = encodeTextTree(entries)
  assert.equal(decodeTextTree(archive).length, LIMITS.fileCount)
})

test('does not charge the validated GNU tar root header against the tree-entry limit', () => {
  const directoryCount = LIMITS.treeEntries - LIMITS.fileCount
  const boundedHeaders = [
    emptyHeader('./', '5'),
    ...Array.from({ length: directoryCount }, (_, index) => (
      emptyHeader('directory-' + String(index).padStart(4, '0'), '5')
    )),
    ...Array.from({ length: LIMITS.fileCount }, (_, index) => (
      emptyHeader('file-' + String(index).padStart(4, '0'))
    )),
  ]
  const archive = Buffer.concat([...boundedHeaders, Buffer.alloc(1024)])

  assert.equal(decodeTextTree(archive).length, LIMITS.fileCount)
  const oversized = Buffer.concat([
    ...boundedHeaders,
    emptyHeader('one-entry-too-many', '5'),
    Buffer.alloc(1024),
  ])
  assert.throws(
    () => decodeTextTree(oversized),
    (error) => error.code === 'TOO_MANY_ENTRIES',
  )
  const absoluteRoot = Buffer.concat([
    emptyHeader('/', '5'),
    Buffer.alloc(1024),
  ])
  assert.throws(
    () => decodeTextTree(absoluteRoot),
    (error) => error.code === 'UNSAFE_PATH',
  )
})
