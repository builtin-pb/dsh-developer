import assert from 'node:assert/strict'
import test from 'node:test'
import { uiSafetyGuardReason } from '../lib/ui-policy.js'

function reason(rawName, args = {}, namespace = 'dsh_ui') {
  return uiSafetyGuardReason({
    name: 'mcp__' + namespace + '__' + rawName,
    arguments: args,
  })
}

test('leaves external provider namespaces untouched', () => {
  assert.equal(reason('browser_run_code_unsafe', {}, 'playwright'), undefined)
  assert.equal(reason('browser_navigate', { url: 'https://example.com' }, 'playwright'), undefined)
})

test('denies code execution and file transfer in the protected namespace', () => {
  assert.match(reason('browser_run_code_unsafe'), /denies code execution/u)
  assert.match(reason('browser_evaluate'), /denies code execution/u)
  assert.match(reason('browser_file_upload'), /file transfer/u)
  assert.match(reason('evaluate_script'), /denies code execution/u)
  assert.match(reason('future_provider_authority'), /closed semantic allowlist/u)
})

test('admits only explicit loopback navigation for protected browser tools', () => {
  assert.equal(reason('browser_navigate', { url: 'http://127.0.0.1:4173/app' }), undefined)
  assert.equal(reason('browser_navigate', { url: 'https://localhost:8443/' }), undefined)
  assert.equal(reason('browser_navigate', { url: 'about:blank' }), undefined)
  assert.match(reason('browser_navigate', { url: 'http://user:secret@localhost/' }), /only to explicit/u)
  assert.match(reason('browser_navigate', { url: 'https://example.com/' }), /only to explicit/u)
  assert.match(reason('browser_navigate', { url: 'file:///etc/passwd' }), /only to explicit/u)
  assert.match(reason('browser_navigate', {}), /only to explicit/u)
})

test('guards URLs on new tabs while allowing ordinary semantic actions', () => {
  assert.equal(reason('browser_tabs', { action: 'new' }), undefined)
  assert.equal(reason('browser_tabs', { action: 'new', url: 'http://localhost:3000' }), undefined)
  assert.match(reason('browser_tabs', { action: 'new', url: 'https://example.com' }), /new dsh_ui tabs/u)
  assert.equal(reason('browser_click', { target: 'e12' }), undefined)
})
