/**
 * at0369-open-file-nearest-slot.test.ts — a file opens in the nearest slot
 * that will take it, and a split column will not.
 *
 * Every fresh card in an arrangement chooses its slot through one rule, ranked
 * from the card the gesture came from: nearest first; an empty slot before a
 * stacked one; right before left. A split column is not a landing place, so it
 * is passed over while anything else qualifies. The card that opened the file
 * is never covered by it.
 *
 * Driven through the real `open-file` control action — whose origin is the
 * first responder — against real files on disk, one deck per claim so each
 * key is proven by a fixture where it alone decides:
 *
 *  1. **Empty before stack.** From slot 2, an empty slot 1 and a stack at
 *     slot 3 are equally near; the file takes the empty one, even though it
 *     lies left — the emptiness key outranks direction.
 *  2. **Right before left.** From slot 2, stacks at slots 1 and 3 are equally
 *     near and equally full; the file takes the right one.
 *  3. **Nearest first.** From slot 0, a stack at slot 1 is nearer than an
 *     empty slot 2; distance outranks emptiness, and the origin's own slot is
 *     never the answer.
 *  4. **A split is skipped.** From slot 1, a split column at slot 2 would win
 *     on direction; it does not qualify, so the file takes the stack at slot 0.
 *
 * The assertion is on the stored slot of the pane holding the new card, read
 * back through the deck's own diagnostic snapshot — the number the imposer
 * resolves geometry from, not a measured frame.
 *
 * Each landing is also checked for its FLASH — the border ring a raise draws,
 * now drawn by a card that arrives. Placement and the flash are one gesture: a
 * card put down away from the link that named it announces itself or it may
 * as well have opened anywhere. The check is on the class, not on the ring's
 * paint, because a background app-test window ticks no keyframes ([P04]).
 *
 * @covers tugdeck/src/lib/opening-placement.ts
 * @covers tugdeck/src/lib/open-file-in-card.ts
 * @covers tugdeck/src/lib/flash-pane-border.ts
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

type SlotSpec = "empty" | "stack" | "split";

/**
 * A four-up deck whose slots stand as `specs` says, with the card in
 * `originSlot` focused. A stack holds one `hello` card; a split holds two, in
 * a column set to split. Card ids are `S<slot>` (a stack) and `S<slot>a` /
 * `S<slot>b` (a split).
 */
function deckOf(specs: readonly SlotSpec[], originSlot: number) {
  const cards: Record<string, unknown>[] = [];
  const panes: Record<string, unknown>[] = [];
  const columns: Record<number, unknown> = {};
  const add = (cardId: string, slot: number) => {
    cards.push({ id: cardId, componentId: "hello", title: cardId, closable: true });
    panes.push({
      id: `p${cardId}`,
      position: { x: 40, y: 40 },
      size: { width: 360, height: 400 },
      cardIds: [cardId],
      activeCardId: cardId,
      title: "",
      acceptsFamilies: ["maker"],
      slot,
    });
  };
  specs.forEach((spec, slot) => {
    if (spec === "stack") add(`S${slot}`, slot);
    if (spec === "split") {
      add(`S${slot}a`, slot);
      add(`S${slot}b`, slot);
      columns[slot] = { mode: "split", order: [`pS${slot}a`, `pS${slot}b`] };
    }
  });
  return {
    state: {
      cards,
      panes,
      activePaneId: `pS${originSlot}`,
      imposition: { kind: "four-up", sidebars: {}, columns },
      hasFocus: true,
    },
    focusCardId: `S${originSlot}`,
  };
}

const textCardIds = (app: App): Promise<string[]> =>
  app.evalJS<string[]>(
    `window.tugdeck.diag.getDeckState().cards
      .filter(function (c) { return c.componentId === "text"; })
      .map(function (c) { return c.id; })`,
  );

