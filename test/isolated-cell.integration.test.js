import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectIsolatedCellAdmission } from '../lib/cell-admission.js'
import { openIsolatedCell } from '../lib/isolated-cell.js'
import { createWslBubblewrapCell } from '../lib/lab/wsl-bubblewrap.js'

test('imports, executes, snapshots, and removes a real isolated cell', {
  skip: process.env.DSH_DEVELOPER_WSL_CELL_TEST !== '1',
  timeout: 45_000,
}, async () => {
  const cell = await createWslBubblewrapCell({
    distro: process.env.DSH_DEVELOPER_WSL_DISTRO || 'Ubuntu-22.04',
    entries: [
      { path: 'index.js', content: 'export const value = "before"\n' },
      { path: 'README.md', content: '# Fixture\n' },
    ],
  })
  try {
    const result = await cell.run([
      '/bin/sh',
      '-c',
      "printf 'export const value = \"after\"\\n' > index.js && mkdir lib && printf 'export const added = true\\n' > lib/added.js",
    ])
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.cleanup.remaining, [])
    const snapshot = await cell.snapshot()
    assert.deepEqual(snapshot.entries, [
      { path: 'index.js', content: 'export const value = "after"\n' },
      { path: 'lib/added.js', content: 'export const added = true\n' },
      { path: 'README.md', content: '# Fixture\n' },
    ])
    assert.match(snapshot.fingerprint, /^sha256:[a-f0-9]{64}$/u)
    await cell.run([
      '/usr/bin/python3',
      '-c',
      "import socket; value = socket.socket(socket.AF_UNIX); value.bind('fixture.sock')",
    ])
    await assert.rejects(
      cell.snapshot(),
      (error) => error.code === 'CELL_SNAPSHOT_INCOMPLETE',
    )
    await cell.run(['/usr/bin/rm', '-f', '/opt/workspace/fixture.sock'])
    const pending = cell.run(['/bin/sh', '-c', '/usr/bin/sleep 30'])
    await assert.rejects(cell.snapshot(), (error) => error.code === 'CELL_BUSY')
    const disposing = cell.dispose()
    await assert.rejects(pending, (error) => error.code === 'CANCELLED')
    await disposing
  } finally {
    await cell.dispose()
  }
  await assert.rejects(
    cell.run(['/usr/bin/true']),
    (error) => error.code === 'CELL_DISPOSED',
  )
})

test('stages a real public-cell result without mutating its source', {
  skip: process.env.DSH_DEVELOPER_WSL_CELL_TEST !== '1',
  timeout: 180_000,
}, async () => {
  const source = await mkdtemp(join(tmpdir(), 'dsh-developer-public-cell-'))
  await writeFile(join(source, 'index.js'), 'export const value = "source"\n', 'utf8')
  let staging
  let stagingRoot
  const admission = await inspectIsolatedCellAdmission(process.env.DSH_DEVELOPER_DSH, {
    distro: process.env.DSH_DEVELOPER_WSL_DISTRO || 'Ubuntu-22.04',
  })
  assert.equal(admission.admitted, true)
  const cell = await openIsolatedCell(source, { admission })
  try {
    await assert.rejects(
      openIsolatedCell('must-not-be-read', { admission }),
      (error) => error.code === 'CELL_CAPACITY',
    )
    const result = await cell.exec("printf 'export const value = \"cell\"\\n' > index.js")
    assert.equal(result.exitCode, 0)
    const sealed = await cell.stageResult()
    staging = sealed.staging
    stagingRoot = sealed.stagingRoot
    assert.equal(sealed.changed, true)
    assert.deepEqual(sealed.changes, { created: [], modified: ['index.js'], deleted: [] })
    assert.equal(await readFile(join(staging, 'index.js'), 'utf8'), 'export const value = "cell"\n')
    assert.equal(await readFile(join(source, 'index.js'), 'utf8'), 'export const value = "source"\n')
  } finally {
    await cell.dispose()
    await rm(source, { recursive: true, force: true })
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true })
  }
})
