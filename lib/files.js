import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { LIMITS } from './constants.js'
import { DshDeveloperError } from './errors.js'
import { assertNoSecrets } from './security.js'

const SKIPPED_METADATA_DIRECTORIES = new Set(['.git', '.hg', '.svn'])
const FORBIDDEN_DIRECTORIES = new Set(['node_modules', 'vendor', '.aws', '.dsh', '.gnupg', '.ssh'])
const FORBIDDEN_FILES = new Set(['.npmrc', '.pypirc', '.netrc', '_netrc', 'id_rsa', 'id_ed25519'])
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

function sameFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
}

function pathError(message, path) {
  throw new DshDeveloperError('UNSAFE_PATH', message, { path })
}

function assertActive(signal, message = 'Filesystem operation was cancelled.') {
  if (signal?.aborted) throw new DshDeveloperError('CANCELLED', message)
}

function forbiddenConfigFile(name) {
  const lower = name.toLocaleLowerCase('en-US')
  return lower === '.env'
    || lower.startsWith('.env.')
    || FORBIDDEN_FILES.has(lower)
    || lower === 'credentials'
    || lower.startsWith('credentials.')
}

export function assertPortableRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0) pathError('Generated file path must not be empty.', path)
  if (path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/u.test(path)) {
    pathError('Generated file path must be relative and use forward slashes.', path)
  }
  const encoded = Buffer.byteLength(path, 'utf8')
  if (encoded > LIMITS.pathBytes) pathError('Generated file path exceeds the portable length limit.', path)
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      pathError('Generated file path contains an unsafe segment.', path)
    }
    if (/[\0-\x1F<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment) || WINDOWS_RESERVED.test(segment)) {
      pathError('Generated file path is not portable across supported filesystems.', path)
    }
  }
  return path
}

function relativePath(root, absolute) {
  const result = relative(root, absolute).split(sep).join('/')
  return assertPortableRelativePath(result)
}

async function readOrdinaryFile(path, before, signal) {
  assertActive(signal, 'Plugin tree snapshot was cancelled.')
  const handle = await open(path, 'r')
  let buffer
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new DshDeveloperError('MUTABLE_TREE', 'A file changed while the source tree was scanned.', { path })
    }
    if (opened.size > LIMITS.fileBytes) {
      throw new DshDeveloperError('FILE_TOO_LARGE', 'File exceeds ' + LIMITS.fileBytes + ' bytes.', { path })
    }
    buffer = await handle.readFile()
    assertActive(signal, 'Plugin tree snapshot was cancelled.')
    const afterRead = await handle.stat()
    if (!sameFile(opened, afterRead)) {
      throw new DshDeveloperError('MUTABLE_TREE', 'A file changed while the source tree was read.', { path })
    }
  } finally {
    await handle.close()
  }
  const after = await lstat(path)
  if (!sameFile(before, after)) {
    throw new DshDeveloperError('MUTABLE_TREE', 'A file changed before the source snapshot was sealed.', { path })
  }
  return buffer
}

