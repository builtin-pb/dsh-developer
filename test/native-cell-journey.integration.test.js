import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'

const enabled = process.env.DSH_DEVELOPER_NATIVE_CELL_JOURNEY_TEST === '1'
const lanes = [
  ['release', process.env.DSH_DEVELOPER_RELEASE_TOOLS_ROOT, process.env.DSH_DEVELOPER_RELEASE_DSH, '0.1.1-rc.2'],
  ['preview', process.env.DSH_DEVELOPER_PREVIEW_TOOLS_ROOT, process.env.DSH_DEVELOPER_PREVIEW_DSH, '0.1.2-alpha.3'],
]

function runFreshProcess(lane, toolsRoot, dshPath, version) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'fixtures', 'native-cell-journey-child.js')], {
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        DSH_DEVELOPER_JOURNEY_LANE: lane,
        DSH_DEVELOPER_JOURNEY_TOOLS_ROOT: toolsRoot,
        DSH_DEVELOPER_JOURNEY_DSH: dshPath,
        DSH_DEVELOPER_JOURNEY_EXPECTED_VERSION: version,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal, stdout, stderr }))
  })
}

for (const [lane, toolsRoot, dshPath, version] of lanes) {
  test('fresh-process actual native isolated Build journey on exact ' + lane + ' lane', {
    skip: !enabled || !toolsRoot || !dshPath
      ? 'set the native-cell journey flag plus exact tools and DSH paths'
      : false,
    timeout: 600_000,
  }, async () => {
    const result = await runFreshProcess(lane, toolsRoot, dshPath, version)
    assert.equal(result.signal, null, result.stderr)
    assert.equal(result.code, 0, result.stderr + '\n' + result.stdout)
    assert.doesNotMatch(result.stderr, /BLOCKER|retained controller root/u)
    const report = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1))
    assert.equal(report.ok, true)
    assert.equal(report.lane, lane)
    assert.equal(report.version, version)
    assert.equal(report.sourceUnchanged, true)
    assert.equal(report.remainingProcesses, 0)
    assert.equal(report.cleanupVerified, true)
    assert.equal(report.applyVerified, true)
    assert.equal(report.rollbackVerified, true)
    assert.equal(report.secondPlan, true)
  })
}
