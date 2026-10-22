/**
 * BodyStandIn — a body card's face, drawn by the shell while the card's own
 * page has not painted.
 *
 * Every card draws its chrome in its own page ([D216]), so a card whose page
 * is still being made — a workspace switch onto cards whose bodies were
 * evicted, or never made — has nothing at its pane until that page paints.
 * The shell stands in for those frames with the card's own chrome, drawn by
 * the same `PaneChrome` the page draws, from the facts the shell sends the
 * page: the pane's chrome as `pane.chrome` projects it from the deck
 * (`paneChromeFor`, read here from the deck itself, since a card that has
 * never had a page has been sent nothing yet), the arrangement's card names
 * (`deck.cards`) and the card's masthead (`cardTitleStore`), whose session
 * facts follow the session while the card has no body to say them
 * (`lib/bodiless-facts-store.ts`).
 *
 * When, and for how long, is `lib/body-stand-in-store.ts`: the chrome with
 * its content box lidded in the pane's surface, as the page's own first
 * frame draws it. The shell's page lies beneath every card, so the card's
 * view — or the last frame the host stands for a card brought back from an
 * eviction — covers it the moment it shows. It is a picture: it answers no
 * point and takes no focus, so a press reaches the shell's pane as it does
 * with no stand-in.
 *
 * Laws: [L02] every store is read through `useSyncExternalStore`; [L06] the
 * face's appearance is the stylesheet's; [L09] the one
 * paint the shell makes for a card, beneath where its view will stand. Its
 * styles are `tug-pane.css`'s, beside the placeholder's, because the face is
 * the pane's own surface and border.
 *
 * @module components/chrome/body-stand-in
 */

import React, { useMemo, useState } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { bodyStandInStore } from "@/lib/body-stand-in-store";
import { bodyCardsStore } from "@/lib/body-cards-store";
import { deckCards } from "@/bus/declarations/deck";
import { cardTitleStore } from "@/lib/card-title-store";
import { bodyFactsStore } from "@/lib/body-facts-store";
import { paneChromeFor } from "@/lib/pane-chrome-projection";
import { useDeckManager } from "@/deck-manager-context";
import { useIsCardFolded } from "@/lib/card-fold";
import { cardKindName, getRegistration } from "@/card-registry";
import { chromeCardsKey, chromeModelOf } from "@/body/body-chrome";
import { PaneChrome, type PaneChromeVerbs } from "./pane-chrome";

/** The stand-in presses nothing: it is a picture of the chrome its page will draw. */
const NO_VERBS: PaneChromeVerbs = {
  onClosePane: () => {},
  onSetWidth: () => {},
  onFillHeight: () => {},
  onArrangePlace: () => {},
  onToggleBullseye: () => {},
  onMoveToSpace: () => {},
  onRevealStackEntry: () => {},
  onDragStart: () => {},
  onResizeStart: () => {},
};

const PassThrough: React.FC<{ children: React.ReactNode }> = ({ children }) => <>{children}</>;

export interface BodyStandInProps {
  cardId: string;
  componentId: string;
}

/** The card's face while its page has not painted, or nothing once it has. */
export function BodyStandIn({ cardId, componentId }: BodyStandInProps): React.ReactElement | null {
  // A card with no body at all yet — on a workspace nobody has shown, whose
  // page the switch onto it is about to ask for — stands too: its placeholder
  // mounts in the switch's own commit, before its page is asked for.
  const standing = useSyncExternalStore(bodyStandInStore.subscribe, () => bodyStandInStore.standing(cardId));
  const unmade = useSyncExternalStore(bodyCardsStore.subscribe, () => bodyCardsStore.stateOf(cardId) === null);
  if (!standing && !unmade) return null;
  return <StandInFace cardId={cardId} componentId={componentId} />;
}

function StandInFace({ cardId, componentId }: BodyStandInProps): React.ReactElement | null {
  // The face stands in its own workspace's deck: the live one when that is
  // shown, and the parked record when it is not, so a parked workspace's
  // card already wears its face when the switch onto it lands, and its first
  // switched frame shows the card's chrome rather than the floor.
  const deck = useDeckManager();
  const state = useSyncExternalStore(deck.subscribe, deck.getSnapshot);
  const spaces = useSyncExternalStore(deck.subscribe, deck.getSpacesSnapshot);
  useSyncExternalStore(cardTitleStore.subscribe, () => cardTitleStore.get(cardId));
  const ownSpaceId = deck.spaceOf(cardId) ?? spaces.activeSpaceId;
  const own = ownSpaceId === spaces.activeSpaceId ? state : (spaces.mountedDecks.get(ownSpaceId) ?? state);
  const value = paneChromeFor(own, cardId, {
    titleOf: (id) => cardTitleStore.get(id),
    waives: (id) => bodyFactsStore.waives(id),
    spaces: { list: spaces.spaces, ownSpaceId },
  });
  // The names the chrome draws come from `deck.cards`; read through a key so
  // the face re-renders when one moved and not on every phase tick.
  useSyncExternalStore(deckCards.subscribe, () => (value === null ? "" : chromeCardsKey(value, deckCards.getSnapshot())));
  const masthead = useSyncExternalStore(cardTitleStore.subscribe, () => cardTitleStore.getMasthead(cardId));
  const folded = useIsCardFolded(cardId);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const refs = useMemo(
    () => ({
      titleBar: { current: null },
      accessory: { current: null } as React.RefObject<HTMLDivElement | null>,
      content: () => {},
    }),
    [],
  );
  if (value === null) return null;
  const cardKind = cardKindName(getRegistration(componentId)?.defaultMeta);
  // A pane id of its own, so nothing that registers by the pane's id — the
  // tab bar's drop targets, the chrome's portal root — finds the picture.
  const model = chromeModelOf(value, deckCards.getSnapshot(), `stand-in:${value.paneId}`, cardKind, folded);
  return (
    <div
      className="tug-body-stand-in"
      data-body-stand-in
      aria-hidden="true"
      inert
      {...(masthead !== null
        ? { "data-masthead": "true", "data-masthead-kind": masthead.kind === "session-masthead" ? "session" : "card" }
        : {})}
      {...(model.role === "sidebar" ? { "data-role": "sidebar" } : {})}
    >
      <PaneChrome
        model={model}
        masthead={masthead}
        verbs={NO_VERBS}
        frameEl={null}
        rootEl={rootEl}
        rootRef={setRootEl}
        titleBarRef={refs.titleBar}
        accessoryRef={refs.accessory}
        contentRef={refs.content}
        accessory={null}
        ResponderScope={PassThrough}
      />
    </div>
  );
}
