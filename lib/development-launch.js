// The verification probe must not request appExit while the CLI's top-level
// startup is still pending. Older DSH has no appReady service, and even a ready
// plugin tree can precede the launcher's watcher setup.
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const entry = process.argv[2]
process.argv.splice(1, 2, entry)
const cli = await import(pathToFileURL(entry).href)
// New launchers use import.meta.main and expose the public callable entry;
// older launchers execute their CLI during module evaluation.
if (typeof cli.runCli === 'function') await cli.runCli()
await writeFile(process.env.DSH_DEVELOPER_BOOT_COMPLETE, 'ready', { flag: 'wx', mode: 0o600 })
