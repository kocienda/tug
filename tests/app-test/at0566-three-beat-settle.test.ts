/**
 * at0566-three-beat-settle.test.ts — a settle that carries a size runs as
 * beats, one kind of motion at a time.
 *
 * ## What this gates
 *
 * A deck settle used to hand every frame ONE effect carrying every term it
 * crossed — translate and size together — so that an edge pinned by their sum
 * stayed pinned. That put a real height tween under a compositor transform on
 * the same frame, and what the reader saw on a split arrival was a card
 * sliding while it shrank, its interior re-laid out under a moving picture.
 * The settle is now choreographed as up to three beats in a fixed order —
 * **shrink, move, grow** — each beat one effect on one recipe, and a beat no
 * frame has a term in is skipped ([B01] of `three-beat-settle`; [D135] as
 * amended). The order reads as make room, move, close up: a card arriving in
 * a split column sees the sitting member shrink, then slides into the room
 * that opened; a card leaving slides away, then the member left behind grows
 * over the room.
 *
 * The claims are read over the frames the imposer itself marks as the settle
 * (`data-imposer-settling` on the canvas), against the beat the imposer names
 * on each one (`data-imposer-beat`), sampled every frame through a split
 * arrival, a split departure, and a cross-column stack move:
 *
 *   1. **The beats run in the declared order, and only the beats the settle
 *      has.** The arrival is a shrink and then a move; the departure is a move
 *      and then a grow; the stack move — the settle the whole design is
 *      measured against ([B02]) — is one move beat and nothing else, with no
 *      size written on any frame at any sample beyond the one React rendered.
 *   2. **During the move beat nothing resizes.** No frame's height changes,
 *      and no top inside either card moves relative to its frame — the
 *      picture translates whole.
 *   3. **During a resize beat nothing translates.** A frame's inline
 *      transform is its held constant or nothing, and its top-left corner
 *      stands still while its edge travels.
 *   4. **The interior lays out truthfully on every frame ([B03]).** The
 *      composer's bottom edge and Z2's top keep one distance from the frame's
 *      bottom edge on every sampled frame of every beat — a resize beat reads
 *      as a sash drag of that edge, never a clip and never a cut.
 *   5. **The settle is spent and cleared.** At rest the mark and the beat
 *      attribute are off the canvas, no frame wears an inline transform, and
 *      no frame wears a pixel height where React renders `auto` — a held or
 *      baked size left behind is residue.
 *
 * Both cards are bound because claim 4 reads the composer and Z2, and an
 * unbound Session card renders the project picker rather than the card body.
 * The transcripts' own length is deliberately not staged: what is under test
 * is which kind of thing moves when, not how much text rides along.
 *
 * `@covers` names the canvas that plans and launches the beats, the planner
 * that partitions a frame's terms into them, and the recipe table each beat's
 * curve is cut from. The fold's own reading of a resize beat is at0563's and
 * at0555's and is not restated here ([B05]).
 *
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/lib/pane-flip.ts
 * @covers tugdeck/src/lib/imposer-motion.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CARD_IDS = ["A", "B"] as const;
type CardId = (typeof CARD_IDS)[number];
const PANE_IDS = ["p1", "p2"] as const;
type PaneId = (typeof PANE_IDS)[number];
/** The card that sits in slot 0 throughout: the member that makes room. */
const SITTER: CardId = "A";
/** The card that arrives in slot 0, leaves it, and crosses again stacked. */
const MOVER: CardId = "B";

const frameSel = (pane: PaneId): string => `.tug-pane[data-pane-id="${pane}"]`;
const transcriptSel = (card: CardId): string =>
  `[data-card-id="${card}"] .session-view-slot .session-view-pane[data-view="transcript"]`;
const entrySel = (card: CardId): string =>
  `[data-card-id="${card}"] [data-slot="session-card-entry-region"]`;
const z2Sel = (card: CardId): string =>
  `[data-card-id="${card}"] .session-card-status-bar`;

/**
 * How long the sampler runs. A full two-beat settle at the default tune is a
 * resize beat (0.6×) plus a move (1.0×) of the 400ms nominal, and the sampler
 * runs well past its end so the rest frames are in the record too.
 */
const CENSUS_MS = 1_400;
/** The whole choreography's window, with room for the last beat to land. */
const AFTER_LAND_MS = 1_800;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Two Session cards, one per column of a two-up. */
function deckShape() {
  return {
    cards: CARD_IDS.map((id) => ({
      id,
      componentId: "session",
      title: `Session ${id}`,
      closable: true,
    })),
    panes: PANE_IDS.map((id, index) => ({
      id,
      position: { x: 40, y: 40 },
      size: { width: 675, height: 620 },
      cardIds: [CARD_IDS[index]],
      activeCardId: CARD_IDS[index],
      title: "",
      acceptsFamilies: ["maker"],
      slot: index,
    })),
    activePaneId: "p1",
    imposition: { kind: "two-up" },
    hasFocus: true,
  };
}

