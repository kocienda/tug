/**
 * at0594-column-flip-cover.test.ts — a column mode flip is a cover, not a
 * fade.
 *
 * Stack Column and Split Column play as one motion. The column's z-frontmost
 * member — the SURVIVOR, the card a stack actually shows — runs a single fused
 * beat: its translate and its height change are the same edge, so they ride
 * one `room` beat rather than a move and then a grow. Every other member
 * animates nothing. On a stack it holds its old tile at full opacity until the
 * survivor has grown over it, and is released only at the chain's completion;
 * on a split it is simply at its tile behind the survivor, uncovered as the
 * survivor retreats. No card fades in either direction
 * (`briefs/column-flip-cover-brief.md`, [B01]–[B03]).
 *
 * The defect this pins: the retiring member used to fade out on a shorter
 * clock than the survivor's two-beat chain, come back at full strength at its
 * committed rect — the full run — and then be painted over by the survivor's
 * grow beat. Every claim below is sampled every frame through the settle,
 * because that defect lives in the frames between the commit and the landing.
 *
 *   1. **No member ever fades.** Every sampled computed opacity is 1, and no
 *      inline opacity is written at any sample.
 *   2. **The survivor's crossing is one fused beat.** Every beat the canvas
 *      names while settling is `room`; no `move` or `grow` is ever sampled.
 *   3. **The stack's retiring member holds its tile until it is covered.**
 *      While the survivor is mid-flight the retiring member is never at its
 *      committed rect: it stands at the tile it is leaving.
 *   4. **The split's revealed member never travels.** It is at its committed
 *      tile from the first settling frame, and the survivor's retreat is what
 *      uncovers it — nothing slides it into place.
 *   5. **Nothing is left behind.** After each settle no member wears an inline
 *      opacity or transform, none keeps the pixel height it was held at, and
 *      no cover mark remains.
 *   6. **The flip never cuts.** The cut census, armed across both directions,
 *      records nothing — a member the flip commits behind its survivor is
 *      read as covered rather than as a jump.
 *
 * The three-member case — middle member frontmost, both directions — holds the
 * same claims and, because the brief left how it READS as an open question,
 * records the survivor's rect through each settle as `note()` lines so the
 * fused beat can be read from the report.
 *
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/lib/cut-detector.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** Geometry tolerance: sub-pixel layout rounding, never a real disagreement. */
const EPSILON = 1.5;
/**
 * How long the sampler runs. A fused settle is one `room` beat at 1.0× of the
 * 400ms nominal; the sampler runs well past its end so the rest frames are in
 * the record too.
 */
const CENSUS_MS = 1_400;
/** The settle window, with room for the last frame to land. */
const AFTER_LAND_MS = 1_800;

const RAIL_WIDTH = 420;
const PANE_WIDTH = 420;

const wait = (ms: number): Promise<void> =>
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

interface Sample {
  t: number;
  settling: boolean;
  beat: string;
  panes: Record<string, FrameSample>;
}

/**
 * N cards sharing slot 0, one card in slot 1, plus the Layout card on the
 * right — the shape at0455 already drives, so the column arithmetic under test
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
async function readNow(app: App, paneIds: string[]): Promise<Sample> {
  return app.evalJS<Sample>(sampleScript(paneIds));
}

/**
 * Arm a per-frame sampler, flip slot 0's mode, and hand back what the sampler
 * saw. Installed BEFORE the dispatch and reading on `requestAnimationFrame`,
 * so the first sample is the pre-motion geometry and every frame of the
 * motion is in the record.
 */
async function census(
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
    `(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: ${JSON.stringify(mode)} }), null)`,
  );
  await wait(AFTER_LAND_MS);
  return app.evalJS<Sample[]>(`window.__at0594`);
}

/** The frames the settle covered, by the imposer's own account. */
const settlingFrames = (samples: Sample[]): Sample[] =>
  samples.filter((s) => s.settling);

const sameRect = (a: FrameSample, b: FrameSample): boolean =>
  Math.abs(a.top - b.top) < EPSILON && Math.abs(a.height - b.height) < EPSILON;

/**
 * The claims every flip holds, in either direction, for any member count:
 * no fade, one fused beat, the covered members where the cover says they are,
 * and nothing left behind.
 */
