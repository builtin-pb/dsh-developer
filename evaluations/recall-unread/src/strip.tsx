/**
 * The recall strip's React surface.
 *
 * Presentation only: it reads the current Session's queue through the
 * framework-supplied selector hook and calls the injected per-Session actions.
 * All classification and batch logic lives in `./actions.ts`.
 */
import { useCallback, useMemo, useState } from 'react';
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import {
  MESSAGE,
  classifyRecallError,
  recallMany,
  selectRecallItems,
  shorten,
  type RecallActions,
  type RecallItem,
} from './actions.js';

/** Slot this component is registered into (declared for its standard props). */
export const slot = 'conversation.input.dock';

interface Feedback {
  readonly level: 'info' | 'error';
  readonly text: string;
}

/** Per-row state that outlives one request but never outlives the snapshot row. */
type RowState = 'idle' | 'recalling' | 'recalled';

/**
 * Compact strip of unclaimed steering messages. Renders nothing when the
 * Session has none, so an idle composer keeps its normal geometry.
 *
 * @param props - standard slot props plus the injected recall face.
 */
export function RecallStrip({ useSession, recall, notify }: PropsRuntime<typeof slot> & RecallActions) {
  const items = useSession(selectRecallItems);
  const [rows, setRows] = useState<Readonly<Record<string, RowState>>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [announcement, setAnnouncement] = useState('');

  /**
   * Show one outcome inline and, in the same call, on the composer notice
   * channel.
   *
   * The notice is not redundant: removing the last pending row empties the
   * queue, so the strip renders `null` and unmounts while the recall request is
   * still in flight. A race lost at that moment can no longer be rendered
   * inline, and the composer notice is the only feedback left. Both channels
   * stay in sync for every outcome.
   */
  const report = useCallback(
    (next: Feedback) => {
      setFeedback(next);
      setAnnouncement(next.text);
      notify(next.level, next.text);
    },
    [notify],
  );

  const onRecallOne = useCallback(
    async (item: RecallItem) => {
      setRows(current => ({ ...current, [item.id]: 'recalling' }));
      setFeedback(null);
      try {
        await recall(item.id);
        setRows(current => ({ ...current, [item.id]: 'recalled' }));
        report({ level: 'info', text: MESSAGE.recalledOne });
      } catch (error) {
        // The removal failed, so drop the local mark: whatever is still
        // pending stays offered (and actionable) instead of looking settled.
        setRows(current => {
          const next = { ...current };
          delete next[item.id];
          return next;
        });
        const outcome = classifyRecallError(error);
        if (outcome.kind === 'claimed') report({ level: 'info', text: MESSAGE.claimed });
        else if (outcome.kind === 'closed') report({ level: 'info', text: MESSAGE.closed });
        else report({ level: 'error', text: MESSAGE.failed(item.preview) });
      }
    },
    [recall, report],
  );

  const onRecallAll = useCallback(async () => {
    setBatchBusy(true);
    setFeedback(null);
    setRows(current => {
      const next: Record<string, RowState> = { ...current };
      for (const item of items) next[item.id] = 'recalling';
      return next;
    });
    const result = await recallMany(items, recall);
    setBatchBusy(false);
    setRows(current => {
      const next: Record<string, RowState> = {};
      for (const [id, state] of Object.entries(current)) if (state !== 'recalling') next[id] = state;
      return next;
    });
    if (result === null) return;
    report(result);
  }, [items, recall, report]);

  const count = items.length;
  const listId = 'dsh-recall-local-list';
  const pending = batchBusy || Object.values(rows).some(state => state === 'recalling');

  const header = useMemo(() => {
    if (feedback !== null) return feedback.text;
    return count === 1 ? '1 unread message' : `${String(count)} unread messages`;
  }, [count, feedback]);

  if (count === 0) return null;

  return (
    <div data-dsh-recall-local="" style={stripStyle}>
      <div data-dsh-recall-local-card="" style={cardStyle}>
        <div style={headerRowStyle}>
          <span aria-hidden="true">↩</span>
          <span id={`${listId}-label`} style={labelStyle}>
            {header}
          </span>
          {count > 1 && (
            <button type="button" onClick={() => void onRecallAll()} disabled={pending} style={buttonStyle(pending)}>
              Recall all
            </button>
          )}
        </div>
        <ul id={listId} aria-labelledby={`${listId}-label`} style={listStyle}>
          {items.map(item => {
            const state = rows[item.id] ?? 'idle';
            const disabled = pending || state !== 'idle';
            return (
              <li key={item.id} data-recall-item={item.id} style={rowStyle}>
                <span title={item.preview} style={previewStyle}>
                  {item.preview}
                </span>
                <span style={state === 'recalled' ? recalledStyle : idleLabelStyle}>
                  {state === 'recalled' ? 'Recalled' : ''}
                </span>
                <button
                  type="button"
                  aria-label={`Recall ${shorten(item.preview, 120)}`}
                  onClick={() => void onRecallOne(item)}
                  disabled={disabled}
                  style={buttonStyle(disabled)}
                >
                  {state === 'recalling' ? 'Recalling…' : 'Recall'}
                </button>
              </li>
            );
          })}
        </ul>
        <span role="status" aria-live="polite" aria-atomic="true" style={visuallyHidden}>
          {announcement}
        </span>
      </div>
    </div>
  );
}

/**
 * Outer dock geometry, copied from the native `conversation.input.dock`
 * occupants: border-box sizing, the strip reserved by the conversation shell
 * for a dock row (composer side clearance plus this entry's own inset on each
 * side), and a content box aligned with the composer card. Without the
 * border-box width the intrinsic padding and border push the right-hand
 * controls past the content edge.
 */
const stripStyle = {
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px))',
  maxWidth: 'calc(var(--dsh-composer-card-max-width, 100%) - var(--dsh-composer-dock-inset, 8px) - var(--dsh-composer-dock-inset, 8px))',
  margin: '0 auto calc(0px - var(--dsh-composer-stack-gap, 6px) - 3px)',
  padding: '0 var(--dsh-composer-dock-inset, 8px)',
  flex: 'none',
  minWidth: 0,
} as const;

/** The visible card: full width of the dock row minus its inset, box-sizing border-box. */
const cardStyle = {
  boxSizing: 'border-box',
  width: '100%',
  margin: '0 auto',
  padding: '6px 8px',
  border: '1px solid var(--dsw-alias-border-l1, currentColor)',
  borderRadius: '8px',
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
  color: 'var(--dsw-alias-label-secondary, inherit)',
  fontSize: '12px',
  lineHeight: '18px',
} as const;

const headerRowStyle = { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } as const;

const labelStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

const rowStyle = {
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  width: '100%',
  minWidth: 0,
} as const;

const previewStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

/** Bounded like the native queue list so a long inbox scrolls instead of growing. */
const listStyle = {
  boxSizing: 'border-box',
  listStyle: 'none',
  margin: 0,
  padding: 0,
  maxHeight: '180px',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
} as const;

const idleLabelStyle = { flex: '0 0 auto' } as const;
const recalledStyle = { flex: '0 0 auto', color: 'var(--dsw-alias-label-tertiary, inherit)' } as const;

const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: '-1px',
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

function buttonStyle(disabled: boolean) {
  return {
    flex: '0 0 auto',
    padding: '2px 8px',
    border: '1px solid var(--dsw-alias-border-l1, currentColor)',
    borderRadius: '6px',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  } as const;
}