/** The stored slot of the pane holding `cardId`; null when it holds none. */
const slotOf = (app: App, cardId: string): Promise<number | null> =>
  app.evalJS<number | null>(
    `(function () {
      var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) {
        return p.cardIds.indexOf(${JSON.stringify(cardId)}) !== -1;
      });
      return pane === undefined || pane.slot === undefined ? null : pane.slot;
    })()`,
  );

/**
 * Open `file` and answer with the id of the Text card that appeared for it —
 * the one id the deck gained. Waiting on the count rather than a fixed delay
 * keeps the read off the frame the card mounts on.
 */
async function openAndCatchCard(app: App, file: string): Promise<string> {
  const before = await textCardIds(app);
  await app.dispatchControlAction("open-file", { path: file });
  await app.waitForCondition<boolean>(
    `window.tugdeck.diag.getDeckState().cards.filter(function (c) {
      return c.componentId === "text";
    }).length === ${before.length + 1}`,
    { timeoutMs: 15_000 },
  );
  const after = await textCardIds(app);
  const fresh = after.filter((id) => !before.includes(id));
  expect(fresh).toHaveLength(1);

  // …and the card that answered the open announces itself. The flash is a
  // one-shot class the pane wears for the length of the keyframes, so the read
  // is a poll: the card is added before React has committed its pane, and the
  // flash lands on the deferred retry that follows the commit.
  await app.waitForCondition<boolean>(
    `(function () {
      var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) {
        return p.cardIds.indexOf(${JSON.stringify(fresh[0])}) !== -1;
      });
      if (pane === undefined) return false;
      var el = document.querySelector(
        '.tug-pane[data-pane-id="' + pane.id + '"]');
      return el !== null && el.classList.contains("tug-pane-flash");
    })()`,
    { timeoutMs: 1_200 },
  );
  return fresh[0];
}

/** Every seeded card's slot, to prove an open placed one card and moved none. */
async function seededSlots(
  app: App,
  specs: readonly SlotSpec[],
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const [slot, spec] of specs.entries()) {
    const ids =
      spec === "stack" ? [`S${slot}`] : spec === "split" ? [`S${slot}a`, `S${slot}b`] : [];
    for (const id of ids) out[id] = await slotOf(app, id);
  }
  return out;
}

const CASES: readonly {
  name: string;
  specs: readonly SlotSpec[];
  origin: number;
  expected: number;
}[] = [
  {
    name: "empty before stack",
    specs: ["stack", "empty", "stack", "stack"],
    origin: 2,
    expected: 1,
  },
  {
    name: "right before left",
    specs: ["empty", "stack", "stack", "stack"],
    origin: 2,
    expected: 3,
  },
  {
    name: "nearest first, and never the origin's own slot",
    specs: ["stack", "stack", "empty", "empty"],
    origin: 0,
    expected: 1,
  },
  {
    name: "a split column is skipped",
    specs: ["stack", "stack", "split", "empty"],
    origin: 1,
    expected: 0,
  },
];

describe.skipIf(!SHOULD_RUN)(
  "at0369 — an opened file lands in the nearest slot that will take it",
  () => {
    test(
      "nearest, then empty, then rightward; a split never qualifies",
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0369-"));
        const app = await launchTugApp({
          testName: "at0369-open-file-nearest-slot",
        });
        try {
          for (const [index, c] of CASES.entries()) {
            const file = path.join(dir, `case-${index}.txt`);
            fs.writeFileSync(file, `${c.name}\n`);

            const seed = deckOf(c.specs, c.origin);
            await app.seedDeckState(seed);
            expect(await app.getActiveCardId(), c.name).toBe(seed.focusCardId);
            const standing = await seededSlots(app, c.specs);

            const fresh = await openAndCatchCard(app, file);
            expect(await slotOf(app, fresh), c.name).toBe(c.expected);

            // Opening a file places the new card and touches no one else's
            // slot.
            expect(await seededSlots(app, c.specs), c.name).toEqual(standing);
          }
        } finally {
          await app.close();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
