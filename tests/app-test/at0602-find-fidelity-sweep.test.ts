/**
 * at0602-find-fidelity-sweep.test.ts — the transcript's projected text and
 * its live DOM text agree, on every row kind.
 *
 * ## Why this exists
 *
 * Find counts from a projection (`transcript-search-index.ts`) and paints
 * from a DOM walk (`transcript-find-highlighter.ts`). The two are joined
 * only by ordinal — "the k-th DOM hit in a row is the k-th index hit" — and
 * until the find trace landed, nothing checked it at runtime. When a row
 * kind projects text the DOM does not hold, find highlights the wrong range
 * with perfect confidence and the chip agrees with itself all the way down.
 * The one test that used to check this was deleted on 2026-08-11 as
 * deprecated (`b80947798`), and the regressions came back.
 *
 * So: seed one transcript carrying every row kind the index projects
 * (`find-fidelity-fixture.ts`), open find with a one-letter query so EVERY
 * row is paintable — and therefore compared, since the painter's comparison
 * only runs under a query with at least one match — scroll the whole
 * transcript so every row mounts at least once, and assert the find trace
 * recorded **zero** `divergence` events.
 *
 * This is also the drift guard: a new searchable row kind that is marked but
 * not projected (or projected but not marked) fails here, at the moment it
 * is added, rather than as a mis-highlight months later.
 *
 * ## What it found, and what the answers were
 *
 * Green. Four divergences stood between it and that, and each one was the
 * projection claiming a separator or a piece of text the DOM does not hold:
 *
 *  - **Block joins.** `markdownToText` joined a message's parsed blocks with
 *    `"\n"`, where the renderer appends each block's wrapper with nothing
 *    between them. Joined with nothing.
 *  - **Terminal lines.** Same shape: each line is its own
 *    `div.tugx-term-line`, so the line break is structure, not a character.
 *    Joined with nothing, with a blank line projected as the `&nbsp;` the
 *    renderer puts in its place, and the retention cap taking the LAST lines
 *    the way `renderTerminal` does.
 *  - **A verb-less header.** A shell exchange passes `toolName=""`, and the
 *    strip marked the empty span findable — a text-less unit no projection
 *    could pair with.
 *  - **Chrome and math.** The fenced-code header's language badge is built
 *    after `block.html` and is now excluded from the walk; and unfenced
 *    `$$…$$` is stripped from the projection only where the renderer's own
 *    text-node walk would have promoted it, which a hard line break inside
 *    the expression prevents.
 *
 * Every divergence a run finds is still reported through `note()`, grouped,
 * because that report is the input to any projection work that follows.
 *
 * ## What this declares, and what it deliberately does not
 *
 * The sweep's subject is the PROJECTION and the comparison — what the index
 * writes down and what the DOM actually holds. It scrolls the transcript
 * host and the list view to mount rows, but it asserts nothing about
 * either, so neither is declared: the selection budget is for the tests a
 * change should actually run, and a sweep that fires on every list-view
 * edit is a sweep nobody reads.
 *
 * @covers tugdeck/src/lib/transcript-search-index.ts
 * @covers tugdeck/src/components/tugways/transcript-find-highlighter.ts
 * @covers tugdeck/src/lib/find-trace.ts
 * @covers tugdeck/src/lib/transcript-find-engine.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
import {
  SCROLLER,
  markTrace,
  openFindBar,
  sessionDeckShape,
  sessionSelectors,
  standUpSession,
  traceSince,
} from "./find-probes";
import { fidelityFixtureSteps } from "./find-fidelity-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const SID = "c7c0d1ea-0000-4000-8000-000000000602";
const SEL = sessionSelectors("A");

/**
 * A one-letter query. Load-bearing, not lazy: `paint()` is never reached
 * with an empty match set, so a row whose projection found nothing is never
 * compared. A probe that hits in every row is what makes every row
 * comparable — a rarer probe would quietly narrow the sweep to the rows that
 * happened to match.
 */
const QUERY = "e";

interface Divergence {
  row: number;
  unit: number;
  cause: string;
  indexUnits: number;
  domUnits: number;
  firstDiffAt: number;
  indexSample: string;
  domSample: string;
}

async function seedFixture(app: App): Promise<void> {
  for (const step of fidelityFixtureSteps(SID)) {
    if (step.kind === "frame") {
      await app.driveSession("A", {
        op: "ingestFrame",
        feedId: 0x40,
        decoded: { tug_session_id: SID, ...step.frame },
      });
    } else {
      await app.driveSession("A", step.drive);
    }
  }
}

/** The set of currently-mounted row indices, as a sorted string. */
const MOUNTED_EXPR = `(function () {
  var out = [];
  document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').forEach(function (el) {
    out.push(Number(el.getAttribute("data-tug-list-cell-index")));
  });
  out.sort(function (a, b) { return a - b; });
  return out.join(",");
})()`;

