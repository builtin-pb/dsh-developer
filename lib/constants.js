export const PRODUCT_NAME = 'dsh-developer'
export const PRODUCT_VERSION = '0.1.0'
export const SLOGAN = 'The single plugin you need for DSH'
export const CREATOR_FORMAT = 'dsh-creator-export'
export const CREATOR_SCHEMA_VERSION = 1
export const DSH_COMPATIBILITY_TARGET = '0.1.1-rc.2'
export const DSH_PREVIEW_TARGET = '0.1.2-alpha.3'

export const LIMITS = Object.freeze({
  creatorBytes: 256 * 1024,
  fileBytes: 512 * 1024,
  treeBytes: 4 * 1024 * 1024,
  fileCount: 256,
  treeEntries: 1024,
  pathBytes: 240,
  descriptionChars: 240,
  shortTextChars: 2_000,
  longTextChars: 24_000,
  listItems: 64,
  toolItems: 32,
  commandOutputBytes: 512 * 1024,
  commandTimeoutMs: 60_000,
})
