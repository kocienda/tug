/**
 * ArcStepItems — an arc's plan ledger as numbered popup-list items.
 *
 * One row per ledger line: the ordinal, the title, and a pulsing dot whose
 * state is the status cell put through {@link ledgerRowState}. Nothing here is
 * derived — the title is the ledger's spelling of the title, and the ordinal is
 * the row's position, which is the step number the plan itself uses and the
 * number an arc's fraction counts against.
 *
 * The dot's liveness comes in as `live` and is the **arc's**, not the holder
 * card's: an arc between rounds is still walking, and the ticks on the track
 * beside this list are drawn from that same fact.
 *
 * **It lives here rather than beside the `ARC` placard because it is not the
 * placard's.** The placard was its first surface and for a while its only one;
 * the Arcs card row folds open to the same ledger, and a row that says a step
 * is running on one surface and pending on another is the disagreement this
 * module exists to make impossible. Every surface that shows an arc's steps
 * mounts this component.
 * The decision is [D176].
 *
 * **The rows are self-contained.** The three rules that make the list read as
 * prose rather than as a table — the muted tabular ordinal, the finished row's
 * strikethrough, and the 22px lead column with the sans face — are paid for on
 * the row itself in this module's own CSS, so the list carries its reading
 * wherever it mounts and needs nothing from the surface around it.
 *
 * **A fragment, not a frame.** The caller supplies the scroller or the
 * container and its `data-slot`; what this renders is the rows.
 *
 * Laws: [L02] every value arrives as a prop — this file reads no store;
 * [L06] the finished-row cue paints through `data-status`, never React state;
 * [L13] the pulse is `TugProgressIndicator`'s; [L19] `.tsx` / `.css` pair,
 * docstring, `data-slot`; [L20] the composed `TugPopupList` /
 * `TugProgressIndicator` primitives keep their own tokens.
 *
 * @tug-pairings TugPopupListItem TugProgressIndicator
 *
 * @module components/tugways/arc-step-list
 */

import "./arc-step-list.css";

import React from "react";

import type { ArcStep } from "@/lib/changeset-types";
import { ledgerRowState } from "@/lib/code-session-store/indicator-liveness";
import {
  TugPopupListItem,
  TugPopupListItemText,
} from "@/components/tugways/tug-popup-list";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";

export function ArcStepItems({
  steps,
  live,
}: {
  steps: ReadonlyArray<ArcStep>;
  /**
   * Whether the arc is under way — `ArcTrackModel.live`, never a card's own
   * idleness. A surface that hands this its holder's turn state rests every
   * dot in the seconds between rounds, which is exactly the window a walking
   * arc spends most of its life in.
   */
  live: boolean;
}): React.ReactElement {
  return (
    <>
      {steps.map((step, index) => (
        <TugPopupListItem
          // The ledger is a table with one row per step, so position is
          // identity — two rows may legitimately carry the same title.
          key={index}
          className="arc-step-list-item"
          data-slot="arc-step"
          data-status={step.status}
          indicator={
            <TugProgressIndicator
              variant="pulsing-dot"
              size={17}
              state={ledgerRowState(step.status, live)}
              aria-label={`step ${step.status}`}
            />
          }
        >
          <TugPopupListItemText
            primary={
              <>
                <span className="arc-step-list-ordinal">{index + 1}.</span>
                {step.title}
              </>
            }
          />
        </TugPopupListItem>
      ))}
    </>
  );
}
