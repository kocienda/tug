/**
 * AT0564: how much room the Session masthead has left under its last line,
 * at rest, in both forms.
 *
 * This test decides nothing. It exists to put one number on the record where
 * a person can read it, because the judgment it serves is a person's: the
 * masthead's tier is declared for a two-line description
 * (`masthead-frame.css`), and at rest the description is a one-line standing
 * sentence, so the line it does not use falls to the foot of the band under
 * the beat — where the `session-tape-centering` arc decided it "reads as the
 * edge of the tier". That decision was taken at a 15.6px band. Whether the
 * remainder still reads as air rather than as a hole is a reading somebody
 * has to take on the running app, and a reading is worth more against a
 * measured number than against arithmetic quoted out of a comment.
 *
 * So the diagnostics are the point: the slack open, the slack folded, and
 * beside each the description box's own height and the band it is set in, so
 * the slack can be read in lines rather than in pixels.
 *
 * What it nonetheless ASSERTS, because a measurement nobody can fail is not a
 * test:
 *
 *  1. The stack fits. The slack is never negative, in either form — the
 *     title, the description pair's used lines and the beat all stand inside
 *     the tier the pane declared for them.
 *  2. The two forms agree. Open and folded measure the same slack, which is
 *     the `masthead-second-line` requirement that the tier is fixed in every
 *     form: a tier that changed height with the fold is one the wall's
 *     packing would have to re-read.
 *
 * The description at rest is the ladder's floor, `Not yet described`, because
 * the standing sentence arrives from the Observer and no harness door writes
 * one. That costs the measurement nothing: what the slack answers to is how
 * many LINES the box took, and the Observer's own rubric gives the standing
 * sentence "about 65 characters", which is one line in this pane exactly as
 * the floor's three words are.
 *
 * @covers tugdeck/src/components/tugways/session-masthead.css
 * @covers tugdeck/src/components/tugways/masthead-frame.css
 * @covers tugdeck/src/components/tugways/tug-session-row.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0564-session";
const PANE_ID = "p1";
const PANE = `.tug-pane[data-pane-id="${PANE_ID}"]`;
const CARD = '[data-card-id="A"]';
const TITLE_BAR = `${PANE} .tug-pane-title-bar[data-masthead="true"]`;
const DESCRIPTION = `${PANE} .session-masthead-row .tug-session-row-description`;
/** The description and the beat as one box — the last ink in the tier. */
const PULSE = `${PANE} .session-masthead-row .tug-session-row-pulse`;

/** One Session card in one pane, wide enough that the row is not the subject. */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: PANE_ID,
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: PANE_ID,
    hasFocus: true,
  };
}

interface Slack {
  /** The tier's own content height, for the arithmetic to be checked against. */
  tierHeight: number;
  /** The band the description's lines are set in. */
  band: number;
  /** How tall the description box actually stands — its used lines. */
  descHeight: number;
  /** Room left between the last line's bottom and the tier's content edge. */
  slack: number;
}

/**
 * The tier's content box against the last ink in it.
 *
 * Content box on both sides, deliberately: the bar draws a 1px rule under
 * itself and carries its own padding, and a rect-to-rect reading would report
 * the room a reader sees plus the chrome nobody reads as air.
 */
async function readSlack(app: App): Promise<Slack> {
  return app.evalJS(
    `(function () {
      var bar = document.querySelector(${JSON.stringify(TITLE_BAR)});
      var desc = document.querySelector(${JSON.stringify(DESCRIPTION)});
      var pulse = document.querySelector(${JSON.stringify(PULSE)});
      if (bar === null || desc === null || pulse === null) {
        return { tierHeight: -1, band: -1, descHeight: -1, slack: -1 };
      }
      var cs = getComputedStyle(bar);
      var barRect = bar.getBoundingClientRect();
      var contentBottom = barRect.bottom -
        parseFloat(cs.paddingBottom) -
        parseFloat(cs.borderBottomWidth);
      var round = function (n) { return Math.round(n * 10) / 10; };
      return {
        tierHeight: round(parseFloat(cs.height)),
        band: round(parseFloat(getComputedStyle(desc).lineHeight)),
        descHeight: round(desc.getBoundingClientRect().height),
        slack: round(contentBottom - pulse.getBoundingClientRect().bottom),
      };
    })()`,
  );
}

/** Flip the flag through the one command every door reaches ([P02]). */
async function toggleFolded(app: App, want: boolean): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
  );
  await app.waitForCondition<boolean>(
    `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).folded === ${want}`,
    { timeoutMs: 8000 },
  );
  // The flag arms the motion; the card writes `data-fold` when the motion
  // ENDS, so the record moving is not yet the form being worn — and a rect
  // read mid-tween is a rect of the tween.
  await app.waitForCondition<boolean>(
    `(function () {
       var card = document.querySelector(${JSON.stringify(CARD)} + " .session-card");
       if (card === null) return false;
       return card.getAttribute("data-fold") === ${want ? '"settled"' : "null"};
     })()`,
    { timeoutMs: 8000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0564: the masthead's at-rest slack", () => {
  test(
    "the tier holds its stack in both forms, with the same room to spare",
    async () => {
      const app = await launchTugApp({ testName: "at0564-masthead-slack" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PULSE)}) !== null`,
          { timeoutMs: 20_000 },
        );

        const open = await readSlack(app);
        note("at0564 slack, open", JSON.stringify(open));

        await toggleFolded(app, true);
        const folded = await readSlack(app);
        note("at0564 slack, folded", JSON.stringify(folded));

        // 1. Nothing overhangs the tier it was declared for.
        expect(open.slack, "the open tier holds its stack").toBeGreaterThanOrEqual(0);
        expect(folded.slack, "the folded tier holds its stack").toBeGreaterThanOrEqual(0);

        // 2. And the fold does not move it.
        expect(
          Math.abs(open.slack - folded.slack),
          "the tier leaves the same room in both forms",
        ).toBeLessThanOrEqual(1);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0564] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
