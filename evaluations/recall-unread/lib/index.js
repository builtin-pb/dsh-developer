/**
 * Host entry for `dsh-recall-local`.
 *
 * This is the module DSH's bundle patch mounts, so it must export `apply`
 * directly (`lib/index.js` is this file, copied verbatim by `build.mjs`). The
 * interface is defined once on the Web Client; the Host half exists only to
 * make the package discoverable and owns no services, configuration, or
 * remote calls.
 */

/** Stable Cordis plugin name. */
export const name = 'recall-local';

/** No Host services are needed. */
export function apply() {}
