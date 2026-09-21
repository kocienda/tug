/**
 * AT0601: the masthead's activity tape stands in ONE place, whatever the
 * lines beside it say.
 *
 * ## The report this reproduces
 *
 * Two Session cards side by side wear the same instrument at two different
 * heights. On the card whose account run is one line the tape sits low, on
 * the card whose run has wrapped to two it sits half a line higher — and the
 * same card moves its own tape up and down as the Observer's sentence gets
 * longer and shorter through a turn. A tape is a reading taken at a glance
 * across a wall of cards; a reading that moves is a reading the eye has to
 * find first.
 *
 * ## Why it happened, and what the fix pins
 *
 * The masthead takes the tape out of the beat's flex line and places it
 * against the pulse box — the description and the account run as one group.
 * It used to place it with `inset-block: 0`, which centres on the box's
 * MEASURED height, and that height is content: the account run is a two-line
 * clamp ([D185]), so a wrapped post made the group a line taller and carried
 * the tape's centre half a line down with it.
 *
 * The fix places the tape in a BAND instead — `--tugx-session-row-spark-band`,
 * composed from the bands the two lines are SET in rather than the height
 * they came out at. So this test does not measure a tape against a pixel it
 * was tuned to; it takes the same reading in three states and requires the
 * three to agree.
 *
 * ## The three states
 *
 *  1. AT REST. The account run is the rest sentence, one line.
 *  2. MID-TURN, WRAPPED. A long ask opens a turn, and the account run stands
 *     in the ask until the Observer's first post — over the width of this
 *     pane that is two lines, which the test CHECKS rather than assumes: the
 *     reading proves nothing unless the run really wrapped.
 *  3. BACK AT REST. The turn ends and the run is one line again.
 *
 * The position is read as the tape's top against the tier's own content box,
 * because that is the claim — the same place on the card, not merely the same
 * place relative to a line that itself moved.
 *
 * @covers tugdeck/src/components/tugways/session-masthead.css
 * @covers tugdeck/src/components/tugways/tug-session-row.css
 * @covers tugdeck/src/components/tugways/tug-activity-line.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// UUID-shaped so the bound session reads as a real one.
const SID = "a7c0d1ea-0000-4000-8000-000000000601";
const PANE_ID = "p1";
const PANE = `.tug-pane[data-pane-id="${PANE_ID}"]`;
const TITLE_BAR = `${PANE} .tug-pane-title-bar[data-masthead="true"]`;
const ROW = `${PANE} .session-masthead-row`;
/** The ACCOUNT run — the box that is one line or two. */
const ACCOUNT = `${ROW} [data-slot="tug-activity-line-activity"]`;
/** The tape itself, not the button the masthead wraps it in. */
const SPARK = `${ROW} [data-slot="tug-sparkline"]`;

/**
 * An ask long enough to wrap the account run at this pane's width, and
 * nothing but prose — the run goes through the markdown pipeline, and a
 * backticked path in it would be a second thing the line's height depends on.
 */
const LONG_ASK =
  "work out why the resume path wedges when the same download is offered " +
  "twice in one session, then say what the fix would cost and which of the " +
  "three call sites would have to change for it";

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

/** One DIGEST frame body, scoped to this session, as the emitter writes it. */
function digestFrame(text: string, beat: number, kind: string): string {
  return JSON.stringify({
    type: "digest",
    text,
    scopes: [SID],
    beat,
    at: Date.now(),
    kind,
  });
}

/** Where the tape stands, and what the lines beside it were doing. */
interface TapeStand {
  /** The tape's top, from the tier's own content top. THE reading. */
  top: number;
  /** Its height and width, because a box that resized also moved its ink. */
  height: number;
  width: number;
  /** The account run's used height — one line or two. */
  accountHeight: number;
  /** The band that run's lines are set in, so the height reads in lines. */
  accountBand: number;
  /** The group's measured height — the number the old rule centred on. */
  pulseHeight: number;
}

