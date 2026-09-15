import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const SLOGAN = 'The single plugin you need for DSH'
const METAFLOW = '[MetaFlow](https://github.com/builtin-pb/metaflow)'

test('keeps both human-facing READMEs strong, concise, linked, and package-visible', async () => {
  const [english, chinese, manifestText, englishGuide, chineseGuide] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.zh-CN.md', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../docs/workflows.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/workflows.zh-CN.md', import.meta.url), 'utf8'),
  ])
  const manifest = JSON.parse(manifestText)
  assert.match(english, /\[简体中文\]\(README\.zh-CN\.md\)/u)
  assert.match(chinese, /\[English\]\(README\.md\)/u)
  for (const value of [english, chinese]) {
    assert.ok(value.includes(SLOGAN))
    assert.ok(value.includes(METAFLOW))
    assert.ok(value.length < 4_500, 'README must stay focused on user outcomes')
    assert.doesNotMatch(value, /earn(?:ing)? GitHub stars|make (?:the )?repo trend|internal factory/iu)
  }
  assert.match(englishGuide, /browser-service collisions/u)
  assert.match(chineseGuide, /Client 服务冲突/u)
  assert.match(englishGuide, /raw plugin-owned Web routes outside the upstream connection service/u)
  assert.match(englishGuide, /Connection registration alone does not prove authentication/u)
  assert.match(chineseGuide, /上游 connection 服务之外的插件自建原始 Web 路由/u)
  assert.match(englishGuide, /migration --source .*--from-dsh 0\.1\.1-rc\.2 --to-dsh 0\.1\.2-alpha\.3/u)
  assert.match(chineseGuide, /源码走廊/u)
  assert.match(englishGuide, /It never edits source/u)
  assert.match(chineseGuide, /绝不修改源码/u)
  assert.match(englishGuide, /Check whether these Claude hooks still deny tools on this DSH install/u)
  assert.match(chineseGuide, /检查这些 Claude hooks 在这套 DSH 上是否仍会拒绝工具调用/u)
  assert.match(englishGuide, /without import, execution, expansion, or activation claims/u)
  assert.match(chineseGuide, /不导入、执行、展开或声称激活/u)
  assert.match(englishGuide, /at most three closed `nextActions`/u)
  assert.match(chineseGuide, /最多附带三个封闭的 `nextActions`/u)
  assert.ok(manifest.files.includes('README.md'))
  assert.ok(manifest.files.includes('README.zh-CN.md'))
})

test('pins the AST runtime and records its direct MIT license evidence', async () => {
  const [manifestText, lockText, installGuide, templates, doctor] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
    readFile(new URL('../docs/install.md', import.meta.url), 'utf8'),
    readFile(new URL('../lib/templates.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/doctor.js', import.meta.url), 'utf8'),
  ])
  const manifest = JSON.parse(manifestText)
  const lock = JSON.parse(lockText)
  const babelEngine = '^22.18.0 || >=24.11.0'
  assert.equal(manifest.engines.node, babelEngine)
  assert.equal(lock.packages[''].engines.node, babelEngine)
  assert.ok(installGuide.includes(babelEngine))
  assert.match(templates, /engines: \{ node: '>=22\.18' \}/u)
  assert.match(doctor, /expectedNodeRange = options\.productSource[\s\S]*: '>=22\.18'/u)
  for (const [name, version] of [
    ['@babel/parser', '8.0.5'],
    ['@babel/traverse', '8.0.5'],
  ]) {
    assert.equal(manifest.dependencies[name], version)
    const installed = lock.packages[`node_modules/${name}`]
    assert.equal(installed.version, version)
    assert.equal(installed.license, 'MIT')
    assert.match(installed.resolved, /^https:\/\/registry\.npmjs\.org\//u)
    assert.match(installed.integrity, /^sha512-/u)
  }
})

test('README and guide links resolve within the distributed documentation', async () => {
  const files = ['README.md', 'README.zh-CN.md', 'docs/install.md', 'docs/development.md', 'docs/macos.md', 'docs/platforms.md', 'docs/verification.md', 'docs/contributing.md', 'docs/workflows.md', 'docs/workflows.zh-CN.md']
  for (const file of files) {
    const source = new URL('../' + file, import.meta.url)
    const content = await readFile(source, 'utf8')
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const target = match[1]
      if (/^(?:https?:|#)/u.test(target)) continue
      const destination = new URL(target, source)
      destination.hash = ''
      await assert.doesNotReject(readFile(destination), file + ' has a broken link: ' + target)
    }
  }
})
