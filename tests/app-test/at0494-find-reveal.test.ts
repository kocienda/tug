/**
 * at0494-find-reveal.test.ts — a find ALWAYS puts its active match on
 * screen, and lands where the reader is.
 *
 * ## Why this exists
 *
 * The transcript's reveal is a multi-stage affair: an estimated jump across
 * evicted rows, a paint once the target row mounts, then band nudges that
 * clear the pinned entry header at the top and the scroller's own bottom
 * edge. Every stage can hand back a rect that is not yet the settled one —
 * a row that mounts a commit later, a height that re-measures after the
 * nudge — and when one does, the reveal declares itself finished with the
 * match still off screen. The chip then reads "1 of N" over a viewport
 * showing none of them, which is the exact shape of the user report.
 *
 * The assertions are therefore about the ONE observable that matters: after
 * a search settles, the active range's rect lies inside the transcript
 * scroller's visible band. It is driven on a transcript tall enough that
 * the first match is far outside the viewport and its row is evicted — the
 * only geometry in which the staged reveal is exercised at all. "Settles"
 * is the reveal's own terminal event in the find trace, not a sleep.
 *
 * | Test               | What would break without it                          |
 * |--------------------|------------------------------------------------------|
 * | search-as-you-type | the landing match of a fresh query left off screen,  |
 * |                    | or a keystroke landing away from the reader's anchor |
 * | extending a query  | a gesture that keeps the same match never revealing  |
 *
 * ## Where a fresh query lands
 *
 * A search does not start at match zero. The brief's `[B04]` (user-settled
 * 2026-09-21) reversed that rule: a transcript is read from the bottom and
 * grows at the bottom, so the top-most match is almost never the one the
 * reader meant. Find captures an ANCHOR when it opens — the bottom-most
 * visible row — and lands on the last match at or above it. The first test
 * checks both shapes of that: from the live edge the landing is the LAST
 * match; and from mid-transcript, typing the probe one character at a time,
 * every keystroke lands at or above the anchor row and within a few rows of
 * it. "At or above" alone is satisfied by row 1, the very behaviour the rule
 * rejects, so the nearness half is the one a regression to match zero fails.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/lib/transcript-find-engine.ts
 * @covers tugdeck/src/lib/find-session.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  SCROLLER,
  awaitGestureReveal,
  chord,
  markTrace,
  openFindBar,
  readChip,
  readReveal,
  seedProseTurns,
  sessionSelectors,
  waitFrames,
} from "./find-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const SID = "c7c0d1ea-0000-4000-8000-000000000494";
const SEL = sessionSelectors("A");
const SCROLL = `${SEL.card} ${SCROLLER}`;

/** Planted once per reply, so every turn holds exactly one match. */
const PROBE = "quartzmarker";
/** Enough to evict the first match's row past a 760 px card. */
const TURNS = 25;

function replyText(n: number): string {
  return [
    `## step ${n}`,
    "",
    `Reply number ${n} carries the ${PROBE} once, in prose long enough that`,
    "the row occupies real height and the transcript grows past a viewport.",
    "",
    `- line ${n}`,
  ].join("\n");
}

/**
 * The bottom-most mounted row that intersects the scroller — the transcript
 * host's own anchor rule, computed here so the test states what it expects
 * rather than reading the engine's answer back.
 */
const ANCHOR_ROW_EXPR = `(function () {
  var sc = document.querySelector('${SCROLL}');
  var box = sc.getBoundingClientRect();
  var best = -1;
  document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.top < box.bottom && r.bottom > box.top) {
      var n = Number(el.getAttribute("data-tug-list-cell-index"));
      if (n > best) best = n;
    }
  });
  return best;
})()`;

async function parkAt(app: App, fraction: number): Promise<void> {
  await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLL}');
  el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ${fraction});
  return el.scrollTop;
})()`);
  await waitFrames(app);
}

// Kept local: every file's `standUp` launches into its own deck and transcript,
// so the name is shared and the function is not.
async function standUp(testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 760 }), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15_000 },
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 20_000 });
  await seedProseTurns(app, "A", SID, TURNS, replyText);
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').length > 4`,
    { timeoutMs: 30_000 },
  );
  return app;
}

