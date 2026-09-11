import assert from 'node:assert/strict'
import test from 'node:test'
import { APPLE_CELL_IMAGE, appleCellArguments, verifyAppleCellConfiguration } from '../lib/lab/apple-container.js'

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
