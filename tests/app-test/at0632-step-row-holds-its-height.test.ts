/**
 * AT0632: a step row is the same height in every state the flow can put it in.
 *
 * ## What this pins
 *
 * One claim, measured rather than argued: **every row of the UpdateTug wizard is
 * exactly as tall at every stage as it was on the panel the user opened.** Not
 * "about as tall", and not "the busy row is as tall as it was" — all four rows,
 * at every stage the host can report, against the four heights the idle panel
 * had.
 *
 * The complaint that produced it was geometric. The wizard opens with four
 * plinths of one height; pressing *Check Now* used to grow the first one, because
 * the barber-pole bar was laid out as a third line inside the row's content
 * column, and the three rows below it and the Close button were pushed down. The
 * same happened on `downloading`, on `extracting` and on `installing`, each time
 * to a different row — so the panel's geometry moved at four points in a flow the
 * user is watching rather than driving.
 *
 * The fix was to give `TugStepRow` an `edge` slot: absolutely positioned chrome
 * along the bottom of the plinth, out of the content column, which a row can fill
 * without growing. That is a thing a stylesheet can promise and quietly stop
 * doing — `--tugx-step-row-h` is a `min-height`, so a row carrying one line too
 * many simply grows past it, and nothing in the build says so. This file is what
 * says so.
 *
 * ## Why it measures rather than inspects
 *
 * A static check could refuse the two slots on one row, and it would be wrong:
 * ConfigureTug's file-chooser row legitimately has both and pays for the line by
 * raising `--tugx-step-row-h` on itself. What a static check cannot see at all is
 * the case that has nothing to do with slots — a detail line that grows a word
 * longer and wraps at some width, which is a second line arriving by a route no
 * lint is watching. Measuring the rendered box catches the class; reading the
 * source catches one instance of it.
 *
 * The height is read with `getBoundingClientRect().height`, which is the number
 * the user's eye is complaining about, and it is compared against a threshold of
 * one pixel — not because a pixel of growth would be acceptable, but because
 * `getBoundingClientRect` reports fractional layout and four plinths of the
 * declared same height land on different sub-pixel offsets: an opened panel
 * measures 57.60003662109375 on two of its rows and 57.5999755859375 on the
 * other two, which is 6e-5px of rounding and not a row that grew. The thing this
 * file exists to catch is a content column gaining a line, and a line here is
 * 18.85px, so a 1px window separates the two by more than four orders of
 * magnitude while still refusing anything a person could see.
 *
 * What is deliberately not walked here is the stalled sweep ([L33]): reaching it
 * means sitting out a wait horizon measured in minutes, and what it does to a row
 * — clear both content slots and the edge — is pinned on `deriveUpdateRows` in
 * `tugdeck/src/components/tugways/__tests__/update-tug-rows.test.ts`, where the
 * sweep's input is an argument.
 *
 * `[B##]` are `.tug/arcs/step-row-fixed-height/brief.md`. `at0612` pins what the
 * wizard *says* at each stage; this file pins only how tall it is while saying it.
 *
 * @covers tugdeck/src/components/tugways/tug-step-row.tsx
 * @covers tugdeck/src/components/tugways/tug-step-row.css
 * @covers tugdeck/src/components/tugways/update-tug-rows.tsx
 * @covers tugdeck/src/components/tugways/update-tug.css
 * @covers tugdeck/src/lib/transfer-rate.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The wizard's panel. Absent from the DOM entirely while it is closed. */
const WIZARD = `[data-testid="update-tug"]`;
/** The four step rows, in the order they are walked. */
const STEP_ROWS = `${WIZARD} .update-tug-steps [data-slot="tug-step-row"]`;
/** The bar, wherever it is. Its place is what the heights below are about. */
const BAR = `[data-testid="update-tug-bar"]`;

/**
 * The reveal count rides every snapshot, so the pushes here carry one too — a
 * push that let it fall back would read to the deck as a count it had not seen.
 */
