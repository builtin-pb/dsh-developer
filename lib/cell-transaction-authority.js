import { DshDeveloperError } from './errors.js'

const factories = new WeakMap()

export function createCellTransactionAuthorityFactory(factory) {
  if (typeof factory !== 'function') {
    throw new DshDeveloperError(
      'CELL_TRANSACTION_AUTHORITY_INVALID',
      'A transaction-authority factory must be a function.',
    )
  }
  const capability = Object.freeze(Object.create(null))
  factories.set(capability, { factory, claimed: false })
  return capability
}

export async function claimCellTransactionAuthority(capability) {
  const entry = capability !== null && typeof capability === 'object'
    ? factories.get(capability)
    : undefined
  if (entry === undefined || entry.claimed) {
    throw new DshDeveloperError(
      'CELL_TRANSACTION_AUTHORITY_INVALID',
      'Source application requires one unclaimed controller-minted transaction capability.',
    )
  }
  entry.claimed = true
  const authority = await entry.factory()
  if (authority === null || typeof authority !== 'object'
      || typeof authority.root !== 'string'
      || typeof authority.backup !== 'string'
      || typeof authority.candidate !== 'string'
      || typeof authority.held !== 'string') {
    throw new DshDeveloperError(
      'CELL_TRANSACTION_AUTHORITY_INVALID',
      'The controller-minted transaction capability did not resolve to its exact private paths.',
    )
  }
  return Object.freeze({ capability, ...authority })
}
