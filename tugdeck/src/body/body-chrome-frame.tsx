/**
 * BodyChromeFrame — a card's pane, chrome and all, in the card's own page.
 *
 * The page is the card's whole view: the host places it at the pane's rect
 * outset by the apron (`lib/chrome-placement.ts`), and this frame lays the
 * pane out inset by that apron on a transparent page, so the border, the
 * corners, the shadow and the grips' overhang paint inside the view. Chrome
 * and content are one layer tree, so nothing the host does to the view can
 * set them apart.
 *
 * **Chrome at once, content when painted.** The page tells the host it has
 * painted (`painted`) at its first frame with chrome, so the card shows at
 * once; until the card's own content has painted (`card.painted`), the
 * content box is lidded in the pane's surface (`data-content-painted`), the
 * job the shell's placeholder lid did when the shell drew the chrome. The
 * shell's arrival keeps waiting on `card.painted`, so an arriving card
 * arrives whole.
 *
 * @module body/body-chrome-frame
 */

import React, { useLayoutEffect, useMemo, useRef, type Ref } from "react";
import { useSyncExternalStore } from "../lib/gesture-scope";
import { cardKindName, getRegistration } from "../card-registry";
import { cardTitleStore } from "../lib/card-title-store";
import { cardPainted, cardRailHold } from "../bus/declarations/card";
import { paneChrome, paneReorderTabs, paneTabDrag, type PaneChromeValue } from "../bus/declarations/pane";
import { cardDragCoordinator } from "../card-drag-coordinator";
import { PaneChrome } from "../components/chrome/pane-chrome";
import type { CardTitleBarHandle } from "../components/chrome/card-title-bar";
import { CardHost } from "../components/chrome/card-host";
import { CANVAS_BACKGROUND_ATTRIBUTE } from "../lib/pane-frame-selectors";
import { CARD_APRON_PX, CHROME_IN_BODY_ATTRIBUTE } from "../lib/chrome-placement";
import { pageZoomStore } from "../lib/page-zoom-store";
import { onHostMessage, postToHost } from "../host/channel";
import { paintedToHost } from "../host/declarations/lifecycle";
import { cardInsetsToPage } from "../host/declarations/geometry";
import { getCardCloseGuard } from "../lib/card-close-guard";
import { cardModalHoldStore, isCardHeld } from "../lib/card-modal-hold-store";
import { readCardCloseAdvice } from "../lib/card-close-advice";
import { deckCards } from "../bus/declarations/deck";
import { bodyChromeVerbs, chromeCardsKey, chromeModelOf, soleCardCloseAdvice } from "./body-chrome";
import type { BodyCardDeck } from "./body-card-deck";

/** On the frame once the card's own content has painted: the content lid lifts. */
export const CONTENT_PAINTED_ATTRIBUTE = "data-content-painted";

/**
 * Where the pane stands within the view, per side, in this page's layout px:
 * the host's insets are points, and the deck root is scaled by View › Zoom.
 */
const INSET_PROPERTIES = {
  top: "--tug-card-inset-top",
  left: "--tug-card-inset-left",
  bottom: "--tug-card-inset-bottom",
  right: "--tug-card-inset-right",
} as const;

type Insets = Record<keyof typeof INSET_PROPERTIES, number>;

/**
 * The pane's insets within this page's view, as the host last said them: the
 * apron plus what the view's growth to whole points added on each side, so
 * the pane stands where the shell's stand-in does to the sub-point. The
 * apron alone until the host has said. The handler is installed with the
 * module, before any bind, so a placement the host sends early is not lost.
 */
let cardInsets: Insets = { top: CARD_APRON_PX, left: CARD_APRON_PX, bottom: CARD_APRON_PX, right: CARD_APRON_PX };
const insetListeners = new Set<() => void>();
onHostMessage(cardInsetsToPage, (next) => {
  cardInsets = { top: next.top, left: next.left, bottom: next.bottom, right: next.right };
  for (const listener of [...insetListeners]) listener();
});

/** Whether this page has told the host its first chrome frame is on screen. */
let chromePaintPosted = false;

const NO_ASK = { confirm: false, message: "", label: "" };
const NO_CLOSE_ASKS = { pane: NO_ASK, card: NO_ASK, all: NO_ASK };

