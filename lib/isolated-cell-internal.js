import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { claimCellStageAuthority } from './cell-stage-authority.js'
import { LIMITS } from './constants.js'
import { asDiagnostic, DshDeveloperError } from './errors.js'
import { fingerprintFileMap, scanOrdinaryTree, writeFilesExclusive } from './files.js'
import { createWslBubblewrapCell } from './lab/wsl-bubblewrap.js'

const ALL_EXIT_CODES = Object.freeze(Array.from({ length: 256 }, (_, value) => value))

function mapEntries(entries) {
  return new Map(entries.map((entry) => [entry.path, entry.content]))
}

function changedPaths(before, after) {
  const created = []
  const modified = []
  const deleted = []
  for (const [path, content] of after) {
    if (!before.has(path)) created.push(path)
    else if (before.get(path) !== content) modified.push(path)
  }
  for (const path of before.keys()) {
    if (!after.has(path)) deleted.push(path)
  }
  const sort = (values) => values.sort((left, right) => left.localeCompare(right, 'en'))
  return { created: sort(created), modified: sort(modified), deleted: sort(deleted) }
}

function validateCommand(command) {
  if (typeof command !== 'string' || command.trim().length === 0 || command.includes('\0')) {
    throw new DshDeveloperError('CELL_COMMAND_INVALID', 'An isolated-cell command must be a non-empty string without NUL characters.')
  }
  if (command.length > LIMITS.longTextChars) {
    throw new DshDeveloperError('CELL_COMMAND_INVALID', 'An isolated-cell command exceeds the bounded command length.')
  }
  return command
}

function validateTimeout(value) {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value <= 0 || value > LIMITS.commandTimeoutMs) {
    throw new DshDeveloperError('CELL_COMMAND_INVALID', 'timeoutMs must be a positive integer no greater than the cell command limit.')
  }
  return value
}

function assertSignal(signal) {
  if (signal === undefined) return
  if (typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function') {
    throw new DshDeveloperError('CELL_OPTIONS_INVALID', 'signal must be an AbortSignal when present.')
  }
}

function validateMethodOptions(options, allowed, label) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DshDeveloperError('CELL_OPTIONS_INVALID', label + ' options must be an object.')
  }
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new DshDeveloperError('CELL_OPTIONS_INVALID', 'Unsupported ' + label + ' option "' + key + '".')
    }
  }
}

function combineSignals(cellSignal, operationSignal) {
  if (cellSignal === undefined) return operationSignal
  if (operationSignal === undefined || operationSignal === cellSignal) return cellSignal
  return AbortSignal.any([cellSignal, operationSignal])
}

function sameOrDescendant(parent, candidate) {
  const relation = relative(resolve(parent), resolve(candidate))
  return relation === ''
    || (relation !== '..' && !relation.startsWith('..' + sep) && !isAbsolute(relation))
}

function selectStagingBase(sourceRoot, hostTempRoot) {
  if (!sameOrDescendant(sourceRoot, hostTempRoot)) return resolve(hostTempRoot)
  const parent = dirname(resolve(sourceRoot))
  if (parent === resolve(sourceRoot)) {
    throw new DshDeveloperError(
      'CELL_STAGING_SEPARATION',
      'No host staging base can be proven outside the isolated-cell source root.',
      { source: resolve(sourceRoot), hostTempRoot: resolve(hostTempRoot) },
    )
  }
  return parent
}

const EXEC_OPTIONS = new Set(['signal', 'timeoutMs'])
const STAGE_OPTIONS = new Set(['signal', 'authority'])

