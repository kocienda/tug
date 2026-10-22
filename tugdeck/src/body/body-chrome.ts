/**
 * body-chrome — what a card that carries its pane's chrome draws it from, and
 * what its chrome's gestures do, in its own page.
 *
 * The shell publishes the pane's facts to every card of the pane as
 * `pane.chrome` (`bus/declarations/pane.ts`); {@link chromeModelOf} turns the
 * replica into the model `PaneChrome` renders, naming each tab and picker row
 * from its card's `deck.cards` record. Every gesture that changes the
 * arrangement leaves as a declared action the shell owns ([L37]), and a
 * title-bar drag or a grip press asks the host to carry the card
 * (`cardGesture`): the host moves the view, and the shell commits what it
 * reports ([L09]: the page never sets its own geometry).
 *
 * @module body/body-chrome
 */

import type React from "react";
import type { CardState } from "../layout-tree";
import type { SlotStackEntry } from "../deck-store-selectors";
import type { PaneChromeValue } from "../bus/declarations/pane";
import type { DeckCardFacts } from "../bus/declarations/deck";
import type { CardMastheadPayload } from "../lib/card-title-store";
import { getRegistration } from "../card-registry";
import { deckCardIcon, deckCardTabTitle } from "../lib/deck-cards";
import {
  paneArrangePlace,
  paneChrome,
  paneClosePane,
  paneFillHeight,
  paneMoveToSpace,
  paneRevealStackEntry,
  paneSetWidth,
  paneToggleBullseye,
} from "../bus/declarations/pane";
import type { PaneChromeModel, PaneChromeVerbs } from "../components/chrome/pane-chrome";
import { postToHost } from "../host/channel";
import { cardGestureToHost } from "../host/declarations/geometry";
import type { ResizeEdge } from "../lib/pane-chrome-projection";
import { GESTURE_EPISODE_WINDOW_MS, beginResizeEpisode } from "../lib/resize-episode";
import { deckRootElement } from "../lib/page-zoom-store";
import { LIMIT_SPRING_MS } from "../lib/rail-width";
import { getTugTiming, isTugMotionEnabled } from "../lib/scale-timing";

/** A card's tab label and icon, from its `deck.cards` record; a card the record has not reached yet has neither. */
function namedCard(cards: Record<string, DeckCardFacts>, cardId: string): { componentId: string; title: string; icon: string | null } {
  const entry = cards[cardId];
  if (entry === undefined) return { componentId: "", title: "", icon: null };
  const registration = getRegistration(entry.componentId);
  return {
    componentId: entry.componentId,
    title: deckCardTabTitle(entry, registration),
    icon: deckCardIcon(entry, registration),
  };
}

/** The tab bar's cards, as the bar reads them, from the replica's tabs and each card's record. */
function tabsOf(value: PaneChromeValue, cards: Record<string, DeckCardFacts>): CardState[] {
  return value.tabs.map((t) => {
    const { componentId, title, icon } = namedCard(cards, t.cardId);
    return { id: t.cardId, componentId, title, closable: true, ...(icon === null ? {} : { icon }) };
  });
}

/** The place badge's picker rows, from the replica's stack and each row's card's record. */
export function slotStackOf(value: PaneChromeValue, cards: Record<string, DeckCardFacts>): SlotStackEntry[] {
  return value.slotStack.map((e) => {
    const { title, icon } = namedCard(cards, e.cardId);
    return { paneId: e.paneId, cardId: e.cardId, title, ...(icon === null ? {} : { icon }), selected: e.selected };
  });
}

/**
 * What the chrome reads of `deck.cards`, as one string: each tab's and
 * picker row's record, so a frame re-renders when a name it draws moved and
 * not on every phase tick.
 */
export function chromeCardsKey(value: PaneChromeValue, cards: Record<string, DeckCardFacts>): string {
  const ids = [...value.tabs.map((t) => t.cardId), ...value.slotStack.map((e) => e.cardId)];
  return JSON.stringify(ids.map((id) => namedCard(cards, id)));
}

