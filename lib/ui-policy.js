import { UI_PROTECTED_NAMESPACE } from './ui-capabilities.js'

const PREFIX = 'mcp__' + UI_PROTECTED_NAMESPACE + '__'
const DENIED = new Set([
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_file_upload',
  'browser_drop',
  'evaluate_script',
  'upload_file',
  'execute_3p_developer_tool',
  'install_extension',
  'uninstall_extension',
  'install_pwa',
  'uninstall_pwa',
])
const ALLOWED = new Set([
  'browser_click',
  'browser_close',
  'browser_console_messages',
  'browser_drag',
  'browser_fill_form',
  'browser_find',
  'browser_handle_dialog',
  'browser_hover',
  'browser_navigate',
  'browser_navigate_back',
  'browser_network_request',
  'browser_network_requests',
  'browser_press_key',
  'browser_resize',
  'browser_select_option',
  'browser_snapshot',
  'browser_tabs',
  'browser_take_screenshot',
  'browser_type',
  'browser_wait_for',
  'click',
  'close_page',
  'fill',
  'fill_form',
  'get_network_request',
  'handle_dialog',
  'hover',
  'list_console_messages',
  'list_network_requests',
  'list_pages',
  'navigate_page',
  'new_page',
  'performance_analyze_insight',
  'performance_start_trace',
  'performance_stop_trace',
  'press_key',
  'resize_page',
  'select_page',
  'take_screenshot',
  'take_snapshot',
  'wait_for',
])
const URL_OPERATIONS = new Set(['browser_navigate', 'navigate_page', 'new_page'])

function isLoopbackUrl(value) {
  if (value === 'about:blank') return true
  if (typeof value !== 'string' || value.length === 0) return false
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username.length > 0 || url.password.length > 0) return false
  return url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
}

export function uiSafetyGuardReason(exec) {
  if (exec === null || typeof exec !== 'object' || typeof exec.name !== 'string') return undefined
  if (!exec.name.startsWith(PREFIX)) return undefined
  const rawName = exec.name.slice(PREFIX.length)
  if (DENIED.has(rawName)) {
    return 'dsh-developer denies code execution, file transfer, installation, and storage-bearing UI tools in the protected dsh_ui namespace.'
  }
  if (!ALLOWED.has(rawName)) {
    return 'dsh-developer denies UI tools outside the closed semantic allowlist in the protected dsh_ui namespace.'
  }
  const args = exec.arguments
  if (URL_OPERATIONS.has(rawName)) {
    const url = args !== null && typeof args === 'object' ? args.url : undefined
    if (!isLoopbackUrl(url)) {
      return 'dsh-developer admits dsh_ui navigation only to explicit HTTP(S) loopback URLs.'
    }
  }
  if (rawName === 'browser_tabs'
      && args !== null
      && typeof args === 'object'
      && args.action === 'new'
      && args.url !== undefined
      && !isLoopbackUrl(args.url)) {
    return 'dsh-developer admits new dsh_ui tabs only at explicit HTTP(S) loopback URLs.'
  }
  return undefined
}

export function registerUiSafetyGuard(ctx) {
  return ctx.tools.guard(uiSafetyGuardReason)
}
