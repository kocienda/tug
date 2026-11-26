/**
 * The Sketch panel's content for an arc's or a cycle's record of where the
 * work came from: what is wanted, then the shape the work will take.
 *
 * Shared by the arc shade's three panels and the cycle shade's sketch assets,
 * which show the same record the same way. Styled by the panels' own sheet
 * (`.session-arc-panel-text`); this module adds none.
 *
 * Laws: [L19] component authoring guide, [L20] composes `TugEmptyLine`, which
 *       keeps its own tokens
 */

import React from "react";

import { TugEmptyLine } from "@/components/tugways/tug-empty-line";
import { parseArcRecord } from "@/lib/arc-record-text";

import type { SessionArcPanel } from "./session-arc-panels";

/**
 * A rung nothing records yet: an empty seat, which says so as every empty
 * list in the app does, with the one centred word.
 */
export const NOT_RECORDED: SessionArcPanel = {
  state: "pending",
  body: <TugEmptyLine>None</TugEmptyLine>,
};

/**
 * The Sketch panel for a record: its opening paragraph, what is wanted, then
 * the approach and the list under it, or the empty seat when there is none,
 * as an arc opened before records were kept has none.
 */
export function recordPanel(text: string | undefined): SessionArcPanel {
  if (text === undefined || text.trim() === "") return NOT_RECORDED;
  return {
    state: "done",
    body: (
      <div className="session-arc-panel-text" data-slot="session-arc-panel-text">
        {parseArcRecord(text).map((block, index) =>
          block.kind === "paragraph" ? (
            <p key={index}>{block.text}</p>
          ) : (
            <ul key={index}>
              {block.items.map((item, at) => (
                <li key={at}>{item}</li>
              ))}
            </ul>
          ),
        )}
      </div>
    ),
  };
}
