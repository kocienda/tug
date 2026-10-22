/**
 * The deck's facts, which the shell owns and every body reads.
 *
 * They are split by how often they move: `deck.facts` is the handful of
 * scalars a body renders against, `deck.menu` is the arrangement projected
 * for the key card's menu gates (it moves with every commit), and
 * `deck.frontmostProject` moves only when the frontmost bound card does.
 * `deck.cards` is every card the arrangement holds, as other pages read
 * it: its kind, title, identity, phase and session, crossing once for every
 * page that names a card it does not show.
 *
 * @module bus/declarations/deck
 */

import type { CardIdentityFacts } from "../../card-registry";
import type { CardSessionBinding } from "../../lib/card-session-binding-store";
import type { CardMastheadPayload } from "../../lib/card-title-store";
import type { SessionRow } from "../../protocol";
import { arr, bool, literal, nullable, num, obj, opaque, rec, str, type Codec } from "../codec";
import { defineSharedStore } from "../shared-store";
import { cardIdentity, cardMasthead } from "./card";
import type { BodyCensus } from "../../lib/body-census";

/** A value the bus carries without reading: anything but absent. */
const carried: Codec<unknown> = opaque((v: unknown): v is unknown => v !== undefined, null);

/** The scalars a body renders against. */
export interface DeckFactsValue {
  theme: string;
  zoom: number;
  keyboardAccess: boolean;
  /** What the shell's own key events say is held: a body sees no keys while the shell has the keyboard. */
  modifierLatch: string[];
  /** The app's focus-ring modality: a body follows the shell's rather than reading its own, and persists nothing. */
  focusRingModality: "keyboard" | "pointer";
  appActive: boolean;
  /**
   * Whether the shell's motion breaker is demoting the deck. The hand switch
   * (`tugtool deck motion demote`) is the deck's, and a body's loops are
   * stilled by its own page's root attribute, which only this fact reaches.
   */
  motionDemoted: boolean;
}

export const deckFacts = defineSharedStore<DeckFactsValue>({
  key: "deck.facts",
  owner: "shell",
  scope: { deck: true },
  codec: obj({
    theme: str,
    zoom: num,
    keyboardAccess: bool,
    modifierLatch: arr(str),
    focusRingModality: literal("keyboard", "pointer"),
    appActive: bool,
    motionDemoted: bool,
  }),
  initial: {
    theme: "",
    zoom: 1,
    keyboardAccess: false,
    modifierLatch: [],
    focusRingModality: "pointer",
    appActive: false,
    motionDemoted: false,
  },
});

/**
 * The shell's menu facts: the deck's arrangement projected the way the
 * shell's menu publisher projects it, and the focus family's travel per
 * direction. A body's one-card deck cannot say how many panes stand, which
 * slot is where, or whether a card lies to the right, so the gates it posts
 * for the key card's menu items read these. Opaque here:
 * `lib/host-menu-state.ts` writes and reads them. Null until the shell has
 * projected.
 */
export interface DeckMenuValue {
  projection: unknown;
  focusTravel: unknown;
}

export const deckMenu = defineSharedStore<DeckMenuValue | null>({
  key: "deck.menu",
  owner: "shell",
  scope: { deck: true },
  codec: nullable(obj({ projection: carried, focusTravel: carried })),
  initial: null,
});

function isBinding(value: unknown): value is CardSessionBinding {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  return typeof b.tugSessionId === "string" && typeof b.workspaceKey === "string" && typeof b.projectDir === "string";
}

/** A card's session binding, as the shell's `cardSessionBindingStore` holds one. */
export const sessionBinding: Codec<CardSessionBinding> = opaque(isBinding, {
  tugSessionId: "s",
  lineId: "l",
  workspaceKey: "w",
  projectDir: "/p",
} as CardSessionBinding);

/**
 * The deck's frontmost bound card's session binding, null when no card is
 * bound: the project a card with no session of its own (the Jots card)
 * resolves a relative path against. Beside it, `projectDirs` is every bound
 * card's project, deduplicated and frontmost first — the workspace's project
 * set, which the Choose Session sheet opens on. A body's one-card deck can
 * say neither which card stands in front nor which projects the rest hold.
 */
export const deckFrontmostProject = defineSharedStore<{
  binding: CardSessionBinding | null;
  projectDirs: string[];
}>({
  key: "deck.frontmostProject",
  owner: "shell",
  scope: { deck: true },
  codec: obj({
    binding: nullable(sessionBinding),
    projectDirs: arr(str),
  }),
  initial: { binding: null, projectDirs: [] },
});

/** What every page reads of a card the arrangement holds. */
export interface DeckCardFacts {
  componentId: string;
  /** The card's live title override, or null (`cardTitleStore.get`). */
  title: string | null;
  masthead: CardMastheadPayload | null;
  /** What the card holds, as the page that shows it resolved it live (`liveCardIdentity`), or null. */
  identity: CardIdentityFacts | null;
  /** The session phase key the card's body last reported (`card.facts` `activity`), or null. */
  activity: string | null;
  binding: CardSessionBinding | null;
  /**
   * The card's session as the shell's ledger holds it — the `state` of its
   * seated segment's row — or null while the shell has no row. A body reads
   * its own on its reveal: a closed or failed session has no subprocess to
   * answer a catch-up.
   */
  sessionState: SessionRow["state"] | null;
  /** A parked workspace card's title from its bindings ledger (`cardIdentity`'s `parked` source), else null. */
  parkedTitle: string | null;
  /** Whether the card waives its type's close confirm now (`card.holds` `waive`). */
  waivesClose: boolean;
}

/**
 * Every card the arrangement holds — every workspace's — by id. A page reads
 * a card it does not show here and nowhere else: its own page stores answer
 * another card's id from this replica, so nothing about a card crosses
 * twice.
 */
export const deckCards = defineSharedStore<Record<string, DeckCardFacts>>({
  key: "deck.cards",
  owner: "shell",
  scope: { deck: true },
  codec: rec(
    obj({
      componentId: str,
      title: nullable(str),
      masthead: nullable(cardMasthead),
      identity: nullable(cardIdentity),
      activity: nullable(str),
      binding: nullable(sessionBinding),
      sessionState: nullable(literal("live", "closed", "failed")),
      parkedTitle: nullable(str),
      waivesClose: bool,
    }),
  ),
  initial: {},
});

/**
 * What the deck holds of its bodies — how many are shown, sibling, hidden,
 * dormant and evicted — and the host's last memory-pressure event, which the
 * Layout card's Bodies row reads (`lib/body-census.ts`). Readings: nothing
 * decides anything from them.
 */
export const deckBodies = defineSharedStore<BodyCensus>({
  key: "deck.bodies",
  owner: "shell",
  scope: { deck: true },
  codec: obj({
    counts: obj({ shown: num, sibling: num, hidden: num, dormant: num, evicted: num }),
    pressure: nullable(obj({ level: literal("normal", "warning", "critical"), at: num })),
  }),
  initial: { counts: { shown: 0, sibling: 0, hidden: 0, dormant: 0, evicted: 0 }, pressure: null },
});
