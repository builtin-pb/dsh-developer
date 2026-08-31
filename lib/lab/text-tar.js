import { LIMITS } from '../constants.js'
import { DshDeveloperError } from '../errors.js'
import { assertPortableRelativePath } from '../files.js'
import { assertNoSecrets } from '../security.js'

const BLOCK_BYTES = 512
const TAR_NAME_BYTES = 100
const TAR_PREFIX_BYTES = 155
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true })
export const TEXT_TAR_MAX_BYTES = LIMITS.treeBytes
  + ((LIMITS.treeEntries + LIMITS.fileCount + 20) * BLOCK_BYTES)

function writeString(header, offset, length, value, label) {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.byteLength > length) {
    throw new DshDeveloperError('CELL_ARCHIVE_PATH', label + ' exceeds the ustar field limit.', { value })
  }
  encoded.copy(header, offset)
}

function writeOctal(header, offset, length, value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DshDeveloperError('CELL_ARCHIVE_INVALID', label + ' must be a non-negative safe integer.', { value })
  }
  const octal = value.toString(8)
  if (octal.length > length - 1) {
    throw new DshDeveloperError('CELL_ARCHIVE_INVALID', label + ' exceeds the ustar numeric field.', { value })
  }
  writeString(header, offset, length, octal.padStart(length - 1, '0') + '\0', label)
}

function splitPath(path) {
  if (Buffer.byteLength(path, 'utf8') <= TAR_NAME_BYTES) return { name: path, prefix: '' }
  const boundaries = []
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === '/') boundaries.push(index)
  }
  for (let cursor = boundaries.length - 1; cursor >= 0; cursor -= 1) {
    const index = boundaries[cursor]
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Buffer.byteLength(prefix, 'utf8') <= TAR_PREFIX_BYTES
        && Buffer.byteLength(name, 'utf8') <= TAR_NAME_BYTES) {
      return { name, prefix }
    }
  }
  throw new DshDeveloperError('CELL_ARCHIVE_PATH', 'Portable path cannot be represented by a ustar header.', { path })
}

function checksum(header) {
  let value = 0
  for (const byte of header) value += byte
  return value
}

function fileHeader(path, size) {
  const header = Buffer.alloc(BLOCK_BYTES)
  const { name, prefix } = splitPath(path)
  writeString(header, 0, TAR_NAME_BYTES, name, 'archive name')
  writeOctal(header, 100, 8, path.startsWith('bin/') ? 0o755 : 0o600, 'archive mode')
  writeOctal(header, 108, 8, 0, 'archive uid')
  writeOctal(header, 116, 8, 0, 'archive gid')
  writeOctal(header, 124, 12, size, 'archive size')
  writeOctal(header, 136, 12, 0, 'archive mtime')
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  writeString(header, 257, 6, 'ustar\0', 'archive magic')
  writeString(header, 263, 2, '00', 'archive version')
  writeString(header, 345, TAR_PREFIX_BYTES, prefix, 'archive prefix')
  const value = checksum(header).toString(8).padStart(6, '0')
  writeString(header, 148, 8, value + '\0 ', 'archive checksum')
  return header
}

function validateTextEntries(entries) {
  if (!Array.isArray(entries)) {
    throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Cell archive entries must be an array.')
  }
  const seen = new Set()
  const seenCase = new Set()
  let bytes = 0
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Each cell archive entry must be an object.')
    }
    const path = assertPortableRelativePath(entry.path)
    if (typeof entry.content !== 'string') {
      throw new DshDeveloperError('CELL_ARCHIVE_BINARY', 'Cell archives accept UTF-8 text files only.', { path })
    }
    if (seen.has(path)) throw new DshDeveloperError('CELL_ARCHIVE_DUPLICATE', 'Cell archive repeats a path.', { path })
    const folded = path.toLocaleLowerCase('en-US')
    if (seenCase.has(folded)) {
      throw new DshDeveloperError('CASE_COLLISION', 'Cell archive paths collide by case.', { path })
    }
    seen.add(path)
    seenCase.add(folded)
    const size = Buffer.byteLength(entry.content, 'utf8')
    if (size > LIMITS.fileBytes) {
      throw new DshDeveloperError('FILE_TOO_LARGE', 'Cell archive file exceeds the file limit.', { path })
    }
    bytes += size
    if (bytes > LIMITS.treeBytes) throw new DshDeveloperError('TREE_TOO_LARGE', 'Cell archive exceeds the tree byte limit.')
    if (seen.size > LIMITS.fileCount) throw new DshDeveloperError('TOO_MANY_FILES', 'Cell archive exceeds the file count limit.')
    if (entry.content.includes('\0')) {
      throw new DshDeveloperError('CELL_ARCHIVE_BINARY', 'Cell archive text contains a NUL byte.', { path })
    }
    assertNoSecrets(entry.content, path)
  }
  return [...entries].sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

export function encodeTextTree(entries) {
  const blocks = []
  for (const entry of validateTextEntries(entries)) {
    const content = Buffer.from(entry.content, 'utf8')
    blocks.push(fileHeader(entry.path, content.byteLength), content)
    const remainder = content.byteLength % BLOCK_BYTES
    if (remainder !== 0) blocks.push(Buffer.alloc(BLOCK_BYTES - remainder))
  }
  blocks.push(Buffer.alloc(BLOCK_BYTES * 2))
  const archive = Buffer.concat(blocks)
  if (archive.byteLength > TEXT_TAR_MAX_BYTES) {
    throw new DshDeveloperError('CELL_ARCHIVE_TOO_LARGE', 'Encoded cell archive exceeds its bounded transport limit.')
  }
  return archive
}

