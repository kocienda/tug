/**
 * at0464-masthead-column.test.ts — one leading column, whatever card wears it.
 *
 * A masthead tier is not a list of one kind of row. The same 72px band is worn
 * by a Session card (a small disc breathing inside a much larger ring) and by a
 * document card (a glyph that fills its box), and since the slot badge landed,
 * a numbered chip stands under both of them. Three marks, three ink widths.
 *
 * Packed the way a RAIL packs — title closed up against the pixels the mark
 * actually paints — those three land on three different verticals, each
 * correct on its own terms and none of them matching: measured, the session
 * tier put its title 25px into the frame and the document tier put its own at
 * 34, with both badges at 6 and neither on its mark's axis.
 *
 * So the tier packs against the COLUMN instead — air, then a fixed advance,
 * then the text — and the marks centre in it whatever their ink is. That is one
 * inherited pair of custom properties on `.tug-masthead-frame`, and
 * `SessionIdentityRow`'s `indicatorPacking="column"` to stop the session tier
 * correcting for ink it no longer measures against.
 *
 * What this file pins:
 *
 *   1. **Both tiers put their text on one vertical.** The title ink and the
 *      sub-line indent are the same distance into the frame on a Session card
 *      and on a document card. This is the assertion that fails if either
 *      masthead is ever given its own leading again.
 *   2. **Mark, badge and column share an axis.** In each tier the mark's box
 *      centre and the badge's centre are the same vertical — an EDGE would
 *      hold only while the two were the same width, and they are not.
 *   3. **The badge leads the text.** The chip clears the title's ink, so the
 *      column is genuinely a column rather than an overlap nobody noticed.
 *
 * Measured against the elements themselves, never against the numbers that
 * produced them: a test that restated the tokens would pass on the day the
 * tokens drifted apart.
 *
 * @covers tugdeck/src/components/tugways/masthead-frame.css
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 * @covers tugdeck/src/components/tugways/card-masthead.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The settle window, with room for the imposition's landing tween. */
const AFTER_LAND_MS = 900;

const SESSION_FRAME = '[data-slot="session-masthead"]';
const DOC_FRAME = '[data-slot="card-masthead"]';

/** How far two verticals may part and still read as one. Sub-pixel only: these
 *  are the same computed column, so anything above rounding is a real drift. */
const ONE_VERTICAL_PX = 0.51;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * A two-up deck: a bound Session card in slot 0, a text card in slot 1.
 *
 * Both kinds at once and side by side, because the whole subject here is
 * whether the two AGREE — a fixture with one of them could only ever restate
 * the numbers this test refuses to restate.
 */
