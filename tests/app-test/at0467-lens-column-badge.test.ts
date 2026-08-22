/**
 * at0467-lens-column-badge.test.ts — a Lens row says where its card stands
 * INSIDE its slot.
 *
 * The slot run on a Lens Sessions row says which numbered place the card holds.
 * It has never said the rest of the coordinate: whether that place is shared,
 * by how many, and — when the place is split — which band the card is. The
 * column badge is that fact, drawn in the slot chip's own footprint so the two
 * read left to right as one address.
 *
 * What this file pins:
 *
 *   1. **Every row in an imposed deck carries the badge, and a place one card
 *      deep reads `1`.** The lone card is in the fixture as the case that used
 *      to draw nothing: its own masthead said the card stood in a place while
 *      its Lens row said it stood nowhere, which is two surfaces disagreeing
 *      about the same card. It is also the row whose place can still be split,
 *      and the badge is the hint that it can.
 *   2. **A stacked slot's rows show the member COUNT.** Every member answers
 *      the same, and deliberately: they all draw the same rect, and what a
 *      reader cannot see is how many are behind the one on top.
 *   3. **A split slot's rows show the BAND LETTER, in the column's own member
 *      order.** A is the topmost band. This is the one place letters appear,
 *      and it is what makes a Lens row and the pane's own cluster the same
 *      address rather than two descriptions.
 *
 * The badge on a Lens row is a READOUT — the row is its own door, and the
 * member picker's door is the badge on the pane's cluster (at0455). So there is
 * no gesture here to drive; the claims are about what the row says.
 *
 * @covers tugdeck/src/components/lens/lens-column-badge.tsx
 * @covers tugdeck/src/components/lens/sections/cards-session-cell.tsx
 * @covers tugdeck/src/components/lens/sections/cards-section.tsx
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/components/tugways/tug-column-badge.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The settle window, with room for the imposition's landing tween. */
const AFTER_LAND_MS = 900;

const SESSION_CARDS = ["A", "B", "C"] as const;
const TEXT_CARD_TITLE = "Notes";
const sessionIdOf = (cardId: string): string => `at0467-${cardId}`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Three session cards in a three-up: A and B share slot 0, C stands alone in
 * slot 1 — the one-deep place in the same fixture as the shared one. A text
 * card holds slot 2, because the Sessions group and the rest of the Cards
 * section are two different row components and the badge has to be on both.
 * The Lens holds the right rail so the rows are on screen.
 */
