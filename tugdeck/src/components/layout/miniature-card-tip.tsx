/**
 * miniature-card-tip.tsx — what hovering a card in the Layout miniature says.
 *
 * The miniature draws each card as a face: its kind's icon, a title bar, a
 * live dot for a session. A face says what KIND of card stands there; the
 * hover says WHICH one. It answers, in the order a reader asks:
 *
 *   1. **What it is** — the card's own name and icon, exactly as its pane's
 *      title bar names it, resolved through `cardIdentity` (the one door to
 *      what a card holds).
 *   2. **Whose it is** — for a session: its `project/callsign`, what it is
 *      doing right now (the same live dot and phase word every session
 *      surface uses), the arc it is working on, and its description.
 *   3. **Where it stands** — the place and the card's position in it (front
 *      of a stack of three, the bottom of a split, second in a rail), whether
 *      it is the card the reader is in, and what stands behind it.
 *   4. **What a press does** — because the part under the hand is a control,
 *      and a control's words say what is before what the press changes.
 *   5. **The citation** — the flat-text form of a session a reader would
 *      paste elsewhere, last and in mono, as every session hover ends.
 *
 * The rows wear `entity-tips`' skeleton classes, because a card is an entity
 * and an entity has one hover shape wherever it is pointed at.
 *
 * **Every subscription lives in here, and nothing here is mounted until the
 * bubble opens.** Radix renders tooltip content only while the tooltip is
 * open, so forty targets on the picture cost forty closed triggers and no
 * subscriptions at all — the deck, the title store and the binding store are
 * read only by the one tip somebody is looking at.
 *
 * Laws: [L02] every store enters through `useSyncExternalStore` /
 *       `useStoreDerived`; [L06] nothing here holds state.
 *
 * @module components/layout/miniature-card-tip
 */

import "./miniature-card-tip.css";

import React from "react";
import { icons } from "lucide-react";

import { getRegistration } from "@/card-registry";
import { deckColumnsOf, railMembersOf } from "@/deck-store-selectors";
import type { DeckState } from "@/layout-tree";
import { SessionPhaseDot } from "@/components/tugways/session-phase-dot";
import { useArcForSession } from "@/lib/arc-session-index";
import { cardIdentity } from "@/lib/card-identity";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { cardTitleStore } from "@/lib/card-title-store";
import { SESSION_PHASE_LABELS } from "@/lib/code-session-store/session-phase-visual";
import { useSessionPhase } from "@/lib/code-session-store/use-session-phase";
import { getDeckStore } from "@/lib/deck-store-registry";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import {
  sessionCitation,
  sessionIdentityLine,
  useSessionIdentity,
} from "@/lib/session-identity";
import { useStoreDerived } from "@/lib/use-store-derived";

import {
  readerPaneIdOf,
  slotStackOf,
  type MiniatureTarget,
} from "@/components/layout/miniature-gestures";

/** Where a target's card stands, read off the deck. */
interface TipPlace {
  /** The card whose hover this is — the pane's active card — or `null` for an
   *  empty slot. */
  cardId: string | null;
  /** "Slot 2", "Left rail". */
  place: string;
  /** The card's position in its place, when the place holds more than one:
   *  "front of 3", "bottom of 2", "2nd of 3". */
  position: string | null;
  /** Whether this is the card the reader is in. */
  here: boolean;
  /** The front cards of the panes stacked behind this one, front to back. */
  behind: readonly string[];
  /** The pane's other tabs, when it holds more than one card. */
  tabs: readonly string[];
  /** What a press on the part does. */
  hint: string;
}