describe.skipIf(!SHOULD_RUN)("AT0494: find reveals its active match", () => {
  test(
    "a fresh query lands at the reader's anchor, inside the visible band",
    async () => {
      const app = await standUp("at0494-find-reveal");
      try {
        // Park at the live edge — the first match is then the far end of a
        // long jump across evicted rows.
        await parkAt(app, 1);

        await openFindBar(app);
        const mark = await markTrace(app);
        await app.nativeType(PROBE);
        const terminal = await awaitGestureReveal(app, mark, PROBE);
        note(`live-edge reveal terminal: ${JSON.stringify(terminal)}`);

        const reveal = await readReveal(app);
        const shape = await app.evalJS<Record<string, unknown>>(`(function () {
  var el = document.querySelector('${SCROLL}');
  return {
    cells: document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').length,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop,
    evicting: el.hasAttribute("data-evict-active"),
  };
})()`);
        const chip = await readChip(app);
        note(`transcript shape: ${JSON.stringify(shape)}`);
        note(`live-edge reveal: ${JSON.stringify(reveal)} chip: ${JSON.stringify(chip)}`);
        expect(terminal, "the reveal must report a terminal outcome").not.toBeNull();
        expect(reveal).not.toBeNull();
        expect(reveal!.text.toLowerCase()).toBe(PROBE);
        // Parked at the live edge, the anchor is the bottom-most row there
        // is, so the landing is the transcript's LAST match — the nearest
        // one above the reader, exactly as ⌘G-backwards would find it.
        expect(
          chip,
          "from the live edge the landing is the last match",
        ).toBe(`${TURNS} of ${TURNS}`);
        expect(
          reveal!.inView,
          `active match off screen: rect ${reveal!.rectTop}..${reveal!.rectBottom} vs band ${reveal!.bandTop}..${reveal!.bandBottom}`,
        ).toBe(true);

        // ── Mid-transcript, one keystroke at a time ───────────────────────
        // ⌘F toggles the bar shut, which ends the search; reopening captures
        // a fresh anchor from wherever the reader now is.
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SEL.findInput)}) === null`,
          { timeoutMs: 8000 },
        );
        await parkAt(app, 0.6);
        // Read BEFORE the bar opens — the same moment, and the same rule,
        // the card captures its anchor by.
        const anchorRow = await app.evalJS<number>(ANCHOR_ROW_EXPR);
        note(`anchor row at ⌘F: ${anchorRow}`);
        expect(anchorRow, "the reader must be parked somewhere real").toBeGreaterThan(2);

        await openFindBar(app);
        const landings: Array<{ char: number; row: number; chip: string; inView: boolean }> = [];
        for (let i = 1; i <= PROBE.length; i += 1) {
          const keyMark = await markTrace(app);
          await app.nativeType(PROBE[i - 1]);
          // The engine debounces search-on-type; the wait is for this
          // keystroke's own gesture and the reveal that answers it.
          await awaitGestureReveal(app, keyMark, PROBE.slice(0, i));
          const r = await readReveal(app);
          const c = await readChip(app);
          if (r !== null) landings.push({ char: i, row: r.row, chip: c, inView: r.inView });
        }
        note(`stepwise landings: ${JSON.stringify(landings)}`);

        expect(
          landings.length,
          "typing must have produced landings to judge",
        ).toBeGreaterThan(0);
        // The fixture plants one match per reply row, so the last match at
        // or above the anchor is within a couple of rows of the bottom-most
        // visible one; the margin is the slack between that row and the
        // last row that actually holds a match.
        const NEAR = 4;
        const below = landings.filter((l) => l.row >= 0 && l.row > anchorRow);
        const faraway = landings.filter((l) => l.row >= 0 && l.row < anchorRow - NEAR);
        expect(
          below.length,
          `the search landed BELOW the anchor row ${anchorRow} on ${below.length} keystroke(s): ${JSON.stringify(below)}`,
        ).toBe(0);
        expect(
          faraway.length,
          `the search left the reader: ${faraway.length} keystroke(s) landed more than ${NEAR} rows above the anchor row ${anchorRow} — ${JSON.stringify(faraway)}`,
        ).toBe(0);
        const final = landings[landings.length - 1];
        expect(final.char, "the full probe must have landed").toBe(PROBE.length);
        expect(final.inView, `the full probe's match is off screen: ${JSON.stringify(final)}`).toBe(
          true,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The gesture half
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("AT0494: every find gesture shows its match", () => {
  test(
    "extending a query that keeps the same match still brings it back on screen",
    async () => {
      const app = await standUp("at0494-find-reveal-gesture");
      try {
        await openFindBar(app);
        // A prefix of the probe: its first match is the same (row, offset)
        // the full probe's first match will be, so the engine PRESERVES the
        // active match when the query is extended. Revealing on a changed
        // identity alone therefore does nothing for the second gesture.
        const prefix = PROBE.slice(0, PROBE.length - 1);
        const firstMark = await markTrace(app);
        await app.nativeType(prefix);
        await awaitGestureReveal(app, firstMark, prefix);
        const first = await readReveal(app);
        expect(first?.inView, "the first gesture reveals").toBe(true);

        // The user reads elsewhere — the top. The query opened at the live
        // edge, so the anchored landing is the LAST match ([B04]), and the
        // top is as far from it as this transcript goes. (This once parked
        // at the live edge, when a fresh query landed on match 1; under the
        // anchor that was where the match already was, and the gesture below
        // had nothing to bring back.)
        await parkAt(app, 0);
        const away = await readReveal(app);
        note(`after scrolling away: ${JSON.stringify(away)}`);

        // …and types the last character. Same match, new gesture.
        const mark = await markTrace(app);
        await app.nativeType(PROBE.slice(PROBE.length - 1));
        const terminal = await awaitGestureReveal(app, mark, PROBE);
        note(`extended-query reveal terminal: ${JSON.stringify(terminal)}`);

        const reveal = await readReveal(app);
        note(`after extending the query: ${JSON.stringify(reveal)}`);
        expect(reveal).not.toBeNull();
        expect(reveal!.text.toLowerCase()).toBe(PROBE);
        expect(
          reveal!.inView,
          `active match off screen: rect ${reveal!.rectTop}..${reveal!.rectBottom} vs band ${reveal!.bandTop}..${reveal!.bandBottom}`,
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