/**
 * Whether this page's chrome frame is the card's face, whole, so the host may
 * show it (`painted`): the shell's pane facts have arrived, and the frame
 * draws the masthead the shell holds for the card. The shell's stand-in draws
 * that masthead; a frame showing its one-line bar in its place would show
 * the card with an empty title until its content set the masthead.
 * `shellHoldsMasthead` is read off the card's own `deck.cards` record, and
 * undefined until the shell's facts reach the page. A frame that never
 * qualifies is shown at the card's ready, which says `painted` whatever this
 * answers.
 */
export function chromeFrameWhole(
  hasChrome: boolean,
  shellHoldsMasthead: boolean | undefined,
  masthead: CardMastheadPayload | null,
): boolean {
  if (!hasChrome || shellHoldsMasthead === undefined) return false;
  return !shellHoldsMasthead || masthead !== null;
}

/**
 * The model `PaneChrome` draws, from the pane's facts. `paneId` is the pane
 * this page's one-card deck holds the card in (`bodyPaneId`), which every
 * registry and the tab bar address; `folded` is the shell's fold, from the
 * card's context. No `placePaneId`: this page's deck cannot answer a place,
 * so the badge draws from the replica.
 */
export function chromeModelOf(
  value: PaneChromeValue,
  cards: Record<string, DeckCardFacts>,
  paneId: string,
  cardKind: string,
  folded: boolean,
): PaneChromeModel {
  return {
    paneId,
    title: value.title,
    icon: value.icon ?? undefined,
    closable: value.closable,
    confirmClose: value.close.pane.confirm,
    role: value.role,
    tabs: tabsOf(value, cards),
    activeCardId: value.activeCardId,
    acceptedFamilies: value.acceptedFamilies,
    cardCount: Math.max(value.tabs.length, 1),
    cardKind,
    grips: value.grips,
    railGrip: value.role === "sidebar" && value.grips.length === 1 && (value.grips[0] === "e" || value.grips[0] === "w"),
    width: value.width,
    fillHeight: value.fillHeight,
    placeArrangement:
      value.placeArrangement === null
        ? null
        : {
            mode: value.placeArrangement.mode,
            kind: value.placeArrangement.kind,
            index: value.placeArrangement.index,
            count: value.placeArrangement.count,
          },
    bullseye: value.bullseye,
    folded: value.cardFold && folded,
    cardFold: value.cardFold,
    slotStack: slotStackOf(value, cards),
    slot: value.slot,
    spaces: { spaces: value.spaces, ownSpaceId: value.ownSpaceId ?? undefined },
  };
}

/**
 * Ask the host to carry this card through a drag (`kind: "move"`) or a resize
 * from `edge`, or, for a rail's edge (`kind: "rail"`), to carry the rail's
 * width drag over every member, with the span a release past a limit springs
 * back over at this page's timing (`springMs`; 0 under reduced motion).
 */
function beginHostGesture(event: React.PointerEvent, kind: "move" | "resize" | "rail", edge?: ResizeEdge): void {
  if (event.button !== 0) return;
  if (kind === "move") markCarried(event);
  const spring = kind === "rail" ? { springMs: isTugMotionEnabled() && getTugTiming() > 0 ? LIMIT_SPRING_MS * getTugTiming() : 0 } : {};
  postToHost(cardGestureToHost, {
    phase: "begin",
    kind,
    ...(edge === undefined ? {} : { edge }),
    x: event.clientX,
    y: event.clientY,
    meta: event.metaKey,
    alt: event.altKey,
    ...spring,
  });
}

/**
 * Mark the frame a move carries, as the shell's pane marks its own at the
 * press: while the host carries the view, the view travels under the hand
 * and the bar's `data-pointer-within` flickers off at every step, so
 * `data-gesture="true"` is what keeps the grab dots the hand is holding lit
 * (`tug-pane.css`'s pin). Taken off at the first move the page hears after
 * the release, or at the next press: the hand is back with the page, and the
 * bar's own trigger answers again. Not at a move before the release: the
 * page hears the hand's moves while the view travels under it, and what a
 * move says of its buttons is not to be trusted to tell a drag from a hover.
 */