interface FrameSample {
  top: number;
  left: number;
  height: number;
  bottom: number;
  /** The frame's INLINE transform — a beat's held constant, or `""`. */
  transform: string;
  /** The frame's inline width and height — a beat's holds, or `""`. */
  width: string;
  inlineHeight: string;
}

interface CardSample {
  transcriptTop: number;
  entryBottom: number;
  z2Top: number;
}

interface Sample {
  t: number;
  /** Whether the canvas carried the settle mark on this frame. */
  settling: boolean;
  /** The beat the imposer named on this frame, `""` outside a beat. */
  beat: string;
  panes: Record<PaneId, FrameSample>;
  cards: Record<CardId, CardSample>;
}

/**
 * Arm a per-frame sampler, dispatch one arrangement change, and hand back what
 * the sampler saw.
 *
 * Installed BEFORE the dispatch and reading on `requestAnimationFrame`, so the
 * first sample is the pre-motion geometry and every frame of the motion is in
 * the record. Every geometric number is a `getBoundingClientRect()` read —
 * the viewport's own coordinates, where a translate shows up — and the
 * inline values are read off `el.style`, which is where a beat's holds live.
 */
async function census(app: App, dispatch: string): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0566 = [];
      var panes = ${JSON.stringify(PANE_IDS)};
      var cards = ${JSON.stringify(CARD_IDS)};
      var t0 = performance.now();
      var rectOf = function (sel) {
        var el = document.querySelector(sel);
        return el === null ? null : el.getBoundingClientRect();
      };
      var tick = function () {
        var canvas = document.querySelector("[data-imposer-settling]");
        var sample = {
          t: performance.now() - t0,
          settling: canvas !== null,
          beat: canvas === null ? "" : canvas.getAttribute("data-imposer-beat") || "",
          panes: {},
          cards: {},
        };
        panes.forEach(function (pane) {
          var el = document.querySelector('.tug-pane[data-pane-id="' + pane + '"]');
          if (el === null) return;
          var r = el.getBoundingClientRect();
          sample.panes[pane] = {
            top: r.top,
            left: r.left,
            height: r.height,
            bottom: r.bottom,
            transform: el.style.transform,
            width: el.style.width,
            inlineHeight: el.style.height,
          };
        });
        cards.forEach(function (card) {
          var root = '[data-card-id="' + card + '"] ';
          var transcript = rectOf(root + '.session-view-slot .session-view-pane[data-view="transcript"]');
          var entry = rectOf(root + '[data-slot="session-card-entry-region"]');
          var z2 = rectOf(root + '.session-card-status-bar');
          sample.cards[card] = {
            transcriptTop: transcript === null ? -1 : transcript.top,
            entryBottom: entry === null ? -1 : entry.bottom,
            z2Top: z2 === null ? -1 : z2.top,
          };
        });
        window.__at0566.push(sample);
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await app.evalJS<null>(`(${dispatch}, null)`);
  await wait(CENSUS_MS + 300);
  return app.evalJS<Sample[]>(`window.__at0566`);
}

const assignSlot = (card: CardId, slot: number): string =>
  `window.__tug.dispatchControlAction("assign-slot", { cardId: ${JSON.stringify(card)}, slot: ${slot} })`;

