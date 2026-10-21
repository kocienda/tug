/**
 * body-census.ts — what the deck holds of its bodies, as the Layout card
 * reads it: how many are shown, sibling, hidden, dormant and evicted, and the
 * host's last memory-pressure event.
 *
 * Readings, never thresholds: nothing reads these counts to decide anything,
 * and no count of bodies is a setting or a default (the program's rule — a
 * card is never refused and never counted). The tiers are the program's:
 *
 *  - **shown** — the active card of its pane in the shown workspace, folded
 *    or not (a fold shows the card's own folded form);
 *  - **sibling** — an inactive tab of a pane in the shown workspace, still
 *    painting behind its pane's active card;
 *  - **hidden** — out of the shown workspace and still awake;
 *  - **dormant** — hidden past `dormantAfterMs`, its page asleep;
 *  - **evicted** — its process given up, the card standing until it is next
 *    shown.
 *
 * Pure over the facts the shell reads, so the census is unit tests over data;
 * the shell publishes it as `deck.bodies`.
 *
 * @module lib/body-census
 */

import type { BodyPressure } from "../host/declarations/lifecycle";

export type BodyTier = "shown" | "sibling" | "hidden" | "dormant" | "evicted";

/** The facts a card's tier is read from. `placed` is null for a card in no pane. */
export interface BodyTierFacts {
  readonly evicted: boolean;
  readonly dormant: boolean;
  readonly placed: { readonly active: boolean; readonly layerShown: boolean } | null;
}

/** A card's tier, or null for one the deck does not place. */
export function bodyTier(facts: BodyTierFacts): BodyTier | null {
  if (facts.evicted) return "evicted";
  if (facts.placed === null) return null;
  if (facts.placed.layerShown && facts.placed.active) return "shown";
  if (facts.dormant) return "dormant";
  return facts.placed.layerShown ? "sibling" : "hidden";
}

/** How many bodies stand in each tier. */
export type BodyCounts = Readonly<Record<BodyTier, number>>;

export const NO_BODIES: BodyCounts = { shown: 0, sibling: 0, hidden: 0, dormant: 0, evicted: 0 };

/** The counts of `tiers`, a card's null tier counted nowhere. */
export function countTiers(tiers: Iterable<BodyTier | null>): BodyCounts {
  const counts = { ...NO_BODIES };
  for (const tier of tiers) if (tier !== null) counts[tier] += 1;
  return counts;
}

/** Whether two counts are the same reading. */
export function sameCounts(a: BodyCounts, b: BodyCounts): boolean {
  return a.shown === b.shown && a.sibling === b.sibling && a.hidden === b.hidden && a.dormant === b.dormant && a.evicted === b.evicted;
}

/** The census as `deck.bodies` carries it. */
export interface BodyCensus {
  readonly counts: BodyCounts;
  /** The host's last pressure event since launch, or null for none. */
  readonly pressure: BodyPressure | null;
}

export const EMPTY_CENSUS: BodyCensus = { counts: NO_BODIES, pressure: null };

/** The counts as the Layout card's Bodies row reads them: `2 shown · 1 sibling · 3 dormant`, empty tiers left out. */
export function countsLine(counts: BodyCounts): string {
  const order: BodyTier[] = ["shown", "sibling", "hidden", "dormant", "evicted"];
  const parts = order.filter((tier) => counts[tier] > 0).map((tier) => `${counts[tier]} ${tier}`);
  return parts.length > 0 ? parts.join(" · ") : "none";
}

/** The pressure event as the row reads it: `none since launch`, or the level and its time of day. */
export function pressureLine(pressure: BodyPressure | null): string {
  if (pressure === null) return "none since launch";
  const at = new Date(pressure.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${pressure.level} at ${at}`;
}
