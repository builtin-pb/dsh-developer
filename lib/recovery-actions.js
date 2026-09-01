import { DSH_COMPATIBILITY_TARGET, DSH_PREVIEW_TARGET } from './constants.js'

export const NEXT_ACTION_LIMIT = 3

export const NEXT_ACTION_IDS = Object.freeze([
  'dsh.select-reviewed-lane',
  'migration.use-supported-corridor',
  'doctor.resolve-blocker',
  'preflight.resolve-blocker',
  'cell.resolve-admission',
  'cell.request-approved-run',
  'cell.stop-after-approval-denial',
  'cell.resolve-run-failure',
  'cell.discard',
  'ui.configure-prerequisites',
  'ui.resolve-admission',
])

const AUTHORITY_CLASSES = Object.freeze([
  'read-only',
  'user-selection',
  'explicit-source-edit',
  'human-approval-once',
  'workflow-owner',
  'operator-configuration',
  'none',
])
const EFFECT_CLASSES = Object.freeze([
  'none',
  'inspection',
  'source-change',
  'isolated-execution',
  'verified-cleanup',
  'process-configuration',
])
const BLOCKING_RELATIONS = Object.freeze(['required-before', 'blocks', 'terminal-for'])
const BLOCKING_TARGETS = Object.freeze([
  'exact-dsh-lane',
  'release-proof',
  'supported-migration',
  'doctor-pass',
  'profile-preflight-pass',
  'cell-admission',
  'cell-run',
  'cell-capacity',
  'ui-admission',
])
const INSTRUCTION_CODES = Object.freeze([
  'select-reviewed-official-dsh',
  'repair-doctor-blocker',
  'repair-preflight-blocker',
  'satisfy-cell-admission',
  'stop-after-approval-denial',
  'repair-and-replan-cell-run',
  'discard-from-owning-agent',
  'configure-pinned-ui-prerequisites',
  'admit-protected-ui-provider',
])
const INTERFACES = Object.freeze(['dsh-developer-cli', 'dsh_developer'])
const OPERATIONS = Object.freeze(['migration', 'cell-run', 'cell-discard'])
const ARGUMENT_NAMES = Object.freeze(['source', 'fromDsh', 'toDsh', 'json', 'planDigest'])
const ARGUMENT_SOURCES = Object.freeze(['literal', 'original-request'])

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

const ARGUMENT_TEMPLATE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', enum: [...ARGUMENT_NAMES] },
    source: { type: 'string', enum: [...ARGUMENT_SOURCES] },
    value: {
      oneOf: [
        { type: 'string' },
        { type: 'boolean' },
      ],
    },
    field: { type: 'string', enum: ['source'] },
  },
  required: ['name', 'source'],
  additionalProperties: false,
}

