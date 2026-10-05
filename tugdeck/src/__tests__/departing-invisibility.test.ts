/**
 * departing-invisibility.test.ts — a departing pane is invisible to every
 * reader that lists or counts.
 *
 * The store holds a closed pane, its cards and a `departing` mark for the one
 * settle that carries it out (`lib/departing.ts`). `getSnapshot` publishes the
 * STANDING deck, which never holds a departing pane, so a reader that lists or
 * counts is right by default. `getPicture` is the one door to the composed
 * deck, and only what draws the departure may read it: the canvas, the settle
 * engine, the raise, the occlusion pass, a departing card's place facts, slot
 * badge and identity, and `spaceOf`.
 *
 * So the property is held at the door rather than reader by reader:
 *
 * - every `getPicture` read in `src` is on {@link PICTURE_READERS}, at the
 *   count recorded there. A new read is a line added here, with the reason
 *   it draws the departure rather than lists or counts;
 * - `composeDeparting` is called only inside `getPicture`, so no other path
 *   reaches the composed deck;
 * - `getSnapshot` returns the standing deck.
 *
 * The one by-id reader of the picture that answers for the departing pane
 * itself is `panePlaceFactsOf`, read as if the pane still stood so its badge
 * does not change mid-fade; that is checked over a composed deck below.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { registerCard } from "../card-registry";
import type { CardState, DeckState, TugPaneState } from "../layout-tree";
import { composeDeparting, type DepartingEntry } from "../lib/departing";
import { panePlaceFactsOf } from "../components/chrome/pane-place-facts";

const SRC = resolve(import.meta.dir, "..");

/**
 * Every file that reads `getPicture`, and how many times. Each draws the
 * departure; none lists or counts.
 */
const PICTURE_READERS: Record<string, number> = {
  // The door itself, its interface, and `spaceOf`: a departing card's own
  // content still answers to the workspace it is leaving.
  "deck-manager.ts": 2,
  "deck-manager-store.ts": 1,
  // Draws every frame, departing ones included.
  "components/chrome/deck-canvas.tsx": 1,
  // Carries the departing frame out and lands it.
  "components/chrome/settle-engine.ts": 2,
  // Stacks a departing frame where it stood.
  "components/chrome/pane-stacking.ts": 1,
  // Occludes against what is on screen, departing frames included.
  "components/chrome/pane-occlusion-controller.ts": 1,
  // A departing card's place facts, slot badge and identity.
  "components/chrome/pane-place-facts.ts": 2,
  "components/tugways/card-slot-badge.tsx": 1,
  "lib/card-identity.ts": 1,
};

/** Strip block and line comments so prose naming the door is not a read. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every non-test source file under `src`, relative path → comment-stripped text. */
function sources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      out.set(relative(SRC, path), stripComments(readFileSync(path, "utf8")));
    }
  };
  walk(SRC);
  return out;
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

describe("only what draws the departure reads the composed deck", () => {
  const files = sources();

  test("every getPicture read is on the allow list, at its recorded count", () => {
    const found: Record<string, number> = {};
    for (const [path, text] of files) {
      const n = count(text, /\bgetPicture\b/g);
      if (n > 0) found[path] = n;
    }
    expect(found).toEqual(PICTURE_READERS);
  });

  test("composeDeparting is called only inside getPicture", () => {
    const callers: string[] = [];
    for (const [path, text] of files) {
      if (path === "lib/departing.ts") continue;
      if (count(text, /\bcomposeDeparting\s*\(/g) > 0) callers.push(path);
    }
    expect(callers).toEqual(["deck-manager.ts"]);

    const manager = files.get("deck-manager.ts") ?? "";
    expect(count(manager, /\bcomposeDeparting\s*\(/g)).toBe(1);
    const door = manager.slice(manager.indexOf("public getPicture = "));
    const body = door.slice(0, door.indexOf("\n  };"));
    expect(body).toContain("composeDeparting(");
  });

  test("getSnapshot publishes the standing deck", () => {
    const manager = files.get("deck-manager.ts") ?? "";
    expect(manager).toMatch(/public getSnapshot = \(\): DeckState => this\.deckState;/);
  });
});

// ---- The departing pane's own place facts ----

beforeAll(() => {
  for (const componentId of ["invTop", "invBottom"]) {
    registerCard({
      componentId,
      contentFactory: () => null,
      defaultMeta: { title: componentId, closable: true },
      layoutRole: "sidebar",
    });
  }
  registerCard({
    componentId: "invContent",
    contentFactory: () => null,
    defaultMeta: { title: "Content", closable: true },
  });
});

function card(id: string, componentId: string): CardState {
  return { id, componentId, title: id, closable: true };
}

function pane(id: string, cardIds: readonly string[], extra: Partial<TugPaneState> = {}): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 320, height: 600 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["standard"],
    ...extra,
  };
}

/**
 * A flow strip of three slots: slot 0 a split column of three members, slot 1
 * one card holding two tabs, slot 2 one card; and a two-member left rail.
 */
const D: DeckState = {
  cards: [
    card("c-top", "invTop"),
    card("c-bottom", "invBottom"),
    card("c-a", "invContent"),
    card("c-b", "invContent"),
    card("c-c", "invContent"),
    card("c-d", "invContent"),
    card("c-d2", "invContent"),
    card("c-e", "invContent"),
  ],
  panes: [
    pane("p-top", ["c-top"], { acceptsFamilies: [] }),
    pane("p-bottom", ["c-bottom"], { acceptsFamilies: [] }),
    pane("p-a", ["c-a"], { slot: 0 }),
    pane("p-b", ["c-b"], { slot: 0 }),
    pane("p-c", ["c-c"], { slot: 0 }),
    pane("p-d", ["c-d", "c-d2"], { slot: 1, size: { width: 480, height: 600 } }),
    pane("p-e", ["c-e"], { slot: 2 }),
  ],
  activePaneId: "p-b",
  bullseyePaneId: "p-b",
  imposition: {
    kind: "three-up",
    layout: "flow",
    sidebars: {
      invTop: { side: "left", pinned: true },
      invBottom: { side: "left", pinned: true },
    },
    columns: { 0: { mode: "split", order: ["p-a", "p-b", "p-c"] } },
  },
  hasFocus: true,
};

/** `D` with `paneId` closed, and the entry the deck manager would record for it. */
function closed(paneId: string): { standing: DeckState; entry: DepartingEntry } {
  const index = D.panes.findIndex((p) => p.id === paneId);
  const leaving = D.panes[index];
  const gone = new Set(leaving.cardIds);
  const standing: DeckState = {
    ...D,
    panes: D.panes.filter((p) => p.id !== paneId),
    cards: D.cards.filter((c) => !gone.has(c.id)),
  };
  if (standing.activePaneId === paneId) delete standing.activePaneId;
  if (standing.bullseyePaneId === paneId) delete standing.bullseyePaneId;
  return {
    standing,
    entry: { pane: leaving, cards: D.cards.filter((c) => gone.has(c.id)), index },
  };
}

describe("panePlaceFactsOf answers a departing pane as if it still stood", () => {
  for (const x of D.panes.map((p) => p.id)) {
    test(`with ${x} departing`, () => {
      const { standing, entry } = closed(x);
      const composed = composeDeparting(standing, [entry]);
      expect(composed.departing).toEqual({ [x]: true });
      expect(panePlaceFactsOf(composed, x)).toEqual(panePlaceFactsOf(D, x));
    });
  }
});
