/**
 * session-minimize-control.tsx — the card's one minimize control, seated at
 * the leading edge of Z2.
 *
 * ## One control, one seat, two glyphs
 *
 * The verb used to wear two faces in two places: a Z4-lead button in the
 * prompt entry while the card was open, and a full-width Show Transcript bar
 * under Z2 while it was minimized. Two seats for one verb meant the control
 * moved when the card changed form — the reader had to find it again — and the
 * minimized form paid a whole band for a door the open form already had a
 * button for. Both retire here ([B03]–[B06]): the control stands at the
 * leading edge of the Z2 status row in BOTH forms, and only its glyph and its
 * label change with the flag.
 *
 * `ChevronsDownUp` collapses, `ChevronsUpDown` expands — the same pair the two
 * old seats used, now on one button, so the glyph is the whole of what the
 * form change costs the reader.
 *
 * ## Why it is authored outside the strip's focus refusal
 *
 * `.session-card-status-bar-main` carries `data-tug-focus="refuse"` so that
 * clicking a status cell or a gap never pulls the caret off the editor
 * ([F07]). That is right for instruments and wrong for a door: a control the
 * user presses is a control the keyboard can rest on. So the seat is a SIBLING
 * of `-main` inside the strip rather than a child of it — inside the strip's
 * box, outside its refusal — and the cells and the gaps keep refusing exactly
 * as they did.
 *
 * ## The seat in the cycle
 *
 * Minimized, it is the one live stop in the card that is not a Z2 cell, and it
 * is the card's Return-home: `persistentDefaultRing` registers it as the
 * scope's default button, which is what makes Return mean "show the
 * transcript" while the transcript, the find bar and the composer are all
 * `inert`. It takes that role at the order the Show Transcript bar held it —
 * one below the Z2 cells.
 *
 * Open, the same seat is just the stop before the cells, and it declares no
 * default ring: Return belongs to the composer's submit there, and a second
 * persistent mark in a card that already has one is the thing [P08]'s
 * one-mark-per-scope rule exists to prevent.
 *
 * `outlined`, not `ghost`: ghost carries no `[data-default-ring]` arm, so it
 * could never wear the Return mark the minimized form needs ([P08]).
 *
 * The button is a plain door onto the same `toggle-session-minimized` command
 * the toolbar button and the menu item reach ([P02], [L11]).
 */

import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugActionTooltip } from "@/components/tugways/tug-action-tooltip";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { dispatchCommand } from "@/command-dispatch";

import "./session-minimize-control.css";

export interface SessionMinimizeControlProps {
  /** Whether the card's pane currently wears the minimized form ([P01]). */
  minimized: boolean;
  /** The card cycle's focus group — `SESSION_CYCLE_GROUP`. */
  focusGroup: string;
  /** The control's order within it — `SESSION_CYCLE_ORDER_MINIMIZE`. */
  focusOrder: number;
}

export function SessionMinimizeControl({
  minimized,
  focusGroup,
  focusOrder,
}: SessionMinimizeControlProps): React.ReactElement {
  const label = minimized ? "Show Transcript" : "Minimize";
  return (
    <div
      className="session-card-minimize-control"
      data-slot="session-minimize-control"
    >
      <TugActionTooltip
        action={TUG_ACTIONS.TOGGLE_SESSION_MINIMIZED}
        content={label}
      >
        <TugPushButton
          subtype="icon"
          emphasis="outlined"
          role="action"
          size="sm"
          aria-label={label}
          // Only the minimized form has a Return to give away — see the
          // docblock. Open, the composer's submit is the card's Return.
          persistentDefaultRing={minimized}
          focusGroup={focusGroup}
          focusOrder={focusOrder}
          icon={
            minimized ? (
              <ChevronsUpDown size={14} aria-hidden="true" />
            ) : (
              <ChevronsDownUp size={14} aria-hidden="true" />
            )
          }
          onClick={() => dispatchCommand(TUG_ACTIONS.TOGGLE_SESSION_MINIMIZED)}
        />
      </TugActionTooltip>
    </div>
  );
}
