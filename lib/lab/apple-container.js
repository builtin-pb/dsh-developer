import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { arch, release } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { LIMITS } from '../constants.js'
import { asDiagnostic, DshDeveloperError } from '../errors.js'
import { fingerprintFileMap } from '../files.js'
import { runBounded, secretFreeEnvironment } from '../runtime.js'
import { decodeTextTree, encodeTextTree, TEXT_TAR_MAX_BYTES } from './text-tar.js'

export const APPLE_CONTAINER_PROVIDER_ID = 'apple-container'
export const APPLE_CONTAINER_VERSION = '1.4.1'
export const APPLE_CELL_IMAGE = 'docker.io/library/node@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b'
const PREFIX = 'dsh-developer-cell-'
const OWNED_NAME = /^dsh-developer-cell-[a-f0-9]{32}$/u
const scripts = Object.fromEntries(await Promise.all(['supervisor', 'reap', 'snapshot', 'enter'].map(async (name) => [
  name, await readFile(new URL('./apple/' + name + '.py', import.meta.url), 'utf8'),
])))
const PYTHON = ['/usr/bin/python3', '-I', '-S', '-c']
const WORKLOAD = [
  ...PYTHON, scripts.enter,
  '/usr/bin/setpriv', '--reuid=1000', '--regid=1000', '--clear-groups',
  '--bounding-set=-all', '--no-new-privs',
  '/usr/bin/prlimit', '--nproc=32', '--nofile=128', '--cpu=45', '--fsize=524288', '--core=0', '--',
  '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp/home', 'LANG=C.UTF-8',
]
function failure(code, message, details) { return new DshDeveloperError(code, message, details) }
function runner(options) {
  return (args, settings = {}) => (options.runBounded ?? runBounded)('container', args, {
    label: 'Apple execution cell', timeoutMs: 15_000, outputLimit: LIMITS.commandOutputBytes,
    env: secretFreeEnvironment(), ...settings,
  })
}
export function appleCellArguments(name, ownerStart = '') {
  if (!OWNED_NAME.test(name)) throw failure('CELL_ID_INVALID', 'Invalid owned VM identity.')
  return [
    'run', '-d', '--name', name, '--label', 'dsh-developer=isolated-cell',
    '--label', 'dsh-owner-pid=' + process.pid, '--label', 'dsh-owner-start=' + ownerStart,
    '--network', 'none', '--read-only', '--cpus', '1', '--memory', '512M',
    '--tmpfs', '/opt/workspace:size=8M,mode=1777', '--tmpfs', '/tmp:size=8M,mode=1777',
    '--tmpfs', '/run/dsh:size=1M,mode=700', '--shm-size', '1M',
    '--cap-drop', 'ALL', ...['SYS_ADMIN', 'SETUID', 'SETGID', 'SETPCAP', 'KILL', 'DAC_OVERRIDE'].flatMap((value) => ['--cap-add', value]),
    '--entrypoint', PYTHON[0], APPLE_CELL_IMAGE, ...PYTHON.slice(1), scripts.supervisor,
  ]
}
export function verifyAppleCellConfiguration(value, name) {
  const c = value?.configuration
  const expected = new Map([['/opt/workspace', ['size=8M', 'mode=1777']], ['/tmp', ['size=8M', 'mode=1777']], ['/run/dsh', ['size=1M', 'mode=700']]])
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  if (value?.id !== name || c?.id !== name || c.image?.reference !== APPLE_CELL_IMAGE
      || c.readOnly !== true || c.ssh !== false || c.virtualization !== false
      || c.resources?.cpuOverhead !== 1 || c.platform?.os !== 'linux' || c.platform?.architecture !== 'arm64'
      || c.rosetta !== false || c.initProcess?.user?.id?.uid !== 0 || c.initProcess?.user?.id?.gid !== 0
      || !equal(c.capDrop, ['ALL']) || !equal(c.capAdd, ['CAP_SYS_ADMIN', 'CAP_SETUID', 'CAP_SETGID', 'CAP_SETPCAP', 'CAP_KILL', 'CAP_DAC_OVERRIDE'])
      || c.resources?.cpus !== 1 || c.resources?.memoryInBytes !== 512 * 1024 * 1024
      || c.networks?.length !== 0 || c.publishedPorts?.length !== 0 || c.publishedSockets?.length !== 0
      || c.mounts?.length !== 3 || c.mounts.some((m) => !equal(m.options, expected.get(m.destination)) || !expected.delete(m.destination) || !m.type?.tmpfs || m.source !== 'tmpfs')
      || expected.size !== 0 || c.initProcess?.executable !== PYTHON[0]
      || JSON.stringify(c.initProcess?.arguments) !== JSON.stringify([...PYTHON.slice(1), scripts.supervisor])) {
    throw failure('CELL_CONFIGURATION_MISMATCH', 'The created VM does not match the fixed offline cell policy.')
  }
  return value
}
async function discover(run, options) {
  if (process.platform !== 'darwin' || arch() !== 'arm64') {
    throw failure('LAB_PROVIDER_UNAVAILABLE', 'Apple container requires Apple silicon and macOS 26 or later.')
  }
  if (options.distro !== undefined && options.distro !== APPLE_CELL_IMAGE) {
    throw failure('LAB_PROVIDER_MISMATCH', 'This host uses Apple container, not a WSL distribution.')
  }
  const version = await run(['--version'], { signal: options.signal })
  if (!version.stdout.startsWith('container CLI version ' + APPLE_CONTAINER_VERSION + ' ')) {
    throw failure('LAB_PROVIDER_VERSION', 'Install the reviewed Apple container version ' + APPLE_CONTAINER_VERSION + '.')
  }
  const image = JSON.parse((await run(['image', 'inspect', APPLE_CELL_IMAGE], { signal: options.signal })).stdout)
  if (image[0]?.configuration?.descriptor?.digest !== APPLE_CELL_IMAGE.split('@')[1]) {
    throw failure('LAB_IMAGE_MISMATCH', 'The reviewed cell image is missing. Pull the exact documented digest first.')
  }
  return { id: APPLE_CONTAINER_PROVIDER_ID, distro: APPLE_CELL_IMAGE, image: APPLE_CELL_IMAGE,
    version: APPLE_CONTAINER_VERSION, guestOS: 'linux', host: { platform: 'darwin', arch: arch(), release: release() } }
}
async function list(run) {
  return JSON.parse((await run(['list', '--all', '--format', 'json'])).stdout)
}
async function removeOwned(run, name) {
  if (!OWNED_NAME.test(name)) throw failure('CELL_ID_INVALID', 'Invalid owned VM identity.')
  if ((await list(run)).some((v) => v.id === name)) await run(['delete', '--force', name])
  if ((await list(run)).some((v) => v.id === name)) throw failure('CELL_CLEANUP_FAILED', 'The owned VM remains after deletion.')
}
async function processStart(pid) {
  try {
    return (await runBounded('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { acceptedExitCodes: [0, 1], timeoutMs: 3000, env: secretFreeEnvironment() })).stdout.trim()
  } catch { return undefined }
}
async function recover(run) {
  const recovered = []
  for (const value of await list(run)) {
    if (!OWNED_NAME.test(value.id) || value.configuration?.labels?.['dsh-developer'] !== 'isolated-cell') continue
    let state = value.status?.state
    const labels = value.configuration.labels
    const ownerPid = Number(labels['dsh-owner-pid'])
    const recorded = labels['dsh-owner-start']
    if (state !== 'stopped' && Number.isSafeInteger(ownerPid) && ownerPid > 0 && recorded) {
      const observed = await processStart(ownerPid)
      // A stopped/mismatched owner is an orphan. A failed identity probe is
      // unknown, so never treat that as permission to delete a live VM.
      if (observed !== undefined && observed !== recorded) {
        for (let i = 0; i < 40 && state !== 'stopped'; i++) {
          await delay(200)
          state = (await list(run)).find((v) => v.id === value.id)?.status?.state
          if (state === undefined) break
        }
        if (state !== undefined && state !== 'stopped') throw failure('CELL_ORPHAN_REMAINS', 'An orphaned VM did not stop after lease expiry.')
      }
    }
    if (state === 'stopped') {
      await removeOwned(run, value.id)
      recovered.push(value.id)
    }
  }
  return recovered
}

export async function createAppleContainerCell(options = {}) {
  const archive = encodeTextTree(options.entries ?? [])
  const run = runner(options)
  const provider = await discover(run, options)
  await recover(run)
  const name = PREFIX + (options.cellId ?? randomBytes(16).toString('hex'))
  if (!OWNED_NAME.test(name)) throw failure('CELL_ID_INVALID', 'Invalid owned VM identity.')
  let timer, heartbeat, active, closing = false, disposed = false, disposePromise
  const lifecycle = new AbortController()
  const signal = (other) => AbortSignal.any([options.signal, other, lifecycle.signal].filter(Boolean))
  const execRoot = (argv, settings = {}) => run(['exec', '-i', name, ...argv], settings)
  async function beat() {
    await execRoot(['/usr/bin/touch', '/run/dsh/lease'], { timeoutMs: 4_000 })
  }
  async function dispose() {
    if (disposed) return
    if (disposePromise) return disposePromise
    closing = true
    clearInterval(timer)
    lifecycle.abort()
    disposePromise = (async () => {
      await heartbeat?.catch(() => {})
      await removeOwned(run, name)
      disposed = true
    })()
    try { await disposePromise } catch (error) { disposePromise = undefined; throw error }
  }
  async function reap() {
    const result = JSON.parse((await execRoot([...PYTHON, scripts.reap])).stdout)
    if (result.remaining?.length !== 0) throw failure('CELL_PROCESS_REMAINS', 'A workload process survived cleanup.')
    return result
  }
  async function guard(action) {
    if (closing || disposed) throw failure('CELL_DISPOSED', 'The isolated VM has been disposed.')
    if (active) throw failure('CELL_BUSY', 'An isolated VM operation is already running.')
    const operation = action()
    active = operation
    try { return await operation } catch (error) { await dispose(); throw error } finally { if (active === operation) active = undefined }
  }
  try {
    await run(appleCellArguments(name, await processStart(process.pid)), { signal: signal(), timeoutMs: 30_000 })
    const inspected = JSON.parse((await run(['inspect', name])).stdout)[0]
    verifyAppleCellConfiguration(inspected, name)
    let ready = false
    for (let i = 0; i < 30; i++) {
      const check = await execRoot(['/usr/bin/test', '-f', '/run/dsh/ready'], { acceptedExitCodes: [0, 1], signal: signal() })
      if (check.exitCode === 0) { ready = true; break }
      await delay(100)
    }
    if (!ready) throw failure('CELL_START_FAILED', 'The VM supervisor did not become ready.')
    timer = setInterval(() => {
      if (heartbeat || closing) return
      heartbeat = beat().catch(() => { lifecycle.abort() }).finally(() => { heartbeat = undefined })
    }, 1_000)
    await execRoot([...WORKLOAD, '/usr/bin/tar', '-xf', '-', '-C', '/opt/workspace', '--no-same-owner', '--no-same-permissions'], {
      input: archive, inputLimit: TEXT_TAR_MAX_BYTES, signal: signal(),
    })
  } catch (error) {
    try { await dispose() } catch (cleanup) {
      throw failure('CELL_CREATE_CLEANUP_FAILED', 'VM creation failed and cleanup could not be verified.', { creation: asDiagnostic(error), cleanup: asDiagnostic(cleanup) })
    }
    throw error
  }
  return {
    provider, name,
    run(command, settings = {}) {
      return guard(async () => {
        try {
          const result = await run(['exec', '-i', '--workdir', '/opt/workspace', name, ...WORKLOAD, ...command], {
            ...settings, signal: signal(settings.signal), timeoutMs: settings.timeoutMs ?? LIMITS.commandTimeoutMs,
          })
          const cleanup = await reap()
          return { ...result, cleanup }
        } catch (error) {
          await dispose()
          throw error
        }
      })
    },
    snapshot(settings = {}) {
      return guard(async () => {
        await reap()
        const read = async () => decodeTextTree((await execRoot([...PYTHON, scripts.snapshot], {
          signal: signal(settings.signal), encoding: null, outputLimit: TEXT_TAR_MAX_BYTES,
        })).stdout)
        const first = await read()
        const second = await read()
        const fingerprint = (entries) => fingerprintFileMap(new Map(entries.map((v) => [v.path, v.content])))
        if (fingerprint(first) !== fingerprint(second)) throw failure('MUTABLE_TREE', 'The VM tree changed during snapshot.')
        return { entries: second, fingerprint: fingerprint(second) }
      })
    },
    dispose,
  }
}

export async function conformAppleContainer(options = {}) {
  const checks = []
  let provider = { id: APPLE_CONTAINER_PROVIDER_ID }, cell
  const verify = async (id, action) => {
    const evidence = await action()
    checks.push({ id, status: 'PASS', blocking: true, message: 'Verified ' + id + '.', evidence })
  }
  try {
    cell = await createAppleContainerCell(options)
    provider = cell.provider
    await verify('lab.provider', async () => provider)
    await verify('lab.filesystem.workspace-write', async () => {
      await cell.run(['/bin/sh', '-c', 'printf proof > /opt/workspace/proof'])
      return { privateWorkspace: true }
    })
    await verify('lab.filesystem.private-read', async () => {
      await cell.run(['/bin/sh', '-c', 'test ! -e /Users && test ! -e /Volumes && test ! -r /run/dsh/lease'])
      return { hostMounts: 0, controlLeaseReadable: false }
    })
    await verify('lab.filesystem.host-write', async () => {
      const r = await cell.run(['/bin/sh', '-c', 'touch /etc/dsh-proof'], { acceptedExitCodes: [1] })
      return { rootReadOnly: true, exitCode: r.exitCode }
    })
    await verify('lab.environment', async () => {
      const r = await cell.run(['/usr/bin/env'])
      const keys = r.stdout.trim().split('\n').map((v) => v.split('=')[0]).sort()
      if (JSON.stringify(keys) !== JSON.stringify(['HOME', 'LANG', 'PATH'])) throw failure('LAB_ENVIRONMENT_INVALID', 'Unexpected guest environment.')
      return { keys }
    })
    await verify('lab.network', async () => {
      const r = await cell.run([...PYTHON, 'import socket; s=socket.socket(); s.settimeout(1); result=s.connect_ex(("1.1.1.1",443)); assert result != 0; print(result)'])
      return { networkInterfaces: 0, deniedConnect: r.stdout.trim() }
    })
    await verify('lab.resources', async () => {
      const r = await cell.run([...PYTHON, 'import os,resource; s=os.statvfs("/opt/workspace"); assert s.f_blocks*s.f_frsize==8388608 and s.f_files==2048; assert resource.getrlimit(resource.RLIMIT_NPROC)==(32,32); assert resource.getrlimit(resource.RLIMIT_FSIZE)==(524288,524288); print("hard bounds verified")'])
      return { memoryBytes: 536870912, configuredCPUs: 1, runtimeCPUOverhead: 1, workspaceBytes: 8388608, workspaceInodes: 2048, output: r.stdout.trim() }
    })
    await verify('lab.resource-pressure', async () => {
      const fork = await cell.run([...PYTHON, `import errno,os,time
count=0
try:
    while count<40:
        pid=os.fork()
        if pid==0:
            os.close(1); os.close(2); time.sleep(30); os._exit(0)
        count+=1
except OSError as e:
    assert e.errno==errno.EAGAIN
assert count<32
print(count)
`])
      return { taskLimitEnforced: true, forked: Number(fork.stdout.trim()) }
    })
    await verify('lab.devices', async () => {
      await cell.run([...PYTHON, 'import os; s=open("/proc/self/status").read(); assert "CapEff:\t0000000000000000" in s and "CapBnd:\t0000000000000000" in s; assert os.getuid()==1000; assert not os.access("/dev/vda",os.R_OK) and not os.access("/dev/vda",os.W_OK); assert not os.access("/run/dsh",os.R_OK)'])
      return { uid: 1000, capabilities: 'none', controlDirectoryReadable: false }
    })
    await verify('lab.workspace-storage', async () => {
      const storage = `import errno,json,os
for mode in ('bytes','inodes'):
    count=0
    try:
        while True:
            with open('/opt/workspace/quota-'+str(count),'wb') as f:
                if mode=='bytes': f.write(b'x'*262144)
            count+=1
    except OSError as e:
        assert e.errno==errno.ENOSPC
    v=os.statvfs('/opt/workspace')
    assert v.f_blocks*v.f_frsize<=8388608 and v.f_files<=2048
    print(json.dumps(dict(mode=mode,files=count,bytes=v.f_blocks*v.f_frsize,inodes=v.f_files)))
    for name in os.listdir('/opt/workspace'):
        if name.startswith('quota-'): os.unlink('/opt/workspace/'+name)
`
      const result = await cell.run([...PYTHON, storage])
      return { hardQuota: true, attempts: result.stdout.trim().split('\n').map(JSON.parse) }
    })
    await verify('lab.processes', async () => {
      const r = await cell.run([...PYTHON, 'import ctypes,os,time; pid=os.fork(); (os.setsid(),ctypes.CDLL(None).prctl(4,0,0,0,0),os.close(1),os.close(2),time.sleep(30)) if pid==0 else time.sleep(0.1)'])
      if (r.cleanup.killed.length < 1) throw failure('LAB_ORPHAN_UNPROVED', 'Detached process cleanup was not witnessed.')
      const threaded = await cell.run([...PYTHON, 'import ctypes,os,threading,time; pid=os.fork(); time.sleep(0.1) if pid else None; os._exit(0) if pid else None; os.setsid(); os.close(1); os.close(2); threading.Thread(target=lambda: time.sleep(30)).start(); ctypes.CDLL(None).pthread_exit(None)'])
      if (threaded.cleanup.killed.length < 1) throw failure('LAB_ORPHAN_UNPROVED', 'Live threads with a zombie leader were not reaped.')
      return { detached: r.cleanup, zombieLeader: threaded.cleanup }
    })
    await verify('lab.snapshot', async () => {
      const snapshot = await cell.snapshot()
      if (snapshot.entries.find((v) => v.path === 'proof')?.content !== 'proof') throw failure('LAB_SNAPSHOT_INVALID', 'Snapshot mismatch.')
      return { fingerprint: snapshot.fingerprint }
    })
    await verify('lab.controller-crash-recovery', async () => {
      const cellId = randomBytes(16).toString('hex')
      const name = PREFIX + cellId
      const run = runner(options)
      const controller = new AbortController()
      const helper = fileURLToPath(new URL('./apple/crash-controller.js', import.meta.url))
      const running = runBounded(process.execPath, [helper, cellId], {
        signal: controller.signal, timeoutMs: 30_000, env: secretFreeEnvironment(),
      }).then((result) => ({ result }), (error) => ({ error }))
      let ready = false
      try {
        for (let i = 0; i < 30; i++) {
          if (options.signal?.aborted) throw failure('CANCELLED', 'Crash conformance was cancelled.')
          if ((await list(run)).some((v) => v.id === name && v.status?.state === 'running')) {
            const check = await run(['exec', name, '/usr/bin/test', '-e', '/opt/workspace/crash-ready'], { acceptedExitCodes: [0,1] })
            if (check.exitCode === 0) { ready = true; break }
          }
          await delay(200)
        }
        if (!ready) throw failure('LAB_CRASH_UNPROVED', 'Crash fixture never became ready.')
        controller.abort()
        const settled = await running
        if (settled.error?.code !== 'CANCELLED') throw failure('LAB_CRASH_UNPROVED', 'The fixture controller was not terminated.')
        const recovered = await recover(run)
        if (!recovered.includes(name)) throw failure('LAB_CRASH_UNPROVED', 'The stopped VM was not recovered.')
        return { controllerKilled: true, leaseExpiryStoppedVM: true, staleVMRemoved: true }
      } finally {
        controller.abort()
        await running
        await removeOwned(run, name)
      }
    })
    await verify('lab.cancellation', async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 300)
      try {
        await cell.run(['/bin/sh', '-c', 'sleep 30'], { signal: controller.signal })
        throw failure('LAB_CANCELLATION_INVALID', 'Cancellation did not interrupt execution.')
      } catch (error) {
        if (error.code !== 'CANCELLED') throw error
      } finally { clearTimeout(timer) }
      return { entireVMRemoved: true }
    })
  } catch (error) {
    checks.push({ id: 'lab.provider-contract', status: 'FAIL', blocking: true, message: 'Apple VM conformance failed.', evidence: asDiagnostic(error) })
  } finally {
    if (cell) {
      try { await cell.dispose(); checks.push({ id: 'lab.cleanup', status: 'PASS', blocking: true, message: 'The owned VM was removed.' }) }
      catch (error) { checks.push({ id: 'lab.cleanup', status: 'FAIL', blocking: true, message: 'VM removal failed.', evidence: asDiagnostic(error) }) }
    }
  }
  return { provider, checks, policy: { guestOS: 'linux', boundary: 'one Linux VM per cell',
    network: 'no attached network', hostMounts: 'none', rootFilesystem: 'read-only',
    workload: 'root-owned cgroup, uid 1000, no capabilities, no new privileges', workloadTasks: 32, lifetimeSeconds: 900, leaseSeconds: 6,
    workspace: { allocatedBytes: 8388608, inodes: 2048 }, temporary: { allocatedBytes: 8388608, inodes: 2048 }, export: { logicalBytes: 4194304, files: 256, perFileBytes: 524288 }, memoryBytes: 536870912, configuredCPUs: 1, runtimeCPUOverhead: 1 } }
}