/** The facts a card's chrome draws before the shell's have arrived: its kind's own title, nothing to press. */
function fallbackChrome(cardId: string, componentId: string): PaneChromeValue {
  const meta = getRegistration(componentId)?.defaultMeta;
  return {
    paneId: "",
    tabs: [],
    activeCardId: cardId,
    title: meta?.title ?? "",
    icon: meta?.icon ?? null,
    closable: false,
    close: NO_CLOSE_ASKS,
    role: getRegistration(componentId)?.layoutRole === "sidebar" ? "sidebar" : "content",
    grips: [],
    acceptedFamilies: [],
    width: null,
    fillHeight: null,
    placeArrangement: null,
    bullseye: null,
    spaces: [],
    ownSpaceId: null,
    slotStack: [],
    cardFold: false,
    slot: null,
  };
}

export interface BodyChromeFrameProps {
  deck: BodyCardDeck;
  cardId: string;
  componentId: string;
  /** The pane this page's one-card deck holds the card in (`bodyPaneId`). */
  paneId: string;
  chrome: PaneChromeValue | null;
  folded: boolean;
  focused: boolean;
  frameEl: HTMLDivElement | null;
  rootEl: HTMLDivElement | null;
  setFrame: (el: HTMLDivElement | null) => void;
  setRootEl: Ref<HTMLDivElement>;
  setContentEl: (el: HTMLDivElement | null) => void;
  titleBarRef: Ref<CardTitleBarHandle>;
  ResponderScope: React.FC<{ children: React.ReactNode }>;
}

