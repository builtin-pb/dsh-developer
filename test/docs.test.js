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
  assert.ok(manifest.files.includes('README.md'))
  assert.ok(manifest.files.includes('README.zh-CN.md'))
})
