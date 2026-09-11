/**
 * Slot registration for `dsh-recall-local`.
 *
 * Kept apart from the React surface so the entry module has one job: wait for
 * the native dock declaration and contribute the strip into the addressed
 * Session's scope. Cordis removes the entry when the plugin unloads, which is
 * what makes disabling the plugin remove the strip.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { createRecallActions, type RecallActions } from './actions.js';
import { RecallStrip } from './strip.js';

/** Slot the strip contributes into: full-width entries directly above the composer card. */
export const slot = 'conversation.input.dock';

/** Registration id; the native queue dock uses order 20, so 10 keeps this above it. */
export const entryId = 'recall-unread';

/** Order of this entry inside `conversation.input.dock`. */
export const entryOrder = 10;

/**
 * Contribute the recall strip once the native dock declaration exists.
 *
 * The injected face is built from the addressed Session scope, which is what
 * keeps every row, notice, and removal bound to the Session whose composer is
 * on screen: switching Sessions rebinds the scope and re-renders that Session's
 * queue.
 *
 * @param ctx - plugin context (root).
 */
export function install(ctx: Context): void {
  ctx.slots.inject(slot, () =>
    ctx.slots.register(
      {
        name: slot,
        id: entryId,
        order: entryOrder,
        inject: (sessionId: SessionId) => {
          const session = ctx.sessions.scope(sessionId);
          if (session === undefined) throw new Error(`recall-local: session "${String(sessionId)}" resolved no scope`);
          const conversation = session.get('conversation');
          if (conversation === undefined) throw new Error('recall-local: conversation service unavailable');
          return createRecallActions({ conversation, scope: session });
        },
      },
      RecallStrip as (props: PropsRuntime<typeof slot> & RecallActions) => ReturnType<typeof RecallStrip>,
    ),
  );
}
