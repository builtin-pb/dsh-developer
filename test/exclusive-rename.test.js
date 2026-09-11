import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { renameDirectoryExclusive } from '../lib/exclusive-rename.js'

test('POSIX exclusive rename preserves every existing destination and has one race winner', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sample-exclusive-rename-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source with spaces')
  await mkdir(source)
  await writeFile(join(source, 'proof'), 'source')
  for (const kind of ['empty', 'populated', 'file', 'link', 'dangling-link']) {
    const destination = join(root, kind)
    if (kind === 'file') await writeFile(destination, 'untouched')
    else if (kind === 'link') await symlink(source, destination)
    else if (kind === 'dangling-link') await symlink(join(root, 'absent'), destination)
    else {
      await mkdir(destination)
      if (kind === 'populated') await writeFile(join(destination, 'proof'), 'untouched')
    }
    const before = await lstat(destination)
    await assert.rejects(renameDirectoryExclusive(source, destination), { code: 'EEXIST' })
    const after = await lstat(destination)
    assert.equal(after.ino, before.ino)
    assert.equal(after.mode, before.mode)
    if (kind === 'file') assert.equal(await readFile(destination, 'utf8'), 'untouched')
    if (kind === 'populated') assert.equal(await readFile(join(destination, 'proof'), 'utf8'), 'untouched')
    if (kind.endsWith('link')) assert.equal(await readlink(destination), kind === 'link' ? source : join(root, 'absent'))
    assert.equal(await readFile(join(source, 'proof'), 'utf8'), 'source')
  }
  const rival = join(root, 'rival')
  await mkdir(rival)
  await writeFile(join(rival, 'proof'), 'rival')
  const destination = join(root, 'winner')
  const results = await Promise.allSettled([
    renameDirectoryExclusive(source, destination),
    renameDirectoryExclusive(rival, destination),
  ])
  assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1)
  assert.equal(results.find((value) => value.status === 'rejected').reason.code, 'EEXIST')
  const winner = await readFile(join(destination, 'proof'), 'utf8')
  const loser = winner === 'source' ? rival : source
  await assert.rejects(lstat(winner === 'source' ? source : rival), { code: 'ENOENT' })
  assert.equal(await readFile(join(loser, 'proof'), 'utf8'), winner === 'source' ? 'rival' : 'source')
})

test('POSIX exclusive rename permits only one winner when racing empty directories', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sample-exclusive-rename-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sources = Array.from({ length: 8 }, (_, index) => join(root, 'source-' + index))
  await Promise.all(sources.map((source) => mkdir(source)))
  const before = await Promise.all(sources.map((source) => lstat(source)))
  const destination = join(root, 'winner')
  const results = await Promise.allSettled(sources.map((source) => renameDirectoryExclusive(source, destination)))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      assert.equal((await lstat(destination)).ino, before[index].ino)
      await assert.rejects(lstat(sources[index]), { code: 'ENOENT' })
    } else {
      assert.equal(result.reason.code, 'EEXIST')
      assert.equal((await lstat(sources[index])).ino, before[index].ino)
    }
  }
})

test('Linux exclusive rename handles relative Unicode paths and preserves source on failure', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sample-exclusive-rename-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, '插件 source')
  const destination = join(root, '插件 destination')
  await mkdir(source)
  await writeFile(join(source, 'proof'), 'source')
  const before = await lstat(source)
  await assert.rejects(renameDirectoryExclusive(source, join(root, 'missing-parent', 'destination')), { code: 'ENOENT' })
  assert.equal((await lstat(source)).ino, before.ino)
  await assert.rejects(lstat(join(root, 'missing-parent')), { code: 'ENOENT' })
  await assert.rejects(renameDirectoryExclusive(join(root, 'missing-source'), destination), { code: 'ENOENT' })
  await assert.rejects(lstat(destination), { code: 'ENOENT' })

  await renameDirectoryExclusive(relative(process.cwd(), source), relative(process.cwd(), destination))
  assert.equal((await lstat(destination)).ino, before.ino)
  assert.equal(await readFile(join(destination, 'proof'), 'utf8'), 'source')
  await assert.rejects(lstat(source), { code: 'ENOENT' })
})

test('Linux exclusive rename fails closed when the kernel rejects renameat2', {
  skip: process.platform !== 'linux' || process.env.DSH_DEVELOPER_LINUX_RENAME_TEST !== '1',
}, async (t) => {
  // A child-only seccomp filter forces real syscall errors through the Python
  // helper. It permits ordinary rename, so an unsafe fallback would be exposed.
  const syscall = { x64: 316, arm64: 276 }[process.arch]
  assert.ok(syscall, 'The opt-in fault test supports Linux x64 and arm64.')
  const filter = `
import ctypes, errno, os, sys
class Filter(ctypes.Structure):
    _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]
class Program(ctypes.Structure):
    _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
instructions = (Filter * 4)(
    Filter(0x20, 0, 0, 0),                               # load syscall number
    Filter(0x15, 0, 1, int(sys.argv[1])),                 # match renameat2
    Filter(0x06, 0, 0, 0x00050000 | getattr(errno, sys.argv[2])),
    Filter(0x06, 0, 0, 0x7fff0000),                      # allow other syscalls
)
program = Program(len(instructions), instructions)
libc = ctypes.CDLL(None, use_errno=True)
libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong]
libc.prctl.restype = ctypes.c_int
for option, value, pointer in [(38, 1, None), (22, 2, ctypes.byref(program))]:
    if libc.prctl(option, value, pointer, 0, 0):
        raise OSError(ctypes.get_errno(), 'Cannot install the test seccomp filter')
os.execv(sys.argv[3], sys.argv[3:])
`
  const check = `
import assert from 'node:assert/strict'
import { renameDirectoryExclusive } from ${JSON.stringify(new URL('../lib/exclusive-rename.js', import.meta.url).href)}
await assert.rejects(renameDirectoryExclusive(process.argv[1], process.argv[2]), (error) => {
  assert.ok(JSON.parse(process.argv[3]).includes(error.code), 'Unexpected rename error: ' + error.code)
  return true
})
`
  const execute = promisify(execFile)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sample-exclusive-rename-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const existing = join(root, 'existing')
  const absent = join(root, 'absent')
  await mkdir(source)
  await mkdir(existing)
  await writeFile(join(source, 'proof'), 'source')
  const before = await lstat(source)
  const destinationBefore = await lstat(existing)
  // Some glibc builds translate ENOSYS to EINVAL for nonzero rename flags;
  // Node reports Linux's EOPNOTSUPP using its ENOTSUP alias.
  for (const [code, expected] of [
    ['ENOSYS', ['ENOSYS', 'EINVAL']],
    ['EINVAL', ['EINVAL']],
    ['EOPNOTSUPP', ['ENOTSUP']],
  ]) {
    await t.test(code, async () => {
      for (const destination of [absent, existing]) {
        await execute('/usr/bin/python3', [
          '-I', '-S', '-c', filter, String(syscall), code,
          process.execPath, '--input-type=module', '-e', check, source, destination, JSON.stringify(expected),
        ], { timeout: 15_000, maxBuffer: 16 * 1024 })
        assert.equal((await lstat(source)).ino, before.ino)
        assert.equal(await readFile(join(source, 'proof'), 'utf8'), 'source')
        assert.equal((await lstat(existing)).ino, destinationBefore.ino)
        await assert.rejects(lstat(absent), { code: 'ENOENT' })
      }
    })
  }
})
