/**
 * at0582-departing-frame-rect.test.ts — a closing card leaves on its own
 * frame, exactly where it stood, and the commit that finally removes it
 * moves nothing.
 *
 * ## What this gates
 *
 * A closing pane is carried out by the settle on its REAL frame. The store
 * keeps the closed pane, its cards and a `departing` mark in the deck it
 * publishes for one settle (`lib/departing.ts`); the canvas draws that pane
 * where it stood, `inert` and outside the solver; the settle's `depart` beat
 * fades it there; and the settle's land is the one commit that removes it
 * (`settle-engine.ts`, "The departures"). Nothing is planted inside the window
 * to stand in for it — that was the exit ghost, and the ghost was two layer
 * transactions inside a window [D9] keeps compositor-only.
 *
 * ## The claim
 *
 * Read on every animation frame of the `depart` beat:
 *
 * 1. The departing frame — `.tug-pane[data-pane-id="p2"]`, marked
 *    `data-settle-departing` — stands at the rect it stood at before the
 *    close, within a pixel. Its holds own position and size while the
 *    survivors move into the room it gave up.
 * 2. It is the CARD: its `.tug-pane-content` still has children. A departure
 *    is the card itself leaving, not a tile standing in for it.
 *
 * And once the deck is at rest:
 *
 * 3. No `[data-departing]` frame remains — the land removed it.
 * 4. The land armed nothing. The commit that removes the pane is a store
 *    notify like any other, and the settle's arm reads it; because the
 *    arrangement signature stands on the deck WITHOUT departing panes, that
 *    commit changed no term, and the last `settle-arm` row after the close's
 *    `settle-release` reads `armed: false, outcome: "unchanged"`. A land that
 *    armed a settle of its own would be a second motion after the gesture had
 *    finished.
 *
 * The deck is at rest when the close is dispatched, so the rect the arm
 * measures is the rect on screen the instant before the gesture.
 *
 * A per-frame sampler rather than a before-and-after reading: the departure
 * lasts one beat, so a check after it has nothing to look at, and a check
 * once mid-fade cannot tell a frame that stood still from one that drifted.
 *
 * The three cards are Session cards bound to REAL resumed transcripts — the
 * slice (`real-transcript-fixture.ts`) — so the card that leaves is a card
 * with a transcript under it, which is the card a user closes. The claims are
 * rects and a commit's arm, which a transcript must not change, so the slice
 * is the one arm this file runs.
 *
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/lib/departing.ts
 * @covers tests/app-test/real-transcript-fixture.ts
 */
import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { bindForTest } from "./real-transcript-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The width each seeded card stands at. */
const SLIM_PX = 560;
/**
 * How long the per-frame sampler watches the close — well past the whole
 * chain, so the departure's entire life is in the record.
 */
const CENSUS_MS = 2_000;
/**
 * Geometry tolerance, in px: sub-pixel layout rounding, never a real
 * disagreement. The strip gap alone is `IMPOSITION_GAP_PX` (5px).
 */
const EPSILON = 1;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** A rect flattened to the four numbers this file compares. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Sample {
  t: number;
  /** The beat the imposer named on this frame, `""` outside a beat. */
  beat: string;
  /** The departing frame's mark, when it wears one. */
  mark: string | null;
  /** The departing frame's rect, while it is in the document. */
  frame: Rect | null;
  /** How many children its `.tug-pane-content` holds. */
  content: number;
}

/**
 * A five-up FLOW band holding three Session cards in slots 1, 2 and 3.
 *
 * A real arrangement rather than a lone card, because the departure has to be
 * read against survivors that are themselves moving into the room it gives up
 * — a frame that drifted WITH the strip would be invisible on a one-card deck.
 */
function deckShape() {
  const ids = ["C", "D", "E"];
  return {
    cards: ids.map((id) => ({
      id,
      componentId: "session",
      title: `Session ${id}`,
      closable: true,
    })),
    panes: ids.map((id, index) => ({
      id: `p${index + 1}`,
      position: { x: 40, y: 40 },
      size: { width: SLIM_PX, height: 400 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
      slot: index + 1,
    })),
    activePaneId: "p2",
    imposition: { kind: "five-up", sidebars: {}, layout: "flow" },
    hasFocus: true,
  };
}

/**
 * Seed the deck, bind its cards, and let the imposer settle, so the close
 * lands on a deck at rest.
 */
async function seed(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "C" });
  await app.waitForCondition<boolean>(
    `document.querySelector('.tug-pane[data-pane-id="p2"]') !== null`,
    { timeoutMs: 8_000 },
  );
  await bindForTest(app, ["C", "D", "E"], { size: "slice", label: "at0582" });
  await wait(1_400);
}

/** Where a pane's frame stands right now — the rect the arm is about to measure. */
async function frameRect(app: App, paneId: string): Promise<Rect> {
  return app.evalJS<Rect>(
    `(function () {
      var el = document.querySelector('.tug-pane[data-pane-id=${JSON.stringify(paneId)}]');
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`,
  );
}

