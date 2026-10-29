/**
 * The refusal block: why a join will not proceed, as one sentence and then one
 * path per row.
 *
 * A refusal reaches the deck as a string, and the string may name files. This
 * is the one component that draws it, mounted in the join fold's refusal
 * band and in the ledger's withheld candidate, so the two seats cannot read
 * the same string two ways. The sentence is the block's first line and the
 * paths are arc fold rows beneath it — the commit receipt's grammar, one file
 * per row, rather than a paragraph of names ([L31]: a join that will not
 * proceed says why, legibly).
 *
 * Laws: [L02] the detail arrives as a prop from the caller's store read;
 * [L06] the rows paint through the fold's own classes and `data-*`, never
 * React state; [L19] it pairs with `session-changes-arc-fold.css`, which the
 * fold row already imports.
 *
 * @module components/tugways/cards/session-changes/session-changes-join-refusal
 */

import "./session-changes-arc-fold.css";

import React from "react";

import {
  ArcFoldCell,
  ArcFoldRow,
} from "@/components/tugways/cards/session-changes/session-changes-arc-fold-row";
import { parseJoinRefusal } from "@/lib/join-refusal";

export interface JoinRefusalBlockProps {
  /** The refusal as the server wrote it. */
  detail: string;
  /** The slot the block's root carries, named for the seat it sits in. */
  slot: string;
  /**
   * False when the seat's own identity line already says the sentence — the
   * ledger's withheld candidate — so only the rows are drawn.
   */
  sentence?: boolean;
}

/** One refusal: its sentence, then its paths as rows. */
export function JoinRefusalBlock({
  detail,
  slot,
  sentence = true,
}: JoinRefusalBlockProps): React.ReactElement {
  const refusal = parseJoinRefusal(detail);
  return (
    <div className="session-changes-join-refusal" data-slot={slot}>
      {sentence ? (
        <span className="session-changes-join-refusal-sentence">{refusal.sentence}</span>
      ) : null}
      {refusal.paths.length > 0 ? (
        <div className="session-changes-join-refusal-paths">
          {refusal.paths.map((path) => (
            <ArcFoldRow
              key={path}
              wrapperProps={{ "data-slot": "session-changes-join-refusal-path" }}
              leading={<ArcFoldCell tone="danger" />}
            >
              <span className="arc-fold-path arc-fold-path-danger">{path}</span>
            </ArcFoldRow>
          ))}
        </div>
      ) : null}
    </div>
  );
}
