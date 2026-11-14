/**
 * slot-flip-cover-fixture.ts — the body of at0594, a slot mode flip is a
 * cover, not a fade.
 *
 * at0594 was one file running both member counts, one launch each, and the
 * two launches together sat at the 20 s file budget (19 s green on
 * 2026-10-18, 20–21 s and `OVERTIME` since). It is now one file per member
 * count — `at0594-slot-flip-cover-two` and `-three` — and this module is
 * the deck, the sampler and the claims both register. The claims and the
 * argument for them are in the two-member file's docblock.
 */

import { expect } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import { PIXEL_TOL } from "./_harness/tolerances";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

/**
 * How long the sampler runs. A fused settle is one `room` beat at 1.0× of the
 * 400ms nominal; the sampler runs well past its end so the rest frames are in
 * the record too.
 */
const CENSUS_MS = 1_400;
/** The settle window, with room for the last frame to land. */
export const AFTER_LAND_MS = 1_800;

const RAIL_WIDTH = 420;
const PANE_WIDTH = 420;

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface FrameSample {
  top: number;
  bottom: number;
  left: number;
  height: number;
  /** Computed opacity — what the reader can see. */
  opacity: number;
  inlineOpacity: string;
  inlineTransform: string;
  inlineHeight: string;
  /** Whether the frame wore `data-imposer-covered` on this frame. */
  covered: boolean;
}

export interface Sample {
  t: number;
  settling: boolean;
  beat: string;
  panes: Record<string, FrameSample>;
}

/**
 * N cards sharing slot 0, one card in slot 1, plus the Layout card on the
 * right — the shape at0455 already drives, so the slot arithmetic under test
 * is the one that file pins.
 */
