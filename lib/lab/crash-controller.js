import { asDiagnostic } from '../errors.js'
import { runControllerCrashFixture } from './wsl-bubblewrap.js'

const [distro, rootId, cellId] = process.argv.slice(2)

runControllerCrashFixture({ distro, rootId, cellId }).catch((error) => {
  process.stderr.write(JSON.stringify(asDiagnostic(error)) + '\n')
  process.exitCode = 1
})
