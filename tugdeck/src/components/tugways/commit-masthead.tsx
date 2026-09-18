/**
 * CommitMasthead — the masthead tier for a Commit card.
 *
 * The three lines are the History shade's row header, re-seated in chrome: the
 * commit's pill, its subject, then author · date · time. Like `CardMasthead`
 * beside it, this is a COMPOSITION of `TugSessionRow` on the shared
 * `masthead-frame.css` tier and not a second authoring of either — the type,
 * the leading, the truncation and the sub-line indent are all the row's, and
 * what is genuinely a commit's own lives here.
 *
 * **The lead line is a pill, which is why this kind exists.** A document
 * masthead's title is a string, so it cannot carry `TugCommitAtom` — the mark
 * every commit surface wears ([P10]). The row takes nodes at every level, so a
 * commit gets its mark by handing one in.
 *
 * **The pill stands in the `name` slot, not the indicator column.** The
 * indicator is for a mark that leads a NAME — a phase dot, a document glyph —
 * and a commit's pill IS its name. Standing it in the column would leave the
 * name line empty beside it and split one run across two verticals.
 *
 * **The third line borrows `CommitMetaCell`**, the same cell a History row's
 * trailing metadata is, with all three fields on: the card's masthead is the
 * one place a commit's author, date and time are all stated, which is what
 * lets the card's body end at the file roster ([B03]).
 *
 * The tier answers a right-click for the whole of its three lines with the
 * commit's own menu, Open Diff included — that is how the whole-commit diff
 * stays one gesture from the card without the body growing a button — and
 * Open Commit dropped, since this card is the one that item would raise. The
 * record rides the payload for that menu's sake: its copy items state a
 * commit's message and roster, and a tier holding only its three drawn lines
 * would copy less of a commit than the History row does.
 *
 * Laws: [L06] appearance is CSS, never React state; [L19] `.tsx`/`.css` pair
 *       with a `data-slot`; [L20] compose — the tier, the row, the pill and
 *       the meta cell are all borrowed.
 *
 * @module components/tugways/commit-masthead
 */

import React from "react";

import type { CommitMastheadPayload } from "@/lib/card-title-store";
import { TugSessionRow } from "@/components/tugways/tug-session-row";
import { TugCommitAtom } from "@/components/tugways/tug-commit-atom";
import {
  CommitMetaCell,
  type CommitMetaField,
} from "@/components/tugways/commit-presentation";
import { useCommitIdentityMenu } from "@/components/tugways/commit-identity-menu";

import "./masthead-frame.css";
import "./commit-masthead.css";

/**
 * All three, always. A History row's reader chooses which of these the row
 * carries because a list is a column of many; a masthead states one commit
 * whole, and the line it is spending is the one the body gave up.
 */
const MASTHEAD_META_FIELDS: readonly CommitMetaField[] = ["author", "date", "time"];

export interface CommitMastheadProps {
  /** The card's published request, minus its discriminant. */
  payload: CommitMastheadPayload;
}

export function CommitMasthead({
  payload,
}: CommitMastheadProps): React.ReactElement {
  // The commit's own menu, claimed for the whole tier. `canOpenDiff` is what
  // this surface adds over a History row's: the row's diff is the shade
  // beneath it, and a card's is nowhere else.
  const menu = useCommitIdentityMenu({
    commit: {
      sha: payload.sha,
      subject: payload.subject,
      author: payload.author,
      dateIso: payload.dateIso,
      // The whole record, so Copy Commit Record writes the same bytes here as
      // it does on the History row for the same commit. The tier does not
      // DRAW these; it states them.
      body: payload.body,
      email: payload.authorEmail,
      files: payload.files,
      paths: payload.files.map((file) => file.path),
    },
    root: payload.root,
    canOpenDiff: true,
    // This card IS the commit's card; an item raising the card the reader is
    // already looking at is a row that does nothing.
    canOpenCommit: false,
  });

  return (
    <>
      <div
        className="commit-masthead tug-masthead-frame"
        data-slot="commit-masthead"
        data-testid="commit-masthead"
        ref={menu.ref as React.Ref<HTMLDivElement>}
        onContextMenuCapture={menu.onContextMenu}
      >
        <TugSessionRow
          className="commit-masthead-row tug-masthead-frame-row"
          /* The two lines below start where the pill's own ink does, the same
             setting both mastheads beside this one pass. */
          subAlign="title"
          name={
            <TugCommitAtom sha={payload.sha} data-testid="commit-masthead-atom" />
          }
          /* ALWAYS rendered, empty string and all — the description is what
             tells the row it is wearing the three-level stack, so omitting it
             would hand the tier a two-line row's whole geometry rather than
             merely dropping a line. A card raised from prose knows a sha and
             nothing else until the record lands, and the empty run holds the
             band until it does. */
          description={
            <span
              className="commit-masthead-subject"
              data-testid="commit-masthead-subject"
            >
              {payload.subject}
            </span>
          }
          /* The row always draws its last level; an empty cell holds the band
             while the record is still in flight. */
          activity={
            payload.author === "" && payload.dateIso === "" ? (
              ""
            ) : (
              <CommitMetaCell
                author={payload.author}
                iso={payload.dateIso}
                fields={MASTHEAD_META_FIELDS}
              />
            )
          }
        />
      </div>
      {/* Beside the tier, never inside it: the menu carries its own
          `ResponderScope`, and mounting that within the tier would put it on
          the chain BELOW the responder its items dispatch to. */}
      {menu.contextMenu}
    </>
  );
}
