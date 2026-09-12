/**
 * cards-session-cell.tsx — the session *monitor* row, as it appears for a
 * single-card session pane in the Cards card:
 *
 *   [dot] <session name>^<arc> ⚒ 7/12           <slot layout>
 *   <description>
 *   <latest beat line>                        <activity sparkline>
 *
 * Three lines, always. A session on a counted arc swaps its dot for the step
 * ring and carries the stage glyph and the count on the title line — all of
 * it `SessionIdentityRow`'s own doing, so the row here has nothing arc-shaped
 * to assemble. The fourth line this row used to grow when bound is retired:
 * the title carries the progress in the width the hidden callsign freed, and
 * the step's title is the fraction's hover sentence wherever a fraction is
 * drawn.
 *
 * The middle line is the agent's rolling description of the session, with the
 * session's creation date standing in until one is written — so the row is the
 * same height whatever the session is doing, and a deck with no model sees a row
 * that says something true rather than one that collapses. The standing-goal
 * level that used to sit here is gone: the description already says what the
 * session is for, and a goal beside it read as an echo.
 *
 * The name is the session identity's Line tier, resolved through
 * `useSessionIdentity` like every other identity surface. The row itself is
 * `TugSessionRow`, the shape the masthead and the new-session picker also wear:
 * how it divides a rail's width between the dot, the title, the slots, and the
 * activity with its tape is that component's decision, so what the gallery
 * approves is what the Cards card wears, by construction rather than by two files
 * agreeing.
 *
 * The row carries `data-session-id` (which session this is) alongside the
 * uniform `data-cards-row-id` every pane row wears (the reorder's handle).
 *
 * Laws: [L02] every store enters React through `useSyncExternalStore`; [L06]
 * appearance (dot, sparkline) is CSS on engine attributes, never React state.
 *
 * @module components/cards/cards-session-cell
 */

import React from "react";

import { SlotPicker } from "./slot-picker";
import { CardsColumnBadge } from "./cards-column-badge";
import { SessionIdentityRow } from "@/components/tugways/session-identity-row";
import { AnnotationScope } from "@/components/tugways/annotation-scope";
import {
  NO_SLASH_COMMANDS,
  useAnnotationContextFor,
} from "@/components/tugways/use-annotation-context";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { TUG_SESSION_ROW_INDICATOR_SIZE } from "@/components/tugways/tug-session-row";

export interface CardsSessionRowProps {
  cardId: string;
  tugSessionId: string;
  projectDir: string;
  /** The pane-row identity the reorder matches on. */
  orderKey: string;
  filterQuery: string;
  onRowPointerDown: (orderKey: string, event: React.PointerEvent) => void;
  /** This row's card is in the layout selection. */
  selected: boolean;
}

/** One monitor row: the shared `SessionIdentityRow`, at the Cards card's settings.
 *  Every decision about what the row SAYS — the description ladder, the
 *  activity ladder, the beat grammar — and about how it PACKS belongs to that
 *  component, so what ships here is what the gallery approved. What is left
 *  here is what is genuinely the Cards card's: the slot picker, the reorder handle,
 *  and the filter query. The `TugListView` cell wrapper still owns cursor /
 *  selection / click. */
export function CardsSessionRow({
  cardId,
  tugSessionId,
  projectDir,
  orderKey,
  filterQuery,
  onRowPointerDown,
  selected,
}: CardsSessionRowProps): React.ReactElement {
  // The binding's workspace key — the row already holds the project directory,
  // and the key is what scopes the file index the annotator's path resolver
  // consults. Read here rather than threaded as a prop: the cell is the one
  // that needs it, and its `cardId` is the whole address.
  const workspaceKey = React.useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    React.useCallback(
      () => cardSessionBindingStore.getBinding(cardId)?.workspaceKey ?? "",
      [cardId],
    ),
  );
  // The description line is prose about the session, and it names files. Same
  // terms as the masthead's ([B02]): the row's own project is both the file
  // index's root and the root a relative path in the prose is counted from,
  // and there is no command catalog behind a monitor rail. The clicks are the
  // card's, mounted once at its content root ([B05]).
  const annotation = useAnnotationContextFor({
    projectDir: projectDir.length > 0 ? projectDir : null,
    workspaceKey: workspaceKey.length > 0 ? workspaceKey : null,
    cwd: projectDir.length > 0 ? projectDir : null,
    isKnownSlashCommand: NO_SLASH_COMMANDS,
  });
  return (
    <AnnotationScope value={annotation}>
      <SessionIdentityRow
        selected={selected}
        className="session-row-content cards-row"
        sessionId={tugSessionId}
        cardId={cardId}
        projectDir={projectDir}
        // The monitor rail's large indicator, and the ONLY place in the app that
        // takes the dot's period jitter: a list of separate sessions, each doing
        // its own work. On one exact period a column of them reads as a single
        // mechanism with several heads.
        dotSize={TUG_SESSION_ROW_INDICATOR_SIZE}
        drift
        // Outdented from the title, not flush with it: a title inset measured off
        // the 28px glyph above is a wide indent to spend on a rail this narrow.
        subAlign="edge"
        tape
        // The rail mounts an `AnnotationScope`, so a post naming a sha puts a
        // commit pill in this line — the description is set loose, in a band
        // floored at the atom register, so the pill is whole ([B07]).
        descriptionType="loose"
        // A monitor row answers a right-click with the session's copies — the
        // atom, the citation, the id, the description, the newest beat — over
        // its whole surface, the same menu the masthead offers. A rail is where
        // a reader is most likely to be gathering a session to name it
        // somewhere else, and it is the surface with the least room to show the
        // description it holds.
        identityMenu
        highlight={filterQuery}
        // The slot the card holds, then where it stands inside that slot — the
        // same outward-in reading the pane's own control cluster has. Both
        // resolve their own facts from the deck store, so the row keeps taking
        // everything as props.
        slots={
          <>
            <SlotPicker cardId={cardId} />
            <CardsColumnBadge cardId={cardId} />
          </>
        }
        // The row is its own reorder handle — a vertical drag from anywhere on
        // it that is not the slot picker carries it.
        onPointerDown={(e) => onRowPointerDown(orderKey, e)}
        data-session-id={tugSessionId}
        data-cards-row-id={orderKey}
        data-cards-row-group="sessions"
        data-cards-group-run="sessions"
      />
    </AnnotationScope>
  );
}
