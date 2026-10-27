/**
 * _rails.ts — the factory rails for a site clip: the five sidebar cards a
 * fresh deck stands, on the sides and in the order the factory gives them.
 *
 * A clip about the band is more honest with the rails up, since that is how
 * the deck is seen: Arcs, Jots and Overview divide the left rail and
 * Workspaces and Layout the right (`FACTORY_RAILS` in `deck-manager.ts`).
 * A scene spreads `factoryRails()` into its deck, launches with `railsEnv()`
 * so the Jots card reads a few jots of the scene's own rather than the
 * machine's, and stands the cards up with `standUpRails` before it records.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { standUpKind } from "../body-grounding/_kind-bodies";
import { cardKind, kindPane } from "../body-grounding/_kinds";
import type { App } from "../_harness";

type RailSide = "left" | "right";
const SIDES: readonly RailSide[] = ["left", "right"];

/** Each rail card: its component id, its id under the default prefix, and its title. */
const RAIL_CARDS: readonly { componentId: string; id: string; title: string; side: RailSide }[] = [
  { componentId: "dashes", id: "sc-rail-arcs", title: "Arcs", side: "left" },
  { componentId: "jots", id: "sc-rail-jots", title: "Jots", side: "left" },
  { componentId: "overview", id: "sc-rail-overview", title: "Overview", side: "left" },
  { componentId: "cards", id: "sc-rail-cards", title: "Workspaces", side: "right" },
  { componentId: "layout", id: "sc-rail-layout", title: "Layout", side: "right" },
];

/** The jots the Jots rail shows in a clip: a few lines of the kind a reader keeps. */
const JOTS = [
  "Verify before every commit, and never commit red.",
  "Read the diff before the commit messages, so the code is judged.",
  "A failing test has three endings: fix the code, change the test, delete it.",
  "Write the join draft before stopping; the join lands it.",
];

/**
 * The deck's rail members: the cards and panes to append to a scene's own,
 * and the `sidebars` and `rails` entries for its imposition.
 *
 * A scene with two decks (two workspaces) gives each its own `prefix`, so
 * no card id stands in both, and a scene that needs the room names the
 * `sides` it keeps.
 */
export function factoryRails(prefix = "sc-rail", sides: readonly RailSide[] = SIDES): {
  cards: Record<string, unknown>[];
  panes: Record<string, unknown>[];
  sidebars: Record<string, { side: "left" | "right" }>;
  rails: Record<"left" | "right", { order: string[] }>;
} {
  const sidebars: Record<string, { side: "left" | "right" }> = {};
  const rails = { left: { order: [] as string[] }, right: { order: [] as string[] } };
  const kept = RAIL_CARDS.filter((c) => sides.includes(c.side));
  for (const c of kept) {
    sidebars[c.componentId] = { side: c.side };
    rails[c.side].order.push(c.componentId);
  }
  return {
    cards: kept.map((c) => ({ id: railId(c.id, prefix), componentId: c.componentId, title: c.title, closable: true })),
    panes: kept.map((c) => kindPane(c.componentId, railId(c.id, prefix), 0)),
    sidebars,
    rails,
  };
}

/** The launch environment for a scene with rails: a jots file of its own under a temp directory. */
export function railsEnv(): Record<string, string> {
  const path = join(mkdtempSync(join(tmpdir(), "tug-site-rails-")), "jots.json");
  writeFileSync(path, JSON.stringify({ version: 1, jots: JOTS.map((text, i) => ({ id: `j${i + 1}`, text })) }, null, 2));
  return { TUG_JOTS_PATH: path };
}

/** Stand every rail card up, so the rails are drawn when the burst starts. */
export async function standUpRails(app: App, prefix = "sc-rail", sides: readonly RailSide[] = SIDES): Promise<void> {
  for (const c of RAIL_CARDS) {
    if (sides.includes(c.side)) await standUpKind(app, cardKind(c.componentId), railId(c.id, prefix));
  }
}

/** A rail card's id under `prefix`. */
function railId(id: string, prefix: string): string {
  return id.replace(/^sc-rail/, prefix);
}