export function BodyChromeFrame({
  deck,
  cardId,
  componentId,
  paneId,
  chrome,
  folded,
  frameEl,
  rootEl,
  setFrame,
  setRootEl,
  setContentEl,
  titleBarRef,
  ResponderScope,
}: BodyChromeFrameProps): React.ReactElement {
  const value = chrome ?? fallbackChrome(cardId, componentId);
  const cardKind = cardKindName(getRegistration(componentId)?.defaultMeta);
  // The names the chrome draws come from `deck.cards`; read through a key so
  // the frame re-renders when one moved and not on every phase tick.
  useSyncExternalStore(deckCards.subscribe, () => chromeCardsKey(value, deckCards.getSnapshot()));
  const model = chromeModelOf(value, deckCards.getSnapshot(), paneId, cardKind, folded);
  const masthead = useSyncExternalStore(cardTitleStore.subscribe, () => cardTitleStore.getMasthead(cardId));
  const contentPainted = useSyncExternalStore(cardPainted.subscribe, () => cardPainted.getSnapshot() === true);
  const railSide = useSyncExternalStore(deck.subscribe, deck.getRailSide);

  // The close's live answers are this page's: the card's own guard, hold and
  // advice. The pane's other cards are the shell's to ask, on `pane.closePane`.
  const verbs = useMemo(
    () =>
      bodyChromeVerbs({
        resolveCloseGuard: () => getCardCloseGuard(cardId)?.run ?? null,
        resolveModalHold: () => (isCardHeld(cardModalHoldStore.getSnapshot(), cardId) ? cardId : null),
        resolveCloseAdvice: () =>
          soleCardCloseAdvice(paneChrome.getSnapshot()?.tabs.length ?? 1, () => readCardCloseAdvice(cardId)),
      }),
    [cardId],
  );

  // The page is the card's view: transparent around the pane, and the pane's
  // insets in this page's layout px at the deck's zoom ([L06]: written to the
  // DOM).
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute(CHROME_IN_BODY_ATTRIBUTE, "");
    const write = (): void => {
      const zoom = pageZoomStore.getFactor();
      for (const side of Object.keys(INSET_PROPERTIES) as Array<keyof Insets>) {
        root.style.setProperty(INSET_PROPERTIES[side], `${cardInsets[side] / zoom}px`);
      }
    };
    write();
    const release = pageZoomStore.subscribe(write);
    insetListeners.add(write);
    return () => {
      release();
      insetListeners.delete(write);
      root.removeAttribute(CHROME_IN_BODY_ATTRIBUTE);
      for (const property of Object.values(INSET_PROPERTIES)) root.style.removeProperty(property);
    };
  }, []);

  // A rail width drag's hold on content that cannot reflow in a frame: the
  // shell's draft says the width to lay it out at while the frame follows
  // the hand, and this page holds its own body there, anchored to the rail's
  // outer edge, as the shell holds an in-document member's ([L06]: written
  // to the DOM). The chrome's borders — the frame's width less its body's —
  // are read as the hold opens, while the body still fills its frame.
  const railHold = useSyncExternalStore(cardRailHold.subscribe, cardRailHold.getSnapshot);
  const railInsetRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const body = rootEl?.querySelector<HTMLElement>(".tug-pane-body") ?? null;
    if (body === null || frameEl === null) return;
    if (railHold === null) {
      railInsetRef.current = null;
      body.style.removeProperty("width");
      body.style.removeProperty("align-self");
      return;
    }
    railInsetRef.current ??= frameEl.offsetWidth - body.offsetWidth;
    body.style.setProperty("align-self", railHold.side === "left" ? "flex-start" : "flex-end");
    body.style.setProperty("width", `${railHold.width - railInsetRef.current}px`);
  }, [railHold, rootEl, frameEl]);

  // A tab drag in this page: a reorder inside the bar is the pane's verb, and
  // past the bar the shell hit-tests the other panes and commits.
  useLayoutEffect(() => {
    cardDragCoordinator.init(deck);
    cardDragCoordinator.initRemote({
      reorder: (dragged, insertIndex) => {
        const tabs = paneChrome.getSnapshot()?.tabs ?? [];
        const fromIndex = tabs.findIndex((t) => t.cardId === dragged);
        if (fromIndex < 0) return;
        const toIndex = insertIndex > fromIndex ? insertIndex - 1 : insertIndex;
        if (toIndex !== fromIndex) paneReorderTabs.dispatch({ fromIndex, toIndex });
      },
      away: (phase, dragged, x, y) => paneTabDrag.dispatch({ phase, cardId: dragged, x, y }),
    });
    return () => cardDragCoordinator.initRemote(null);
  }, [deck]);

  // The first frame with the shell's chrome facts: the host may show the
  // view now. Two frames on, so the frame carrying the chrome has gone to the
  // compositor (`body-main.ts`'s rule for `painted`).
  const hasChrome = chrome !== null;
  useLayoutEffect(() => {
    if (!hasChrome || chromePaintPosted) return;
    chromePaintPosted = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => postToHost(paintedToHost, {}));
    });
  }, [hasChrome]);

  // The frame's tier, as the shell's pane stamps its own: which masthead,
  // and the rail tier.
  const frameAttrs: Record<string, string> = {};
  if (masthead !== null) {
    frameAttrs["data-masthead"] = "true";
    frameAttrs["data-masthead-kind"] = masthead.kind === "session-masthead" ? "session" : "card";
  }
  if (model.role === "sidebar") frameAttrs["data-role"] = "sidebar";
  // A pinned rail's panel livery, keyed as the shell's frame keys it: the
  // edge it is pinned to, and in a divided rail its place among the
  // members, which says whether it draws the seam's hairline at its foot.
  if (model.role === "sidebar" && railSide !== null) {
    frameAttrs["data-rail-side"] = railSide;
    const place = value.placeArrangement;
    if (place !== null && place.kind === "rail" && place.mode === "split") {
      frameAttrs["data-rail-member-index"] = String(place.index);
      if (place.index === place.count - 1) frameAttrs["data-rail-member-last"] = "";
    }
  }
  if (contentPainted) frameAttrs[CONTENT_PAINTED_ATTRIBUTE] = "";

  const accessoryRef = useRef<HTMLDivElement>(null);
  // The chrome stands in the pane's responder scope, so a responder of the
  // title bar's own — the masthead's — is the pane's child. A placement that
  // lands the keyboard there leaves first responder inside the card, and the
  // chain still finds the key card its title-bar commands ask.
  return (
    <>
      <div className="body-canvas" {...{ [CANVAS_BACKGROUND_ATTRIBUTE]: "" }}>
        <div
          ref={setFrame}
          className="tug-pane body-chrome-frame"
          data-testid="tug-pane"
          data-pane-id={paneId}
          data-card-id={cardId}
          {...frameAttrs}
        >
          <ResponderScope>
            <PaneChrome
              model={model}
              masthead={masthead}
              verbs={verbs}
              frameEl={frameEl}
              rootEl={rootEl}
              rootRef={setRootEl}
              titleBarRef={titleBarRef}
              accessoryRef={accessoryRef}
              contentRef={setContentEl}
              accessory={null}
              ResponderScope={ResponderScope}
            />
          </ResponderScope>
        </div>
      </div>
      <ResponderScope>
        <CardHost cardId={cardId} hostStackId={paneId} componentId={componentId} isActive />
      </ResponderScope>
    </>
  );
}
