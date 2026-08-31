/**
 * at0467-cards-column-badge.test.ts — a Lens row says where its card stands
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
 *   2. **A stacked slot's rows show the member COUNT, and each marks its own
 *      depth.** The count is the same on every row — what no amount of looking
 *      at a stack will give you is how many are behind the front card — but
 *      the marked slice is that row's own position in the z-order, so a list of
 *      three sharers says which of them you are actually looking at.
 *   3. **A split slot's rows show the BAND LETTER, in the column's own member
 *      order.** A is the topmost band. This is the one place letters appear,
 *      and it is what makes a Lens row and the pane's own cluster the same
 *      address rather than two descriptions.
 *
 * The badge on a Lens row is a READOUT — the row is its own door, and the
 * member picker's door is the badge on the pane's cluster (at0455). So there is
 * no gesture here to drive; the claims are about what the row says.
 *
 * @covers tugdeck/src/components/cards/cards-column-badge.tsx
 * @covers tugdeck/src/components/cards/cards-session-cell.tsx
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/components/tugways/tug-column-badge.tsx
 * @covers tugdeck/src/components/cards/slot-picker.tsx
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
 * The Lens holds the right rail so the rows are on screen.
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
   * Whether the row's own slot run says this card is the one on screen — the
   * run draws a `filled` chip only for the card at the front of its slot. Read
   * from the run rather than from the fixture, so the claim below does not
   * depend on predicting which pane a seed's focus raise left on top.
   */
  front: boolean;
}

/** Every Lens Sessions row, with whatever column badge it carries. */
async function rowBadges(app: App): Promise<RowBadge[]> {
  return app.evalJS<RowBadge[]>(
    `Array.prototype.slice.call(
      document.querySelectorAll('.cards-list .cards-row[data-session-id]')
    ).map(function (row) {
      var badge = row.querySelector('[data-testid="cards-column-badge"]');
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
        front: row.querySelector(
          '[data-testid="cards-slot-picker"] [data-slot="tug-slot"][data-state="filled"]',
        ) !== null,
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
         .call(document.querySelectorAll('.cards-list .cards-oneline'))
         .filter(function (el) {
           return el.textContent.indexOf(${JSON.stringify(TEXT_CARD_TITLE)}) >= 0;
         })[0];
       if (row === undefined) throw new Error("no content row for the text card");
       var badge = row.querySelector('[data-testid="cards-column-badge"]');
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
      const app = await launchTugApp({ testName: "at0467-cards-column-badge" });
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
          [...sharers.map((r) => r.lit)].sort(),
          "three cards in one place mark three different slices",
        ).toEqual(["bottom", "middle", "top"]);
        // And the marks are not merely distinct, they are oriented: the card
        // the RUN says is on screen — the row whose slot chip is filled — is
        // the one at the front of the glyph. Read from the run rather than
        // from the fixture, because which pane a seed's focus raise leaves on
        // top is not something this file should be predicting.
        expect(
          sharers.filter((r) => r.front).map((r) => r.lit),
          "the card the run says you are looking at is the front of the glyph",
        ).toEqual(["top"]);

        // ── The two sections draw the coordinate at the same width. ──
        // A Sessions cell and an ordinary Cards row are different components
        // that compose the same pair, and they have drifted apart twice: once
        // on the gap (the content row's headline gap applied between the run
        // and the badge on top of the badge's own standoff) and once on the
        // alignment (the push to the trailing edge lived on the picker, and
        // survived only as long as the picker was a direct child of the
        // headline). Both are measured here, in rects, because both were
        // invisible to every claim this file made about what the rows SAY.
        const geometry = await app.evalJS<{
          gaps: number[];
          trailingSlack: number[];
        }>(
          `(function () {
             function measure(row) {
               // The RUN's own box, not its last chip. The run draws a window
               // now, and a card at the end of the arrangement has a stub in
               // the position past it — so the last chip and the last drawn
               // position are different elements, and only one of them is what
               // the badge stands next to. The claim is about the run and the
               // badge being one coordinate, and the run is this box.
               var last = row
                 .querySelector('[data-testid="cards-slot-picker"]')
                 .getBoundingClientRect();
               var badge = row
                 .querySelector('[data-testid="cards-column-badge"]')
                 .getBoundingClientRect();
               // How much room is left after the badge, out to the row's own
               // content edge — the run is pushed to the trailing edge, so
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
          `run→badge gap: session ${geometry.gaps[0]}px, content ${geometry.gaps[1]}px | ` +
            `trailing slack: ${geometry.trailingSlack.join("px, ")}px`,
        );
        expect(
          geometry.gaps[1],
          "the run and the badge stand the same distance apart in both sections",
        ).toBe(geometry.gaps[0]);
        // And the coordinate ends on ONE vertical down the whole list, which
        // is what the trailing inset is for. It also catches the run losing
        // its push to the trailing edge altogether: a row is ~420px wide, so a
        // run left hugging the title reads hundreds of pixels of slack here.
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
          "a split's bands read A, B, C top to bottom; the untouched place still reads 1",
        ).toEqual([
          `${sessionIdOf("A")}:split:A:top`,
          `${sessionIdOf("B")}:split:B:middle`,
          `${sessionIdOf("C")}:stack:1:top`,
          `${sessionIdOf("D")}:split:C:bottom`,
        ]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