/** Divide or stack slot 0, through the one write path, and let it land. */
async function setColumnMode(
  app: App,
  mode: "split" | "stack",
): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: ${JSON.stringify(mode)} }), null)`,
  );
  await wait(AFTER_LAND_MS);
}

/** The frames the settle covered, by the imposer's own account. */
function settlingFrames(samples: Sample[]): Sample[] {
  return samples.filter((s) => s.settling);
}

/** The beats the imposer named, in order of first appearance. */
function beatsSeen(frames: Sample[]): string[] {
  const seen: string[] = [];
  for (const s of frames) {
    if (s.beat !== "" && !seen.includes(s.beat)) seen.push(s.beat);
  }
  return seen;
}

/** The extent a picked series covered across the frames it was sampled in. */
function spread(frames: Sample[], pick: (s: Sample) => number): number {
  if (frames.length === 0) return 0;
  const values = frames.map(pick);
  return Math.max(...values) - Math.min(...values);
}

/** The pane a card is riding in, by the fixture's pairing. */
const paneOf = (card: CardId): PaneId => PANE_IDS[CARD_IDS.indexOf(card)];

/** One beat's window, for the diagnostics line. */
function window_(frames: Sample[], beat: string): string {
  const inBeat = frames.filter((s) => s.beat === beat);
  if (inBeat.length === 0) return `${beat}=none`;
  return `${beat}=${Math.round(inBeat[0].t)}..${Math.round(inBeat[inBeat.length - 1].t)}ms(${inBeat.length}f)`;
}

/**
 * Claims 1 through 4 over one sampled settle.
 *
 * `order` is the beat sequence this motion must produce, and it is asserted
 * exactly: a beat that is missing, extra, or out of order is the choreography
 * being wrong, not a tolerance.
 */
function assertBeats(label: string, samples: Sample[], order: string[]): void {
  const frames = settlingFrames(samples);
  const seen = beatsSeen(frames);
  note(
    label,
    `frames=${frames.length} beats=${JSON.stringify(seen)} ${order.map((b) => window_(frames, b)).join(" ")}`,
  );
  expect(
    frames.length,
    `${label}: the settle must be sampled mid-motion`,
  ).toBeGreaterThan(5);

  // 1. The beats, in order, and no others.
  expect(seen, `${label}: the beats run in the declared order`).toEqual(order);

  for (const beat of order) {
    const inBeat = frames.filter((s) => s.beat === beat);
    expect(
      inBeat.length,
      `${label}: the ${beat} beat must be sampled`,
    ).toBeGreaterThan(2);
    if (beat === "move") {
      // 2. Nothing resizes during the move, and the picture goes whole.
      let travelled = 0;
      for (const pane of PANE_IDS) {
        expect(
          spread(inBeat, (s) => s.panes[pane].height),
          `${label}: ${pane}'s height does not change during the move`,
        ).toBeLessThan(1.5);
        travelled = Math.max(
          travelled,
          spread(inBeat, (s) => s.panes[pane].left),
          spread(inBeat, (s) => s.panes[pane].top),
        );
      }
      expect(
        travelled,
        `${label}: something actually travels during the move`,
      ).toBeGreaterThan(100);
      for (const card of CARD_IDS) {
        const pane = paneOf(card);
        expect(
          spread(inBeat, (s) => s.cards[card].transcriptTop - s.panes[pane].top),
          `${label}: no top inside ${card} moves relative to its frame during the move`,
        ).toBeLessThan(1.5);
      }
    } else {
      // 3. Nothing translates during a resize beat: the inline transform is
      //    one held constant per frame, and the corner stands still.
      let travelled = 0;
      for (const pane of PANE_IDS) {
        const transforms = new Set(inBeat.map((s) => s.panes[pane].transform));
        expect(
          transforms.size,
          `${label}: ${pane}'s transform is its held constant through the ${beat} (${[...transforms].join(" | ")})`,
        ).toBeLessThanOrEqual(1);
        expect(
          spread(inBeat, (s) => s.panes[pane].left),
          `${label}: ${pane}'s left edge stands still through the ${beat}`,
        ).toBeLessThan(0.5);
        expect(
          spread(inBeat, (s) => s.panes[pane].top),
          `${label}: ${pane}'s top edge stands still through the ${beat}`,
        ).toBeLessThan(0.5);
        travelled = Math.max(travelled, spread(inBeat, (s) => s.panes[pane].height));
      }
      expect(
        travelled,
        `${label}: some frame's edge actually travels during the ${beat}`,
      ).toBeGreaterThan(100);
    }
  }

  // 4. The composer's bottom and Z2's top ride the frame's edge on every
  //    sampled frame of every beat — one distance, held.
  for (const card of CARD_IDS) {
    const pane = paneOf(card);
    expect(
      spread(frames, (s) => s.cards[card].entryBottom - s.panes[pane].bottom),
      `${label}: ${card}'s composer bottom rides its frame's edge`,
    ).toBeLessThan(1.5);
    expect(
      spread(frames, (s) => s.cards[card].z2Top - s.panes[pane].bottom),
      `${label}: ${card}'s Z2 rides its frame's edge`,
    ).toBeLessThan(1.5);
  }
}

/** A pane's inline size as React renders it — the settle's holds and tweens
 *  come and go on top of it, and residue is anything left that is not it. */
type InlineSize = Pick<FrameSample, "width" | "inlineHeight">;

/** The inline sizes on the first, pre-motion sample: what React rendered. */
function rendered(samples: Sample[]): Record<PaneId, InlineSize> {
  const first = samples[0];
  const out = {} as Record<PaneId, InlineSize>;
  for (const pane of PANE_IDS) {
    out[pane] = {
      width: first.panes[pane].width,
      inlineHeight: first.panes[pane].inlineHeight,
    };
  }
  return out;
}

