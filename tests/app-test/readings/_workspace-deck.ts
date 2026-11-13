/**
 * _workspace-deck.ts — a deck shaped like the user's, for the readings that
 * switch workspaces on one.
 *
 * Every workspace stands its own five rail cards (Dashes, Jots and Overview
 * on the left, Cards and Layout on the right) beside its content panes, one
 * pane per content card, imposed side by side. The content is Text and
 * Session cards; the Session cards are unbound, so nothing spawns and their
 * pages carry no transcript.
 */

/** The rail kinds every workspace on the user's deck stands, and their sides. */
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

/** A workspace tagged `tag`, its ids under `prefix`, with one content card per kind in `content`. */
export function space(prefix: string, tag: string, content: ("text" | "session")[]): Space {
  return {
    id: `${prefix}-${tag}-space`,
    rail: RAIL.map((r) => `${prefix}-${tag}-${r.kind}`),
    content: content.map((kind, i) => ({ id: `${prefix}-${tag}-${kind}${i}`, kind })),
  };
}

/** Every card of a workspace: its rail, then its content. */
export const cardsOf = (s: Space): string[] => [...s.rail, ...s.content.map((c) => c.id)];

/** A workspace's deck: its rail panes, then one content pane per card, imposed side by side. */
export function deckOf(s: Space): Record<string, unknown> {
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
  const kinds = ["one-up", "one-up", "two-up", "three-up"] as const;
  return {
    cards: [
      ...RAIL.map((r, i) => ({ id: s.rail[i], componentId: r.kind, title: r.kind, closable: true })),
      ...s.content.map((c) => ({ id: c.id, componentId: c.kind, title: c.id, closable: true })),
    ],
    panes: [...RAIL.map((r, i) => pane(s.rail[i], r.kind)), ...s.content.map((c, slot) => pane(c.id, c.id, slot))],
    activePaneId: `${s.content[0].id}-pane`,
    imposition: {
      kind: kinds[Math.min(s.content.length, 3)],
      layout: "fit",
      sidebars: Object.fromEntries(RAIL.map((r) => [r.kind, { side: r.side }])),
      rails: {
        left: { order: RAIL.filter((r) => r.side === "left").map((r) => r.kind) },
        right: { order: RAIL.filter((r) => r.side === "right").map((r) => r.kind) },
      },
    },
    hasFocus: true,
  };
}

/** The saved layout of `spaces`, the first of them active. */
export function layoutOf(spaces: readonly Space[]): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: spaces[0].id,
    spaces: spaces.map((s, i) => ({ id: s.id, name: `Space ${i + 1}`, deck: deckOf(s) })),
  };
}
