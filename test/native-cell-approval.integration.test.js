import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { inspectLiveAgentWorkspace } from '../lib/native-cell-workflow.js'

const lanes = [
  ['release', process.env.DSH_DEVELOPER_RELEASE_TOOLS_ROOT, '0.1.1-rc.2'],
  ['preview', process.env.DSH_DEVELOPER_PREVIEW_TOOLS_ROOT, '0.1.2-alpha.3'],
]

async function importFrom(requireFromLane, name) {
  return import(pathToFileURL(requireFromLane.resolve(name)).href)
}

for (const [lane, root, expectedVersion] of lanes) {
  test('exact ' + lane + ' DSH tools contract enforces audited allowed-once before handler execution', {
    skip: root === undefined ? 'set the exact tools package root to exercise this installed lane' : false,
  }, async () => {
    const manifest = join(root, 'package.json')
    const requireFromLane = createRequire(manifest)
    const packageValue = requireFromLane(manifest)
    assert.equal(packageValue.version, expectedVersion)
    const [{ Context }, { default: SystemPrompt }, { default: ToolRuntime }] = await Promise.all([
      importFrom(requireFromLane, '@deepseek-ai/cordis'),
      importFrom(requireFromLane, '@deepseek-ai/dsh-system-prompt'),
      importFrom(requireFromLane, '@deepseek-ai/dsh-tools'),
    ])
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    let answer = 'unavailable'
    let requestBehavior
    const requests = []
    ctx.provide('approval', {
      request(value) {
        requests.push(value)
        return requestBehavior ? requestBehavior(value) : Promise.resolve(answer)
      },
    })
    const pending = new Set()
    const granted = new Set()
    let bodies = 0
    let guards = 0
    ctx.on('tools/pre-execute', (exec) => {
      pending.add(exec.token)
      return Promise.resolve({ kind: 'ask', reason: 'exact plan sha256:' + 'a'.repeat(64) })
    })
    ctx.tools.guard((exec) => {
      guards += 1
      if (!pending.delete(exec.token)) return 'missing exact pre-execute token'
      granted.add(exec.token)
      return undefined
    })
    ctx.on('tools/result', (exec) => {
      pending.delete(exec.token)
      granted.delete(exec.token)
    })
    ctx.tools.register({
      name: 'approval_contract_probe',
      description: 'exact approval contract probe',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(_args, exec) {
        if (!granted.delete(exec.token)) throw new Error('handler lacked allowed-once token proof')
        bodies += 1
        return 'ran'
      },
    })
    const agent = { session: { header: { id: lane + '-approval-probe' } } }
    let nextCall = 0
    const execute = (signal = new AbortController().signal) => ctx.tools.execute({
      callId: lane + '-call-' + (++nextCall),
      name: 'approval_contract_probe',
      arguments: {},
      agent,
      signal,
    })

    for (const outcome of ['unavailable', 'rejected', 'cancelled']) {
      answer = outcome
      const beforeBodies = bodies
      const beforeGuards = guards
      const result = await execute()
      assert.equal(result.isError, true, outcome)
      assert.equal(bodies, beforeBodies, outcome + ' must launch zero handlers')
      assert.equal(guards, beforeGuards, outcome + ' must reach zero post-approval guards')
    }

    answer = 'allowed-always'
    const rogue = await execute()
    assert.equal(rogue.isError, true)
    assert.equal(bodies, 0, 'a non-once rogue approval outcome must launch zero handlers')
    assert.equal(guards, 0, 'a non-once rogue approval outcome must reach zero guards')

    answer = 'allowed-once'
    const allowed = await execute()
    assert.equal(allowed.isError, false)
    assert.equal(bodies, 1)
    assert.equal(guards, 1)
    assert.match(requests.at(-1).reason, /^exact plan sha256:/u)
    assert.equal(requests.at(-1).toolName, 'approval_contract_probe')
    assert.equal(requests.at(-1).agent, agent)

    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    requestBehavior = () => {
      entered.resolve()
      return release.promise
    }
    const cancellation = new AbortController()
    const cancelled = execute(cancellation.signal)
    await entered.promise
    cancellation.abort('cancel approval')
    release.resolve('allowed-once')
    const cancelledResult = await cancelled
    assert.equal(cancelledResult.isError, true)
    assert.equal(bodies, 1, 'cancellation after ask must still launch zero additional handlers')
    assert.equal(guards, 2, 'an allowed-once answer reaches the monotonic guard before caller cancellation blocks the handler')
  })

  test('exact ' + lane + ' Agent registry excludes an owner-bound clean-header child from root authority', {
    skip: root === undefined ? 'set the exact tools package root to exercise this installed lane' : false,
  }, async () => {
    const requireFromLane = createRequire(join(root, 'package.json'))
    const [{ Context }, { AgentRegistry }] = await Promise.all([
      importFrom(requireFromLane, '@deepseek-ai/cordis'),
      importFrom(requireFromLane, '@deepseek-ai/dsh-agent'),
    ])
    const registry = new AgentRegistry(new Context())
    const makeAgent = (id) => ({
      id,
      ctx: {},
      session: {
        id,
        header: { id, cwd: process.cwd(), origin: 'user', delegationDepth: 0 },
      },
    })
    const rootAgent = makeAgent(lane + '-root')
    const cleanHeaderChild = makeAgent(lane + '-clean-header-child')
    const detachRoot = registry.enter(rootAgent, undefined)
    const detachChild = registry.enter(cleanHeaderChild, rootAgent)
    try {
      assert.equal(registry.list().includes(cleanHeaderChild), true)
      assert.equal(registry.roots().includes(cleanHeaderChild), false)
      await assert.rejects(
        inspectLiveAgentWorkspace(cleanHeaderChild, {
          isRootAgent: (candidate) => registry.roots().includes(candidate),
        }),
        (cause) => cause.code === 'CELL_ROOT_AGENT_NOT_LIVE',
      )
    } finally {
      detachChild()
      detachRoot()
    }
  })
}
