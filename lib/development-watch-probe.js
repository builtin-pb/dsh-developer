// @ts-check
/** @import {} from '@deepseek-ai/cordis-plugin-loader' */
/**
 * Observe native Host HMR after initial application readiness.
 *
 * publish receives only { sequence, attempt, warnings, status, active, inactive }.
 * The initial snapshot has attempt 0; attempts count hmr/reload events, not file
 * edits or successful activations. Warnings are cumulative HMR warn/error records.
 * A warning invalidates settlement even when the old entries remain active.
 *
 * The caller owns serial/atomic publication and reporting publisher failures.
 * Publisher throws/rejections are consumed here without logging their payloads.
 * Already-started publications belong to the caller; disposal prevents new ones.
 * Only one native settlement is awaited at a time; newer requests coalesce.
 * A native lifecycle that never settles remains pending, without a polling timer.
 * ctx.on/logger.exporter registrations are owned by the calling Cordis fiber.
 * @param {import('./development-types.js').Context} ctx
 * @param {{ publish: (record: import('./development-types.js').ReloadReceipt) => unknown }} options
 */
export function observeDevelopmentReload(ctx, { publish }) {
  if (typeof publish !== 'function') throw new TypeError('publish must be a function')
  const loader = ctx.loader
  let disposed = false
  let sequence = 0, attempt = 0, warnings = 0
  let generation = Symbol(), checking = false
  /** @type {symbol | undefined} */
  let requested

  const snapshot = () => {
    let active = 0, inactive = 0, unavailable = false
    try {
      for (const entry of loader.entries()) {
        try {
          if (entry.disabled) continue
          if (entry.fiber?.state === 2) active++
          else inactive++
        } catch {
          // An unreadable disabled expression/state cannot establish readiness.
          inactive++
        }
      }
    } catch {
      // Keep only observed counts; never turn an inspection error into success.
      unavailable = true
    }
    return { active, inactive, unavailable }
  }

  /** @param {import('./development-types.js').ReloadReceipt['status']} status */
  const emit = status => {
    if (disposed) return
    const { active, inactive, unavailable } = snapshot()
    if (disposed) return
    if (unavailable || (status === 'settled' && inactive)) status = 'failed'
    const record = { sequence: ++sequence, attempt, warnings, status, active, inactive }
    try { void Promise.resolve(publish(record)).catch(() => {}) } catch { /* Publisher owns error handling. */ }
  }

  const settle = async () => {
    if (checking || disposed) return
    checking = true
    try {
      while (!disposed && requested !== undefined) {
        const observed = requested
        requested = undefined
        let failed = false
        try { await loader.await() } catch { failed = true }
        if (!disposed && observed === generation) emit(failed ? 'failed' : 'settled')
      }
    } finally {
      checking = false
    }
  }

  ctx.effect(() => () => {
    disposed = true
    generation = Symbol()
    requested = undefined
  }, 'stop native development reload observation')

  // Cordis warns at level 2; the default exporter threshold (1) hides syntax
  // failures. Inspect only the logger identity/severity, never message args.
  ctx.logger.exporter({
    colors: false,
    levels: { default: -1, hmr: 2 },
    export(message) {
      if (disposed || message.name !== 'hmr' || !['warn', 'error'].includes(message.type)) return
      warnings++
      generation = Symbol()
      requested = undefined
      emit('warning')
    },
  })
  ctx.on('hmr/reload', () => {
    if (disposed) return
    attempt++
    requested = generation = Symbol()
    emit('pending')
    void settle()
  })
  emit('settled')
}