function deckShape(): Record<string, unknown> {
  const slots: Record<string, number> = { A: 0, B: 0, C: 1 };
  return {
    cards: [
      ...SESSION_CARDS.map((id) => ({
        id,
        componentId: "session",
        title: `Session ${id}`,
        closable: true,
      })),
      { id: "T", componentId: "text", title: TEXT_CARD_TITLE, closable: true },
      { id: "L", componentId: "lens", title: "Lens", closable: true },
    ],
    panes: [
      ...SESSION_CARDS.map((id, index) => ({
        id: `p${index + 1}`,
        position: { x: 40 + index * 40, y: 40 },
        size: { width: 675, height: 520 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["standard"],
        slot: slots[id],
      })),
      {
        id: "pText",
        position: { x: 200, y: 40 },
        size: { width: 675, height: 520 },
        cardIds: ["T"],
        activeCardId: "T",
        title: "",
        acceptsFamilies: ["standard"],
        slot: 2,
      },
      {
        id: "pLens",
        position: { x: 0, y: 0 },
        size: { width: 420, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Lens",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      sidebars: { lens: { side: "right" } },
    },
    hasFocus: true,
  };
}

interface RowBadge {
  sessionId: string;
  /** `null` when the row draws no badge at all. */
  kind: string | null;
  character: string | null;
  lit: string | null;
}

/** Every Lens Sessions row, with whatever column badge it carries. */
async function rowBadges(app: App): Promise<RowBadge[]> {
  return app.evalJS<RowBadge[]>(
    `Array.prototype.slice.call(
      document.querySelectorAll('.lens-cards-list .lens-cards-row[data-session-id]')
    ).map(function (row) {
      var badge = row.querySelector('[data-testid="lens-column-badge"]');
      return {
        sessionId: row.getAttribute("data-session-id"),
        kind: badge === null ? null : badge.getAttribute("data-kind"),
        character: badge === null ? null : badge.textContent.trim(),
        lit: badge === null ? null : badge.getAttribute("data-lit"),
      };
    }).sort(function (a, b) {
      return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
    })`,
  );
}

/**
 * The badge on the Cards section's ordinary row — a different component from
 * the Sessions cell, reached by its title because a content row carries no
 * session id to find it by.
 */
async function contentRowBadge(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function () {
       var row = Array.prototype.slice
         .call(document.querySelectorAll('.lens-cards-list .lens-cards-oneline'))
         .filter(function (el) {
           return el.textContent.indexOf(${JSON.stringify(TEXT_CARD_TITLE)}) >= 0;
         })[0];
       if (row === undefined) throw new Error("no content row for the text card");
       var badge = row.querySelector('[data-testid="lens-column-badge"]');
       return badge === null
         ? "none"
         : badge.getAttribute("data-kind") + ":" + badge.textContent.trim();
     })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0467 — the Lens row's column badge", () => {
  test(
    "every row says where its card stands, one card deep or shared",
    async () => {
      const app = await launchTugApp({ testName: "at0467-lens-column-badge" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        // An unbound session card renders the project picker instead of a
        // session, and its Lens row would carry no session id to find it by.
        for (const cardId of SESSION_CARDS) {
          await app.bindSession(cardId, {
            tugSessionId: sessionIdOf(cardId),
            projectDir: "/tmp/at0467",
          });
        }
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('.lens-cards-list .lens-cards-row[data-session-id]').length === ${SESSION_CARDS.length}`,
          { timeoutMs: 20_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── Stacked: the two sharers count, the lone card reads 1. ──
        const stacked = await rowBadges(app);
        note(
          `stacked: ${stacked
            .map((r) => `${r.sessionId}=${r.kind ?? "-"}${r.character ?? ""}`)
            .join(" ")}`,
        );
        expect(
          stacked.map((r) => `${r.sessionId}:${r.kind ?? "none"}:${r.character ?? ""}`),
          "the sharers count their place, and the lone card names its own",
        ).toEqual([
          `${sessionIdOf("A")}:stack:2`,
          `${sessionIdOf("B")}:stack:2`,
          `${sessionIdOf("C")}:stack:1`,
        ]);
        // Every member of a stack lights the top slice — the badge stands on a
        // card you can see, and a visible stacked card is the top one.
        expect(stacked.slice(0, 2).map((r) => r.lit)).toEqual(["top", "top"]);

        // A content card's row is a different component from a Sessions cell,
        // and the badge has to be on both — a reader scanning the Cards
        // section reads one list, not two.
        const content = await contentRowBadge(app);
        note(`content row: ${content}`);
        expect(
          content,
          "the text card's row says where it stands too",
        ).toBe("stack:1");

        // ── Split: the same two rows become an address. ──
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "split" }), null)`,
        );
        await wait(AFTER_LAND_MS);

        const split = await rowBadges(app);
        note(
          `split: ${split
            .map((r) => `${r.sessionId}=${r.kind ?? "-"}${r.character ?? ""}/${r.lit ?? "-"}`)
            .join(" ")}`,
        );
        expect(
          split.map((r) => `${r.sessionId}:${r.kind ?? "none"}:${r.character ?? ""}:${r.lit ?? ""}`),
          "a split's bands read A then B; the untouched place still reads 1",
        ).toEqual([
          `${sessionIdOf("A")}:split:A:top`,
          `${sessionIdOf("B")}:split:B:bottom`,
          `${sessionIdOf("C")}:stack:1:top`,
        ]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
