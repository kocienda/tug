/**
 * session-show-transcript-bar.tsx — the minimized Session card's one control.
 *
 * A minimized card is instruments only ([B01]): the masthead's beat, the Z2
 * status row, and this bar. Everything the card can still be asked to do from
 * that form is one thing — show the transcript again — so the bar is one
 * full-width button and nothing else.
 *
 * It is CHROME that comes and goes with the form, not content that folds. The
 * transcript, the find bar and the composer are all kept mounted while
 * minimized ([L26], [B05] "the composer folds rather than unmounts") because
 * unmounting them would throw away a draft, a scroll position and a find
 * session; the bar has no such state, exists only in the minimized form, and
 * mounting it conditionally is what keeps the open card's DOM unchanged.
 *
 * `outlined`, not `ghost` and not `primary` — the argument is [P08]'s: ghost
 * carries no `[data-default-ring]` arm, so it could never wear the Return
 * mark it wears here; `primary`'s rest is a static tint, so a wall of ten
 * minimized cards would show ten tinted bars. `outlined` is the doctrine's
 * Rest, carries the promotion arm, and leaves the wall reading as one lit bar
 * over nine at rest.
 *
 * `persistentDefaultRing` is the explicit "this button is the scope's
 * Return-home" declaration ([P08]): it registers the bar as the default button
 * AND lights its ring while the keyboard rests anywhere else in the card, which
 * is honest here because nothing else in the minimized form consumes Return —
 * the transcript, the find bar and the composer are all `inert`. The cycle seat
 * arrives as props rather than an import: the orders are session-card.tsx's
 * (Table T01) and the card already imports this file, so reading them back the
 * other way would be a cycle.
 *
 * The button is a plain door onto the same `toggle-session-minimized` command
 * the toolbar button and the menu item reach ([P02], [L11]).
 */

import { ChevronsUpDown } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { dispatchCommand } from "@/command-dispatch";

import "./session-show-transcript-bar.css";

export interface SessionShowTranscriptBarProps {
  /** The card cycle's focus group — `SESSION_CYCLE_GROUP`. */
  focusGroup: string;
  /** The bar's order within it — `SESSION_CYCLE_ORDER_SHOW_TRANSCRIPT`. */
  focusOrder: number;
}

export function SessionShowTranscriptBar({
  focusGroup,
  focusOrder,
}: SessionShowTranscriptBarProps): React.ReactElement {
  return (
    <div
      className="session-card-show-transcript"
      data-slot="session-show-transcript"
    >
      <TugPushButton
        className="session-card-show-transcript-button"
        emphasis="outlined"
        role="action"
        size="xs"
        subtype="icon-text"
        persistentDefaultRing
        focusGroup={focusGroup}
        focusOrder={focusOrder}
        icon={<ChevronsUpDown size={14} aria-hidden="true" />}
        onClick={() => dispatchCommand(TUG_ACTIONS.TOGGLE_SESSION_MINIMIZED)}
      >
        Show Transcript
      </TugPushButton>
    </div>
  );
}