/** An ordinal word for a position in a short run. */
function ordinal(n: number): string {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

/** A member's position down a divided place of `count`, in words a reader
 *  says: top and bottom for a pair, ordinals past that. */
function positionDown(index: number, count: number): string | null {
  if (count < 2) return null;
  if (count === 2) return index === 0 ? "top of 2" : "bottom of 2";
  return `${ordinal(index + 1)} of ${count}`;
}

/** The pane's tabs other than its active card, in tab order. */
function otherTabs(
  deck: DeckState,
  paneId: string,
): readonly string[] {
  const pane = deck.panes.find((p) => p.id === paneId);
  if (pane === undefined) return [];
  return pane.cardIds.filter((id) => id !== pane.activeCardId);
}

/** Read a target's place off the deck. Plain data, so `useStoreDerived` keeps
 *  it by value and the tip repaints only when its answer moves. */
function placeOf(deck: DeckState | null, target: MiniatureTarget): TipPlace | null {
  if (deck === null) return null;
  const reader = readerPaneIdOf(deck);
  if (target.kind === "block") {
    const stack = slotStackOf(deck, target.slot);
    const place = `Slot ${target.slot + 1}`;
    const front = stack[0];
    if (front === undefined) {
      return {
        cardId: null,
        place,
        position: null,
        here: false,
        behind: [],
        tabs: [],
        hint: "Click to go to it · drop a card here to fill it",
      };
    }
    return {
      cardId: front.activeCardId,
      place,
      position: stack.length > 1 ? `front of ${stack.length}` : null,
      here: front.id === reader,
      behind: stack.slice(1).map((pane) => pane.activeCardId),
      tabs: otherTabs(deck, front.id),
      hint:
        stack.length > 1
          ? "Click to bring it forward, again to cycle the stack · drag to move it"
          : "Click to bring it forward · drag to move it",
    };
  }
  if (target.kind === "member") {
    const pane = deck.panes.find((p) => p.id === target.paneId);
    if (pane === undefined) return null;
    const column = deckColumnsOf(deck, null).find((c) => c.slot === target.slot);
    const members = column?.members ?? [];
    const index = members.indexOf(target.paneId);
    const down = index < 0 ? null : positionDown(index, members.length);
    return {
      cardId: pane.activeCardId,
      place: `Slot ${target.slot + 1}`,
      position: down === null ? null : `${down}, split`,
      here: pane.id === reader,
      behind: [],
      tabs: otherTabs(deck, pane.id),
      hint: "Click to bring it forward · drag to move or reorder it",
    };
  }
  const pane = deck.panes.find((p) => p.id === target.paneId);
  if (pane === undefined) return null;
  const members = railMembersOf(deck, target.side);
  const index = members.findIndex((m) => m.paneId === target.paneId);
  return {
    cardId: pane.activeCardId,
    place: target.side === "left" ? "Left rail" : "Right rail",
    position: index < 0 ? null : positionDown(index, members.length),
    here: pane.id === deck.activePaneId,
    behind: [],
    tabs: otherTabs(deck, pane.id),
    hint: "Click to bring it forward · drag to reorder it or change sides",
  };
}

/** The lucide component a card's icon names, or `null`. */
function IconFor({ name }: { name: string | null }): React.ReactElement | null {
  if (name === null) return null;
  const Icon = icons[name as keyof typeof icons] as
    | React.ComponentType<React.SVGProps<SVGSVGElement>>
    | undefined;
  if (Icon === undefined) return null;
  return <Icon className="layout-tip-icon" aria-hidden="true" />;
}

/** What kind of card this is, in the registry's own word — said only when
 *  the card's name does not already say it. */
function kindWord(componentId: string | null, title: string): string | null {
  if (componentId === null) return null;
  const word = getRegistration(componentId)?.defaultMeta.title ?? "";
  if (word === "" || word === title) return null;
  return word;
}

/**
 * A session's rows: who it is, what it is doing, where it is working, and
 * what it is about. Its own component because its hooks are a session's, and
 * a card that is not a session must not call them.
 */
function SessionRows({
  sessionId,
  projectDir,
  title,
}: {
  sessionId: string;
  projectDir: string | null;
  title: string;
}): React.ReactElement {
  const identity = useSessionIdentity(
    sessionId,
    projectDir === null ? undefined : { projectDir },
  );
  const phase = useSessionPhase(sessionId);
  const arc = useArcForSession(sessionId);
  const line = sessionIdentityLine(identity);
  return (
    <>
      {line !== title ? <span className="tugx-tip-meta">{line}</span> : null}
      <span className="tugx-tip-meta layout-tip-phase">
        <SessionPhaseDot sessionId={sessionId} size={7} />
        <span>{SESSION_PHASE_LABELS[phase]}</span>
        {arc !== null ? (
          <span className="layout-tip-arc">{`· on arc ${arc.name}`}</span>
        ) : null}
      </span>
      {identity.description !== null && identity.description !== "" ? (
        <span className="tugx-tip-meta layout-tip-description">
          {identity.description}
        </span>
      ) : null}
    </>
  );
}

/** A session's citation, the hover's last row. */
function SessionCitationRow({
  sessionId,
  projectDir,
}: {
  sessionId: string;
  projectDir: string | null;
}): React.ReactElement {
  const identity = useSessionIdentity(
    sessionId,
    projectDir === null ? undefined : { projectDir },
  );
  return (
    <span className="tugx-tip-mono">
      {sessionCitation(identity, { project: true })}
    </span>
  );
}

/**
 * MiniatureCardTip — the hover content for one part of the miniature.
 */
export function MiniatureCardTip({
  target,
}: {
  target: MiniatureTarget;
}): React.ReactElement | null {
  const place = useStoreDerived(getDeckStore(), (deck) => placeOf(deck, target));
  // A card's name is published by the card itself and its session is
  // re-addressed on every rotation, so the tip listens to both while it is
  // open and re-reads `cardIdentity` — the one door to what a card holds —
  // whenever either moves.
  useSyncExternalStore(cardTitleStore.subscribe, cardTitleStore.version);
  useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    cardSessionBindingStore.getSnapshot,
  );
  if (place === null) return null;

  if (place.cardId === null) {
    return (
      <span className="tugx-tip layout-tip">
        <span className="tugx-tip-title">{`${place.place} is empty`}</span>
        <span className="layout-tip-hint">{place.hint}</span>
      </span>
    );
  }

  const identity = cardIdentity(place.cardId);
  const sessionId = identity.tugSessionId;
  const kind = kindWord(identity.componentId, identity.title);
  const where = [place.place, place.position].filter(Boolean).join(" · ");
  const nameOf = (cardId: string): string => cardIdentity(cardId).title;

  return (
    <span className="tugx-tip layout-tip" data-testid="layout-card-tip">
      <span className="layout-tip-head">
        <IconFor name={identity.icon} />
        <span className="tugx-tip-title">{identity.title}</span>
      </span>
      {sessionId !== null ? (
        <SessionRows
          sessionId={sessionId}
          projectDir={identity.projectDir}
          title={identity.title}
        />
      ) : kind !== null ? (
        <span className="tugx-tip-meta">{kind}</span>
      ) : null}
      {sessionId === null && identity.path !== null ? (
        <span className="tugx-tip-mono">{identity.path}</span>
      ) : null}
      <span className="layout-tip-place">
        {where}
        {place.here ? <span className="layout-tip-here"> · you are here</span> : null}
      </span>
      {place.behind.length > 0 ? (
        <span className="tugx-tip-meta">
          {`Behind it: ${place.behind.map(nameOf).join(", ")}`}
        </span>
      ) : null}
      {place.tabs.length > 0 ? (
        <span className="tugx-tip-meta">
          {`Also in this pane: ${place.tabs.map(nameOf).join(", ")}`}
        </span>
      ) : null}
      <span className="layout-tip-hint">{place.hint}</span>
      {sessionId !== null ? (
        <SessionCitationRow sessionId={sessionId} projectDir={identity.projectDir} />
      ) : null}
    </span>
  );
}