function assertCover(
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
  let midFlight = 0;
  for (const s of frames) {
    const sv = s.panes[survivor];
    if (sv === undefined || sameRect(sv, survivorEnd)) continue;
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
function memberAtRank(sample: Sample, paneIds: string[], rank: number): string {
  const ordered = paneIds
    .filter((id) => sample.panes[id] !== undefined)
    .sort((a, b) => sample.panes[a]!.top - sample.panes[b]!.top);
  const id = ordered[rank];
  if (id === undefined) throw new Error(`no member at rank ${rank}`);
  return id;
}

async function launch(memberCount: number, testName: string): Promise<App> {
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

/** Bring one member to the front of its column — the raise, z-order only. */
async function raise(app: App, paneId: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.activateCard(${JSON.stringify(cardOf(paneId))}), null)`,
  );
  await wait(300);
}

async function takeCuts(app: App): Promise<string> {
  await app.evalJS<null>(`(window.__tug.disarmCutDetector(), null)`);
  const cuts = await app.evalJS<{ paneId: string; kind: string }[]>(
    `window.__tug.takeCutRecords()`,
  );
  return cuts.map((c) => `${c.paneId}:${c.kind}`).join("; ");
}

describe.skipIf(!SHOULD_RUN)("at0594 — column flip cover", () => {
  test(
    "a two-member column with the bottom member frontmost flips both ways as a cover",
    async () => {
      const paneIds = ["p1", "p2"];
      const app = await launch(2, "at0594-column-flip-cover-two");
      try {
        // Split first, so the bottom member can be found and raised. This
        // flip is not under test; it lands before anything samples.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "split" }), null)`,
        );
        await wait(AFTER_LAND_MS);
        const split = await readNow(app, paneIds);
        const survivor = memberAtRank(split, paneIds, 1);
        const other = paneIds.find((id) => id !== survivor)!;
        await raise(app, survivor);
        note(`two-member: bottom member ${survivor} raised; ${other} retires`);

        await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);

        // ── Stack: the survivor rises and grows; the other holds its tile. ──
        const stacked = await census(app, paneIds, "stack");
        assertCover("stack", stacked, paneIds, survivor, "stack");
        {
          const end = stacked[stacked.length - 1]!.panes;
          expect(
            sameRect(end[survivor]!, end[other]!),
            "stacked members share one rect",
          ).toBe(true);
        }

        // ── Split: the survivor retreats to its tile; the other is uncovered. ──
        const divided = await census(app, paneIds, "split");
        assertCover("split", divided, paneIds, survivor, "split");
        {
          const end = divided[divided.length - 1]!.panes;
          expect(
            sameRect(end[other]!, split.panes[other]!),
            "the revealed member is back at its tile",
          ).toBe(true);
          expect(
            sameRect(end[survivor]!, split.panes[survivor]!),
            "the survivor is back at its tile",
          ).toBe(true);
        }

        expect(
          await takeCuts(app),
          "stack and split on a column produce no cut records",
        ).toBe("");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a three-member column with the middle member frontmost flips both ways as a cover",
    async () => {
      const paneIds = ["p1", "p2", "p3"];
      const app = await launch(3, "at0594-column-flip-cover-three");
      try {
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "split" }), null)`,
        );
        await wait(AFTER_LAND_MS);
        const split = await readNow(app, paneIds);
        const survivor = memberAtRank(split, paneIds, 1);
        await raise(app, survivor);
        note(
          `three-member: middle member ${survivor} raised at ${Math.round(split.panes[survivor]!.top)}..${Math.round(split.panes[survivor]!.bottom)}`,
        );

        await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);

        // The survivor's rect through each settle, for the eye the arc does
        // not have: both edges move on a stack from the middle tile, and both
        // retreat on the split. Read the samples for one edge sweep per beat.
        const trace = (label: string, samples: Sample[]): void => {
          const rows = settlingFrames(samples)
            .filter((_, i) => i % 3 === 0)
            .map((s) => {
              const p = s.panes[survivor]!;
              return `${Math.round(s.t)}ms ${s.beat || "-"} ${Math.round(p.top)}..${Math.round(p.bottom)}`;
            });
          note(`${label} survivor: ${rows.join(" | ")}`);
        };

        const stacked = await census(app, paneIds, "stack");
        trace("stack", stacked);
        assertCover("stack", stacked, paneIds, survivor, "stack");

        const divided = await census(app, paneIds, "split");
        trace("split", divided);
        assertCover("split", divided, paneIds, survivor, "split");
        {
          const end = divided[divided.length - 1]!.panes;
          for (const id of paneIds) {
            expect(
              sameRect(end[id]!, split.panes[id]!),
              `${id} is back at its tile after the round trip`,
            ).toBe(true);
          }
        }

        expect(
          await takeCuts(app),
          "stack and split on a three-member column produce no cut records",
        ).toBe("");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
