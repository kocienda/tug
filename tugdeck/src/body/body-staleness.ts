/**
 * body-staleness.ts — whether a hidden page's picture still stands for what
 * it would draw now.
 *
 * A page hidden by a switch keeps the picture it last drew. Shown again, it
 * is *current* when none of the values it draws from moved while it was
 * hidden, and then it can say `painted` at once rather than wait for its deck
 * to hold still: what it shows is what it would draw. The signature is the
 * join of exactly those values, so a move in one of them is a move in the
 * signature, and nothing else is.
 *
 * Left out, each for a reason its store gives: `deckFacts.theme` is the
 * screen's theme, which a body reads only for its first paint and never draws
 * after (it wears `cardTheme`), and which moves on every switch between
 * differently-themed workspaces; `modifierLatch` moves on every chorded
 * switch; `appActive` and `focusRingModality` draw nothing on a hidden page;
 * `deckMenu` is a separate store the page does not draw. Of `cardContext`,
 * `firstResponderCardId` is the keyboard's and names another card after
 * every switch, while a page draws only whether it is the key card itself;
 * and `layerShown` is the shown edge the signature is compared across, which
 * gates what a page does and draws nothing, so keeping it would make every
 * arriving page stale by definition.
 *
 * Pure, so a test drives it without a page.
 */

import type { DeckFactsValue } from "../bus/declarations/deck";

/** What a page draws from, as it last applied each. */
export interface DrawnValues {
  readonly cardTheme: unknown;
  readonly paneChrome: unknown;
  readonly cardContext: unknown;
  /** The whole `deckCards` replica; only the page's own entry is drawn unless it renders other cards. */
  readonly deckCards: Readonly<Record<string, unknown>> | null;
  readonly deckFacts: DeckFactsValue | null;
  /** The arrangement stores, for a kind that lists or moves the whole deck; null for any other. */
  readonly arrangement: { readonly deck: unknown; readonly spaces: unknown } | null;
}

/**
 * The signature of what a page bound to `cardId` draws from `values`. A page
 * whose kind renders other cards (`rendersOthers`: the rail kinds and
 * Overview, the kinds that follow the whole deck) takes every card's entry
 * and the arrangement stores whole; any other takes its own entry alone.
 */
export function drawnSignature(cardId: string, values: DrawnValues, rendersOthers: boolean): string {
  return JSON.stringify(drawnParts(cardId, values, rendersOthers));
}

/**
 * The signature's parts by name, each its value's JSON: what {@link movedParts}
 * compares. The context and the card's own entry are one part per field
 * (`cardContext.folded`, `deckCards.title`, …), so a reading names which moved.
 */
export function drawnParts(cardId: string, values: DrawnValues, rendersOthers: boolean): Record<string, string> {
  const facts = values.deckFacts;
  return {
    cardTheme: JSON.stringify(values.cardTheme ?? null),
    paneChrome: JSON.stringify(values.paneChrome ?? null),
    ...fieldParts("cardContext", drawnContext(cardId, values.cardContext)),
    ...(rendersOthers ? { deckCards: JSON.stringify(values.deckCards ?? null) } : fieldParts("deckCards", values.deckCards?.[cardId] ?? null)),
    deckFacts: JSON.stringify(facts === null ? null : [facts.zoom, facts.keyboardAccess, facts.motionDemoted]),
    arrangement: JSON.stringify(rendersOthers ? (values.arrangement ?? null) : null),
  };
}

/**
 * What of a card's context its page draws: every field but the keyboard's
 * first responder, which it draws only as whether that is itself, and the
 * layer's shown flag, which is the edge being compared across.
 */
export function drawnContext(cardId: string, context: unknown): unknown {
  if (context === null || typeof context !== "object") return context ?? null;
  const { firstResponderCardId, layerShown: _shown, ...drawn } = context as Record<string, unknown>;
  return { ...drawn, key: firstResponderCardId === cardId };
}

function fieldParts(name: string, value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object") return { [name]: JSON.stringify(value ?? null) };
  const parts: Record<string, string> = {};
  for (const [field, v] of Object.entries(value)) parts[`${name}.${field}`] = JSON.stringify(v ?? null);
  return parts;
}

/** Whether a page that drew `drawnAtHide` when it was hidden would draw something else now. */
export function staleAfter(drawnAtHide: string | null, now: string): boolean {
  return drawnAtHide !== null && drawnAtHide !== now;
}

/** The names of the parts that differ between two signatures, for a reading of what made a page stale. */
export function movedParts(drawnAtHide: string, now: string): string[] {
  const a = JSON.parse(drawnAtHide) as Record<string, string>;
  const b = JSON.parse(now) as Record<string, string>;
  return Object.keys(b).filter((key) => a[key] !== b[key]);
}
