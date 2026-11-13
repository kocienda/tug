/**
 * _workspace-deck.ts — a deck shaped like the user's, for the readings that
 * switch workspaces on one.
 *
 * The window stands one rail of five cards (Dashes, Jots and Overview on the
 * left, Cards and Layout on the right), shared by every workspace, and each
 * workspace its content panes, one pane per content card, imposed side by
 * side. The content is Text and Session cards; the Session cards are
 * unbound, so nothing spawns and their pages carry no transcript.
 */

/** The rail kinds the window stands, and their sides. */
export const RAIL = [
  { kind: "dashes", side: "left" },
  { kind: "jots", side: "left" },
  { kind: "overview", side: "left" },
  { kind: "cards", side: "right" },
  { kind: "layout", side: "right" },
] as const;

export interface Space {
  id: string;
  rail: string[];
  content: { id: string; kind: "text" | "session" }[];
}

/**
 * A workspace tagged `tag`, its ids under `prefix`, with one content card per
 * kind in `content`. Its `rail` is the window's, the same ids for every
 * workspace under one `prefix`.
 */
export function space(prefix: string, tag: string, content: ("text" | "session")[]): Space {
  return {
    id: `${prefix}-${tag}-space`,
    rail: RAIL.map((r) => `${prefix}-rail-${r.kind}`),
    content: content.map((kind, i) => ({ id: `${prefix}-${tag}-${kind}${i}`, kind })),
  };
}

/** Every card shown with a workspace: the window's rail, then its content. */
export const cardsOf = (s: Space): string[] => [...s.rail, ...s.content.map((c) => c.id)];

const pane = (id: string, title: string, slot?: number) => ({
  id: `${id}-pane`,
  position: { x: 60, y: 60 },
  size: { width: 600, height: 700 },
  cardIds: [id],
  activeCardId: id,
  title,
  acceptsFamilies: slot === undefined ? ([] as string[]) : ["standard"],
  ...(slot === undefined ? {} : { slot }),
});

/** A workspace's deck: one content pane per card, imposed side by side, and no rail. */
export function deckOf(s: Space): Record<string, unknown> {
  const kinds = ["one-up", "one-up", "two-up", "three-up"] as const;
  return {
    cards: s.content.map((c) => ({ id: c.id, componentId: c.kind, title: c.id, closable: true })),
    panes: s.content.map((c, slot) => pane(c.id, c.id, slot)),
    activePaneId: `${s.content[0].id}-pane`,
    imposition: { kind: kinds[Math.min(s.content.length, 3)], layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The window's rail as the layout envelope carries it: `s`'s rail cards and their sides. */
export function railOf(s: Space): Record<string, unknown> {
  return {
    cards: RAIL.map((r, i) => ({ id: s.rail[i], componentId: r.kind, title: r.kind, closable: true })),
    panes: RAIL.map((r, i) => pane(s.rail[i], r.kind)),
    imposition: {
      sidebars: Object.fromEntries(RAIL.map((r) => [r.kind, { side: r.side }])),
      rails: {
        left: { order: RAIL.filter((r) => r.side === "left").map((r) => r.kind) },
        right: { order: RAIL.filter((r) => r.side === "right").map((r) => r.kind) },
      },
    },
  };
}

/** The saved layout of `spaces`, the first of them active, with one window rail. */
export function layoutOf(spaces: readonly Space[]): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: spaces[0].id,
    spaces: spaces.map((s, i) => ({ id: s.id, name: `Space ${i + 1}`, deck: deckOf(s) })),
    rail: railOf(spaces[0]),
  };
}
