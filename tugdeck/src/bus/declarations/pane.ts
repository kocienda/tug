/**
 * What the shell tells a card's body about the pane the card stands in, and
 * the gestures a card's chrome asks of the shell.
 *
 * The shell's: `pane.chrome` is the pane as its chrome draws it — the tab
 * set by card id (each tab named from its card's `deck.cards` record), the
 * composed title, the grips the arrangement offers, the title-bar
 * menus' facts (`paneChromeFor` in `lib/pane-chrome-projection.ts`). Every
 * card of a pane is sent the same value, sibling or active, so a tab switch
 * shows a page that has already drawn its new chrome. The card's own
 * masthead is not in it: the active card's page holds that itself. It goes
 * after `card.context`, so a body that attaches reads its context first.
 *
 * The verbs are the shell's, since the shell holds the arrangement: a tab
 * selected, closed or reordered, the pane closed, and each title-bar menu's
 * act. The sending card is the envelope's `from`; a verb that names another
 * card names it in the payload, and the shell answers it only for a card in
 * the sender's own pane. `card.close` and `card.addSibling`
 * (`declarations/verbs.ts`) keep their meanings beside these.
 *
 * @module bus/declarations/pane
 */

import type { CloseAsks } from "../../lib/close-asks";
import type { ColumnMode, ContentWidth } from "../../lib/layout-imposer";
import { arr, bool, empty, literal, nullable, num, obj, str } from "../codec";
import { defineAction } from "../routed-action";
import { defineSharedStore } from "../shared-store";
import { cardContext } from "./card";

/** An edge or corner a pane's frame can be resized from. */
export type ResizeEdge = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

const resizeEdge = literal("n", "s", "e", "w", "nw", "ne", "sw", "se");

/** One tab of a pane: its card, named in the page from the card's `deck.cards` record. */
export interface PaneChromeTab {
  cardId: string;
}

/** One row of the place badge's picker: a pane sharing this pane's place, named from its active card's record. */
export interface PaneChromeStackEntry {
  paneId: string;
  cardId: string;
  selected: boolean;
}

/** The pane's place in its run, as the badge draws it. */
export interface PaneChromePlace {
  mode: ColumnMode;
  kind: "column" | "rail";
  /** This pane's band in a split, topmost first; 0 in a stack. */
  index: number;
  /** The band's letter in a split, or null in a stack. */
  band: string | null;
  /** How many panes share the place, at least 1. */
  count: number;
}

/** A pane as its chrome draws it. */
export interface PaneChromeValue {
  paneId: string;
  /** The pane's cards, in tab order. */
  tabs: PaneChromeTab[];
  activeCardId: string;
  /** The title bar's text: `composePaneTitleBarText` over the active card. */
  title: string;
  icon: string | null;
  closable: boolean;
  /** Whether each close gesture asks first, and what it asks (`closeAsksOf`). */
  close: CloseAsks;
  role: "content" | "sidebar";
  /** The edges the arrangement lets the hand resize the pane from. */
  grips: ResizeEdge[];
  /** The families the tab bar's add-tab menu offers. */
  acceptedFamilies: string[];
  /** The width menu, with the preset it checks (null at a custom width); null when it is not offered. */
  width: { preset: ContentWidth | null } | null;
  /** The Fill Height row, with whether the pane fills its slot now; null when it is not offered. */
  fillHeight: { fills: boolean } | null;
  /** The place badge; null for a pane standing in no place. */
  placeArrangement: PaneChromePlace | null;
  /** Whether the pane stands in bullseye; null when the verb is not offered (a rail). */
  bullseye: boolean | null;
  /** The workspaces the move control lists; empty when it is not offered (a rail). */
  spaces: Array<{ id: string; name: string }>;
  /** The workspace the pane's layer shows, which the move control leaves out. */
  ownSpaceId: string | null;
  /** The panes sharing this pane's place, topmost first. */
  slotStack: PaneChromeStackEntry[];
  /** Whether the bar draws the fold glyph: a content card that does not own its folded form. */
  cardFold: boolean;
  /** The slot badge's count and held slot, or null when the pane stands in no slot to name. */
  slot: { count: number; held: number } | null;
}

