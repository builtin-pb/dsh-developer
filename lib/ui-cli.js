import { DshDeveloperError } from './errors.js'
import {
  formatUiCliReport,
  PLAYWRIGHT_CLI_CONTRACT_VERSION,
  resolveUiCliConfiguration,
  UI_CLI_ENVIRONMENT,
  UI_CLI_OPERATIONS,
  UiCliController,
  uiCliConfigurationRequested,
} from './ui-cli-internal.js'

export {
  formatUiCliReport,
  PLAYWRIGHT_CLI_CONTRACT_VERSION,
  UI_CLI_ENVIRONMENT,
  UI_CLI_OPERATIONS,
  uiCliConfigurationRequested,
}

function validateExecutionOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some((key) => key !== 'signal')) {
    throw new DshDeveloperError('UI_OPTIONS_INVALID', 'UI options accept only signal.')
  }
}

function validateControllerOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).length > 0) {
    throw new DshDeveloperError('UI_OPTIONS_INVALID', 'UI controller creation does not accept options.')
  }
}

export async function createUiCliController(options = {}) {
  validateControllerOptions(options)
  const configuration = await resolveUiCliConfiguration()
  return new UiCliController(configuration)
}

export async function executeUiCliAction(sessionId, input, options = {}) {
  validateExecutionOptions(options)
  const controller = await createUiCliController()
  return controller.execute(sessionId, input, options)
}
