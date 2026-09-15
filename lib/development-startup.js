import { findSecrets, redactSensitiveOutput } from './security.js'

/** A usable application can contain failed plugins; development needs the whole enabled composition. */
export async function assertDevelopmentStartup(ctx) {
  const loader = ctx.loader
  await loader.await()
  const failures = []
  let privateKey = false
  for (const entry of loader.entries()) {
    let detail
    try {
      if (entry.disabled) continue
      const fiber = entry.fiber
      // Cordis FiberState is a const enum: ACTIVE=2, FAILED=3. These are also
      // the states used by DSH's native startup audit in the supported runtimes.
      if (fiber?.state === 2) continue
      if (fiber?.state === 3) {
        await fiber.await()
        detail = 'activation failed without a recorded reason'
      } else if (fiber?.state === 0) {
        const missing = Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined)
        detail = 'pending; missing services: ' + (missing.join(', ') || 'unknown')
      } else detail = fiber ? 'inactive fiber state ' + fiber.state : 'failed to import'
    } catch (error) { detail = error instanceof Error ? error.message : String(error) }
    const subject = String(entry.options.id) + ' (' + String(entry.options.name) + ')'
    const diagnostic = subject + ': ' + detail
    privateKey ||= findSecrets(diagnostic).includes('private-key')
    failures.push(redactSensitiveOutput(diagnostic).slice(0, 2048))
  }
  if (failures.length) {
    throw new Error('Development profile has ' + failures.length + ' inactive enabled entries:\n'
      + (privateKey ? '[redacted: activation diagnostics contained a private key]'
        : failures.slice(0, 8).join('\n') + (failures.length > 8 ? '\nAdditional entries omitted.' : '')))
  }
}
