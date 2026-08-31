import { randomUUID } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { doctorCreator, doctorPlugin, reportDigest } from './doctor.js'
import { asDiagnostic, DshDeveloperError } from './errors.js'
import {
  assertAbsentDirectoryDestination,
  probeNoReplaceDirectoryRename,
  scanOrdinaryTree,
  writeFilesExclusive,
} from './files.js'
import { renderGeneratedBundle } from './templates.js'

function assertNotCancelled(signal, details = {}) {
  if (signal?.aborted) throw new DshDeveloperError('CANCELLED', 'Promotion was cancelled before final commit.', details)
}

export async function promoteCreatorExport(source, output, options = {}) {
  const sourcePath = resolve(source)
  const destinationInfo = await assertAbsentDirectoryDestination(output)
  const creatorDoctor = await doctorCreator(sourcePath, {
    ...options,
    runtime: 'required',
  })
  if (!creatorDoctor.ok || !creatorDoctor.snapshot || !creatorDoctor.runtime) {
    throw new DshDeveloperError(
      'DOCTOR_FAILED',
      'Creator export did not pass blocking Doctor checks; no output was created.',
      { doctor: creatorDoctor },
    )
  }
  const creatorExport = creatorDoctor.snapshot.value
  if (basename(destinationInfo.destination) !== creatorExport.name) {
    throw new DshDeveloperError(
      'OUTPUT_NAME_MISMATCH',
      'Output directory name must exactly match Creator export name "' + creatorExport.name + '".',
      { destination: destinationInfo.destination, expectedBasename: creatorExport.name },
    )
  }

  assertNotCancelled(options.signal)
  await probeNoReplaceDirectoryRename(destinationInfo.parent)
  const rendered = renderGeneratedBundle(creatorExport)
  const staging = join(destinationInfo.parent, '.dsh-developer-stage-' + randomUUID())
  await mkdir(staging, { recursive: false, mode: 0o700 })

  try {
    await writeFilesExclusive(staging, rendered.files, { signal: options.signal })
  } catch (error) {
    if (error instanceof DshDeveloperError) {
      error.details = { ...error.details, staging }
      throw error
    }
    throw new DshDeveloperError(
      'STAGING_WRITE_FAILED',
      'Candidate materialization failed and the staging directory was retained.',
      { staging, causeCode: error?.code },
    )
  }

  assertNotCancelled(options.signal, { staging })
  let finalDoctor
  try {
    finalDoctor = await doctorPlugin(staging, {
      ...options,
      runtime: 'required',
      requireGenerated: true,
    })
  } catch (error) {
    if (error instanceof DshDeveloperError) {
      error.details = { ...error.details, staging }
    }
    throw error
  }
  if (!finalDoctor.ok) {
    throw new DshDeveloperError(
      'FINAL_GATE_FAILED',
      'Generated candidate failed blocking Doctor checks and remains in staging for recovery.',
      { staging, doctor: finalDoctor },
    )
  }
  assertNotCancelled(options.signal, { staging })
  try {
    await assertAbsentDirectoryDestination(destinationInfo.destination)
  } catch (error) {
    if (error instanceof DshDeveloperError) error.details = { ...error.details, staging }
    throw error
  }

  try {
    await rename(staging, destinationInfo.destination)
  } catch (error) {
    throw new DshDeveloperError(
      'ATOMIC_COMMIT_FAILED',
      'Atomic no-replace commit failed; staging was retained and the destination was not overwritten.',
      {
        staging,
        destination: destinationInfo.destination,
        causeCode: error.code,
      },
    )
  }

  // Commit crossed the terminal-effect boundary; finish the exact-state probe
  // even if cancellation arrives now so the caller receives a non-ambiguous result.
  let committed
  try {
    const scanCommittedTree = options.scanCommittedTree ?? scanOrdinaryTree
    committed = await scanCommittedTree(destinationInfo.destination)
  } catch (error) {
    throw new DshDeveloperError(
      'COMMIT_STATE_AMBIGUOUS',
      'Atomic rename succeeded, but the exact destination state could not be observed; no rollback or replay was attempted.',
      {
        commitState: 'ambiguous',
        destination: destinationInfo.destination,
        cause: asDiagnostic(error),
      },
    )
  }
  if (committed.fingerprint !== finalDoctor.fingerprint) {
    throw new DshDeveloperError(
      'COMMIT_STATE_AMBIGUOUS',
      'The destination exists but changed immediately after commit; no rollback or replay was attempted.',
      {
        commitState: 'ambiguous',
        destination: destinationInfo.destination,
        expectedFingerprint: finalDoctor.fingerprint,
        observedFingerprint: committed.fingerprint,
      },
    )
  }

  return {
    committed: true,
    destination: destinationInfo.destination,
    sourceFingerprint: creatorExport.sourceFingerprint,
    bundleFingerprint: committed.fingerprint,
    doctorDigest: reportDigest(finalDoctor),
    doctor: finalDoctor,
  }
}
