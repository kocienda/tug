/**
 * at0467-cards-slot-badge.test.ts — a Cards row says where its card stands,
 * with the two badges its masthead wears.
 *
 * A Cards row carries the masthead's pair: the slot badge, one numbered chip
 * saying which place the card holds, then the stack badge. The slot badge
 * replaced a run of one chip per place, which cost the row's title its width
 * on every deck with more than a few places.
 *
 * The slot badge says which numbered place the card holds.
 * It has never said the rest of the coordinate: whether that place is shared,
 * by how many, and — when the place is split — which band the card is. The
 * slot badge is that fact, drawn in the slot chip's own footprint so the two
 * read left to right as one address.
 *
 * What this file pins:
 *
 *   1. **Every row in an imposed deck carries the badge, and a place one card
 *      deep reads `1`.** The lone card is in the fixture as the case that used
 *      to draw nothing: its own masthead said the card stood in a place while
 *      its Cards row said it stood nowhere, which is two surfaces disagreeing
 *      about the same card. It is also the row whose place can still be split,
 *      and the badge is the hint that it can.
 *   2. **A stacked slot's rows show the member COUNT, and each marks its own
 *      depth.** The count is the same on every row — what no amount of looking
 *      at a stack will give you is how many are behind the front card — but
 *      the marked slice is that row's own position in the z-order, so a list of
 *      three sharers says which of them you are actually looking at.
 *   3. **A split slot's rows show the BAND LETTER, in the slot's own member
 *      order.** A is the topmost band. This is the one place letters appear,
 *      and it is what makes a Cards row and the pane's own cluster the same
 *      address rather than two descriptions.
 *   4. **The pair is quiet at rest and holds one column.** The slot chip rests
 *      (no lit chip on the row: accent is for the popup's current place), the
 *      stack badge takes the row's own ink, and the slot badge's box is the box
 *      a row with no slot holds open, so the trailing column stays ruled.
 *   5. **Pressing the slot badge opens every place, and a pick moves the card —
 *      a selected row's pick moves the whole selection.** A row outside the
 *      selection moves only its own card.
 *
 * The stack badge on a Cards row is a READOUT — the row is its own door, and
 * the member picker's door is the badge on the pane's cluster (at0455).
 *
 * @covers tugdeck/src/components/cards/cards-slot-badge.tsx
 * @covers tugdeck/src/components/cards/cards-session-cell.tsx
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/components/tugways/tug-slot-badge.tsx
 * @covers tugdeck/src/components/cards/cards-row-slot.tsx
 * @covers tugdeck/src/components/cards/cards-row-slot.css
 * @covers tugdeck/src/components/cards/cards-slot-badge.css
 * @covers tugdeck/src/components/tugways/card-slot-badge.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The settle window, with room for the imposition's landing tween. */
const AFTER_LAND_MS = 900;

const SESSION_CARDS = ["A", "B", "C", "D"] as const;
const TEXT_CARD_TITLE = "Notes";
const sessionIdOf = (cardId: string): string => `at0467-${cardId}`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Three session cards in a three-up: A and B share slot 0, C stands alone in
 * slot 1 — the one-deep place in the same fixture as the shared one. A text
 * card holds slot 2, because the Sessions group and the rest of the Cards
 * section are two different row components and the badge has to be on both.
 * The Cards card holds the right rail so the rows are on screen.
 */
