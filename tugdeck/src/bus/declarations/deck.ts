/**
 * The deck's facts, which the shell owns and every body reads.
 *
 * They are split by how often they move: `deck.facts` is the handful of
 * scalars a body renders against, `deck.menu` is the arrangement projected
 * for the key card's menu gates (it moves with every commit), and
 * `deck.frontmostProject` moves only when the frontmost bound card does.
 *
 * @module bus/declarations/deck
 */

import type { CardSessionBinding } from "../../lib/card-session-binding-store";
import { arr, bool, literal, nullable, num, obj, opaque, str, type Codec } from "../codec";
import { defineSharedStore } from "../shared-store";

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
 * resolves a relative path against. A body's one-card deck cannot say which
 * card stands in front.
 */
export const deckFrontmostProject = defineSharedStore<{ binding: CardSessionBinding | null }>({
  key: "deck.frontmostProject",
  owner: "shell",
  scope: { deck: true },
  codec: obj({
    binding: nullable(sessionBinding),
  }),
  initial: { binding: null },
});
