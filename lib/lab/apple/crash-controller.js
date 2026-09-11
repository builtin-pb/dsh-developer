import { createAppleContainerCell } from '../apple-container.js'
const cell = await createAppleContainerCell({ cellId: process.argv[2] })
await cell.run(['/bin/sh', '-c', 'touch /opt/workspace/crash-ready; sleep 30'])
// Conformance must kill this process, not exercise graceful disposal.
await cell.dispose()
process.exitCode = 1