async function scanTreeOnce(root, signal) {
  const entries = []
  const seenCase = new Map()
  let bytes = 0
  let treeEntries = 0

  async function visit(directory) {
    assertActive(signal, 'Plugin tree snapshot was cancelled.')
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      assertActive(signal, 'Plugin tree snapshot was cancelled.')
      treeEntries += 1
      if (treeEntries > LIMITS.treeEntries) {
        throw new DshDeveloperError('TOO_MANY_ENTRIES', 'Plugin tree exceeds ' + LIMITS.treeEntries + ' files and directories.')
      }
      const absolute = join(directory, child.name)
      const path = relativePath(root, absolute)
      const folded = path.toLocaleLowerCase('en-US')
      if (seenCase.has(folded)) {
        throw new DshDeveloperError(
          'CASE_COLLISION',
          'Portable paths collide by case: "' + seenCase.get(folded) + '" and "' + path + '".',
          { paths: [seenCase.get(folded), path] },
        )
      }
      seenCase.set(folded, path)

      const info = await lstat(absolute)
      if (info.isSymbolicLink()) {
        throw new DshDeveloperError('UNSAFE_LINK', 'Links are not accepted in plugin trees.', { path })
      }
      if (info.isDirectory()) {
        if (SKIPPED_METADATA_DIRECTORIES.has(child.name)) continue
        if (FORBIDDEN_DIRECTORIES.has(child.name)) {
          throw new DshDeveloperError(
            'FORBIDDEN_TREE',
            'Dependency or vendor directory "' + path + '" must not be part of the snapshot.',
            { path },
          )
        }
        await visit(absolute)
        continue
      }
      if (!info.isFile()) {
        throw new DshDeveloperError('UNSAFE_SPECIAL_FILE', 'Only ordinary files are accepted.', { path })
      }
      if (forbiddenConfigFile(child.name)) {
        throw new DshDeveloperError('FORBIDDEN_CONFIG', 'Credential-bearing config file "' + path + '" is not accepted.', { path })
      }
      if (entries.length >= LIMITS.fileCount) {
        throw new DshDeveloperError('TOO_MANY_FILES', 'Plugin tree exceeds ' + LIMITS.fileCount + ' files.', { path })
      }
      const buffer = await readOrdinaryFile(absolute, info, signal)
      bytes += buffer.byteLength
      if (bytes > LIMITS.treeBytes) {
        throw new DshDeveloperError('TREE_TOO_LARGE', 'Plugin tree exceeds ' + LIMITS.treeBytes + ' bytes.', { path })
      }
      let content
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        throw new DshDeveloperError('BINARY_FILE', 'Binary or non-UTF-8 file "' + path + '" is not accepted.', { path })
      }
      if (content.includes('\0')) {
        throw new DshDeveloperError('BINARY_FILE', 'NUL byte found in "' + path + '".', { path })
      }
      assertNoSecrets(content, path)
      entries.push({
        path,
        bytes: buffer.byteLength,
        digest: createHash('sha256').update(buffer).digest('hex'),
        content,
      })
    }
  }

  await visit(root)
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry.path, 'utf8')
    hash.update('\0')
    hash.update(String(entry.bytes), 'utf8')
    hash.update('\0')
    hash.update(entry.content, 'utf8')
    hash.update('\0')
  }
  return {
    entries,
    fileCount: entries.length,
    treeEntries,
    bytes,
    fingerprint: 'sha256:' + hash.digest('hex'),
  }
}

export async function scanOrdinaryTree(root, options = {}) {
  assertActive(options.signal, 'Plugin tree snapshot was cancelled.')
  const absoluteRoot = resolve(root)
  const rootInfo = await lstat(absoluteRoot).catch((error) => {
    throw new DshDeveloperError('SOURCE_UNAVAILABLE', 'Cannot inspect plugin tree: ' + error.message, { path: absoluteRoot })
  })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new DshDeveloperError('UNSAFE_SOURCE', 'Plugin source must be an ordinary directory.', { path: absoluteRoot })
  }
  const first = await scanTreeOnce(absoluteRoot, options.signal)
  const second = await scanTreeOnce(absoluteRoot, options.signal)
  if (first.fingerprint !== second.fingerprint) {
    throw new DshDeveloperError('MUTABLE_TREE', 'Plugin tree changed while its snapshot was acquired.', { path: absoluteRoot })
  }
  return { root: absoluteRoot, ...second }
}

export function mapTreeEntries(tree) {
  return new Map(tree.entries.map((entry) => [entry.path, entry.content]))
}

export function fingerprintFileMap(files) {
  const paths = [...files.keys()].sort((left, right) => left.localeCompare(right, 'en'))
  const hash = createHash('sha256')
  for (const path of paths) {
    assertPortableRelativePath(path)
    const content = files.get(path)
    if (typeof content !== 'string') {
      throw new DshDeveloperError('INVALID_GENERATED_FILE', 'Generated file "' + path + '" is not text.', { path })
    }
    hash.update(path, 'utf8')
    hash.update('\0')
    hash.update(String(Buffer.byteLength(content, 'utf8')), 'utf8')
    hash.update('\0')
    hash.update(content, 'utf8')
    hash.update('\0')
  }
  return 'sha256:' + hash.digest('hex')
}

