/**
 * `dsh-recall-local` Web Client entry.
 *
 * Shows the current Session's still-unclaimed steering messages in a compact
 * strip above the composer and removes one (or all) on request. "Unclaimed"
 * means the occurrence still sits in the Host Agent inbox `next-step` list,
 * which is exactly the `placement: 'steering'` rows of the authoritative
 * Session queue snapshot. Once the model claims a row it leaves that snapshot,
 * so it stops being recallable by construction and this strip never offers it.
 */
/// <reference types="@deepseek-ai/dsh-api-session-controller/client" />
import type { Context } from '@deepseek-ai/cordis';
import { install } from './install.js';

export { MESSAGE, isRecallable, previewOf, textOf, selectRecallItems, type RecallItem } from './actions.js';
export { RecallStrip, slot } from './strip.js';
export { entryId, entryOrder } from './install.js';

/** Stable Cordis plugin name. */
export const name = 'recall-local';

/** Services that must exist before the strip can be contributed. */
export const inject = ['slots', 'sessions'];

/**
 * Client plugin entry: DSH calls this with the client root context.
 *
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  install(ctx);
}