export async function openIsolatedCellInternal(source, options = {}, dependencies = {}) {
  const scan = dependencies.scanOrdinaryTree ?? scanOrdinaryTree
  const createCell = dependencies.createWslBubblewrapCell ?? createWslBubblewrapCell
  const makeTemp = dependencies.mkdtemp ?? mkdtemp
  const getTempDirectory = dependencies.tmpdir ?? tmpdir
  const resolvePhysicalPath = dependencies.realpath ?? realpath
  const makeDirectory = dependencies.mkdir ?? mkdir
  const remove = dependencies.rm ?? rm
  const writeFiles = dependencies.writeFilesExclusive ?? writeFilesExclusive
  const verifyTree = dependencies.verifyTree ?? scanOrdinaryTree
  const onDisposed = dependencies.onDisposed
  assertSignal(options.signal)
  const sourceTree = await scan(source, { signal: options.signal })
  const sourceFiles = mapEntries(sourceTree.entries)
  const cell = await createCell({
    distro: options.distro,
    signal: options.signal,
    entries: sourceTree.entries.map(({ path, content }) => ({ path, content })),
  })
  let state = 'open'
  let staged
  let operationPromise
  let disposePromise
  let abortDisposePromise
  const lifecycleController = new AbortController()

  function assertOpen() {
    if (state === 'disposed') throw new DshDeveloperError('CELL_DISPOSED', 'The isolated execution cell is already disposed.')
    if (state === 'sealed') throw new DshDeveloperError('CELL_SEALED', 'The isolated execution cell result is already sealed.')
    if (state === 'closing') throw new DshDeveloperError('CELL_CLOSING', 'The isolated execution cell is being disposed.')
    if (state === 'running' || state === 'sealing') {
      throw new DshDeveloperError('CELL_BUSY', 'The isolated execution cell already has an operation in progress.')
    }
  }

  const handle = {
    source: sourceTree.root,
    sourceFingerprint: sourceTree.fingerprint,
    provider: {
      id: cell.provider.id,
      distro: cell.provider.distro,
      kernel: cell.provider.kernel,
      bwrapVersion: cell.provider.bwrapVersion,
    },
    async exec(command, execOptions = {}) {
      validateMethodOptions(execOptions, EXEC_OPTIONS, 'exec')
      assertOpen()
      assertSignal(execOptions.signal)
      const timeoutMs = validateTimeout(execOptions.timeoutMs)
      const normalizedCommand = validateCommand(command)
      state = 'running'
      const operation = (async () => {
        const result = await cell.run(['/bin/sh', '-c', normalizedCommand], {
          signal: combineSignals(
            combineSignals(options.signal, execOptions.signal),
            lifecycleController.signal,
          ),
          timeoutMs,
          acceptedExitCodes: ALL_EXIT_CODES,
          label: 'isolated plugin-development command',
        })
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          cleanup: {
            observed: result.cleanup.found.length,
            killed: result.cleanup.killed,
            remaining: result.cleanup.remaining.length,
          },
        }
      })()
      operationPromise = operation
      try {
        return await operation
      } catch (error) {
        if (options.signal?.aborted && abortDisposePromise !== undefined) {
          try {
            await abortDisposePromise
          } catch (cleanupError) {
            throw new DshDeveloperError(
              'CELL_CANCELLATION_CLEANUP_FAILED',
              'Cell cancellation failed to verify disposal of its owned workspace.',
              { operation: asDiagnostic(error), cleanup: asDiagnostic(cleanupError) },
            )
          }
        }
        if (['CELL_WORKSPACE_LIMIT', 'CELL_WORKSPACE_BOUND_BREACHED', 'CELL_WORKSPACE_WATCHDOG_FAILED'].includes(error?.code)) {
          try {
            await handle.dispose()
          } catch (cleanupError) {
            throw new DshDeveloperError(
              'CELL_COMMAND_CLEANUP_FAILED',
              'A poisoned execution cell could not verify disposal after its command failed.',
              { command: asDiagnostic(error), cleanup: asDiagnostic(cleanupError) },
            )
          }
        }
        throw error
      } finally {
        if (operationPromise === operation) operationPromise = undefined
        if (state === 'running') state = 'open'
      }
    },
    async stageResult(stageOptions = {}) {
      validateMethodOptions(stageOptions, STAGE_OPTIONS, 'stageResult')
      assertOpen()
      assertSignal(stageOptions.signal)
      const signal = combineSignals(
        combineSignals(options.signal, stageOptions.signal),
        lifecycleController.signal,
      )
      state = 'sealing'
      const operation = (async () => {
        const snapshot = await cell.snapshot({ signal })
        const files = mapEntries(snapshot.entries)
        const changes = changedPaths(sourceFiles, files)
        const changeCount = changes.created.length + changes.modified.length + changes.deleted.length
        if (changeCount === 0) {
          return {
            changed: false,
            staging: undefined,
            stagingRoot: undefined,
            changes,
            sourceFingerprint: sourceTree.fingerprint,
            resultFingerprint: snapshot.fingerprint,
          }
        }

        const sourcePhysicalRoot = await resolvePhysicalPath(sourceTree.root)
        let claimedAuthority
        let stagingRoot
        let destination
        if (stageOptions.authority === undefined) {
          const hostTempPhysicalRoot = await resolvePhysicalPath(getTempDirectory())
          const stagingBase = selectStagingBase(sourcePhysicalRoot, hostTempPhysicalRoot)
          stagingRoot = await makeTemp(join(stagingBase, '.dsh-developer-cell-result-'))
          destination = join(stagingRoot, 'result')
        } else {
          claimedAuthority = await claimCellStageAuthority(stageOptions.authority)
          stagingRoot = resolve(claimedAuthority.root)
          destination = resolve(claimedAuthority.destination)
          if (!isAbsolute(claimedAuthority.root)
              || destination !== join(stagingRoot, 'result')) {
            throw new DshDeveloperError(
              'CELL_STAGE_AUTHORITY_INVALID',
              'The controller-minted authority must name one absolute root with its exact result child.',
            )
          }
        }
        try {
          const stagingPhysicalRoot = await resolvePhysicalPath(stagingRoot)
          if (sameOrDescendant(sourcePhysicalRoot, stagingPhysicalRoot)) {
            throw new DshDeveloperError(
              'CELL_STAGING_SEPARATION',
              'The created host staging directory resolves inside the isolated-cell source root.',
              { source: sourcePhysicalRoot, stagingRoot, stagingPhysicalRoot },
            )
          }
          if (claimedAuthority === undefined) await makeDirectory(destination, { mode: 0o700 })
          await writeFiles(destination, files, { signal })
          const verified = await verifyTree(destination, { signal })
          if (verified.fingerprint !== snapshot.fingerprint
              || fingerprintFileMap(mapEntries(verified.entries)) !== snapshot.fingerprint) {
            throw new DshDeveloperError('CELL_STAGING_MISMATCH', 'Materialized cell result differs from the sealed snapshot.')
          }
        } catch (error) {
          if (claimedAuthority !== undefined) {
            throw new DshDeveloperError(
              'CELL_STAGING_RETAINED',
              'Controller-owned result staging failed and remains retained for verified discard.',
            )
          }
          let cleanupError
          try {
            await remove(stagingRoot, { recursive: true, force: true })
          } catch (failure) {
            cleanupError = failure
          }
          if (cleanupError) {
            throw new DshDeveloperError(
              'CELL_STAGING_CLEANUP_FAILED',
              'A failed result staging directory could not be removed; the exact retained path is reported for recovery.',
              {
                stagingRoot,
                failure: asDiagnostic(error),
                cleanup: asDiagnostic(cleanupError),
              },
            )
          }
          throw error
        }
        return {
          changed: true,
          staging: destination,
          stagingRoot,
          ...(claimedAuthority === undefined ? {} : { stageAuthority: claimedAuthority.capability }),
          changes,
          sourceFingerprint: sourceTree.fingerprint,
          resultFingerprint: snapshot.fingerprint,
        }
      })()
      operationPromise = operation
      try {
        staged = await operation
        if (state === 'sealing') state = 'sealed'
        return staged
      } catch (error) {
        if (options.signal?.aborted && abortDisposePromise !== undefined) {
          try {
            await abortDisposePromise
          } catch (cleanupError) {
            throw new DshDeveloperError(
              'CELL_CANCELLATION_CLEANUP_FAILED',
              'Cell cancellation failed to verify disposal of its owned workspace.',
              { operation: asDiagnostic(error), cleanup: asDiagnostic(cleanupError) },
            )
          }
        }
        throw error
      } finally {
        if (operationPromise === operation) operationPromise = undefined
        if (state === 'sealing') state = 'open'
      }
    },
    async dispose() {
      if (state === 'disposed') return
      if (disposePromise === undefined) {
        state = 'closing'
        lifecycleController.abort(new DshDeveloperError('CELL_CLOSING', 'The isolated execution cell is being disposed.'))
        const pending = operationPromise
        disposePromise = (async () => {
          const providerDisposal = cell.dispose()
          if (pending !== undefined) await pending.catch(() => {})
          await providerDisposal
          state = 'disposed'
          options.signal?.removeEventListener('abort', abortForLifetime)
          onDisposed?.()
        })()
      }
      try {
        await disposePromise
      } catch (error) {
        disposePromise = undefined
        throw error
      }
    },
    get stagedResult() {
      return staged
    },
  }

  function abortForLifetime() {
    if (abortDisposePromise !== undefined || state === 'disposed') return
    abortDisposePromise = handle.dispose()
    abortDisposePromise.catch(() => {})
  }

  if (options.signal?.aborted) abortForLifetime()
  else options.signal?.addEventListener('abort', abortForLifetime, { once: true })
  return handle
}