function parseOctal(header, offset, length, label) {
  const raw = header.subarray(offset, offset + length).toString('ascii').replace(/[\0 ]+$/u, '')
  if (!/^[0-7]+$/u.test(raw)) {
    throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Invalid ustar ' + label + ' field.', { raw })
  }
  const value = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(value)) {
    throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Ustar ' + label + ' exceeds the safe integer range.')
  }
  return value
}

function readString(header, offset, length) {
  const field = header.subarray(offset, offset + length)
  const end = field.indexOf(0)
  try {
    return FATAL_UTF8.decode(field.subarray(0, end === -1 ? field.length : end))
  } catch {
    throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Ustar header contains a non-UTF-8 text field.')
  }
}

function verifyHeader(header) {
  const expected = parseOctal(header, 148, 8, 'checksum')
  const copy = Buffer.from(header)
  copy.fill(0x20, 148, 156)
  if (checksum(copy) !== expected) {
    throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Ustar header checksum mismatch.')
  }
  if (readString(header, 257, 6) !== 'ustar') {
    throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Cell snapshot is not a ustar archive.')
  }
}

function normalizeEntryPath(raw, directory) {
  if (directory && (raw === '.' || raw === './')) return undefined
  let path = raw
  while (path.startsWith('./')) path = path.slice(2)
  if (directory) path = path.replace(/\/+$/u, '')
  return assertPortableRelativePath(path)
}

function zeroBlock(block) {
  return block.every((value) => value === 0)
}

export function decodeTextTree(value) {
  const archive = Buffer.isBuffer(value) ? value : Buffer.from(value)
  if (archive.byteLength > TEXT_TAR_MAX_BYTES || archive.byteLength % BLOCK_BYTES !== 0) {
    throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Cell snapshot has an invalid bounded archive size.')
  }
  const entries = []
  const seen = new Set()
  const seenCase = new Set()
  let totalBytes = 0
  let treeEntries = 0
  let offset = 0
  let ended = false
  while (offset < archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK_BYTES)
    if (zeroBlock(header)) {
      ended = true
      for (let rest = offset; rest < archive.byteLength; rest += BLOCK_BYTES) {
        if (!zeroBlock(archive.subarray(rest, rest + BLOCK_BYTES))) {
          throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Cell snapshot contains data after its end marker.')
        }
      }
      break
    }
    verifyHeader(header)
    const type = String.fromCharCode(header[156] || 0x30)
    const directory = type === '5'
    if (type !== '0' && !directory) {
      throw new DshDeveloperError('CELL_ARCHIVE_UNSAFE_TYPE', 'Cell snapshot contains a link or special file.', { type })
    }
    const name = readString(header, 0, TAR_NAME_BYTES)
    const prefix = readString(header, 345, TAR_PREFIX_BYTES)
    const path = normalizeEntryPath(prefix.length > 0 ? prefix + '/' + name : name, directory)
    if (path !== undefined) {
      treeEntries += 1
      if (treeEntries > LIMITS.treeEntries) {
        throw new DshDeveloperError('TOO_MANY_ENTRIES', 'Cell snapshot exceeds the tree entry limit.')
      }
    }
    const size = parseOctal(header, 124, 12, 'size')
    if (directory && size !== 0) {
      throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Cell snapshot directory has nonzero content size.', { path })
    }
    const dataStart = offset + BLOCK_BYTES
    const padded = Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES
    const next = dataStart + padded
    if (next > archive.byteLength) {
      throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Cell snapshot entry exceeds the archive boundary.', { path })
    }
    if (!directory) {
      if (path === undefined) throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Cell snapshot file path is empty.')
      if (seen.has(path)) throw new DshDeveloperError('CELL_ARCHIVE_DUPLICATE', 'Cell snapshot repeats a file.', { path })
      const folded = path.toLocaleLowerCase('en-US')
      if (seenCase.has(folded)) throw new DshDeveloperError('CASE_COLLISION', 'Cell snapshot files collide by case.', { path })
      if (size > LIMITS.fileBytes) throw new DshDeveloperError('FILE_TOO_LARGE', 'Cell snapshot file exceeds the file limit.', { path })
      totalBytes += size
      if (totalBytes > LIMITS.treeBytes) throw new DshDeveloperError('TREE_TOO_LARGE', 'Cell snapshot exceeds the tree byte limit.')
      if (entries.length >= LIMITS.fileCount) throw new DshDeveloperError('TOO_MANY_FILES', 'Cell snapshot exceeds the file count limit.')
      const bytes = archive.subarray(dataStart, dataStart + size)
      let content
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new DshDeveloperError('CELL_ARCHIVE_BINARY', 'Cell snapshot contains a binary or non-UTF-8 file.', { path })
      }
      if (content.includes('\0')) throw new DshDeveloperError('CELL_ARCHIVE_BINARY', 'Cell snapshot text contains a NUL byte.', { path })
      assertNoSecrets(content, path)
      seen.add(path)
      seenCase.add(folded)
      entries.push({ path, content })
    }
    offset = next
  }
  if (!ended) throw new DshDeveloperError('CELL_ARCHIVE_INVALID', 'Cell snapshot lacks a ustar end marker.')
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return entries
}
