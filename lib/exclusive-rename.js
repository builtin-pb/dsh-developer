import { execFile } from 'node:child_process'
import { rename } from 'node:fs/promises'
import { getSystemErrorName, promisify } from 'node:util'

// Node's POSIX rename replaces empty directories. Darwin's RENAME_EXCL and
// Linux's RENAME_NOREPLACE keep the check and rename in one kernel operation.
const DARWIN_RENAME = `
import ctypes, os, sys
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
rename = libc.renamex_np
rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
rename.restype = ctypes.c_int
result = rename(os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2]), 4)
print(ctypes.get_errno() if result else 0)
`
const LINUX_RENAME = `
import ctypes, errno, os, sys
libc = ctypes.CDLL(None, use_errno=True)
try:
    rename = libc.renameat2
except AttributeError:
    print(errno.ENOSYS)
    sys.exit(0)
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
rename.restype = ctypes.c_int
AT_FDCWD = -100
RENAME_NOREPLACE = 1
result = rename(AT_FDCWD, os.fsencode(sys.argv[1]), AT_FDCWD, os.fsencode(sys.argv[2]), RENAME_NOREPLACE)
print(ctypes.get_errno() if result else 0)
`
const execute = promisify(execFile)

export async function renameDirectoryExclusive(source, destination) {
  if (process.platform === 'win32') return rename(source, destination)
  const script = process.platform === 'darwin' ? DARWIN_RENAME : process.platform === 'linux' ? LINUX_RENAME : null
  if (script === null) {
    throw Object.assign(new Error('Atomic no-replace rename is unavailable on this platform.'), { code: 'ENOTSUP' })
  }
  let stdout
  try {
    const result = await execute('/usr/bin/python3', ['-I', '-S', '-c', script, source, destination], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      timeout: 10_000,
      maxBuffer: 1024,
    })
    stdout = result.stdout
  } catch (cause) {
    throw Object.assign(new Error('Exclusive rename was not acknowledged; inspect both paths.'), { code: 'RENAME_STATE_UNKNOWN', cause })
  }
  const errno = Number(stdout.trim())
  if (!/^\d+\s*$/u.test(stdout) || !Number.isSafeInteger(errno)) {
    throw Object.assign(new Error('Exclusive rename returned an invalid result; inspect both paths.'), { code: 'RENAME_STATE_UNKNOWN' })
  }
  if (errno !== 0) {
    const code = getSystemErrorName(-errno)
    throw Object.assign(new Error('Exclusive directory rename failed: ' + code), { code })
  }
}
