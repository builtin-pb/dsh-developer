import type { Context } from '@deepseek-ai/cordis';
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';

export const name = 'session-status';
export const inject = ['slots', 'uiSession'];
export const slot = 'conversation.session.header.actions';

/** Return a primitive so unrelated snapshot updates do not rerender the label. */
function selectStatus(snapshot: SessionSnapshot) {
  if (snapshot.removed) return 'removed';
  if (snapshot.openState === 'error') return 'unavailable';
  if (snapshot.openState !== 'open') return 'loading';
  return snapshot.running ? 'running' : 'idle';
}

/** DSH supplies the current Session hook and owns its subscription and rebinding. */
function SessionStatus({ useSession }: PropsRuntime<typeof slot>) {
  const status = useSession(selectStatus);
  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-session-status={status}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4em',
        padding: '3px 6px',
        border: '1px solid var(--dsw-alias-border-l1, currentColor)',
        borderRadius: '6px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true">{status === 'running' ? '●' : '○'}</span>
      <span>Session: {status}</span>
    </span>
  );
}

/** Wait for each header declaration lifetime; Cordis removes the effect on unload. */
export function apply(ctx: Context): void {
  ctx.slots.inject(slot, () => ctx.slots.register({
    name: slot,
    id: 'dsh-session-status',
    order: 100,
  }, SessionStatus));
}
