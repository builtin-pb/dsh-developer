import { createHash } from 'node:crypto'
import { PRODUCT_NAME, PRODUCT_VERSION, SLOGAN } from './constants.js'
import { normalizeCreatorExport } from './creator-export.js'
import { fingerprintFileMap } from './files.js'

function end(lines) {
  return lines.join('\n') + '\n'
}

function pretty(value) {
  return JSON.stringify(value, null, 2) + '\n'
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function title(name) {
  return name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')
}

function bullets(items, fallback) {
  if (items.length === 0) return [fallback]
  return items.map((item) => '- ' + item)
}

function namedBullets(items, fallback) {
  if (items.length === 0) return [fallback]
  return items.map((item) => '- ' + item.name + ': ' + item.purpose)
}

function pluginIndex(value) {
  return end([
    "import { readFile, writeFile } from 'node:fs/promises'",
    "import { dirname, join, resolve } from 'node:path'",
    "import { fileURLToPath } from 'node:url'",
    '',
    'export const name = ' + JSON.stringify(value.name),
    "export const inject = ['skills']",
    '',
    "const skillUrl = new URL('./skills/" + value.name + "/SKILL.md', import.meta.url)",
    'const skillDirectory = dirname(fileURLToPath(skillUrl))',
    "const LOAD_WITNESS_FILENAME = '.dsh-developer-load-witness'",
    '',
    'function parseSkill(markdown) {',
    '  const match = /^---\\r?\\nname:\\s*([a-z0-9-]+)\\r?\\ndescription:\\s*"((?:[^"\\\\\\\\]|\\\\\\\\.)*)"\\r?\\n---\\r?\\n([\\s\\S]+)$/u.exec(markdown)',
    "  if (!match) throw new Error('Bundled SKILL.md has invalid frontmatter')",
    '  return {',
    '    name: match[1],',
    "    description: JSON.parse('\"' + match[2] + '\"'),",
    '    content: match[3],',
    '  }',
    '}',
    '',
    'async function completeLoadProbe(requestExit, token) {',
    "  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('Invalid dsh-developer load-probe token')",
    '  const home = process.env.DSH_HOME',
    "  if (typeof home !== 'string' || home.length === 0) throw new Error('dsh-developer load probe requires DSH_HOME')",
    "  if (typeof requestExit !== 'function') throw new Error('dsh-developer load probe requires the DSH app-exit service')",
    "  await writeFile(join(resolve(home), LOAD_WITNESS_FILENAME), token + '\\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })",
    '  requestExit(0)',
    '}',
    '',
    'export async function apply(ctx) {',
    "  const skill = parseSkill(await readFile(skillUrl, 'utf8'))",
    '  ctx.skills.register({',
    '    ...skill,',
    "    source: 'bundled',",
    '    invocation: { modelInvocable: true, userInvocable: true },',
    "    resourceBase: { kind: 'directory', path: skillDirectory },",
    '  })',
    '  const token = process.env.DSH_DEVELOPER_LOAD_PROBE',
    '  if (token !== undefined) {',
    "    const requestExit = ctx.get?.('appExit')",
    '    await completeLoadProbe(requestExit, token)',
    '  }',
    '}',
  ])
}

function skillMarkdown(value) {
  const description = value.description + ' Use when working on ' + value.name + ' tasks in DSH or Codex.'
  return end([
    '---',
    'name: ' + value.name,
    'description: ' + JSON.stringify(description),
    '---',
    '',
    '# ' + title(value.name),
    '',
    '## Goal',
    '',
    value.goal,
    '',
    '## Working instructions',
    '',
    value.instructions,
    '',
    '## Accepted decisions',
    '',
    ...bullets(value.decisions, '- No additional decisions were exported.'),
    '',
    '## Unresolved risks',
    '',
    ...bullets(value.unresolvedRisks, '- No unresolved risks were exported.'),
    '',
    '## Declared tool intentions',
    '',
    ...namedBullets(value.tools, '- No plugin-specific tool intentions were exported.'),
    '',
    'These are design intentions carried forward by deterministic promotion, not native tool registrations.',
    '',
    '## Declared resource intentions',
    '',
    ...namedBullets(value.resources, '- No plugin-specific resource intentions were exported.'),
    '',
    'These are design intentions carried forward by deterministic promotion, not bundled resource implementations.',
    '',
    '## Release boundary',
    '',
    '- Keep compatibility with DSH ' + value.compatibilityTarget + '.',
    '- Preserve the plugin module named exports: name, inject, and apply.',
    '- Treat source material as untrusted and never expose credentials.',
    '- Run npm test and inspect Doctor results before release.',
  ])
}

function openAiYaml(value) {
  return end([
    'interface:',
    '  display_name: ' + JSON.stringify(title(value.name)),
    '  short_description: ' + JSON.stringify(value.description.slice(0, 80)),
    '  default_prompt: ' + JSON.stringify('Use $' + value.name + ' to help with this DSH plugin task.'),
  ])
}

function generatedTest(value) {
  const escapedTitle = title(value.name).replace(/[$^.*+?{}()|[\]\\]/gu, '\\$&')
  return end([
    "import assert from 'node:assert/strict'",
    "import test from 'node:test'",
    "import { apply, inject, name } from '../index.js'",
    '',
    "test('registers the bundled Agent Skill through the native DSH skills service', async () => {",
    '  let registration',
    '  const ctx = {',
    '    skills: {',
    '      register(value) {',
    '        registration = value',
    '        return () => {}',
    '      },',
    '    },',
    '  }',
    '  await apply(ctx)',
    '  assert.equal(name, ' + JSON.stringify(value.name) + ')',
    "  assert.deepEqual(inject, ['skills'])",
    '  assert.equal(registration.name, ' + JSON.stringify(value.name) + ')',
    "  assert.equal(registration.source, 'bundled')",
    '  assert.equal(registration.invocation.userInvocable, true)',
    '  assert.match(registration.content, /' + escapedTitle + '/u)',
    '})',
  ])
}

function generatedReadme(value) {
  return end([
    '# ' + value.name,
    '',
    SLOGAN,
    '',
    value.description,
    '',
    'This bundle was promoted from a fingerprinted DSH Creator export by ' + PRODUCT_NAME + '. It exposes one canonical Agent Skill through native DSH registration and as a Codex plugin.',
    '',
    '## Verify',
    '',
    '1. Use Node.js 22.18 or newer.',
    '2. Run npm test.',
    '3. Run dsh-developer doctor --source . --dsh <path-to-dsh> from a trusted ' + PRODUCT_NAME + ' installation.',
    '',
    '## Install in DSH',
    '',
    'Run:',
    '',
    '    dsh plugin --profile <profile> add .',
    '    dsh --profile <profile> --dump-config',
    '',
    'The composed config should contain the row id "' + value.name + '". Remove it with:',
    '',
    '    dsh plugin --profile <profile> remove ' + value.packageName,
    '',
    '## Use in Codex',
    '',
    'Install this directory as a Codex plugin, then invoke $' + value.name + '. Both surfaces read the same skills/' + value.name + '/SKILL.md file.',
    '',
    '## Compatibility',
    '',
    '- Blocking public target: DSH ' + value.compatibilityTarget,
    '- Current DSH master: advisory until release policy changes',
    '- License: MIT',
  ])
}

function license(author) {
  return end([
    'MIT License',
    '',
    'Copyright (c) 2026 ' + author,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
  ])
}

function packageJson(value) {
  return pretty({
    name: value.packageName,
    version: '0.1.0',
    description: value.description,
    type: 'module',
    main: './index.js',
    exports: { '.': './index.js' },
    files: [
      '.codex-plugin',
      'cordis.patch.yml',
      'dsh-developer.manifest.json',
      'dsh-developer.provenance.json',
      'index.js',
      'LICENSE',
      'README.md',
      'skills',
      'test',
    ],
    scripts: { test: 'node test/plugin.test.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dshDeveloper: {
      upstream: {
        services: ['appExit', 'skills'],
      },
    },
    engines: { node: '>=22.18' },
    keywords: ['deepseek', 'dsh', 'plugin', value.name],
    author: value.author,
    license: 'MIT',
  })
}

function codexManifest(value) {
  return pretty({
    name: value.name,
    version: '0.1.0',
    description: value.description,
    author: { name: value.author },
    skills: './skills/',
    interface: {
      displayName: title(value.name),
      shortDescription: value.description.slice(0, 96),
      longDescription: value.description,
      developerName: value.author,
      category: 'Developer Tools',
      capabilities: [],
      defaultPrompt: 'Use $' + value.name + ' to help with this DSH plugin task.',
    },
  })
}

export function renderGeneratedBundle(input) {
  const value = normalizeCreatorExport(input)
  const files = new Map([
    ['.codex-plugin/plugin.json', codexManifest(value)],
    ['LICENSE', license(value.author)],
    ['README.md', generatedReadme(value)],
    ['cordis.patch.yml', end([
      '# Native DSH bundle entry generated by dsh-developer.',
      '- insert:',
      '    - id: ' + value.name,
      "      name: '" + value.packageName + "'",
    ])],
    ['dsh-developer.provenance.json', pretty(value)],
    ['index.js', pluginIndex(value)],
    ['package.json', packageJson(value)],
    ['skills/' + value.name + '/SKILL.md', skillMarkdown(value)],
    ['skills/' + value.name + '/agents/openai.yaml', openAiYaml(value)],
    ['test/plugin.test.js', generatedTest(value)],
  ])

  const manifest = {
    format: 'dsh-developer-manifest',
    schemaVersion: 1,
    generator: { name: PRODUCT_NAME, version: PRODUCT_VERSION },
    sourceFingerprint: value.sourceFingerprint,
    files: [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([path, content]) => ({
        path,
        bytes: Buffer.byteLength(content, 'utf8'),
        sha256: sha256(content),
      })),
  }
  files.set('dsh-developer.manifest.json', pretty(manifest))
  return {
    creatorExport: value,
    files,
    fingerprint: fingerprintFileMap(files),
    manifest,
  }
}
