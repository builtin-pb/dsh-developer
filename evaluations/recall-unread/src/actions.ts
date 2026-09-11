/**
 * Transport-free recall logic for `dsh-recall-local`.
 *
 * Everything here is a plain function over the Session queue snapshot and one
 * session-scoped removal verb, so the classification, preview, and batch
 * orchestration can be exercised without a browser or a React tree. The React
 * entry only renders what these functions decide.
 */
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client';

type QueueRow = SessionSnapshot['queue'][number];

/** One recallable steering occurrence as the strip presents it. */
export interface RecallItem {
  readonly id: string;
  readonly preview: string;
}

/** Outcome of one removal attempt. */
export type RecallOutcome =
  | { readonly kind: 'recalled' }
  | { readonly kind: 'claimed' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'failed'; readonly error: unknown };

/** Copy for each terminal outcome. A lost race is named, never reported as success. */
export const MESSAGE = {
  recalledOne: 'Unread message recalled.',
  recalledMany: (count: number) => `${String(count)} unread messages recalled.`,
  claimed: 'Already picked up by the model — nothing to recall.',
  closed: 'The turn stopped accepting steering messages.',
  failed: (preview: string) => `Could not recall “${shorten(preview)}”.`,
  failedMany: (failed: number) => `${String(failed)} of the unread messages could not be recalled.`,
} as const;
/** Bound the preview echoed in feedback copy so one long message cannot flood the strip. */
export function shorten(preview: string, limit = 40): string {
  const chars = Array.from(preview);
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : preview;
}

/** Readable preview for one queued occurrence: text blocks joined, whitespace collapsed. */
export function previewOf(content: QueueRow['content']): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type !== 'image' && block.type !== 'file') parts.push(`[${block.type}]`);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Full trimmed prompt text when every block is text; `null` for attachment-bearing input. */
export function textOf(content: QueueRow['content']): string | null {
  if (!content.every(block => block.type === 'text')) return null;
  return content.map(block => (block.type === 'text' ? block.text : '')).join('').trim();
}

/**
 * Whether one queue row may still be recalled.
 *
 * Claimed steering leaves the queue snapshot entirely, so presence here plus
 * the steering placement is the whole test. Rows without readable text are
 * excluded: a recalled attachment-only message would lose work the user cannot
 * see in the strip.
 */
export function isRecallable(row: QueueRow): boolean {
  if (row.placement !== 'steering') return false;
  const text = textOf(row.content);
  return text !== null && text !== '';
}

/** Project the queue snapshot onto strip rows in Host FIFO order. */
export function selectRecallItems(snapshot: SessionSnapshot): readonly RecallItem[] {
  return snapshot.queue.filter(isRecallable).map(row => ({ id: String(row.id), preview: previewOf(row.content) }));
}

/** Business face injected per Session by the registration. */
export interface RecallActions {
  /** Remove one still-pending steering occurrence from the Host inbox. */
  recall: (itemId: string) => Promise<void>;
  /** Surface one short outcome line in this Session's composer. */
  notify: (level: 'info' | 'error', text: string) => void;
}

/** Minimal session-scope face `createRecallActions` needs (satisfied by the real conversation service). */
export interface RecallVerbSource {
  /** The scope-addressed queue mutation verb. */
  updateQueue(itemId: never, action: { kind: 'remove' }): Promise<void>;
  /** The per-session composer notice outlet, addressed by a session-scoped context. */
  input: { for(scope: never): { notify(level: 'info' | 'error', text: string): void } };
}

/** Address and verb source for one Session's recall face. */
export interface RecallActionsInit {
  /** The session scope whose conversation service performs the removal. */
  conversation: RecallVerbSource;
  /** The same session's scoped context, used to route the composer notice. */
  scope: unknown;
}

/** Build the per-Session action face from one already-resolved session scope. */
export function createRecallActions(init: RecallActionsInit): RecallActions {
  return {
    recall: itemId => init.conversation.updateQueue(itemId as never, { kind: 'remove' }),
    notify: (level, text) => {
      init.conversation.input.for(init.scope as never).notify(level, text);
    },
  };
}

/** Classify one rejection from the removal verb. */
export function classifyRecallError(error: unknown): RecallOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('queue-item-not-found')) return { kind: 'claimed' };
  if (message.includes('steer-unavailable')) return { kind: 'closed' };
  return { kind: 'failed', error };
}

/** One visible outcome for a batch attempt. */
export interface BatchFeedback {
  readonly level: 'info' | 'error';
  readonly text: string;
}

/**
 * Recall every supplied row, oldest first.
 *
 * Sequential on purpose: each removal re-publishes the Session snapshot and
 * the remaining rows stay stable Host-side while the batch is walked. A row
 * the model claimed mid-batch resolves as `claimed` and is reported as such —
 * the batch continues so one race cannot leak the rest of the strip.
 */
export async function recallMany(
  items: readonly RecallItem[],
  recall: (itemId: string) => Promise<void>,
): Promise<BatchFeedback | null> {
  let recalled = 0;
  let claimed = 0;
  let closed = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await recall(item.id);
      recalled += 1;
    } catch (error) {
      const outcome = classifyRecallError(error);
      if (outcome.kind === 'claimed') claimed += 1;
      else if (outcome.kind === 'closed') closed += 1;
      else failed += 1;
    }
  }
  if (recalled === 0 && claimed === 0 && closed === 0 && failed === 0) return null;
  if (failed > 0) return { level: 'error', text: MESSAGE.failedMany(failed) };
  if (recalled > 0) return { level: 'info', text: recalled === 1 ? MESSAGE.recalledOne : MESSAGE.recalledMany(recalled) };
  // Nothing removed: name the race that actually happened, never success.
  if (claimed > 0) return { level: 'info', text: MESSAGE.claimed };
  return { level: 'info', text: MESSAGE.closed };
}