let reveal = 0;
const nextReveal = (): number => (reveal += 1);

/** A snapshot in the shape `UpdateSnapshot.jsonObject` emits, host-side. */
interface Payload {
  stage: string;
  version?: string;
  build?: string;
  currentVersion?: string;
  releaseNotes?: string | null;
  releaseNotesFailed?: boolean;
  userInitiated?: boolean;
  percent?: number | null;
  receivedBytes?: number;
  expectedBytes?: number;
  message?: string;
  cancellable?: boolean;
  revealCount?: number;
}

function snapshot(stage: string, over: Partial<Payload> = {}): Payload {
  return {
    stage,
    version: "0.9.0",
    build: "900",
    currentVersion: "0.8.10",
    releaseNotes: null,
    releaseNotesFailed: false,
    userInitiated: false,
    percent: null,
    receivedBytes: 0,
    expectedBytes: 0,
    message: "",
    cancellable: false,
    revealCount: reveal,
    ...over,
  };
}

/** Push one snapshot the way `MainWindow.bridgeUpdateState` does. */
async function push(app: App, payload: Payload): Promise<void> {
  await app.evalJS<null>(
    `(window.__tugBridge.onUpdateState(${JSON.stringify(payload)}), null)`,
  );
}

/** Wait until the wizard is up, on `stage`. */
async function waitForWizard(app: App, stage: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
       var d = document.querySelector(${JSON.stringify(WIZARD)});
       return d !== null && d.getAttribute("data-stage") === ${JSON.stringify(stage)};
     })()`,
    { timeoutMs: 10_000 },
  );
}

/**
 * The four rows' heights and step keys, in layout order.
 *
 * Both in one read, so a stage that somehow reordered or dropped a row is caught
 * by the same call rather than by a second one racing it.
 */
async function rowBoxes(app: App): Promise<{ key: string; height: number }[]> {
  return app.evalJS<{ key: string; height: number }[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(STEP_ROWS)}),
       function (r) {
         return {
           key: r.getAttribute("data-step"),
           height: r.getBoundingClientRect().height,
         };
       }
     )`,
  );
}

async function elementCount(app: App, selector: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
}

/**
 * How far two row heights may differ and still be the same height.
 *
 * Sub-pixel layout noise, and nothing more: see the header. A row that actually
 * grew gained a line of 13px text at 1.45 line-height, which is 18.85px.
 */
const HEIGHT_EPSILON_PX = 1;

/** Assert two row heights are the same height, within the layout's own noise. */
function expectSameHeight(actual: number, expected: number, why: string): void {
  expect(Math.abs(actual - expected), why).toBeLessThan(HEIGHT_EPSILON_PX);
}

/** One row's detail line: how tall it is, against one line of it. */
interface DetailLine {
  key: string;
  /** The span's laid-out height. */
  height: number;
  /** One line of it, from the computed style. */
  lineHeight: number;
  /** The text's own width, and how much room the column gave it. */
  width: number;
  avail: number;
  chars: number;
}

/**
 * Every row's detail line, measured.
 *
 * The row's 60px floor has about 20px of slack over `headline + one detail
 * line`, which is enough to absorb a detail line wrapping to *two* — so a wrap
 * is a thing the row heights above cannot see, and it is still the panel saying
 * one of its rows in two lines while the others say theirs in one. This is what
 * catches it, and it is also where the line's real width is recorded, which is
 * the number `DETAIL_LINE_BUDGET` in `transfer-rate.ts` is answerable to.
 */