const DECK = {
  cards: [
    { id: "A", componentId: "session", title: "Session A", closable: true },
    { id: "B", componentId: "text", title: "File", closable: true },
  ],
  panes: [
    {
      id: "p1",
      position: { x: 40, y: 40 },
      size: { width: 675, height: 520 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: ["standard"],
      slot: 0,
    },
    {
      id: "p2",
      position: { x: 80, y: 40 },
      size: { width: 675, height: 520 },
      cardIds: ["B"],
      activeCardId: "B",
      title: "",
      acceptsFamilies: ["standard"],
      slot: 1,
    },
  ],
  activePaneId: "p1",
  imposition: { kind: "two-up" },
  hasFocus: true,
};

interface TierGeometry {
  /** The mark's box centre, as a distance from the frame's leading edge. */
  markAxis: number;
  /** The badge chip's centre, the same way. */
  badgeAxis: number;
  /** The badge's trailing edge. */
  badgeEnd: number;
  /** Where the title's INK starts — a range, not the line box. */
  titleInk: number;
  /** Where a sub-line's box starts. The indent is padding, so the box IS the
   *  answer here and the ink would only add the run's own bearing. */
  subLineBox: number;
}

/**
 * Read one tier. Every number is a distance from the frame's own leading edge,
 * so two panes at different places on the canvas are directly comparable.
 */
const PROBE = `(function () {
  function read(frame, markSel) {
    if (frame === null) return null;
    var f = frame.getBoundingClientRect();
    var mark = frame.querySelector(markSel);
    var title = frame.querySelector(".tug-list-row-title");
    var sub = frame.querySelector(".tug-session-row-description");
    var badge = frame.querySelector('[data-testid="card-slot-badge"] [data-slot="tug-slot"]');
    if (mark === null || title === null || sub === null || badge === null) return null;
    var m = mark.getBoundingClientRect();
    var b = badge.getBoundingClientRect();
    var range = document.createRange();
    range.selectNodeContents(title);
    var t = range.getBoundingClientRect();
    return {
      markAxis: +(m.left + m.width / 2 - f.left).toFixed(2),
      badgeAxis: +(b.left + b.width / 2 - f.left).toFixed(2),
      badgeEnd: +(b.right - f.left).toFixed(2),
      titleInk: +((t.width === 0 ? title.getBoundingClientRect().left : t.left) - f.left).toFixed(2),
      subLineBox: +(sub.getBoundingClientRect().left - f.left).toFixed(2)
    };
  }
  return JSON.stringify({
    session: read(document.querySelector(${JSON.stringify(SESSION_FRAME)}), ".tug-session-row-dot"),
    doc: read(document.querySelector(${JSON.stringify(DOC_FRAME)}), ".card-masthead-icon")
  });
})()`;

async function readTiers(
  app: App,
): Promise<{ session: TierGeometry | null; doc: TierGeometry | null }> {
  return JSON.parse(await app.evalJS<string>(PROBE)) as {
    session: TierGeometry | null;
    doc: TierGeometry | null;
  };
}

describe.skipIf(!SHOULD_RUN)("at0464 — the masthead's leading column", () => {
  test(
    "a session tier and a document tier share one leading column",
    async () => {
      const app = await launchTugApp({ testName: "at0464-masthead-column" });
      try {
        await app.seedDeckState({ state: DECK, focusCardId: "A" });
        // An UNBOUND session card renders the project picker and wears no
        // masthead at all, so the tier under test would never mount.
        await app.bindSession("A", {
          tugSessionId: "at0464-A",
          projectDir: "/tmp/at0464",
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SESSION_FRAME)}) !== null && document.querySelector(${JSON.stringify(DOC_FRAME)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await wait(AFTER_LAND_MS);

        const { session, doc } = await readTiers(app);
        note(`session ${JSON.stringify(session)}`);
        note(`doc     ${JSON.stringify(doc)}`);

        expect(session, "the Session card's tier is mounted").not.toBeNull();
        expect(doc, "the document card's tier is mounted").not.toBeNull();
        if (session === null || doc === null) return;

        // 1 — the text column is one column.
        expect(
          Math.abs(session.titleInk - doc.titleInk),
          "both tiers start their title on the same vertical",
        ).toBeLessThanOrEqual(ONE_VERTICAL_PX);
        expect(
          Math.abs(session.subLineBox - doc.subLineBox),
          "and their sub-lines hang off that same vertical",
        ).toBeLessThanOrEqual(ONE_VERTICAL_PX);

        // 2 — the mark and the badge stand on one axis, in each tier and
        //     across both. Centres, not edges: a phase dot's ink is half the
        //     chip's width, so an edge alignment would only ever be a
        //     coincidence of two numbers that are free to move apart.
        for (const [name, tier] of [
          ["session", session],
          ["doc", doc],
        ] as const) {
          expect(
            Math.abs(tier.markAxis - tier.badgeAxis),
            `${name}: the badge stands on the mark's own axis`,
          ).toBeLessThanOrEqual(ONE_VERTICAL_PX);
        }
        expect(
          Math.abs(session.badgeAxis - doc.badgeAxis),
          "and it is the same axis on both kinds of card",
        ).toBeLessThanOrEqual(ONE_VERTICAL_PX);

        // 3 — and the column really is leading of the text.
        expect(
          session.badgeEnd,
          "the chip clears the title's ink rather than sitting under it",
        ).toBeLessThanOrEqual(session.titleInk);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
