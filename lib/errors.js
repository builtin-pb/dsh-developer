export class DshDeveloperError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DshDeveloperError'
    this.code = code
    this.details = details
  }
}

export function asDiagnostic(error) {
  if (error instanceof DshDeveloperError) {
    return {
      code: error.code,
      message: error.message,
      ...error.details,
    }
  }
  return {
    code: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : String(error),
  }
}