describe.skipIf(!SHOULD_RUN)("AT0602: the index and the DOM agree on every row", () => {
  test(
    "scrolling the whole transcript under a live query records no divergence",
    async () => {
      const app = await launchTugApp({ testName: "at0602-find-fidelity-sweep" });
      try {
        await standUpSession(app, "A", SID, sessionDeckShape(["A"]));
        await seedFixture(app);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').length > 3`,
          { timeoutMs: 30_000 },
        );
        // Let the last frames commit and the list settle its heights.
        await new Promise((r) => setTimeout(r, 1500));

        const rowCount = await app.evalJS<number>(`(function () {
  var max = -1;
  document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').forEach(function (el) {
    var n = Number(el.getAttribute("data-tug-list-cell-index"));
    if (n > max) max = n;
  });
  var sc = document.querySelector('${SEL.card} ${SCROLLER}');
  return sc ? Math.max(max + 1, 0) : 0;
})()`);
        note(`fixture mounted rows at rest: ${rowCount}`);

        // Open find and put a query up BEFORE the walk: the comparison runs
        // inside `paint()`, and `paint()` only runs under a live query.
        await openFindBar(app);
        await app.nativeType(QUERY);
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(SEL.chip)})?.textContent || "") !== ""`,
          { timeoutMs: 15_000 },
        );
        await new Promise((r) => setTimeout(r, 1200));

        // Everything from here is what the sweep is about.
        const mark = await markTrace(app);

        // Top to bottom in viewport-sized steps, waiting for the mounted set
        // to turn over between steps and then for one quiet window, so every
        // row is mounted (and therefore compared) at least once.
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SEL.card} ${SCROLLER}');
  el.scrollTop = 0;
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 600));

        const seen = new Set<number>();
        const absorb = async (): Promise<void> => {
          const mounted = await app.evalJS<string>(MOUNTED_EXPR);
          for (const part of mounted.split(",")) {
            if (part !== "") seen.add(Number(part));
          }
        };
        await absorb();

        for (let step = 0; step < 60; step += 1) {
          const moved = await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SEL.card} ${SCROLLER}');
  var before = el.scrollTop;
  el.scrollTop = Math.min(el.scrollTop + Math.round(el.clientHeight * 0.75),
                          el.scrollHeight - el.clientHeight);
  return el.scrollTop > before;
})()`);
          // One quiet window: the windowing commit, then the paint it
          // provokes, then the comparison inside that paint.
          await new Promise((r) => setTimeout(r, 250));
          await absorb();
          if (!moved) break;
        }

        const rowsSeen = [...seen].sort((a, b) => a - b);
        note(`rows mounted during the sweep: ${rowsSeen.length} (${rowsSeen.join(",")})`);

        const events = await traceSince(app, mark);
        const divergences = events.filter(
          (e) => e.kind === "divergence",
        ) as unknown as Divergence[];

        if (divergences.length > 0) {
          const byCause = new Map<string, number>();
          for (const d of divergences) {
            byCause.set(d.cause, (byCause.get(d.cause) ?? 0) + 1);
            note(
              `divergence row=${d.row} unit=${d.unit} cause=${d.cause} ` +
                `units=${d.indexUnits}/${d.domUnits} at=${d.firstDiffAt}\n` +
                `    index: ${JSON.stringify(d.indexSample)}\n` +
                `    dom:   ${JSON.stringify(d.domSample)}`,
            );
          }
          note(
            `divergence totals by cause: ${JSON.stringify(Object.fromEntries(byCause))}`,
          );
          note(
            `divergent rows: ${JSON.stringify([...new Set(divergences.map((d) => d.row))].sort((a, b) => a - b))}`,
          );
        }

        // Two positive controls, because the comparison runs INSIDE `paint()`
        // and a sweep over which the painter never ran would report zero
        // divergences while having compared nothing at all. A green here has
        // to mean "compared and agreed", never "never looked".
        expect(rowsSeen.length, "the sweep must have mounted rows to compare").toBeGreaterThan(3);
        const painted = await app.evalJS<number>(`(function () {
  var n = 0;
  for (var name of ['transcript-find-match', 'transcript-find-active']) {
    var hl = CSS.highlights.get(name);
    if (hl) { for (var _ of hl) n += 1; }
  }
  return n;
})()`);
        note(`painted ranges at the end of the sweep: ${painted}`);
        expect(painted, "the painter must have run for the comparison to have run").toBeGreaterThan(0);
        expect(
          events.filter((e) => e.kind === "gesture").length +
            events.filter((e) => e.kind === "divergence").length +
            painted,
          "the find trace must be live in this build",
        ).toBeGreaterThan(0);
        expect(
          divergences.length,
          `the projection and the DOM disagree on ${divergences.length} unit(s); ` +
            "see the Diagnostics above for each row, cause, and sample",
        ).toBe(0);

        // No repaint loop. The heal is idempotent per `(rowId, projection)`
        // — a healed row's index text IS its DOM text — so over a static
        // transcript no `(row, unit)` may disagree twice. A second record
        // for one pair would mean the heal and the comparison had started
        // handing each other work, which is a spin nobody would see except
        // as a warm fan.
        const perPair = new Map<string, number>();
        for (const d of divergences) {
          const pair = `${d.row}:${d.unit}`;
          perPair.set(pair, (perPair.get(pair) ?? 0) + 1);
        }
        const repeated = [...perPair].filter(([, n]) => n > 1);
        expect(
          repeated,
          `these (row, unit) pairs diverged more than once over a static ` +
            `transcript, which means the heal is not settling: ${JSON.stringify(repeated)}`,
        ).toEqual([]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