function deckShape(): Record<string, unknown> {
  const slots: Record<string, number> = { A: 0, B: 0, D: 0, C: 1 };
  return {
    cards: [
      ...SESSION_CARDS.map((id) => ({
        id,
        componentId: "session",
        title: `Session ${id}`,
        closable: true,
      })),
      { id: "T", componentId: "text", title: TEXT_CARD_TITLE, closable: true },
      { id: "L", componentId: "cards", title: "Cards", closable: true },
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
        id: "pCards",
        position: { x: 0, y: 0 },
        size: { width: 420, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Cards",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      sidebars: { cards: { side: "right" } },
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
  /**
   * Whether this card is the one on screen in its slot — the last pane in the
   * deck's order that holds the slot is the one on top of it. Read from the
   * live deck rather than from the fixture, so the claim below does not
   * depend on predicting which pane a seed's focus raise left on top.
   */
  front: boolean;
}

/** Every Cards Sessions row, with whatever slot badge it carries. */
async function rowBadges(app: App): Promise<RowBadge[]> {
  // card-dom: shell
  const fronts = await app.evalJS<string[]>(
    `(function () {
      var deck = window.tugdeck.diag.getDeckState();
      var top = {};
      for (var i = 0; i < deck.panes.length; i += 1) {
        var pane = deck.panes[i];
        if (pane.slot !== undefined) top[pane.slot] = pane.activeCardId;
      }
      return Object.keys(top).map(function (k) { return top[k]; });
    })()`,
  );
  const rows = await app.body("L").evalJS<Omit<RowBadge, "front">[]>(
    `Array.prototype.slice.call(
      document.querySelectorAll('.cards-list .cards-row[data-session-id]')
    ).map(function (row) {
      var badge = row.querySelector('[data-testid="cards-slot-badge"]');
      return {
        sessionId: row.getAttribute("data-session-id"),
        kind: badge === null ? null : badge.getAttribute("data-kind"),
        character: badge === null ? null : badge.textContent.trim(),
        // The MARKED ELEMENT OF THE DRAWING, not the root's computed fact.
        // Reading the root passed a badge whose glyph lit its front slice no
        // matter what the fact said — the root carried "middle" and the
        // picture carried "top", and only the picture is on screen.
        lit: badge === null
          ? null
          : (badge.querySelector('[data-region][data-lit="true"]') || {
              getAttribute: function () { return "none"; },
            }).getAttribute("data-region"),
      };
    }).sort(function (a, b) {
      return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
    })`,
  );
  return rows.map((r) => ({
    ...r,
    front: fronts.some((cardId) => sessionIdOf(cardId) === r.sessionId),
  }));
}

/**
 * The badge on the Cards section's ordinary row — a different component from
 * the Sessions cell, reached by its title because a content row carries no
 * session id to find it by.
 */
async function contentRowBadge(app: App): Promise<string> {
  return app.body("L").evalJS<string>(
    `(function () {
       var row = Array.prototype.slice
         .call(document.querySelectorAll('.cards-list .cards-oneline'))
         .filter(function (el) {
           return el.textContent.indexOf(${JSON.stringify(TEXT_CARD_TITLE)}) >= 0;
         })[0];
       if (row === undefined) throw new Error("no content row for the text card");
       var badge = row.querySelector('[data-testid="cards-slot-badge"]');
       return badge === null
         ? "none"
         : badge.getAttribute("data-kind") + ":" + badge.textContent.trim();
     })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0467 — the Cards row's slot badge", () => {
  test(
    "every row says where its card stands, and its slot badge moves it",
    async () => {
      const app = await launchTugApp({ testName: "at0467-cards-slot-badge" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        // An unbound session card renders the project picker instead of a
        // session, and its Cards row would carry no session id to find it by.
        for (const cardId of SESSION_CARDS) {
          await app.bindSession(cardId, {
            tugSessionId: sessionIdOf(cardId),
            projectDir: "/tmp/at0467",
          });
        }
        await app.body("L").waitForCondition<boolean>(
          `document.querySelectorAll('.cards-list .cards-row[data-session-id]').length === ${SESSION_CARDS.length}`,
          { timeoutMs: 20_000 },
        );
        await wait(AFTER_LAND_MS);

        // ── Stacked: the three sharers count 3, the lone card reads 1. ──
        const stacked = await rowBadges(app);
        note(
          `stacked: ${stacked
            .map(
              (r) =>
                `${r.sessionId}=${r.kind ?? "-"}${r.character ?? ""}/${r.lit ?? "-"}` +
                `${r.front ? "*" : ""}`,
            )
            .join(" ")}`,
        );
        expect(
          stacked.map((r) => `${r.sessionId}:${r.kind ?? "none"}:${r.character ?? ""}`),
          "the sharers count their place, and the lone card names its own",
        ).toEqual([
          `${sessionIdOf("A")}:stack:3`,
          `${sessionIdOf("B")}:stack:3`,
          `${sessionIdOf("C")}:stack:1`,
          `${sessionIdOf("D")}:stack:3`,
        ]);

        // The three sharers count the same and stand differently, and the
        // badge has to say both. THREE deep is the case that matters: a
        // two-deep stack can pass on a badge that only knows front-or-not,
        // and a middle member is what proves the run is being read rather
        // than a boolean.
        const sharers = stacked.filter((r) => r.character === "3");
        expect(
          sharers.map((r) => r.lit).sort(),
          "three cards in one place mark three different slices",
        ).toEqual(["bottom", "middle", "top"]);
        // And the marks are not merely distinct, they are oriented: the card
        // the deck has on top of the slot is the one at the front of the
        // glyph. Read from the live deck rather than from the fixture, because
        // which pane a seed's focus raise leaves on top is not something this
        // file should be predicting.
        expect(
          sharers.filter((r) => r.front).map((r) => r.lit),
          "the card on top of the slot is the front of the glyph",
        ).toEqual(["top"]);

        // ── The two sections draw the coordinate at the same width. ──
        // A Sessions cell and an ordinary Cards row are different components
        // that compose the same pair, and they have drifted apart twice: once
        // on the gap (the content row's headline gap applied between the two
        // badges on top of the stack badge's own standoff) and once on the
        // alignment (the push to the trailing edge lived on the first badge,
        // and survived only as long as it was a direct child of the
        // headline). Both are measured here, in rects, because both were
        // invisible to every claim this file made about what the rows SAY.
        const geometry = await app.body("L").evalJS<{
          gaps: number[];
          trailingSlack: number[];
        }>(
          `(function () {
             function measure(row) {
               var last = row
                 .querySelector('[data-testid="cards-row-slot"]')
                 .getBoundingClientRect();
               var badge = row
                 .querySelector('[data-testid="cards-slot-badge"]')
                 .getBoundingClientRect();
               // How much room is left after the badge, out to the row's own
               // content edge — the pair is pushed to the trailing edge, so
               // this is the row's inset and nothing more.
               var content = row.getBoundingClientRect();
               return {
                 gap: Math.round(badge.left - last.right),
                 slack: Math.round(content.right - badge.right),
               };
             }
             var session = document.querySelector(
               '.cards-list .cards-row[data-session-id]',
             );
             var content = Array.prototype.slice
               .call(document.querySelectorAll('.cards-list .cards-oneline'))
               .filter(function (el) {
                 return el.textContent.indexOf(${JSON.stringify(TEXT_CARD_TITLE)}) >= 0;
               })[0];
             if (session === null || content === undefined) {
               throw new Error("need one row of each kind on screen");
             }
             var a = measure(session);
             var b = measure(content);
             return { gaps: [a.gap, b.gap], trailingSlack: [a.slack, b.slack] };
           })()`,
        );
        note(
          `slot→stack gap: session ${geometry.gaps[0]}px, content ${geometry.gaps[1]}px | ` +
            `trailing slack: ${geometry.trailingSlack.join("px, ")}px`,
        );
        expect(
          geometry.gaps[1],
          "the two badges stand the same distance apart in both sections",
        ).toBe(geometry.gaps[0]);
        // And the coordinate ends on ONE vertical down the whole list, which
        // is what the trailing inset is for. It also catches the pair losing
        // its push to the trailing edge altogether: a row is ~420px wide, so a
        // pair left hugging the title reads hundreds of pixels of slack here.
        expect(
          geometry.trailingSlack[1],
          "both sections end the coordinate on one vertical",
        ).toBe(geometry.trailingSlack[0]);

        // A content card's row is a different component from a Sessions cell,
        // and the badge has to be on both — a reader scanning the Cards
        // section reads one list, not two.
        const content = await contentRowBadge(app);
        note(`content row: ${content}`);
        expect(
          content,
          "the text card's row says where it stands too",
        ).toBe("stack:1");

        // ── Quiet at rest, and one column. ──
        const rest = await app.body("L").evalJS<{
          badges: number;
          litChips: number;
          stackInkIsRow: boolean;
          badgeWidth: number;
          reserveWidth: number;
        }>(
          `(function () {
             var first = document.querySelector('.cards-list [data-testid="cards-row-slot"]');
             var stack = document.querySelector('.cards-list [data-testid="cards-slot-badge"]');
             return {
               badges: document.querySelectorAll(
                 '.cards-list [data-testid="cards-row-slot"] [data-testid="card-slot-badge"]',
               ).length,
               litChips: document.querySelectorAll(
                 '.cards-list [data-testid="cards-row-slot"] [data-slot="tug-slot"]:not([data-state="rest"])',
               ).length,
               stackInkIsRow: getComputedStyle(stack).color === getComputedStyle(stack.parentElement).color,
               badgeWidth: first.querySelector('[data-testid="card-slot-badge"]').getBoundingClientRect().width,
               reserveWidth: parseFloat(getComputedStyle(first).minInlineSize),
             };
           })()`,
        );
        note(`at rest: ${JSON.stringify(rest)}`);
        expect(rest.badges, "every row draws one slot badge, not a chip per place").toBe(
          SESSION_CARDS.length + 1,
        );
        expect(rest.litChips, "no row's chip is lit at rest").toBe(0);
        expect(rest.stackInkIsRow, "the stack badge takes the row's own ink").toBe(true);
        expect(
          rest.badgeWidth,
          "the box a slotless row holds open is the slot badge's own width",
        ).toBe(rest.reserveWidth);

        // ── Split: the same two rows become an address. ──
        // card-dom: shell
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-slot-mode", { slot: 0, mode: "split" }), null)`,
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
          "a split's bands read A, B, C top to bottom; the untouched place still reads 1",
        ).toEqual([
          `${sessionIdOf("A")}:split:A:top`,
          `${sessionIdOf("B")}:split:B:middle`,
          `${sessionIdOf("C")}:stack:1:top`,
          `${sessionIdOf("D")}:split:C:bottom`,
        ]);

        // ── The slot badge moves the card, and a selected row its selection. ──
        // Driven after the split, on the same launch: the moves are about which
        // place a card stands in, which a split does not change.
        const body = app.body("L");
        const slotOf = async (): Promise<Record<string, number | null>> =>
          // card-dom: shell
          app.evalJS<Record<string, number | null>>(
            `(function () {
              var deck = window.tugdeck.diag.getDeckState();
              var out = {};
              for (var i = 0; i < deck.panes.length; i += 1) {
                var pane = deck.panes[i];
                for (var j = 0; j < pane.cardIds.length; j += 1) {
                  out[pane.cardIds[j]] = pane.slot === undefined ? null : pane.slot;
                }
              }
              return out;
            })()`,
          );
        const PICKER = '[data-testid="card-slot-badge-picker"]';
        /** Open the row's popup for `cardId` and pick place `slot`. */
        const pick = async (cardId: string, slot: number): Promise<void> => {
          await body.evalJS<boolean>(
            `(function () {
              var row = document.querySelector('.cards-list .cards-row[data-session-id="${sessionIdOf(cardId)}"]');
              row.querySelector('[data-testid="card-slot-badge-trigger"]').click();
              return true;
            })()`,
          );
          await body.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
            { timeoutMs: 5_000 },
          );
          // The popup stands inside the Workspaces card. The row's badge sits
          // at the card's trailing edge, so a popup that opened flush from it
          // ran off the card and off the window.
          await wait(300);
          const bounds = await body.evalJS<{ popup: number[]; card: number[] }>(
            `(function () {
              var popup = document.querySelector(${JSON.stringify(PICKER)}).closest('[data-slot="tug-popover"]').getBoundingClientRect();
              var card = document.querySelector('.cards-card').getBoundingClientRect();
              return {
                popup: [Math.round(popup.left), Math.round(popup.right)],
                card: [Math.round(card.left), Math.round(card.right)],
              };
            })()`,
          );
          note(`popup for ${cardId}: ${JSON.stringify(bounds)}`);
          expect(bounds.popup[0], "the popup starts inside the card").toBeGreaterThanOrEqual(bounds.card[0]);
          expect(bounds.popup[1], "the popup ends inside the card").toBeLessThanOrEqual(bounds.card[1]);
          await body.evalJS<boolean>(
            `(document.querySelector(${JSON.stringify(PICKER)}).children[${slot}].click(), true)`,
          );
          await body.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PICKER)}) === null`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
        };

        // A (place 1) and C (place 2) selected; B (place 1) left out.
        // card-dom: shell
        await app.evalJS<null>(`(window.__tug.setLayoutSelection(["A", "C"]), null)`);
        await wait(300);
        await pick("A", 2);
        const grouped = await slotOf();
        note(`after the group move: ${JSON.stringify(grouped)}`);
        expect(grouped.A, "the pressed row's card went to place 3").toBe(2);
        expect(grouped.C, "and so did the other selected card").toBe(2);
        expect(grouped.B, "the unselected card stayed where it was").toBe(0);

        // B's row is outside the selection: its pick is B's alone.
        await pick("B", 1);
        const single = await slotOf();
        note(`after the single move: ${JSON.stringify(single)}`);
        expect(single.B, "B moved to place 2").toBe(1);
        expect(single.A, "A did not follow it").toBe(2);
        expect(single.C, "nor did C").toBe(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
