import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import * as plugin from '../lib/index.js'

// Set DSH_PACKAGE_ROOT to exercise the packages supplied by an installed DSH.
const requireDsh = createRequire(process.env.DSH_PACKAGE_ROOT
  ? pathToFileURL(resolve(await realpath(process.env.DSH_PACKAGE_ROOT), 'package.json'))
  : import.meta.url)
const { Context } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')).href)
const { default: Tools } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-tools')).href)
const { default: SystemPrompt } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-system-prompt')).href)
const cases = JSON.parse(await readFile(new URL('../tool-cases.json', import.meta.url), 'utf8'))

test('registers, executes canonical tool cases, and unregisters through Cordis', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const scope = ctx.plugin(plugin)
  await scope
  assert.equal(ctx.tools.get('check_package_version').name, 'check_package_version')
  for (const [index, entry] of cases.entries()) {
    const result = await ctx.tools.execute({
      callId: `package-check-${index}`,
      name: entry.tool,
      arguments: entry.arguments,
      signal: new AbortController().signal,
    })
    assert.equal(result.isError, entry.isError ?? false, JSON.stringify(entry.arguments))
    assert.deepEqual(result.value ?? null, entry.expected)
    if (result.isError) {
      assert.equal(Object.hasOwn(result, 'value'), false)
      assert.match(result.error.message, /must be/)
    } else {
      assert.deepEqual(JSON.parse(result.content[0].text), entry.expected)
    }
  }
  await scope.dispose()
  assert.equal(ctx.tools.get('check_package_version'), undefined)
})
