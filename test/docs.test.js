import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const SLOGAN = 'The single plugin you need for DSH'
const METAFLOW = '[MetaFlow](https://github.com/builtin-pb/metaflow)'

test('keeps both human-facing READMEs strong, concise, linked, and package-visible', async () => {
  const [english, chinese, manifestText] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.zh-CN.md', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ])
  const manifest = JSON.parse(manifestText)
  assert.match(english, /\[简体中文\]\(README\.zh-CN\.md\)/u)
  assert.match(chinese, /\[English\]\(README\.md\)/u)
  for (const value of [english, chinese]) {
    assert.ok(value.includes(SLOGAN))
    assert.ok(value.includes(METAFLOW))
    assert.ok(value.length < 12_000, 'README must stay focused on user outcomes')
    assert.doesNotMatch(value, /earn(?:ing)? GitHub stars|make (?:the )?repo trend|internal factory/iu)
  }
  assert.match(english, /browser-service collisions/u)
  assert.match(chinese, /Client 服务冲突/u)
  assert.match(english, /raw plugin-owned Web routes outside the authenticated connection boundary/u)
  assert.match(chinese, /宿主认证 connection 边界之外的插件自建原始 Web 路由/u)
  assert.match(english, /migration --source .*--from-dsh 0\.1\.1-rc\.2 --to-dsh 0\.1\.2-alpha\.3/u)
  assert.match(chinese, /源码走廊/u)
  assert.match(english, /It never edits source/u)
  assert.match(chinese, /绝不修改源码/u)
  assert.match(english, /Check whether these Claude hooks still deny tools on this DSH install/u)
  assert.match(chinese, /检查这些 Claude hooks 在这套 DSH 上是否仍会拒绝工具调用/u)
  assert.match(english, /without import, execution, expansion, or activation claims/u)
  assert.match(chinese, /不导入、执行、展开或声称激活/u)
  assert.match(english, /at most three closed `nextActions`/u)
  assert.match(chinese, /最多附带三个封闭的 `nextActions`/u)
  assert.ok(manifest.files.includes('README.md'))
  assert.ok(manifest.files.includes('README.zh-CN.md'))
})

test('pins the AST runtime and records its direct MIT license evidence', async () => {
  const [manifestText, lockText, english, chinese, templates, doctor] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.zh-CN.md', import.meta.url), 'utf8'),
    readFile(new URL('../lib/templates.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/doctor.js', import.meta.url), 'utf8'),
  ])
  const manifest = JSON.parse(manifestText)
  const lock = JSON.parse(lockText)
  const babelEngine = '^22.18.0 || >=24.11.0'
  assert.equal(manifest.engines.node, babelEngine)
  assert.equal(lock.packages[''].engines.node, babelEngine)
  assert.ok(english.includes(babelEngine))
  assert.ok(chinese.includes(babelEngine))
  assert.match(templates, /engines: \{ node: '>=22\.18' \}/u)
  assert.match(doctor, /expectedNodeRange = options\.productSource[\s\S]*: '>=22\.18'/u)
  for (const [name, version] of [
    ['@babel/parser', '8.0.4'],
    ['@babel/traverse', '8.0.4'],
  ]) {
    assert.equal(manifest.dependencies[name], version)
    const installed = lock.packages[`node_modules/${name}`]
    assert.equal(installed.version, version)
    assert.equal(installed.license, 'MIT')
    assert.match(installed.resolved, /^https:\/\/registry\.npmjs\.org\//u)
    assert.match(installed.integrity, /^sha512-/u)
  }
})
