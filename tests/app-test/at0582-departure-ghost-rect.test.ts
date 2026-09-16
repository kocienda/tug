/**
 * at0582-departure-ghost-rect.test.ts — a departing card's ghost stands exactly
 * where the card stood, and its face fills the ghost.
 *
 * ## What this gates
 *
 * A closing pane cannot be animated out: React unmounts the frame inside the
 * removal commit, so by the time there is an animation to run there is no
 * element to run it on. The canvas plants a `.tug-pane-exit-ghost` at the
 * frame's last measured rect instead, fades it, and takes it away
 * (`deck-canvas.tsx`, "The departures"). Since `ebcb64175` the ghost also
 * carries a FACE — a `cloneNode(true)` of the whole `.tug-pane` subtree, taken
 * on `cardWillBeginDestruction` while the frame still exists — so the card
 * fades as itself rather than as a coloured rectangle.
 *
 * Nothing tested WHERE either of them stood. `at0450` asserts a ghost exists
 * mid-fade and is gone at rest; `at0571` asserts the ghost carries a face and
 * that the face carries the picker. Neither compares a rect to anything, and
 * the defect that fell through the gap is the plainest one there is: the
 * clone keeps the live frame's inline `position: absolute` and the imposer's
 * `left`/`top`, inline geometry outranks the `.tug-pane-exit-ghost >
 * .tug-pane-exit-face { position: absolute; inset: 0 }` class rule, and so the
 * face is laid out INSIDE the ghost at the pane's own canvas coordinates. The
 * reader sees the card, then a copy of it shifted down and right by the strip
 * gap, then the copy fading.
 *
 * ## The claim
 *
 * Two rules, read on every animation frame of the `depart` beat:
 *
 * 1. The GHOST's bounding rect equals the rect the departing frame stood at,
 *    within a pixel. The ghost owns position and size.
 * 2. The FACE's bounding rect equals the same rect. The face owns NOTHING: it
 *    is a picture that fills the box the ghost placed, and any geometry of its
 *    own — inline or otherwise — is a leak.
 *
 * The deck is at rest when the close is dispatched, so the rect the arm
 * measures is the rect on screen the instant before the gesture, and that is
 * what the census reads both of them against.
 *
 * A per-frame sampler rather than a before-and-after reading, for the reason
 * `at0576` gives: the ghost stands for one beat and is taken away, so a check
 * that runs after it is gone has nothing to look at, and a check that runs
 * once mid-fade cannot tell a ghost that stood still from one that drifted.
 *
 * ## Why the face is read twice
 *
 * The rect is the claim. The face's INLINE `position`/`left`/`top` are read
 * alongside it because they are the leak's mechanism, and a failure that names
 * them is a failure that says what to fix rather than only that something
 * moved.
 *
 * @covers tugdeck/src/components/chrome/departure-face.ts
 * @covers tugdeck/src/components/tugways/tug-pane.css
 */
import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The width each seeded card stands at. */
const SLIM_PX = 560;
/**
 * How long the per-frame sampler watches the close.
 *
 * The depart beat is the chain's first and runs at the divide-join window; the
 * sampler runs well past the whole chain so the ghost's entire life — plant,
 * fade, removal — is in the record.
 */
const CENSUS_MS = 2_000;
/**
 * Geometry tolerance, in px.
 *
 * Sub-pixel layout rounding and a device-pixel-ratio boundary, never a real
 * disagreement. The defect this file gates is the strip gap plus a border —
 * `IMPOSITION_GAP_PX` is 5px — so the bar sits well below it and well above
 * the rounding.
 */
const EPSILON = 1.5;

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
  /** How many ghosts stand on this frame. */
  ghosts: number;
  /** The ghost's rect, when one stands. */
  ghost: Rect | null;
  /** The face's rect, when the ghost carries one. */
  face: Rect | null;
  /** The face's own inline geometry — the leak's mechanism, named. */
  faceInline: string;
}

/**
 * A five-up FLOW band holding three `hello` cards in slots 1, 2 and 3.
 *
 * A real arrangement rather than a lone card, because the departure has to be
 * read against survivors that are themselves moving into the room it gives up
 * — a ghost that drifted WITH the strip would be invisible on a one-card deck.
 */