const closeAsk = obj({ confirm: bool, message: str, label: str });

export const paneChrome = defineSharedStore<PaneChromeValue | null>({
  key: "pane.chrome",
  owner: "shell",
  scope: { card: true },
  after: [cardContext],
  codec: nullable(
    obj({
      paneId: str,
      tabs: arr(obj({ cardId: str })),
      activeCardId: str,
      title: str,
      icon: nullable(str),
      closable: bool,
      close: obj({ pane: closeAsk, card: closeAsk, all: closeAsk }),
      role: literal("content", "sidebar"),
      grips: arr(resizeEdge),
      acceptedFamilies: arr(str),
      width: nullable(obj({ preset: nullable(literal("slim", "comfy", "wide")) })),
      fillHeight: nullable(obj({ fills: bool })),
      placeArrangement: nullable(
        obj({
          mode: literal("stack", "split"),
          kind: literal("column", "rail"),
          index: num,
          band: nullable(str),
          count: num,
        }),
      ),
      bullseye: nullable(bool),
      spaces: arr(obj({ id: str, name: str })),
      ownSpaceId: nullable(str),
      slotStack: arr(obj({ paneId: str, cardId: str, selected: bool })),
      cardFold: bool,
      slot: nullable(obj({ count: num, held: num })),
    }),
  ),
  initial: null,
});

// ---- What a card's chrome asks of the shell ----

/** Make `cardId`, a card of the sender's pane, its active tab. */
export const paneSelectTab = defineAction({
  id: "pane.selectTab",
  owner: "shell",
  codec: obj({ cardId: str }),
});

/** Close the tab of `cardId`, a card of the sender's pane, through its modal hold and its close guard. */
export const paneCloseCard = defineAction({
  id: "pane.closeCard",
  owner: "shell",
  codec: obj({ cardId: str }),
});

/** Close the sender's whole pane: the title bar's ×, its confirm already answered in the card. */
export const paneClosePane = defineAction({
  id: "pane.closePane",
  owner: "shell",
  codec: empty,
});

/** Move the tab at `fromIndex` of the sender's pane to `toIndex`. */
export const paneReorderTabs = defineAction({
  id: "pane.reorderTabs",
  owner: "shell",
  codec: obj({ fromIndex: num, toIndex: num }),
});

/** A tab drag past its own bar, at the sender's viewport point: the shell hit-tests and commits it. */
export const paneTabDrag = defineAction({
  id: "pane.tabDrag",
  owner: "shell",
  codec: obj({ phase: literal("move", "end", "cancel"), cardId: str, x: num, y: num }),
});

/** Set the sender's pane to a width preset. */
export const paneSetWidth = defineAction({
  id: "pane.setWidth",
  owner: "shell",
  codec: obj({ preset: literal("slim", "comfy", "wide") }),
});

/** Make the sender's pane fill its slot's height again. */
export const paneFillHeight = defineAction({
  id: "pane.fillHeight",
  owner: "shell",
  codec: empty,
});

/** Split, stack or equalize the column the sender's pane stands in. */
export const paneArrangePlace = defineAction({
  id: "pane.arrangePlace",
  owner: "shell",
  codec: obj({ verb: literal("place:split", "place:stack", "place:equalize") }),
});

/** Put the sender's pane in bullseye, or take it out. */
export const paneToggleBullseye = defineAction({
  id: "pane.toggleBullseye",
  owner: "shell",
  codec: empty,
});

/** Move the sender's pane's active card to the workspace `spaceId`. */
export const paneMoveToSpace = defineAction({
  id: "pane.moveToSpace",
  owner: "shell",
  codec: obj({ spaceId: str }),
});

/** Raise `paneId`, a pane sharing the sender's place: a row of the badge's picker. */
export const paneRevealStackEntry = defineAction({
  id: "pane.revealStackEntry",
  owner: "shell",
  codec: obj({ paneId: str }),
});

/** Slide the strip `cardId`, a card of the sender's pane, rides until its pane is fully in: a title-bar click's release. */
export const paneRevealCard = defineAction({
  id: "pane.revealCard",
  owner: "shell",
  codec: obj({ cardId: str }),
});
