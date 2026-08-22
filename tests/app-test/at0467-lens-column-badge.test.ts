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
 *   1. **A shared slot's rows carry the badge; a lone card's row does not.**
 *      Presence is the claim, because the badge's absence is a decision rather
 *      than an omission: a card alone in its slot has nothing the run does not
 *      already say, and a chip stating a fact that does not exist is worse than
 *      no chip.
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
const sessionIdOf = (cardId: string): string => `at0467-${cardId}`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Three session cards in a three-up: A and B share slot 0, C stands alone in
 * slot 1 — the negative case in the same fixture as the positive one. The Lens
 * holds the right rail so the rows are on screen.
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

describe.skipIf(!SHOULD_RUN)("at0467 — the Lens row's column badge", () => {
  test(
    "a shared slot's rows say how the place is shared; a lone card's row says nothing",
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

        // ── Stacked: the two sharers count, the lone card says nothing. ──
        const stacked = await rowBadges(app);
        note(
          `stacked: ${stacked
            .map((r) => `${r.sessionId}=${r.kind ?? "-"}${r.character ?? ""}`)
            .join(" ")}`,
        );
        expect(
          stacked.map((r) => `${r.sessionId}:${r.kind ?? "none"}:${r.character ?? ""}`),
          "the sharers count their place; the card alone in slot 1 draws no badge",
        ).toEqual([
          `${sessionIdOf("A")}:stack:2`,
          `${sessionIdOf("B")}:stack:2`,
          `${sessionIdOf("C")}:none:`,
        ]);
        // Every member of a stack lights the top slice — the badge stands on a
        // card you can see, and a visible stacked card is the top one.
        expect(stacked.slice(0, 2).map((r) => r.lit)).toEqual(["top", "top"]);

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
          "a split's bands read A then B, and each lights its own end of the run",
        ).toEqual([
          `${sessionIdOf("A")}:split:A:top`,
          `${sessionIdOf("B")}:split:B:bottom`,
          `${sessionIdOf("C")}:none::`,
        ]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
