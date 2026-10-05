/**
 * miniature-faces.tsx — what a block in the Layout miniature says about the
 * card standing there.
 *
 * The miniature drew every card as the same grey bar, so the picture stated
 * the arrangement and nothing about what was arranged. A face is the card
 * seen small: a title bar, the card kind's registered icon, and — for a
 * stack — the sheets of the cards behind it stepping out at the top. A
 * session wears its live dot in the bar, and the card the reader is in wears
 * the Key ink the flow window already uses for "what you are looking at".
 *
 * **Every fact here is one the deck already holds.** The icon is the one the
 * pane's own title bar draws (`CardState.icon`, else the registration's
 * `defaultMeta.icon`); the stack is the slot's panes front to back; "here" is
 * the pane the numbered pills mark. The section resolves them from its own
 * subscription and hands them down — the drawing reads no store but the one
 * leaf below, which is the live dot, and that is a leaf precisely so a turn's
 * every event repaints a five-pixel dot rather than the picture.
 *
 * **The block keeps its rect.** A stack's sheets and its front face are drawn
 * INSIDE the block's own box, stepping down and left from it, rather than
 * spilling past it: the overlay's targets, the strip's segments and the drop
 * zones all stand on the block's rect, and a face that moved it would put
 * every one of them a few pixels off the card they mean.
 *
 * Laws: [L02] the binding and the phase enter through `useSyncExternalStore`
 *       (inside the dot's hooks); [L06] nothing here holds state.
 *
 * @module components/layout/miniature-faces
 */

import React, { useSyncExternalStore } from "react";
import { icons } from "lucide-react";

import { SessionPhaseDot } from "@/components/tugways/session-phase-dot";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { cardIdentity } from "@/lib/card-identity";
import type { SidebarSide } from "@/lib/layout-imposer";

/** One card, as the miniature draws it. */
export interface MiniatureFace {
  /** The pane the card stands in — what a press on it addresses. */
  paneId: string;
  /** The pane's ACTIVE card — the one whose face shows. */
  cardId: string;
  /** The lucide icon name the pane's title bar draws for that card. */
  icon?: string;
  /** Whether this is the card the reader is in — the pane the pills mark. */
  here: boolean;
}

/**
 * Every face the committed drawing carries, keyed the way the drawing finds
 * its parts.
 *
 * Three maps rather than one because the drawing has three kinds of part, and
 * each already carries its own order: an undivided slot draws its FRONT face
 * and stacks the rest behind it, a split column draws one face per member top
 * to bottom, and a rail one per member in rail order.
 */
export interface MiniatureFaces {
  /** Each occupied slot's panes, front first. */
  slots: Readonly<Record<number, readonly MiniatureFace[]>>;
  /** Each split column's members, top to bottom (`DeckColumn.members`). */
  members: Readonly<Record<number, readonly MiniatureFace[]>>;
  /** Each side's rail members, in rail order (`railMembersOf`). */
  rails: Partial<Record<SidebarSide, readonly MiniatureFace[]>>;
}

/** The most sheets a stack shows behind its front card. Past two the stair is
 *  noise at this size; the count lives in the tooltip. */
const MAX_SHEETS = 2;

/** The lucide component a face's icon names, or `null` for none. */
function iconFor(name: string | undefined): React.ComponentType<
  React.SVGProps<SVGSVGElement>
> | null {
  if (name === undefined) return null;
  const Icon = icons[name as keyof typeof icons];
  return Icon === undefined
    ? null
    : (Icon as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>);
}

/**
 * A session card's live dot, or nothing for any other card.
 *
 * Its own leaf for the reason `SessionPhaseDot` is one: phase lives on the
 * card's session store, whose snapshot moves on every transcript event, and
 * the picture must not move with it. Drifted, because the faces are separate
 * sessions doing separate work — on one period a row of them reads as one
 * mechanism with several heads.
 *
 * The session is resolved through `cardIdentity`, the one door to what a card
 * holds; the binding store is subscribed only to hear that the answer may have
 * moved — a rotation re-addresses the card, and a dot holding the old segment
 * would fall idle while the session works.
 */
function FaceDot({ cardId }: { cardId: string }): React.ReactElement | null {
  const sessionId = useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    () => cardIdentity(cardId).tugSessionId,
  );
  if (sessionId === null) return null;
  return (
    <span className="layout-mini-face-dot">
      <SessionPhaseDot sessionId={sessionId} size={6} drift />
    </span>
  );
}

/** A face's contents: the title bar, and the icon under it. */
function FaceBody({ face }: { face: MiniatureFace }): React.ReactElement {
  const Icon = iconFor(face.icon);
  return (
    <>
      <span className="layout-mini-face-bar">
        <FaceDot cardId={face.cardId} />
      </span>
      {Icon === null ? null : (
        <Icon className="layout-mini-face-icon" aria-hidden="true" />
      )}
    </>
  );
}

/**
 * An undivided slot's faces: the front card, and up to two sheets behind it.
 *
 * Drawn back to front, so the nearer sheets cover the farther ones by paint
 * order with no z-index to manage. `--sheets` and `--sheet` are the whole
 * geometry: each card nearer the reader steps three pixels down and two left,
 * so the front face sits at the block's bottom-left and the deepest sheet
 * peeks out at its top-right.
 */
export function MiniatureStackFaces({
  faces,
}: {
  faces: readonly MiniatureFace[];
}): React.ReactElement | null {
  const front = faces[0];
  if (front === undefined) return null;
  const sheets = Math.min(faces.length - 1, MAX_SHEETS);
  return (
    <>
      {Array.from({ length: sheets }, (_, i) => {
        const k = sheets - i;
        return (
          <span
            key={`sheet-${k}`}
            className="layout-mini-sheet"
            style={{ "--sheet": k } as React.CSSProperties}
          />
        );
      })}
      <span
        className="layout-mini-face"
        data-here={front.here ? "" : undefined}
        data-pane-id={front.paneId}
      >
        <FaceBody face={front} />
      </span>
    </>
  );
}

/** How many sheets a slot's faces draw behind the front — the block carries
 *  it as `--sheets` so every layer inside it reads one number. */
export function sheetsFor(faces: readonly MiniatureFace[] | undefined): number {
  if (faces === undefined || faces.length === 0) return 0;
  return Math.min(faces.length - 1, MAX_SHEETS);
}

/** One split member's face, filling the member's block. */
export function MiniatureMemberFace({
  face,
}: {
  face: MiniatureFace | undefined;
}): React.ReactElement | null {
  if (face === undefined) return null;
  return (
    <span
      className="layout-mini-face"
      data-here={face.here ? "" : undefined}
      data-pane-id={face.paneId}
    >
      <FaceBody face={face} />
    </span>
  );
}

/**
 * A rail member's face: the icon alone. A rail is the frame around the
 * subject rather than the subject, so it says what each card IS and leaves
 * the title bar and the dot to the cards being arranged.
 */
export function MiniatureRailFace({
  face,
}: {
  face: MiniatureFace | undefined;
}): React.ReactElement | null {
  if (face === undefined) return null;
  const Icon = iconFor(face.icon);
  if (Icon === null) return null;
  return (
    <Icon
      className="layout-mini-rail-icon"
      data-here={face.here ? "" : undefined}
      aria-hidden="true"
    />
  );
}