async function detailLines(app: App): Promise<DetailLine[]> {
  return app.evalJS<DetailLine[]>(
    `Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(STEP_ROWS)}),
       function (r) {
         var el = r.querySelector(".tug-step-row-detail");
         if (el === null) return null;
         var cs = getComputedStyle(el);
         var range = document.createRange();
         range.selectNodeContents(el);
         var text = range.getBoundingClientRect();
         return {
           key: r.getAttribute("data-step"),
           height: el.getBoundingClientRect().height,
           lineHeight: parseFloat(cs.lineHeight),
           width: text.width,
           avail: el.getBoundingClientRect().width,
           chars: (el.textContent || "").length,
         };
       }
     ).filter(function (d) { return d !== null; })`,
  );
}

/**
 * Wait until the rows have stopped moving.
 *
 * A stage push is a React render and, on the stages that carry one, a painted
 * write from a store subscription. Measuring on the first frame after the push
 * would be measuring a layout that is still settling, and the failure that
 * produces is a flake rather than a finding. Two consecutive reads of the same
 * four heights is the settle.
 */
async function waitForRowsSettled(app: App): Promise<void> {
  await app.evalJS<null>(`(window.__at0632 = { heights: null }, null)`);
  await app.waitForCondition<boolean>(
    `(function () {
       var rows = document.querySelectorAll(${JSON.stringify(STEP_ROWS)});
       if (rows.length !== 4) { window.__at0632.heights = null; return false; }
       var key = Array.prototype.map.call(rows, function (r) {
         return r.getBoundingClientRect().height;
       }).join(",");
       var settled = window.__at0632.heights === key;
       window.__at0632.heights = key;
       return settled;
     })()`,
    { timeoutMs: 15_000, pollMs: 50 },
  );
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "gallery-input", title: "Card A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 600 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * Every stage the host can report, and what it takes to be in it.
 *
 * `idle` is absent because it is the baseline the rest are measured against. The
 * four that used to grow a row are here — `checking`, `downloading`, `extracting`,
 * `installing` — and so are the five that never did, because the claim is about
 * the row rather than about the bar: a detail line is as capable of adding a line
 * as a bar was. Two of the four no longer draw a bar at all, which changes
 * nothing here: the row has to hold its height either way.
 */
const STAGES: { stage: string; over?: Partial<Payload> }[] = [
  { stage: "checking", over: { cancellable: true } },
  { stage: "available" },
  {
    stage: "downloading",
    over: {
      cancellable: true,
      percent: 25,
      receivedBytes: 12_400_000,
      expectedBytes: 48_100_000,
    },
  },
  { stage: "paused" },
  { stage: "extracting", over: { percent: 60 } },
  { stage: "readyToInstall" },
  { stage: "installing" },
  { stage: "upToDate" },
  { stage: "error", over: { message: "the feed did not answer" } },
];

describe.skipIf(!SHOULD_RUN)("AT0632: a step row holds its height", () => {
  test(
    "every wizard row is exactly as tall at every stage as it was on the opened panel",
    async () => {
      const app = await launchTugApp({ testName: "at0632-step-row-holds-its-height" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.waitForCondition<boolean>(
          `typeof window.__tugBridge !== "undefined"
             && typeof window.__tugBridge.onUpdateState === "function"`,
          { timeoutMs: 20_000 },
        );

        // ---- The baseline: the panel as the user opened it ----------------
        //
        // Raised at `idle` by a bumped reveal, which is the menu item's door
        // and the only one that opens the wizard on a stage with nothing to
        // report. Four rows, none of them busy, none of them carrying a bar:
        // this is the geometry the complaint was that the flow moved.
        await push(app, snapshot("idle", { revealCount: nextReveal() }));
        await waitForWizard(app, "idle");
        await waitForRowsSettled(app);
        const opened = await rowBoxes(app);
        expect(opened.map((r) => r.key)).toEqual([
          "check",
          "download",
          "stop-work",
          "relaunch",
        ]);
        expect(await elementCount(app, BAR)).toBe(0);
        note(
          "at0632 opened",
          opened.map((r) => `${r.key}=${r.height}`).join(" "),
        );

        // The four plinths are one height as the panel opens. If they were not,
        // every comparison below would be measuring against a panel that was
        // already uneven, and the comparison would mean nothing.
        for (const row of opened) {
          expectSameHeight(
            row.height,
            opened[0]!.height,
            `row "${row.key}" opened at ${row.height}px against "${opened[0]!.key}" at ${opened[0]!.height}px`,
          );
        }

        // ---- And every stage leaves them exactly there --------------------
        for (const { stage, over } of STAGES) {
          await push(app, snapshot(stage, { ...over, revealCount: reveal }));
          await waitForWizard(app, stage);
          await waitForRowsSettled(app);
          const rows = await rowBoxes(app);
          note(
            `at0632 ${stage}`,
            rows.map((r) => `${r.key}=${r.height}`).join(" "),
          );
          expect(rows.map((r) => r.key)).toEqual(opened.map((r) => r.key));
          for (const [i, row] of rows.entries()) {
            // Named in the message because a bare number pair says which stage
            // failed and not which row grew, and the row is the finding.
            expectSameHeight(
              row.height,
              opened[i]!.height,
              `row "${row.key}" at stage "${stage}" is ${row.height}px, was ${opened[i]!.height}px on the opened panel`,
            );
          }

          // And no row says its line in two lines while the others say theirs
          // in one — the wrap the 60px floor is roomy enough to hide.
          for (const line of await detailLines(app)) {
            note(
              `at0632 ${stage} ${line.key} detail`,
              `${line.chars} chars, ${Math.round(line.width)}px of ${Math.round(line.avail)}px, h=${line.height} lh=${line.lineHeight}`,
            );
            expect(
              line.height,
              `row "${line.key}"'s detail line at stage "${stage}" wrapped: ${line.height}px over a ${line.lineHeight}px line`,
            ).toBeLessThan(line.lineHeight * 1.5);
          }
        }

        // ---- And the bar was really there while that held ------------------
        //
        // Every assertion above is satisfied by a wizard that draws no bar at
        // all, which is the one way this file could pass while saying nothing.
        // So: back to the stage that used to grow the download row, and the bar
        // is on the plinth's edge rather than in the content column.
        await push(
          app,
          snapshot("downloading", {
            cancellable: true,
            percent: 42,
            receivedBytes: 20_200_000,
            expectedBytes: 48_100_000,
            revealCount: reveal,
          }),
        );
        await waitForWizard(app, "downloading");
        await waitForRowsSettled(app);
        expect(
          await elementCount(app, `${STEP_ROWS} .tug-step-row-edge ${BAR}`),
        ).toBe(1);
        expect(
          await elementCount(app, `${STEP_ROWS} .tug-step-row-main ${BAR}`),
        ).toBe(0);

        // The strip is inside the plinth it belongs to, flush with its bottom.
        // A strip that had escaped its row would satisfy every height above and
        // be drawn in the wrong place.
        const strip = await app.evalJS<{
          within: boolean;
          flush: number;
          height: number;
        }>(
          `(function () {
             var row = document.querySelector(
               ${JSON.stringify(STEP_ROWS)} + '[data-step="download"]'
             );
             var edge = row.querySelector(".tug-step-row-edge");
             var r = row.getBoundingClientRect();
             var e = edge.getBoundingClientRect();
             return {
               within: e.left >= r.left - 0.5 && e.right <= r.right + 0.5,
               flush: Math.abs(e.bottom - r.bottom),
               height: e.height,
             };
           })()`,
        );
        note("at0632 strip", JSON.stringify(strip));
        expect(strip.within).toBe(true);
        expect(strip.flush).toBeLessThan(0.5);
        // It has a box — a strip of zero height would be a bar nobody can see.
        expect(strip.height).toBeGreaterThan(0);
        // And it is a strip rather than a third line: it cannot be taller than
        // the line it would otherwise have cost the row.
        expect(strip.height).toBeLessThan(opened[0]!.height / 2);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0632] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