/** Arm the per-frame sampler, close the pane, and hand back every frame's reading. */
async function census(app: App, paneId: string): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0582 = [];
      var t0 = performance.now();
      var tick = function () {
        var canvas = document.querySelector("[data-imposer-settling]");
        var el = document.querySelector('.tug-pane[data-pane-id=${JSON.stringify(paneId)}]');
        var r = el === null ? null : el.getBoundingClientRect();
        var content = el === null ? null : el.querySelector(".tug-pane-content");
        window.__at0582.push({
          t: Math.round(performance.now() - t0),
          beat: canvas === null ? "" : canvas.getAttribute("data-imposer-beat") || "",
          mark: el === null ? null : el.getAttribute("data-settle-departing"),
          frame: r === null ? null : { left: r.left, top: r.top, width: r.width, height: r.height },
          content: content === null ? 0 : content.children.length,
        });
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await app.evalJS<null>(
    `(window.__tug.closePane(${JSON.stringify(paneId)}), null)`,
  );
  await wait(CENSUS_MS + 300);
  return app.evalJS<Sample[]>(`window.__at0582`);
}

/** How far a sampled rect stands from the one the frame stood at. */
function drift(rect: Rect, measured: Rect): number {
  return Math.max(
    Math.abs(rect.left - measured.left),
    Math.abs(rect.top - measured.top),
    Math.abs(rect.width - measured.width),
    Math.abs(rect.height - measured.height),
  );
}

const fmt = (r: Rect): string =>
  `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`;

describe.skipIf(!SHOULD_RUN)("AT0582: the departing frame's rect", () => {
  test(
    "the card leaves on its own frame, where it stood, and the land moves nothing",
    async () => {
      const app = await launchTugApp({ testName: "at0582-departing-frame" });
      try {
        await seed(app);
        const measured = await frameRect(app, "p2");
        expect(measured, "the pane to close was on screen").not.toBeNull();
        note("measured", `p2 stood at ${fmt(measured)}`);

        // The trace records `settle-release` and `store-notify` only while
        // it is enabled, so it is switched on before the mark is taken.
        const mark = await app.evalJS<number>(
          `(window.__deckTrace.enable(true), window.__deckTrace.since(0).length)`,
        );
        const samples = await census(app, "p2");
        // An occluded harness window suspends `requestAnimationFrame`, and a
        // census with no samples in it would pass this file's claim by having
        // watched nothing at all.
        expect(
          samples.length,
          "the departure must be sampled per animation frame",
        ).toBeGreaterThan(5);

        const departing = samples.filter(
          (s) => s.beat === "depart" && s.mark === "p2" && s.frame !== null,
        );
        note(
          "census",
          `${samples.length} frames sampled; p2 departing on ${departing.length} depart frame(s)`,
        );
        expect(
          departing.length,
          "the closing pane's own frame is carried on the depart beat",
        ).toBeGreaterThan(2);

        const offences: string[] = [];
        let worst = 0;
        for (const s of departing) {
          const d = drift(s.frame as Rect, measured);
          worst = Math.max(worst, d);
          if (d > EPSILON && offences.length < 6) {
            offences.push(
              `t=${s.t}ms: the departing frame stood at ${fmt(s.frame as Rect)}, ${d.toFixed(1)}px off the measured ${fmt(measured)}`,
            );
          }
        }
        note("worst drift", `${worst.toFixed(2)}px (bar ${EPSILON}px)`);
        expect(
          offences,
          "the departing frame stands at its pre-close rect on every frame of its beat",
        ).toEqual([]);
        expect(
          departing.filter((s) => s.content === 0).map((s) => `t=${s.t}ms`),
          "and it is the card: its content is still there while it leaves",
        ).toEqual([]);

        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(".tug-pane[data-departing]").length`,
          ),
          "at rest, the land has removed the departing frame",
        ).toBe(0);

        // The land armed nothing: every `settle-arm` after the close's
        // release reads the arrangement as unchanged.
        const rows = await app.evalJS<
          Array<{ kind: string; armed?: boolean; outcome?: string; caller?: string }>
        >(
          `window.__deckTrace.since(${mark}).filter(function (e) {
             return e.kind === "settle-arm" || e.kind === "settle-release" || e.kind === "store-notify";
           }).map(function (e) {
             return { kind: e.kind, armed: e.armed, outcome: e.outcome, caller: e.caller };
           })`,
        );
        const release = rows.findIndex((r) => r.kind === "settle-release");
        const after = release < 0 ? [] : rows.slice(release + 1);
        note("after the release", JSON.stringify(after));
        expect(release, "the close's settle released").toBeGreaterThanOrEqual(0);
        expect(
          after.some((r) => r.kind === "store-notify" && r.caller === "landDepartures"),
          "the land is a store commit after the release",
        ).toBe(true);
        const arms = after.filter((r) => r.kind === "settle-arm");
        expect(arms.length, "and the settle's arm read it").toBeGreaterThan(0);
        expect(
          arms[arms.length - 1],
          "the land armed nothing: its signature did not change",
        ).toEqual({ kind: "settle-arm", armed: false, outcome: "unchanged", caller: undefined });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