export async function writeFilesExclusive(root, files, options = {}) {
  const paths = [...files.keys()].sort((left, right) => left.localeCompare(right, 'en'))
  const folded = new Set()
  for (const path of paths) {
    assertActive(options.signal, 'Candidate materialization was cancelled.')
    assertPortableRelativePath(path)
    const lower = path.toLocaleLowerCase('en-US')
    if (folded.has(lower)) {
      throw new DshDeveloperError('CASE_COLLISION', 'Generated paths collide by case.', { path })
    }
    folded.add(lower)
    const content = files.get(path)
    if (typeof content !== 'string') {
      throw new DshDeveloperError('INVALID_GENERATED_FILE', 'Generated file "' + path + '" is not text.', { path })
    }
    if (Buffer.byteLength(content, 'utf8') > LIMITS.fileBytes) {
      throw new DshDeveloperError('FILE_TOO_LARGE', 'Generated file "' + path + '" exceeds the file limit.', { path })
    }
    assertNoSecrets(content, path)
  }

  for (const path of paths) {
    assertActive(options.signal, 'Candidate materialization was cancelled.')
    const absolute = join(root, ...path.split('/'))
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
    const handle = await open(absolute, 'wx', path.startsWith('bin/') ? 0o755 : 0o600)
    try {
      await handle.writeFile(files.get(path), 'utf8')
    } finally {
      await handle.close()
    }
  }
}

function ownedProbeName(prefix) {
  return '.' + prefix + '-' + randomUUID()
}

export async function probeNoReplaceDirectoryRename(parent) {
  const source = join(parent, ownedProbeName('dsh-developer-rename-source'))
  const destination = join(parent, ownedProbeName('dsh-developer-rename-destination'))
  await mkdir(source, { mode: 0o700 })
  await mkdir(destination, { mode: 0o700 })
  let refused = false
  try {
    await rename(source, destination)
  } catch (error) {
    if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) refused = true
    else throw error
  } finally {
    await rm(source, { recursive: true, force: true })
    await rm(destination, { recursive: true, force: true })
  }
  if (!refused) {
    throw new DshDeveloperError(
      'ATOMIC_NO_REPLACE_UNAVAILABLE',
      'This filesystem allows directory rename to replace an existing empty destination. Promotion refuses an unsafe fallback.',
      { parent },
    )
  }
  return { supported: true, parent }
}

export async function assertAbsentDirectoryDestination(destination) {
  const absolute = resolve(destination)
  const parent = dirname(absolute)
  const parentInfo = await stat(parent).catch((error) => {
    throw new DshDeveloperError('OUTPUT_PARENT_UNAVAILABLE', 'Output parent is unavailable: ' + error.message, { parent })
  })
  if (!parentInfo.isDirectory()) {
    throw new DshDeveloperError('OUTPUT_PARENT_UNAVAILABLE', 'Output parent must be a directory.', { parent })
  }
  const parentLinkInfo = await lstat(parent)
  if (parentLinkInfo.isSymbolicLink()) {
    throw new DshDeveloperError('UNSAFE_OUTPUT_PARENT', 'Output parent must not be a symbolic link.', { parent })
  }
  const canonicalParent = await realpath(parent)
  const sameParent = process.platform === 'win32'
    ? canonicalParent.toLocaleLowerCase('en-US') === parent.toLocaleLowerCase('en-US')
    : canonicalParent === parent
  if (!sameParent) {
    throw new DshDeveloperError(
      'UNSAFE_OUTPUT_PARENT',
      'Output parent must not traverse a link or junction.',
      { parent, canonicalParent },
    )
  }
  try {
    await lstat(absolute)
    throw new DshDeveloperError('OUTPUT_EXISTS', 'Output destination already exists and will not be replaced.', { destination: absolute })
  } catch (error) {
    if (error instanceof DshDeveloperError) throw error
    if (error.code !== 'ENOENT') throw error
  }
  if (basename(absolute).startsWith('.dsh-developer-stage-')) {
    throw new DshDeveloperError('UNSAFE_OUTPUT_NAME', 'Output name uses a reserved staging prefix.', { destination: absolute })
  }
  assertPortableRelativePath(basename(absolute))
  return { destination: absolute, parent }
}

export async function readTextFile(path) {
  return readFile(path, 'utf8')
}
