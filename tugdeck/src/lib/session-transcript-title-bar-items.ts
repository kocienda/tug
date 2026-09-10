/**
 * The Session card's title-bar contribution: its four Go in Transcript verbs
 * as rows in the pane's `…` popup.
 *
 * A module of its own rather than a literal inside `session-card.tsx`, for the
 * same reason `session-card-close-advice.ts` is one: what belongs on a Session
 * card's title bar is a small standing policy, and a policy with an address
 * can be named by the test that guards it. The card imports it and publishes
 * it; nothing else about the card is involved.
 *
 * These four are ROWS, not buttons. Four is too many for the title bar's
 * control cluster, and stepping a transcript is a keyboard gesture first — the
 * popup is where a verb that is one of many, and reached rarely by pointer,
 * belongs.
 *
 * Why the card publishes them at all: the turn family moved off the ⌥⌘ arrows
 * onto the bracket band ([D184]) so the arrows could carry directional card
 * focus, and that move costs every hand that had learned ⌥⌘↑. These rows are
 * the payment — each one renders the command table's own chord through
 * `commandShortcut`, so the card itself says where the verb went.
 *
 * Membership only. Whether a row is live is the registry's answer, asked of
 * the same chain the chord and the native menu item ask, so a card with an
 * empty transcript shows four dimmed rows rather than an empty menu.
 *
 * @module lib/session-transcript-title-bar-items
 */

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";

import type { PaneTitleBarItem } from "./pane-title-bar-items-store";

/**
 * The family in the order the native Session ▸ Go in Transcript submenu lists
 * it. One order for both surfaces: a reader who learns one has learned both.
 *
 * No `unavailableHint` — the popup's rows carry no tooltip to hang one on
 * (only a standing button does), so a phrase here would be a field nothing
 * reads.
 */
export const SESSION_TRANSCRIPT_TITLE_BAR_ITEMS: readonly PaneTitleBarItem[] = [
  { commandId: TUG_ACTIONS.PREVIOUS_TURN },
  { commandId: TUG_ACTIONS.NEXT_TURN },
  { commandId: TUG_ACTIONS.FIRST_TURN },
  { commandId: TUG_ACTIONS.LAST_TURN },
];
