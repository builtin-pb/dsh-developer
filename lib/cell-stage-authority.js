import { DshDeveloperError } from './errors.js'

const factories = new WeakMap()

export function createCellStageAuthorityFactory(factory) {
  if (typeof factory !== 'function') {
    throw new DshDeveloperError('CELL_STAGE_AUTHORITY_INVALID', 'A stage-authority factory must be a function.')
  }
  const capability = Object.freeze(Object.create(null))
  factories.set(capability, { factory, claimed: false })
  return capability
}

export async function claimCellStageAuthority(capability) {
  const entry = capability !== null && typeof capability === 'object'
    ? factories.get(capability)
    : undefined
  if (entry === undefined || entry.claimed) {
    throw new DshDeveloperError(
      'CELL_STAGE_AUTHORITY_INVALID',
      'Result staging requires one unclaimed controller-minted authority capability.',
    )
  }
  entry.claimed = true
  const authority = await entry.factory()
  if (authority === null || typeof authority !== 'object'
      || typeof authority.root !== 'string'
      || typeof authority.destination !== 'string') {
    throw new DshDeveloperError(
      'CELL_STAGE_AUTHORITY_INVALID',
      'The controller-minted stage authority did not resolve to its exact root and result directory.',
    )
  }
  return Object.freeze({
    capability,
    root: authority.root,
    destination: authority.destination,
  })
}