export function markCarried(event: Pick<React.PointerEvent, "target">): void {
  // The press's target, not its current target: the bar hands a drag over
  // once the press has travelled, after React has let go of the event's
  // current target. The page draws one pane, so its frame is the fallback.
  const target = event.target instanceof Element ? event.target : null;
  const frame =
    target?.closest<HTMLElement>(".tug-pane") ?? document.querySelector<HTMLElement>(".body-chrome-frame");
  if (frame === null) return;
  frame.setAttribute("data-gesture", "true");
  const lift = (): void => {
    frame.removeAttribute("data-gesture");
    window.removeEventListener("pointerup", released, true);
    window.removeEventListener("pointermove", lift, true);
    window.removeEventListener("pointerdown", lift, true);
  };
  const released = (): void => {
    window.removeEventListener("pointerup", released, true);
    window.addEventListener("pointermove", lift, true);
  };
  // Past the press's own dispatch, so the press that marks the frame is not
  // the one that lifts it.
  setTimeout(() => {
    window.addEventListener("pointerup", released, true);
    window.addEventListener("pointerdown", lift, true);
  }, 0);
}

/**
 * Hold the reader's place in this page across a grip's resize: opened at the
 * press, the last moment the pre-gesture layout is on screen, since the host
 * resizes the view — and with it this page's layout — from the first drag.
 * It ends once the hand is up and the page has taken the size the shell
 * commits, or at a bound for a press that changed no size.
 */
function holdReaderAcrossResize(): void {
  const root = deckRootElement();
  const episode = beginResizeEpisode(root, GESTURE_EPISODE_WINDOW_MS);
  let resizes: ResizeObserver | null = null;
  let bound = 0;
  const end = (): void => {
    resizes?.disconnect();
    resizes = null;
    window.clearTimeout(bound);
    episode.end();
  };
  window.addEventListener(
    "pointerup",
    () => {
      // The commit's size reaches this page a placement after the up: end on
      // the first resize after it, or at the bound when nothing moves.
      let first = true;
      resizes = new ResizeObserver(() => {
        if (first) {
          first = false;
          return;
        }
        end();
      });
      resizes.observe(root);
      bound = window.setTimeout(end, RESIZE_SETTLE_BOUND_MS);
    },
    { once: true, capture: true },
  );
}

/** How long a grip's episode waits after the up for the committed size to arrive. */
const RESIZE_SETTLE_BOUND_MS = 1_000;

/**
 * The close advice the pane's close reads: the sole card's own, so an empty
 * card in a pane of one closes without asking; none in a pane of several,
 * whose confirm is about discarding every tab at once and holds
 * unconditionally — the shell's pane's rule (`tug-pane.tsx`).
 */
export function soleCardCloseAdvice<A>(tabCount: number, read: () => A | null): A | null {
  return tabCount > 1 ? null : read();
}

/**
 * The chrome's verbs in a card's page: each arrangement gesture a declared
 * action to the shell, each drag or grip press a host gesture. The close
 * resolvers are the caller's, since the guard, the hold and the advice are
 * this page's own.
 */
export function bodyChromeVerbs(
  resolvers: Pick<PaneChromeVerbs, "resolveCloseGuard" | "resolveModalHold" | "resolveCloseAdvice">,
): PaneChromeVerbs {
  return {
    onClosePane: () => paneClosePane.dispatch({}),
    onSetWidth: (preset) => paneSetWidth.dispatch({ preset }),
    onFillHeight: () => paneFillHeight.dispatch({}),
    onArrangePlace: (verb) => paneArrangePlace.dispatch({ verb: `place:${verb}` }),
    onToggleBullseye: () => paneToggleBullseye.dispatch({}),
    onMoveToSpace: (spaceId) => paneMoveToSpace.dispatch({ spaceId }),
    onRevealStackEntry: (entry) => paneRevealStackEntry.dispatch({ paneId: entry.paneId }),
    onDragStart: (event) => beginHostGesture(event, "move"),
    onResizeStart: (edge, event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.button !== 0) return;
      holdReaderAcrossResize();
      beginHostGesture(event, paneChrome.getSnapshot()?.role === "sidebar" ? "rail" : "resize", edge);
    },
    ...resolvers,
  };
}
