/**
 * Compile-time-only structural checks. `tsc --noEmit` type-checks this file,
 * so it proves the plugin's narrow faces accept the real installed DSH
 * services, and that the slot it registers into is the native declaration.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots';
import type { RecallVerbSource } from '../src/actions.js';
import * as client from '../src/client.js';
import { RecallStrip } from '../src/strip.js';

declare const conversation: IConversation;
declare const session: Context;

/** The real conversation service satisfies the narrow recall verb face. */
const verbSource: RecallVerbSource = conversation;

/** The entry registers into a list-scoped session slot with no owner share. */
type DockSlot = SlotMap['conversation.input.dock'];
const dockKind: DockSlot['kind'] = 'list';
const dockScope: DockSlot['scope'] = 'session';

/** The entry registers into that exact slot key. */
const registeredInto: 'conversation.input.dock' = client.slot;

/** The addressed Session scope is a real Cordis Context. */
const scopeIsContext: Context = session;

/** The strip is a plain callable component (the shape `register` accepts). */
const stripIsComponent: (props: never) => unknown = RecallStrip;

export const checks = [verbSource, dockKind, dockScope, registeredInto, scopeIsContext, stripIsComponent, client.entryId];