function deckShape(memberCount: number) {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: PANE_WIDTH, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  const members: [string, number, string][] = [];
  for (let i = 0; i < memberCount; i += 1) {
    members.push([`p${i + 1}`, 0, String.fromCharCode(65 + i)]);
  }
  members.push(["p9", 1, "Z"]);
  return {
    cards: [
      ...members.map(([, , cardId]) => ({
        id: cardId,
        componentId: "hello",
        title: `Card ${cardId}`,
        closable: true,
      })),
      { id: "L", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...members.map(([id, slot, cardId]) => pane(id, slot, cardId)),
      {
        id: "pRail",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Layout",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: {
      kind: "three-up",
      sidebars: { layout: { side: "right" } },
    },
    hasFocus: true,
  };
}

/** The card each member pane shows, by pane id. */
const cardOf = (paneId: string): string =>
  String.fromCharCode(65 + Number.parseInt(paneId.slice(1), 10) - 1);

/** One frame's read of every member. */
const sampleScript = (paneIds: string[]): string => `
  (function () {
    var canvas = document.querySelector("[data-imposer-settling]");
    var sample = {
      t: 0,
      settling: canvas !== null,
      beat: canvas === null ? "" : canvas.getAttribute("data-imposer-beat") || "",
      panes: {},
    };
    ${JSON.stringify(paneIds)}.forEach(function (id) {
      var el = document.querySelector('.tug-pane[data-pane-id="' + id + '"]');
      if (el === null) return;
      var r = el.getBoundingClientRect();
      sample.panes[id] = {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        height: r.height,
        opacity: parseFloat(getComputedStyle(el).opacity),
        inlineOpacity: el.style.opacity,
        inlineTransform: el.style.transform,
        inlineHeight: el.style.height,
        covered: el.hasAttribute("data-imposer-covered"),
      };
    });
    return sample;
  })()`;

/** Every member's live frame right now. */
export async function readNow(app: App, paneIds: string[]): Promise<Sample> {
  return app.evalJS<Sample>(sampleScript(paneIds));
}

// Kept local: every file's `census` samples its own gesture's readings, so the
// name is shared and the function is not.
/**
 * Arm a per-frame sampler, flip slot 0's mode, and hand back what the sampler
 * saw. Installed BEFORE the dispatch and reading on `requestAnimationFrame`,
 * so the first sample is the pre-motion geometry and every frame of the
 * motion is in the record.
 */
export async function census(
  app: App,
  paneIds: string[],
  mode: "stack" | "split",
): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0594 = [];
      var t0 = performance.now();
      var tick = function () {
        var sample = ${sampleScript(paneIds)};
        sample.t = performance.now() - t0;
        window.__at0594.push(sample);
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-slot-mode", { slot: 0, mode: ${JSON.stringify(mode)} }), null)`,
  );
  await wait(AFTER_LAND_MS);
  return app.evalJS<Sample[]>(`window.__at0594`);
}

/** The frames the settle covered, by the imposer's own account. */
export const settlingFrames = (samples: Sample[]): Sample[] =>
  samples.filter((s) => s.settling);

export const sameRect = (a: FrameSample, b: FrameSample): boolean =>
  Math.abs(a.top - b.top) < PIXEL_TOL && Math.abs(a.height - b.height) < PIXEL_TOL;

/**
 * The claims every flip holds, in either direction, for any member count:
 * no fade, one fused beat, the covered members where the cover says they are,
 * and nothing left behind.
 */
export function assertCover(
  label: string,
  samples: Sample[],
  paneIds: string[],
  survivor: string,
  direction: "stack" | "split",
): void {
  const frames = settlingFrames(samples);
  expect(
    frames.length,
    `${label}: the settle must be sampled mid-motion`,
  ).toBeGreaterThan(2);
  const last = samples[samples.length - 1];
  if (last === undefined) throw new Error(`${label}: no samples`);
  const committed = last.panes;
  const survivorEnd = committed[survivor];
  if (survivorEnd === undefined) throw new Error(`${label}: no survivor rect`);

  // 1. No member ever fades.
  for (const s of samples) {
    for (const id of paneIds) {
      const p = s.panes[id];
      if (p === undefined) continue;
      expect(
        p.opacity,
        `${label}: ${id} at ${Math.round(s.t)}ms is at full opacity`,
      ).toBe(1);
      expect(
        p.inlineOpacity,
        `${label}: ${id} at ${Math.round(s.t)}ms wears no inline opacity`,
      ).toBe("");
    }
  }

  // 2. The survivor's crossing is one fused beat.
  const beats = new Set(frames.map((s) => s.beat).filter((b) => b !== ""));
  expect(
    [...beats],
    `${label}: every beat named while settling is the fused room beat`,
  ).toEqual(["room"]);

  // 3/4. The covered members, while the survivor is mid-flight.
  const first = samples[0];
  if (first === undefined) throw new Error(`${label}: no first sample`);
  const survivorStart = first.panes[survivor];
  let midFlight = 0;
  for (const s of frames) {
    const sv = s.panes[survivor];
    // In flight is away from BOTH ends. The settle marks the canvas at its
    // arm, and its commit lands a frame later (the deck store tells React
    // after the paint), so the first settling frame can still show the
    // arrangement before the flip: the survivor at its start, every member
    // at its tile, nothing yet for a cover to hide.
    if (sv === undefined || sameRect(sv, survivorEnd)) continue;
    if (survivorStart !== undefined && sameRect(sv, survivorStart)) continue;
    midFlight += 1;
    for (const id of paneIds) {
      if (id === survivor) continue;
      const p = s.panes[id];
      const before = first.panes[id];
      const end = committed[id];
      if (p === undefined || before === undefined || end === undefined) continue;
      if (direction === "stack") {
        // The retiring member holds the tile it is leaving — never the full
        // run it is committed to, which is where the fade used to drop it.
        expect(
          sameRect(p, end),
          `${label}: ${id} at ${Math.round(s.t)}ms is not at its committed rect while the survivor is mid-flight`,
        ).toBe(false);
        expect(
          sameRect(p, before),
          `${label}: ${id} at ${Math.round(s.t)}ms holds the tile it is leaving`,
        ).toBe(true);
      } else {
        // The revealed member is at its committed tile from the first frame;
        // the survivor's retreat uncovers it, strip by strip, so it is not
        // inside the survivor's rect for long — it is simply where it lands.
        expect(
          sameRect(p, end),
          `${label}: ${id} at ${Math.round(s.t)}ms stands at its committed tile (${Math.round(p.top)}..${Math.round(p.bottom)})`,
        ).toBe(true);
      }
      expect(
        p.covered,
        `${label}: ${id} at ${Math.round(s.t)}ms wears the cover`,
      ).toBe(true);
    }
  }
  expect(
    midFlight,
    `${label}: the survivor must be sampled mid-flight`,
  ).toBeGreaterThan(1);

  // 5. Nothing is left behind. React renders an inline height of its own on
  // every frame — `auto` stacked, the tile's pixels split — so what residue
  // looks like is not "any value" but the ONE the hold wrote: the pre-motion
  // rect height in pixels, which the restorer exists to take back.
  for (const id of paneIds) {
    const p = committed[id];
    const rendered = first.panes[id];
    if (p === undefined || rendered === undefined) {
      throw new Error(`${label}: ${id} missing at rest`);
    }
    expect(p.inlineTransform, `${label}: ${id} keeps no inline transform`).toBe("");
    expect(
      p.inlineHeight,
      `${label}: ${id} does not keep the height it was held at`,
    ).not.toBe(`${rendered.height}px`);
    expect(p.inlineOpacity, `${label}: ${id} keeps no inline opacity`).toBe("");
    expect(p.covered, `${label}: ${id} keeps no cover mark`).toBe(false);
  }
  expect(last.settling, `${label}: the settle has ended`).toBe(false);
}

/** The member at a given rank from the top of the split run. */
export function memberAtRank(sample: Sample, paneIds: string[], rank: number): string {
  const ordered = paneIds
    .filter((id) => sample.panes[id] !== undefined)
    .sort((a, b) => sample.panes[a]!.top - sample.panes[b]!.top);
  const id = ordered[rank];
  if (id === undefined) throw new Error(`no member at rank ${rank}`);
  return id;
}

export async function launch(memberCount: number, testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
  );
  await app.seedDeckState({ state: deckShape(memberCount), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelector('.tug-pane[data-pane-id="p${memberCount}"]') !== null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
  return app;
}

/** Bring one member to the front of its slot — the raise, z-order only. */
export async function raise(app: App, paneId: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.activateCard(${JSON.stringify(cardOf(paneId))}), null)`,
  );
  await wait(300);
}

export async function takeCuts(app: App): Promise<string> {
  await app.evalJS<null>(`(window.__tug.disarmCutDetector(), null)`);
  const cuts = await app.evalJS<{ paneId: string; kind: string }[]>(
    `window.__tug.takeCutRecords()`,
  );
  return cuts.map((c) => `${c.paneId}:${c.kind}`).join("; ");
}