async function readStand(app: App): Promise<TapeStand> {
  return app.evalJS(
    `(function () {
      var bar = document.querySelector(${JSON.stringify(TITLE_BAR)});
      var run = document.querySelector(${JSON.stringify(ACCOUNT)});
      var spark = document.querySelector(${JSON.stringify(SPARK)});
      var pulse = document.querySelector(${JSON.stringify(ROW)} + " .tug-session-row-pulse");
      if (bar === null || run === null || spark === null || pulse === null) {
        return { top: -1, height: -1, width: -1, accountHeight: -1, accountBand: -1, pulseHeight: -1 };
      }
      var cs = getComputedStyle(bar);
      var barRect = bar.getBoundingClientRect();
      var contentTop = barRect.top +
        parseFloat(cs.paddingTop) +
        parseFloat(cs.borderTopWidth);
      var sparkRect = spark.getBoundingClientRect();
      var round = function (n) { return Math.round(n * 10) / 10; };
      return {
        top: round(sparkRect.top - contentTop),
        height: round(sparkRect.height),
        width: round(sparkRect.width),
        accountHeight: round(run.getBoundingClientRect().height),
        accountBand: round(parseFloat(getComputedStyle(run).lineHeight)),
        pulseHeight: round(pulse.getBoundingClientRect().height),
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0601: the masthead tape stands in one place", () => {
  test(
    "a wrapping account run does not move the tape, and rest returns it unmoved",
    async () => {
      const app = await launchTugApp({ testName: "at0601-masthead-tape-vertical" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SPARK)}) !== null`,
          { timeoutMs: 20_000 },
        );

        // ── 1. At rest: the account run is one line ──────────────────────
        const atRest = await readStand(app);
        note("at0601 tape at rest", JSON.stringify(atRest));
        expect(atRest.width, "the tape is mounted and sized").toBeGreaterThan(8);
        expect(
          atRest.accountHeight,
          "the rest sentence is one line",
        ).toBeLessThan(atRest.accountBand * 1.5);

        // ── 2. A long ask opens a turn, and the run wraps to two ─────────
        await app.evalJS<boolean>(
          `window.__tug.publishDigestFrame(${JSON.stringify(
            digestFrame(`asked: ${LONG_ASK}`, 1, "ask"),
          )})`,
        );
        // The wrap itself is the precondition, so wait for the BOX to be two
        // lines rather than for the text to arrive — the line has a dwell,
        // and a rect read while the previous sentence is still on screen is
        // a rect of the state this reading is supposed to leave behind.
        await app.waitForCondition<boolean>(
          `(function () {
             var run = document.querySelector(${JSON.stringify(ACCOUNT)});
             if (run === null) return false;
             var band = parseFloat(getComputedStyle(run).lineHeight);
             return run.getBoundingClientRect().height > band * 1.5;
           })()`,
          { timeoutMs: 20_000 },
        );

        const wrapped = await readStand(app);
        note("at0601 tape with a wrapped account run", JSON.stringify(wrapped));
        expect(
          wrapped.pulseHeight,
          "the group really did grow — the reading is of the reported state",
        ).toBeGreaterThan(atRest.pulseHeight + 4);

        // THE ASSERTION. The group grew by a line and the instrument did not
        // move: the tape is placed in a band, not centred on a box.
        expect(
          Math.abs(wrapped.top - atRest.top),
          "a wrapped account run leaves the tape exactly where it was",
        ).toBeLessThanOrEqual(0.5);
        expect(
          wrapped.height,
          "and the tape's own box is the same box",
        ).toBeCloseTo(atRest.height, 1);

        // ── 3. The turn ends: one line again, same place ─────────────────
        await app.evalJS<boolean>(
          `window.__tug.publishDigestFrame(${JSON.stringify(
            digestFrame("Done", 2, "turn"),
          )})`,
        );
        await app.waitForCondition<boolean>(
          `(function () {
             var run = document.querySelector(${JSON.stringify(ACCOUNT)});
             if (run === null) return false;
             var band = parseFloat(getComputedStyle(run).lineHeight);
             return run.getBoundingClientRect().height < band * 1.5;
           })()`,
          { timeoutMs: 20_000 },
        );

        const backAtRest = await readStand(app);
        note("at0601 tape back at rest", JSON.stringify(backAtRest));
        expect(
          Math.abs(backAtRest.top - atRest.top),
          "and the turn ending returns it to the same place",
        ).toBeLessThanOrEqual(0.5);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0601] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