export const NEXT_ACTION_SCHEMA = deepFreeze({
  type: 'object',
  properties: {
    id: { type: 'string', enum: [...NEXT_ACTION_IDS] },
    why: { type: 'string' },
    authorityClass: { type: 'string', enum: [...AUTHORITY_CLASSES] },
    effectClass: { type: 'string', enum: [...EFFECT_CLASSES] },
    automatic: { type: 'boolean', enum: [false] },
    blocking: {
      type: 'object',
      properties: {
        relation: { type: 'string', enum: [...BLOCKING_RELATIONS] },
        target: { type: 'string', enum: [...BLOCKING_TARGETS] },
      },
      required: ['relation', 'target'],
      additionalProperties: false,
    },
    recovery: {
      oneOf: [
        {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['instruction'] },
            code: { type: 'string', enum: [...INSTRUCTION_CODES] },
            text: { type: 'string' },
          },
          required: ['kind', 'code', 'text'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['operation'] },
            interface: { type: 'string', enum: [...INTERFACES] },
            operation: { type: 'string', enum: [...OPERATIONS] },
            argumentTemplate: {
              type: 'array',
              items: ARGUMENT_TEMPLATE_SCHEMA,
            },
            text: { type: 'string' },
            onDenied: { type: 'string', enum: ['stop-without-execution-or-retry'] },
          },
          required: ['kind', 'interface', 'operation', 'argumentTemplate', 'text'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: [
    'id',
    'why',
    'authorityClass',
    'effectClass',
    'automatic',
    'blocking',
    'recovery',
  ],
  additionalProperties: false,
})

const LANE_DIAGNOSTICS = new Set([
  'CELL_DSH_LANE_UNAVAILABLE',
  'DSH_ENTRY_UNAVAILABLE',
  'DSH_ENTRY_UNVERIFIED',
  'DSH_IMPACT_LANE_MISMATCH',
  'DSH_LANE_UNAVAILABLE',
  'DSH_LANE_UNREVIEWED',
  'DSH_MATRIX_LANE_MISMATCH',
  'DSH_NOT_FOUND',
  'DSH_PACKAGE_ENTRY_INVALID',
  'DSH_PACKAGE_ENTRY_MISSING',
  'DSH_PACKAGE_IDENTITY_INVALID',
  'DSH_PACKAGE_INVALID',
  'DSH_PACKAGE_NOT_FOUND',
  'DSH_UNSUPPORTED',
  'DSH_VERSION_INVALID',
  'DSH_VERSION_MISMATCH',
  'PROFILE_PREFLIGHT_DSH_UNSUPPORTED',
])
const UI_PREREQUISITE_DIAGNOSTICS = new Set([
  'UI_AGENT_REQUIRED',
  'UI_BROWSER_INVALID',
  'UI_CLI_ENTRY_INVALID',
  'UI_CLI_NOT_CONFIGURED',
  'UI_CLI_PACKAGE_INVALID',
  'UI_CLI_VERSION_MISMATCH',
  'UI_ROOT_INVALID',
])
const CELL_APPROVAL_DIAGNOSTICS = new Set([
  'APPROVAL_CANCELLED',
  'APPROVAL_REJECTED',
  'APPROVAL_UNAVAILABLE',
  'CELL_APPROVAL_DENIED',
  'CELL_APPROVAL_GATE_UNAVAILABLE',
])
const CELL_ADMISSION_DIAGNOSTICS = new Set([
  'CELL_NOT_ADMITTED',
  'DSH_SANDBOX_CONTRACT_UNKNOWN',
  'DSH_SANDBOX_IDENTITY_MISMATCH',
  'DSH_SANDBOX_NOT_FOUND',
  'DSH_SUBAGENT_CONTRACT_UNKNOWN',
  'DSH_SUBAGENT_IDENTITY_MISMATCH',
  'DSH_SUBAGENT_NOT_FOUND',
])
const CELL_CLEANUP_DIAGNOSTICS = new Set([
  'CELL_CLEANUP_FAILED',
  'CELL_DISCARD_CLEANUP_FAILED',
  'CELL_OWNER_CLEANUP_FAILED',
  'CELL_STAGE_CLEANUP_AMBIGUOUS',
  'CELL_STAGE_IDENTITY_MISMATCH',
  'CELL_STAGE_MISSING',
  'CELL_STAGE_MUTATED',
  'CELL_WORKFLOW_CAPACITY',
])
const NON_RECOVERABLE_DIAGNOSTICS = new Set([
  'CANCELLED',
  'CLI_USAGE',
  'COMMAND_USAGE',
  'TOOL_USAGE',
])
const LANE_CHECK_IDS = new Set([
  'compatibility.public-runtime',
  'installation.package-identity',
  'lane.preview',
  'lane.release',
  'runtime.cli-contract',
  'runtime.identity',
])
const PLAN_DIGEST = /^sha256:[a-f0-9]{64}$/u

function instruction(id, why, authorityClass, effectClass, blocking, code, text) {
  return deepFreeze({
    id,
    why,
    authorityClass,
    effectClass,
    automatic: false,
    blocking,
    recovery: { kind: 'instruction', code, text },
  })
}

function operation(id, why, authorityClass, effectClass, blocking, recovery) {
  return deepFreeze({
    id,
    why,
    authorityClass,
    effectClass,
    automatic: false,
    blocking,
    recovery: { kind: 'operation', ...recovery },
  })
}

function laneAction() {
  return instruction(
    'dsh.select-reviewed-lane',
    'The current evidence does not establish the exact reviewed DSH lane required by this gate.',
    'user-selection',
    'none',
    { relation: 'required-before', target: 'exact-dsh-lane' },
    'select-reviewed-official-dsh',
    'Select a user-authorized, package-declared official DSH entry for '
      + DSH_COMPATIBILITY_TARGET + '; use ' + DSH_PREVIEW_TARGET
      + ' only for an explicitly advisory preview gate. Then rerun the same operation. Do not invent, search for, install, or substitute a path without authority, and never use preview evidence as release proof.',
  )
}

function migrationAction() {
  return operation(
    'migration.use-supported-corridor',
    'The requested migration corridor is outside the installed read-only ledger.',
    'read-only',
    'inspection',
    { relation: 'required-before', target: 'supported-migration' },
    {
      interface: 'dsh-developer-cli',
      operation: 'migration',
      argumentTemplate: [
        { name: 'source', source: 'original-request', field: 'source' },
        { name: 'fromDsh', source: 'literal', value: DSH_COMPATIBILITY_TARGET },
        { name: 'toDsh', source: 'literal', value: DSH_PREVIEW_TARGET },
        { name: 'json', source: 'literal', value: true },
      ],
      text: 'Rerun the read-only migration inspection with the same authorized source and the exact supported corridor shown in nextActions. The ledger must reject every other corridor before reading source.',
    },
  )
}

function doctorAction() {
  return instruction(
    'doctor.resolve-blocker',
    'At least one blocking Doctor check failed.',
    'explicit-source-edit',
    'source-change',
    { relation: 'blocks', target: 'doctor-pass' },
    'repair-doctor-blocker',
    'Use the first failing blocking check in report order and only its existing evidence. Repair it within already-approved source scope, or obtain explicit edit approval first, then rerun Doctor with required runtime proof. Do not skip or weaken the check.',
  )
}

function preflightAction() {
  return instruction(
    'preflight.resolve-blocker',
    'The clean-profile preflight has an unresolved blocking check.',
    'explicit-source-edit',
    'source-change',
    { relation: 'blocks', target: 'profile-preflight-pass' },
    'repair-preflight-blocker',
    'Keep the real profile unchanged. Resolve the first failing blocking check using the report evidence under existing source-edit authority, or ask the operator for the required clean-profile configuration, then rerun preflight. Do not install into or weaken the target profile gate.',
  )
}

function admissionAction() {
  return instruction(
    'cell.resolve-admission',
    'The exact isolated-cell admission evidence does not admit execution.',
    'user-selection',
    'none',
    { relation: 'blocks', target: 'cell-admission' },
    'satisfy-cell-admission',
    'Do not open or run a cell. Satisfy the first failing admission check without weakening it, preserve the capability, lab, and admission digests, then rerun admission on the same exact reviewed lane.',
  )
}

function approvedRunAction(planDigest) {
  return operation(
    'cell.request-approved-run',
    'The immutable cell plan is ready but has no execution authority.',
    'human-approval-once',
    'isolated-execution',
    { relation: 'required-before', target: 'cell-run' },
    {
      interface: 'dsh_developer',
      operation: 'cell-run',
      argumentTemplate: [{ name: 'planDigest', source: 'literal', value: planDigest }],
      text: 'Call dsh_developer cell-run with only the exact planDigest shown in nextActions. DSH must request audited allowed-once approval; this metadata grants nothing and never runs automatically.',
      onDenied: 'stop-without-execution-or-retry',
    },
  )
}

function approvalStoppedAction() {
  return instruction(
    'cell.stop-after-approval-denial',
    'The required one-time execution approval was denied, cancelled, or unavailable.',
    'none',
    'none',
    { relation: 'terminal-for', target: 'cell-run' },
    'stop-after-approval-denial',
    'Stop without executing or retrying cell-run. Do not broaden authority or reinterpret conversation as approval. The owning Agent may keep the immutable plan for a later explicit decision or discard it with the exact original digest.',
  )
}

function runFailureAction() {
  return instruction(
    'cell.resolve-run-failure',
    'The isolated run or its post-run verification did not pass.',
    'explicit-source-edit',
    'source-change',
    { relation: 'blocks', target: 'cell-run' },
    'repair-and-replan-cell-run',
    'First complete verified cell-discard. Then use only the bounded run evidence to repair the authorized source or revise the command plan, create a new immutable plan, and request fresh one-time approval. Never rerun the old digest or treat its staged preview as release evidence.',
  )
}

function discardAction(planDigest) {
  if (!PLAN_DIGEST.test(planDigest ?? '')) {
    return instruction(
      'cell.discard',
      'An existing or poisoned isolated workflow must release capacity through verified cleanup.',
      'workflow-owner',
      'verified-cleanup',
      { relation: 'required-before', target: 'cell-capacity' },
      'discard-from-owning-agent',
      'Use cell-discard only from the owning live Agent with the exact original planDigest. If that digest is unavailable, do not invent one or delete a reported path manually; retain the blocker for owner or lifecycle cleanup.',
    )
  }
  return operation(
    'cell.discard',
    'The isolated workflow retains process capacity until identity-verified cleanup completes.',
    'workflow-owner',
    'verified-cleanup',
    { relation: 'required-before', target: 'cell-capacity' },
    {
      interface: 'dsh_developer',
      operation: 'cell-discard',
      argumentTemplate: [{ name: 'planDigest', source: 'literal', value: planDigest }],
      text: 'Call dsh_developer cell-discard from the owning live Agent with only this exact planDigest. Let the controller re-prove identity and cleanup; never delete, move, or reconstruct a retained path manually.',
    },
  )
}

function uiPrerequisiteAction() {
  return instruction(
    'ui.configure-prerequisites',
    'The pinned local UI controller prerequisites are absent, partial, or invalid.',
    'operator-configuration',
    'process-configuration',
    { relation: 'required-before', target: 'ui-admission' },
    'configure-pinned-ui-prerequisites',
    'Before DSH starts, have the operator configure one exact supported Playwright CLI entry, one browser executable, and one absolute controller state directory. Do not discover or install them automatically, copy diagnostic paths, add credentials, or relax loopback isolation.',
  )
}

function uiAdmissionAction() {
  return instruction(
    'ui.resolve-admission',
    'No complete protected semantic UI provider is admitted for the calling Agent.',
    'operator-configuration',
    'process-configuration',
    { relation: 'blocks', target: 'ui-admission' },
    'admit-protected-ui-provider',
    'Keep browser execution, file transfer, and non-loopback navigation denied. Configure or scope one complete dsh-developer-protected semantic provider, then rerun dsh_developer ui admission before any UI action.',
  )
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function reportChecks(report) {
  const output = []
  const append = (values) => {
    if (!Array.isArray(values)) return
    for (const value of values.slice(0, 128 - output.length)) {
      const item = object(value)
      if (item) output.push(item)
      if (output.length === 128) break
    }
  }
  append(report?.checks)
  if (Array.isArray(report?.lanes)) {
    for (const lane of report.lanes.slice(0, 8)) {
      append(object(lane)?.checks)
      if (output.length === 128) break
    }
  }
  return output
}

function unresolvedBlocking(check) {
  return check?.status !== 'PASS' && check.blocking !== false
}

function checkFailed(checks, id) {
  return checks.some((check) => check.id === id && check.status !== 'PASS')
}

function diagnosticCode(value) {
  return typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(value.code)
    ? value.code
    : undefined
}

function planDigest(report, input) {
  for (const value of [report?.planDigest, input?.planDigest]) {
    if (typeof value === 'string' && PLAN_DIGEST.test(value)) return value
  }
  return undefined
}

function hasLaneBlocker(report, checks, code) {
  if (LANE_DIAGNOSTICS.has(code)) return true
  if (report?.runtime?.lane?.recognized === false) return true
  if (checkFailed(checks, 'compatibility.public-runtime')) return true
  if (checkFailed(checks, 'runtime.identity')) return true
  if (checkFailed(checks, 'runtime.cli-contract')) return true
  if (checkFailed(checks, 'installation.package-identity')) return true
  return checks.some((check) => (
    (check.id === 'lane.release' || check.id === 'lane.preview') && check.status !== 'PASS'
  ))
}

function isDoctorReport(report) {
  return typeof report?.kind === 'string' && report.kind.startsWith('doctor-')
}

function operationDiagnostic(code) {
  return code !== undefined
    && !NON_RECOVERABLE_DIAGNOSTICS.has(code)
    && !code.endsWith('_OPTIONS_INVALID')
}

export function deriveNextActions(context = {}) {
  const value = object(context) ?? {}
  const report = object(value.report)
  const diagnostic = object(value.diagnostic) ?? object(report?.diagnostic)
  const input = object(value.input)
  const operationName = typeof value.operation === 'string' ? value.operation : undefined
  const code = diagnosticCode(diagnostic) ?? diagnosticCode(report?.failure)
  const checks = reportChecks(report)
  const digest = planDigest(report, input)
  const candidates = new Map()
  const offer = (priority, action) => {
    const current = candidates.get(action.id)
    const quality = action.recovery.kind === 'operation' ? 1 : 0
    if (!current || priority < current.priority || (priority === current.priority && quality > current.quality)) {
      candidates.set(action.id, { priority, quality, action })
    }
  }

  const cellRun = report?.kind === 'isolated-cell-run' || operationName === 'cell-run'
  const cleanupRequired = report?.cleanup?.requiresCellDiscard === true
    || report?.phase === 'cleanup-failed'
    || CELL_CLEANUP_DIAGNOSTICS.has(code)
  if (cleanupRequired) offer(10, discardAction(digest))

  if (CELL_APPROVAL_DIAGNOSTICS.has(code)
      || ['rejected', 'cancelled', 'unavailable', 'denied'].includes(value.approvalOutcome)) {
    offer(15, approvalStoppedAction())
  }

  if (report?.kind === 'isolated-cell-plan' && report.ok === true && digest !== undefined) {
    offer(20, approvedRunAction(digest))
    offer(90, discardAction(digest))
  }

  if (hasLaneBlocker(report, checks, code)) offer(30, laneAction())
  if (code === 'MIGRATION_CORRIDOR_UNSUPPORTED') offer(35, migrationAction())

  const admissionFailed = (report?.kind === 'isolated-agent-cell-admission'
      && (report.admitted !== true || report.ok !== true))
    || code === 'CELL_NOT_ADMITTED'
    || CELL_ADMISSION_DIAGNOSTICS.has(code)
  if (admissionFailed) offer(40, admissionAction())

  if (cellRun && report?.ok === false) offer(45, runFailureAction())

  const preflight = report?.kind === 'dsh-profile-preflight' || operationName === 'preflight'
  const diagnosticReport = report?.kind === 'dsh-developer-diagnostic'
  const nonLaneChecks = checks.filter((check) => !LANE_CHECK_IDS.has(check.id))
  const preflightEvidenceBlocker = nonLaneChecks.some(unresolvedBlocking)
    || (!diagnosticReport && report?.ok === false && checks.length === 0)
  const preflightDiagnosticBlocker = operationDiagnostic(code) && !LANE_DIAGNOSTICS.has(code)
  if (preflight && (preflightEvidenceBlocker || preflightDiagnosticBlocker)) {
    offer(50, preflightAction())
  }

  const doctor = isDoctorReport(report) || operationName === 'doctor'
  const doctorEvidenceBlocker = nonLaneChecks.some(unresolvedBlocking)
    || (!diagnosticReport && report?.ok === false && checks.length === 0)
  const doctorDiagnosticBlocker = operationDiagnostic(code) && !LANE_DIAGNOSTICS.has(code)
  if (doctor && (doctorEvidenceBlocker || doctorDiagnosticBlocker)) {
    offer(60, doctorAction())
  }

  if (UI_PREREQUISITE_DIAGNOSTICS.has(code)) offer(70, uiPrerequisiteAction())
  if (report?.kind === 'ui-capabilities' && report.ok !== true) offer(80, uiAdmissionAction())

  return deepFreeze([...candidates.values()]
    .sort((left, right) => left.priority - right.priority
      || NEXT_ACTION_IDS.indexOf(left.action.id) - NEXT_ACTION_IDS.indexOf(right.action.id))
    .slice(0, NEXT_ACTION_LIMIT)
    .map((value_) => value_.action))
}

export function withNextActions(value, context = {}) {
  const target = object(value)
  if (!target) throw new TypeError('withNextActions requires one object boundary value')
  const report = object(context.report)
    ?? (object(target.report) ?? (diagnosticCode(target) === undefined ? target : undefined))
  const diagnostic = object(context.diagnostic)
    ?? (diagnosticCode(target) === undefined ? undefined : target)
  return {
    ...target,
    nextActions: deriveNextActions({ ...context, report, diagnostic }),
  }
}

export function formatFirstNextAction(value) {
  const actions = Array.isArray(value) ? value : value?.nextActions
  const action = Array.isArray(actions) ? actions[0] : undefined
  if (!action || !NEXT_ACTION_IDS.includes(action.id) || typeof action.recovery?.text !== 'string') return ''
  return 'Next action [' + action.id + ']: ' + action.recovery.text
}

export function appendFirstNextAction(text, value) {
  const next = formatFirstNextAction(value)
  return next.length === 0 ? text : text + '\n' + next
}
