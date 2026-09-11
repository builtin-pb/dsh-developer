import assert from 'node:assert/strict'
import { arch } from 'node:os'
import test from 'node:test'
import { APPLE_CELL_IMAGE, APPLE_CONTAINER_VERSION, appleCellArguments, createAppleContainerCell, verifyAppleCellConfiguration } from '../lib/lab/apple-container.js'

test('unpublished Apple cleanup failure identifies the retained VM using an injected CLI', {
  skip: process.platform !== 'darwin' || arch() !== 'arm64',
}, async () => {
  let created = false
  await assert.rejects(createAppleContainerCell({
    cellId: 'b'.repeat(32),
    runBounded: async (_command, args) => {
      let stdout
      if (args[0] === '--version') stdout = 'container CLI version ' + APPLE_CONTAINER_VERSION + ' fixture'
      else if (args[0] === 'image') stdout = JSON.stringify([{ configuration: { descriptor: { digest: APPLE_CELL_IMAGE.split('@')[1] } } }])
      else if (args[0] === 'list') stdout = JSON.stringify(created ? [{ id: 'dsh-developer-cell-' + 'b'.repeat(32) }] : [])
      else if (args[0] === 'run') { created = true; throw new Error('fixture creation acknowledgement failed') }
      else if (args[0] === 'delete') throw new Error('fixture deletion failed')
      else assert.fail('unexpected injected CLI operation: ' + args[0])
      return { stdout, stderr: '', exitCode: 0 }
    },
  }), (cause) => cause.code === 'CELL_CREATE_CLEANUP_FAILED'
    && cause.details.providerId === 'apple-container'
    && cause.details.cellId === 'dsh-developer-cell-' + 'b'.repeat(32))
})

const name = 'dsh-developer-cell-' + 'a'.repeat(32)
function configuration() {
  const args = appleCellArguments(name)
  return { id: name, configuration: {
    id: name, image: { reference: APPLE_CELL_IMAGE }, readOnly: true, ssh: false, virtualization: false, rosetta: false,
    platform: { os: 'linux', architecture: 'arm64' }, resources: { cpus: 1, cpuOverhead: 1, memoryInBytes: 536870912 },
    networks: [], publishedPorts: [], publishedSockets: [],
    capDrop: ['ALL'], capAdd: ['CAP_SYS_ADMIN', 'CAP_SETUID', 'CAP_SETGID', 'CAP_SETPCAP', 'CAP_KILL', 'CAP_DAC_OVERRIDE'],
    mounts: ['/opt/workspace', '/tmp', '/run/dsh'].map((destination) => ({ destination, source: 'tmpfs', type: { tmpfs: {} }, options: destination === '/run/dsh' ? ['size=1M', 'mode=700'] : ['size=8M', 'mode=1777'] })),
    initProcess: { executable: '/usr/bin/python3', arguments: args.slice(args.indexOf(APPLE_CELL_IMAGE) + 1), user: { id: { uid: 0, gid: 0 } } },
  } }
}

test('Apple VM configuration rejects added authority and changed fixed policy', () => {
  assert.equal(verifyAppleCellConfiguration(configuration(), name).id, name)
  for (const mutate of [
    c => { c.networks.push({}) }, c => { c.publishedSockets.push({}) },
    c => { c.mounts[0].source = '/Users' }, c => { c.mounts[0].options[0] = 'size=1G' },
    c => { c.mounts[1].destination = '/opt/workspace' }, c => { c.readOnly = false },
    c => { c.capAdd.push('CAP_SYS_PTRACE') }, c => { c.resources.memoryInBytes *= 2 },
    c => { c.resources.cpuOverhead = 2 }, c => { c.image.reference = 'node:latest' },
    c => { c.initProcess.arguments = ['-c', 'pass'] },
  ]) {
    const value = configuration()
    mutate(value.configuration)
    assert.throws(() => verifyAppleCellConfiguration(value, name), { code: 'CELL_CONFIGURATION_MISMATCH' })
  }
  assert.throws(() => appleCellArguments('unowned-container'), { code: 'CELL_ID_INVALID' })
})