function deckShape() {
  const ids = ["C", "D", "E"];
  return {
    cards: ids.map((id) => ({
      id,
      componentId: "hello",
      title: `Card ${id}`,
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

/** Seed the deck and let the imposer settle, so the close lands on a deck at rest. */
async function seed(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "C" });
  await app.waitForCondition<boolean>(
    `document.querySelector('.tug-pane[data-pane-id="p2"]') !== null`,
    { timeoutMs: 8_000 },
  );
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

/**
 * Arm the per-frame sampler, close the pane, and hand back every frame's
 * reading of the ghost and its face.
 */
async function census(app: App, paneId: string): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0582 = [];
      var t0 = performance.now();
      var box = function (el) {
        if (el === null) return null;
        var r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      };
      var tick = function () {
        var canvas = document.querySelector("[data-imposer-settling]");
        var ghost = document.querySelector(".tug-pane-exit-ghost");
        var face =
          ghost === null
            ? null
            : ghost.querySelector(":scope > .tug-pane-exit-face");
        window.__at0582.push({
          t: Math.round(performance.now() - t0),
          beat: canvas === null ? "" : canvas.getAttribute("data-imposer-beat") || "",
          ghosts: document.querySelectorAll(".tug-pane-exit-ghost").length,
          ghost: box(ghost),
          face: box(face),
          faceInline:
            face === null
              ? ""
              : "position=" + (face.style.position || "-") +
                " left=" + (face.style.left || "-") +
                " top=" + (face.style.top || "-") +
                " width=" + (face.style.width || "-") +
                " height=" + (face.style.height || "-") +
                " transform=" + (face.style.transform || "-"),
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

describe.skipIf(!SHOULD_RUN)("AT0582: the departure ghost's rect", () => {
  test(
    "the ghost stands where the card stood, and the face fills the ghost",
    async () => {
      const app = await launchTugApp({ testName: "at0582-departure-ghost" });
      try {
        await seed(app);
        const measured = await frameRect(app, "p2");
        expect(measured, "the pane to close was on screen").not.toBeNull();
        note("measured", `p2 stood at ${fmt(measured)}`);

        const samples = await census(app, "p2");
        // An occluded harness window suspends `requestAnimationFrame`, and a
        // census with no samples in it would pass this file's claim by having
        // watched nothing at all.
        expect(
          samples.length,
          "the departure must be sampled per animation frame",
        ).toBeGreaterThan(5);

        const standing = samples.filter((s) => s.ghost !== null);
        expect(
          standing.length,
          "a closing pane leaves a ghost, and the census must have seen it stand",
        ).toBeGreaterThan(2);
        const withFace = standing.filter((s) => s.face !== null);
        expect(
          withFace.length,
          "the ghost carries a face for the whole time it stands ([F01])",
        ).toBe(standing.length);
        note(
          "census",
          `${samples.length} frames sampled; a ghost stood on ${standing.length} of them, ` +
            `beats ${[...new Set(standing.map((s) => s.beat || "(none)"))].join(", ")}`,
        );
        note("face inline geometry", withFace[0]?.faceInline ?? "(no face)");

        const offences: string[] = [];
        let worstGhost = 0;
        let worstFace = 0;
        for (const s of standing) {
          const gd = drift(s.ghost as Rect, measured);
          worstGhost = Math.max(worstGhost, gd);
          if (gd > EPSILON && offences.length < 6) {
            offences.push(
              `t=${s.t}ms beat "${s.beat}": the ghost stood at ${fmt(s.ghost as Rect)}, ${gd.toFixed(1)}px off the measured ${fmt(measured)}`,
            );
          }
          if (s.face === null) continue;
          const fd = drift(s.face, measured);
          worstFace = Math.max(worstFace, fd);
          if (fd > EPSILON && offences.length < 6) {
            offences.push(
              `t=${s.t}ms beat "${s.beat}": the face stood at ${fmt(s.face)}, ${fd.toFixed(1)}px off the measured ${fmt(measured)} (inline ${s.faceInline})`,
            );
          }
        }
        note(
          "worst drift",
          `ghost ${worstGhost.toFixed(1)}px, face ${worstFace.toFixed(1)}px (bar ${EPSILON}px)`,
        );
        expect(
          offences,
          "the ghost and its face both stand at the rect the departing frame was measured at, on every frame of the fade",
        ).toEqual([]);

        // Nothing retained at rest: the same bar `at0450` holds, read here so
        // this file's own gesture cannot leave a tile behind unnoticed.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(".tug-pane-exit-ghost").length`,
          ),
          "the ghost is taken away when its fade lands",
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