/**
 * Claim 5: the settle is spent and cleared.
 *
 * A pane's inline width is React's own and stays; its inline height is `auto`
 * in every arrangement here, split tile or whole column. So residue is a
 * transform, or a pixel height — the animator's baked commit, or a beat's
 * hold, left where React rendered `auto`, which is exactly what the restorers
 * and the beats' own hold-drops exist to take back.
 */
async function assertAtRest(app: App, label: string): Promise<void> {
  const rest = await app.evalJS<{
    settling: boolean;
    beat: string | null;
    residue: Record<string, { transform: string; height: string }>;
  }>(
    `(function () {
      var canvas = document.querySelector("[data-imposer-settling]");
      var out = { settling: canvas !== null, beat: null, residue: {} };
      var beatCarrier = document.querySelector("[data-imposer-beat]");
      out.beat = beatCarrier === null ? null : beatCarrier.getAttribute("data-imposer-beat");
      ${JSON.stringify(PANE_IDS)}.forEach(function (pane) {
        var el = document.querySelector('.tug-pane[data-pane-id="' + pane + '"]');
        if (el === null) return;
        out.residue[pane] = { transform: el.style.transform, height: el.style.height };
      });
      return out;
    })()`,
  );
  note(`${label} at rest`, JSON.stringify(rest));
  expect(rest.settling, `${label}: the settle mark is off at rest`).toBe(false);
  expect(rest.beat, `${label}: the beat attribute is off at rest`).toBeNull();
  for (const pane of PANE_IDS) {
    const r = rest.residue[pane];
    expect(r.transform, `${label}: ${pane} wears no transform at rest`).toBe("");
    expect(
      r.height === "" || r.height === "auto",
      `${label}: ${pane} wears no baked height where React rendered auto (${r.height})`,
    ).toBe(true);
  }
}

/** Bring both Session cards up bound on a fresh app. */
async function openCards(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: SITTER });
  for (const card of CARD_IDS) {
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(card)})`,
      { timeoutMs: 30_000 },
    );
  }
  for (const card of CARD_IDS) {
    await app.bindSession(card, { tugSessionId: `at0566-session-${card}` });
    await app.awaitEngineReady(card);
  }
  for (const card of CARD_IDS) {
    await app.waitForCondition<boolean>(
      `document.querySelector(${JSON.stringify(transcriptSel(card))}) !== null && document.querySelector(${JSON.stringify(entrySel(card))}) !== null && document.querySelector(${JSON.stringify(z2Sel(card))}) !== null`,
      { timeoutMs: 15_000 },
    );
  }
  for (const pane of PANE_IDS) {
    await app.waitForCondition<boolean>(
      `document.querySelector(${JSON.stringify(frameSel(pane))}) !== null`,
      { timeoutMs: 5_000 },
    );
  }
  await wait(AFTER_LAND_MS);
}

describe.skipIf(!SHOULD_RUN)("AT0566: the three-beat settle", () => {
  test(
    "a split arrival shrinks then moves, a departure moves then grows, and a stack move is one move beat",
    async () => {
      const app = await launchTugApp({ testName: "at0566-three-beat-settle" });
      try {
        await openCards(app);

        // ── The split arrival: make room, then move in ─────────────────
        // Slot 0 is divided before the mover arrives, so the arrival is into
        // a split column: the sitter shrinks to its tile and the mover shrinks
        // to the other, and only then does the mover cross into the room.
        await setColumnMode(app, "split");
        const arrival = await census(app, assignSlot(MOVER, 0));
        assertBeats("arrival", arrival, ["shrink", "move"]);
        await assertAtRest(app, "arrival");

        // ── The split departure: move out, then close up ───────────────
        const departure = await census(app, assignSlot(MOVER, 1));
        assertBeats("departure", departure, ["move", "grow"]);
        await assertAtRest(app, "departure");

        // ── The cross-column stack move: one beat, transform-only ──────
        await setColumnMode(app, "stack");
        const stack = await census(app, assignSlot(MOVER, 0));
        assertBeats("stack move", stack, ["move"]);
        // Transform-only: no hold and no tween ever writes a size on a frame,
        // so every sample's inline size is the one React rendered — the
        // first sample's, since a stack move has no opening hold to catch.
        const stackBefore = rendered(stack);
        for (const s of settlingFrames(stack)) {
          for (const pane of PANE_IDS) {
            expect(
              `${s.panes[pane].width}|${s.panes[pane].inlineHeight}`,
              `stack move: ${pane} carries no size term at ${Math.round(s.t)}ms`,
            ).toBe(`${stackBefore[pane].width}|${stackBefore[pane].inlineHeight}`);
          }
        }
        await assertAtRest(app, "stack move");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
