import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { apply as observeServer } from '../lib/development-server-probe.js'

const marker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
const fragments = { receipt: 'short-body-receipt', stdout: 'short-body-out', stderr: 'short-body-err' }

// Exercise the real parent and CLI with a local process fixture. It publishes
// only a startup-error receipt: no native DSH, Web socket or browser is started.
async function startupFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-server-secrets-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const source = join(root, 'plugin'), runtime = join(root, 'runtime')
  await mkdir(source)
  await mkdir(runtime)
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'fixture', dsh: { bundle: { patch: './patch.yml' } },
  }))
  await writeFile(join(runtime, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: '1.0.0', publishConfig: { access: 'public' }, bin: { dsh: './bin.cjs' },
  }))
  const dshPath = join(runtime, 'bin.cjs'), settingsPath = join(root, 'settings.json')
  const observationPath = join(root, 'process.json')
  await writeFile(dshPath, `
    if (!process.argv.includes('plugin') && !process.argv.includes('--dump-config')) {
      const fs = require('node:fs');
      const settings = JSON.parse(fs.readFileSync(${JSON.stringify(settingsPath)}, 'utf8'));
      setInterval(() => {}, 1000);
      fs.writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({ home: process.env.DSH_HOME }));
      process.stdout.write(settings.stdout, () => process.stderr.write(settings.stderr, () => {
        fs.writeFileSync(process.env.DSH_DEVELOPER_SERVER_RESULT, JSON.stringify({
          kind: 'dsh-development-server-private', version: 1,
          token: process.env.DSH_DEVELOPER_SERVER_TOKEN, ...settings.receipt,
        }));
      }));
    }
  `)
  const cli = fileURLToPath(new URL('../bin/dsh-developer.js', import.meta.url))
  return async (settings, json) => {
    await writeFile(settingsPath, JSON.stringify(settings))
    let failure
    await assert.rejects(promisify(execFile)(process.execPath,
      [cli, 'dev', '--source', source, '--dsh', dshPath, ...(json ? ['--json'] : [])], {
        timeout: 10_000,
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
      }), error => {
      assert.equal(error.code, 1, 'startup must fail, rather than hang or report success')
      assert.equal(error.stdout, '', 'an error receipt must never announce readiness')
      failure = error.stderr
      return true
    })
    const observed = JSON.parse(await readFile(observationPath, 'utf8'))
    await assert.rejects(stat(observed.home), { code: 'ENOENT' })
    const diagnostic = json ? JSON.parse(failure) : undefined
    if (diagnostic) assert.equal(diagnostic.code, 'DEVELOPMENT_SERVER_STARTUP_FAILED')
    else assert.match(failure, /DEVELOPMENT_SERVER_STARTUP_FAILED/u)
    return { text: failure, diagnostic }
  }
}

function assertWithheld({ text, diagnostic }) {
  for (const fragment of [marker, ...Object.values(fragments)]) {
    assert(!text.includes(fragment), 'startup output must not disclose ' + fragment)
  }
  if (diagnostic) {
    assert.deepEqual(diagnostic.output.withheld, { stdout: true, stderr: true })
    assert.match(diagnostic.message, /withheld/u)
    for (const stream of ['stdout', 'stderr']) assert.match(diagnostic[stream], /redacted|withheld/u)
  } else assert.match(text, /Process output withheld/u)
}

test('a marker in either process stream withholds startup-receipt fragments in human and JSON output', async t => {
  const invoke = await startupFixture(t)
  for (const stream of ['stdout', 'stderr']) for (const json of [false, true]) {
    const settings = { receipt: { error: fragments.receipt },
      stdout: fragments.stdout + '\n', stderr: fragments.stderr + '\n' }
    settings[stream] += marker + '\n'
    assertWithheld(await invoke(settings, json))
  }
})

test('a private-key receipt flag masks the message and both process streams in human and JSON output', async t => {
  const invoke = await startupFixture(t)
  for (const json of [false, true]) {
    // The probe has already removed/clipped the marker. Only its boolean
    // observation connects these otherwise unrecognizable body fragments.
    const result = await invoke({ receipt: { error: fragments.receipt, privateKeyOutput: true },
      stdout: fragments.stdout + '\n', stderr: fragments.stderr + '\n' }, json)
    assertWithheld(result)
    if (json) assert.equal(result.diagnostic.privateKeyOutput, true)
  }
})

test('an ordinary clean startup failure retains its cause and both process streams', async t => {
  const invoke = await startupFixture(t)
  const settings = { receipt: { error: 'Error: fixture startup failed' },
    stdout: 'clean stdout detail\n', stderr: 'dsh: clean stderr detail\n' }
  for (const json of [false, true]) {
    const { text, diagnostic } = await invoke(settings, json)
    assert(text.includes(settings.receipt.error))
    assert(text.includes('clean stdout detail'))
    assert(text.includes('dsh: clean stderr detail'))
    assert(!text.includes('Process output withheld'))
    if (json) {
      assert.deepEqual(diagnostic.output.withheld, { stdout: false, stderr: false })
      assert.notEqual(diagnostic.privateKeyOutput, true)
    }
  }
})

test('the real server probe records a raw private-key marker before redaction and receipt clipping', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-server-probe-secrets-'))
  const keys = ['DSH_DEVELOPER_SERVER_RESULT', 'DSH_DEVELOPER_SERVER_TOKEN']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const disposers = []
  t.after(async () => {
    disposers.reverse().forEach(dispose => dispose())
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  const messages = [marker + '\n' + fragments.receipt,
    'ordinary prefix\n' + 'padding\n'.repeat(200) + marker + '\n' + fragments.receipt,
    'ordinary clean startup error']
  for (const [index, message] of messages.entries()) {
    const path = join(root, index + '.json')
    process.env.DSH_DEVELOPER_SERVER_RESULT = path
    process.env.DSH_DEVELOPER_SERVER_TOKEN = 'fixture-token'
    observeServer({
      loader: { await: async () => { throw new Error(message) }, entries: () => [] },
      effect: factory => { disposers.push(factory()) },
      on() {}, inject() {},
      get: () => () => assert.fail('publishing a failure receipt must not need appExit'),
    })
    let receipt
    const deadline = Date.now() + 3000
    while (!receipt && Date.now() < deadline) {
      try { receipt = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    assert(receipt, 'the real probe must publish its startup failure')
    assert.equal(receipt.kind, 'dsh-development-server-private')
    assert.equal(receipt.token, 'fixture-token')
    assert(receipt.error.length <= 1024)
    assert(!receipt.error.includes(marker))
    assert(!receipt.error.includes(fragments.receipt))
    if (index < 2) assert.equal(receipt.privateKeyOutput, true)
    else {
      assert.notEqual(receipt.privateKeyOutput, true)
      assert.equal(receipt.error, message)
    }
  }
})
