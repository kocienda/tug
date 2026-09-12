/**
 * at0555-session-fold-motion.test.ts — the fold runs on the settle's clock.
 *
 * ## What this gates
 *
 * The pane frame's height is a REAL geometry tween — the imposer's settle
 * animates `height` and never smears it — and the fold has exactly one clock,
 * that one. That is what this file gates. Anything inside the card that
 * animated on a clock of its own would finish somewhere the frame carrying it
 * had not reached, and the seam would show; the card's interior therefore has
 * no clock at all. It is laid out once at the open size and clipped, and the
 * frame's edge is the only thing in motion.
 *
 * The card DID carry a second tween once: the entry region's
 * `grid-template-rows` rode a CSS transition that shared the settle's duration
 * and nothing else, so the two curves drifted apart inside their shared window
 * and the composer was still growing after the frame had stopped. Claim 1 used
 * to assert the duration equality and call it one clock; it was one window on
 * two curves. It now asserts that the second curve is gone.
 *
 * Four claims, over one wall of three folded Session cards in a split column
 * — which is the shape the fold has to survive, because it is the one where a
 * wrong clock moves somebody else's card:
 *
 *   1. **One clock, and the card declares none of its own.** The entry
 *      region's computed `transition-duration` is exactly zero. No sampling,
 *      no tolerance: a second tween in the card is either declared or it is
 *      not, and the stylesheet's own comment says not to put one back. The
 *      band the windows below are read against is taken from
 *      `--tugx-imposer-settle-duration` scaled by `--tug-timing` — the same
 *      product `deck-canvas.tsx` hands the settle's tweens — so a retune
 *      anywhere up the tree retimes the assertion with the motion.
 *   2. **One clock, observed.** Sampling every frame through a show and then a
 *      fold: the subject FRAME's own height and the sibling below it start
 *      together and END together. The plan asked for "no sibling frame's rect
 *      changes before the settle's end", and in a wall that reads wrong —
 *      opening the middle card MUST move the card beneath it. What the claim
 *      is actually about is that nothing jumps ahead: the sibling's travel
 *      window and the fold's window are the same window, and neither closes
 *      early. The observed duration carries a looser band than claim 1's
 *      because an eased curve spends its last frames sub-pixel, so a sampler
 *      reads the end a little early by construction.
 *
 *      The subject side is the frame rather than the composer because the
 *      composer has no travel left to read: it is held at its open box for
 *      the crossing's length. So the composer is sampled to assert the
 *      opposite — that its box does not move while the wall's does, which is
 *      at0563's stillness claim made in the one shape where a wrong clock
 *      would move a card belonging to somebody else.
 *   3. **The composer comes back whole.** A draft typed before the fold is
 *      still in the editor after it, and the editor has its box back — the
 *      [L26] promise the deferred terminal state exists to keep, asserted at
 *      the far end of a real motion rather than a cut.
 *   4. **A settle landing mid-fold does not land the card early.** Opening a
 *      neighbour partway through the subject's own fold retargets the
 *      settle — the running tween is cancelled and a fresh one carries the
 *      frame the rest of the way — and the crossing is the same crossing
 *      throughout. So on every frame the card reads `"settled"`, its edge is
 *      already at rest. This is the wall's own hazard: in a wall the fold's
 *      window is shared with whatever else the user is doing, and a crossing
 *      closed by the cancelled tween's own completion would put the card in
 *      its terminal form with hundreds of pixels of travel still to come.
 *
 * Only the middle card is bound, and only because claim 3 needs a composer to
 * type into — an unbound Session card has no editor to hold a draft. The two
 * neighbours stay unbound: what is under test is a clock and a stylesheet, and
 * two more engines would add nothing but two more engines.
 *
 * `@covers` names the stylesheet that IS the motion, the module that owns the
 * clock both halves read, and the module that owns the crossing claim 4 is
 * about. `session-card.tsx` (the terminal-state effect)
 * and `deck-canvas.tsx` (the settle that writes the property) are deliberately
 * NOT named: both stand at their recorded fan-out of 21, and recorded debt may
 * be paid down but never refinanced. at0551 drives the same effect's output
 * from a narrower file, which is where a break in it would surface.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.css
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/lib/fold-crossing.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const PANE_IDS = ["p1", "p2", "p3"] as const;
const CARD_IDS = ["A", "B", "C"] as const;
/** The card the fold is driven on — the middle of the wall. */
const SUBJECT = "B";
/** The middle card's session id — the one binding this file needs. */
const SID = "at0555-session";
/** The card below it, whose travel is the sibling half of claim 2. */
const NEIGHBOUR = "p3";
/** The card UNFOLDED partway through the subject's own fold, for claim 4. */
const INTERRUPTER = "A";
/** The subject card's own pane — the frame the fold's one motion rides. */
const SUBJECT_PANE = PANE_IDS[CARD_IDS.indexOf(SUBJECT)];

const CARD = `[data-card-id="${SUBJECT}"] .session-card`;
const ENTRY = `[data-card-id="${SUBJECT}"] [data-slot="session-card-entry-region"]`;
const PROMPT_INPUT = `[data-card-id="${SUBJECT}"] [data-slot="tug-text-editor"] .cm-content`;

/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;
/** How long the census samples for — a beat and a half at the default tune. */
const CENSUS_MS = 700;
/** How far into the subject's fold the interrupting fold is dispatched. */
const RETARGET_AT_MS = 120;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Three Session cards sharing slot 0 of a one-up. */
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
      slot: 0,
    })),
    activePaneId: "p1",
    imposition: { kind: "one-up" },
    hasFocus: true,
  };
}

/** Fold or show one named card, through the one write path ([P02]). */
async function setFolded(
  app: App,
  cardId: string,
  value: boolean,
): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-card-folded", { cardId: ${JSON.stringify(cardId)}, folded: ${value} }), null)`,
  );
  await wait(AFTER_LAND_MS);
}

interface Sample {
  t: number;
  /** The imposer's crossing mark on the subject's frame, `""` when absent. */
  mark: string;
  /** The subject frame's own height — the fold's one motion. */
  frame: number;
  entry: number;
  neighbour: number;
}

/**
 * Arm a per-frame sampler, flip the flag, and hand back what it saw.
 *
 * The sampler is installed BEFORE the dispatch and reads on `requestAnimation
 * Frame`, so the first sample is the pre-fold geometry and every frame of the
 * motion is in the record. The subject frame's height is the fold's own
 * extent, the neighbour pane's top is the wall's, and the composer's height is
 * read to assert that it does NOT move — the interior is laid out once at the
 * open size and clipped, so the composer has no travel of its own to compare.
 */
async function census(
  app: App,
  cardId: string,
  value: boolean,
): Promise<Sample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0555 = [];
      var entrySel = ${JSON.stringify(ENTRY)};
      var frameSel = '.tug-pane[data-pane-id="${SUBJECT_PANE}"]';
      var neighbourSel = '.tug-pane[data-pane-id="${NEIGHBOUR}"]';
      var t0 = performance.now();
      var tick = function () {
        var entry = document.querySelector(entrySel);
        var frame = document.querySelector(frameSel);
        var neighbour = document.querySelector(neighbourSel);
        window.__at0555.push({
          t: performance.now() - t0,
          mark:
            frame === null
              ? ""
              : frame.getAttribute("data-fold-crossing") || "",
          frame: frame === null ? -1 : frame.getBoundingClientRect().height,
          entry: entry === null ? -1 : entry.getBoundingClientRect().height,
          neighbour:
            neighbour === null ? -1 : neighbour.getBoundingClientRect().top,
        });
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-card-folded", { cardId: ${JSON.stringify(cardId)}, folded: ${value} }), null)`,
  );
  await wait(CENSUS_MS + 300);
  return app.evalJS<Sample[]>(`window.__at0555`);
}

/**
 * The window a sampled series moved in: first frame that left its start, last
 * frame that changed at all. `null` when nothing moved.
 */
function windowOf(
  samples: Sample[],
  pick: (s: Sample) => number,
): { start: number; end: number; travel: number } | null {
  if (samples.length < 3) return null;
  const start0 = pick(samples[0]);
  const moved = (v: number): boolean => Math.abs(v - start0) > 1;
  let start = -1;
  let end = -1;
  for (let i = 1; i < samples.length; i += 1) {
    if (start < 0 && moved(pick(samples[i]))) start = samples[i].t;
    if (Math.abs(pick(samples[i]) - pick(samples[i - 1])) > 0.5) {
      end = samples[i].t;
    }
  }
  if (start < 0 || end < 0) return null;
  return {
    start,
    end,
    travel: Math.abs(pick(samples[samples.length - 1]) - start0),
  };
}

/** The frames the crossing covered, by the imposer's own mark. */
function crossingFrames(samples: Sample[]): Sample[] {
  return samples.filter((s) => s.mark !== "");
}

/** The extent a picked series covered across the frames it was sampled in. */
function spread(frames: Sample[], pick: (s: Sample) => number): number {
  if (frames.length === 0) return 0;
  const values = frames.map(pick);
  return Math.max(...values) - Math.min(...values);
}

/** One frame of the retarget census: the subject's edge, and the card's own state. */
interface FoldSample {
  t: number;
  /** The subject frame's height — the edge that is still travelling. */
  frame: number;
  /** The subject card's `data-fold`, `""` when absent. */
  fold: string;
}

/**
 * Fold the subject, and unfold a NEIGHBOUR partway through it.
 *
 * Any deck change landing inside the fold's window retargets the settle: the
 * running tween is cancelled and a fresh one carries the frame the rest of the
 * way. What comes back is every frame of the subject's edge alongside the
 * subject card's own `data-fold`, which is what claim 4 reads the two against.
 *
 * The interruption is a neighbour UNFOLDING rather than folding, because a
 * split column runs one open Session card at a time: a neighbour folding
 * while the subject is already on its way in changes nothing about the
 * arrangement, and a neighbour opening is the gesture a reader makes next.
 */
async function retargetCensus(app: App): Promise<FoldSample[]> {
  await app.evalJS<null>(
    `(function () {
      window.__at0555r = [];
      var frameSel = '.tug-pane[data-pane-id="${SUBJECT_PANE}"]';
      var cardSel = ${JSON.stringify(CARD)};
      var t0 = performance.now();
      var tick = function () {
        var frame = document.querySelector(frameSel);
        var card = document.querySelector(cardSel);
        window.__at0555r.push({
          t: performance.now() - t0,
          frame: frame === null ? -1 : frame.getBoundingClientRect().height,
          fold: card === null ? "" : card.getAttribute("data-fold") || "",
        });
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-card-folded", { cardId: ${JSON.stringify(SUBJECT)}, folded: true }), null)`,
  );
  await wait(RETARGET_AT_MS);
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-card-folded", { cardId: ${JSON.stringify(INTERRUPTER)}, folded: false }), null)`,
  );
  await wait(CENSUS_MS + 300);
  return app.evalJS<FoldSample[]>(`window.__at0555r`);
}

describe.skipIf(!SHOULD_RUN)("AT0555: the fold's clock", () => {
  test(
    "the composer's collapse and the wall's travel are one motion, and the draft survives it",
    async () => {
      const app = await launchTugApp({ testName: "at0555-fold-motion" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: SUBJECT });
        for (const cardId of CARD_IDS) {
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(cardId)})`,
            { timeoutMs: 30_000 },
          );
        }
        await app.bindSession(SUBJECT, { tugSessionId: SID });
        await app.awaitEngineReady(SUBJECT);
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "split" }), null)`,
        );
        await wait(AFTER_LAND_MS);

        // The draft goes in while the card is open and stays there for the
        // rest of the test — the fold is what it has to survive.
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("a draft that outlives the fold");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(PROMPT_INPUT)}) || { textContent: "" }).textContent.indexOf("outlives") >= 0`,
          { timeoutMs: 8000 },
        );

        // ── 1. One clock, and the card declares none of its own ──
        const clock = await app.evalJS<{
          settleMs: number;
          timing: number;
          transitionMs: number;
        }>(
          `(function () {
            var entry = document.querySelector(${JSON.stringify(ENTRY)});
            var root = document.documentElement;
            var raw = getComputedStyle(entry)
              .getPropertyValue("--tugx-imposer-settle-duration")
              .trim();
            var settleMs = raw.endsWith("ms")
              ? parseFloat(raw)
              : raw.endsWith("s")
                ? parseFloat(raw) * 1000
                : 400;
            var timing =
              parseFloat(
                getComputedStyle(root).getPropertyValue("--tug-timing"),
              ) || 1;
            var declared = getComputedStyle(entry).transitionDuration.split(",")[0].trim();
            var transitionMs = declared.endsWith("ms")
              ? parseFloat(declared)
              : parseFloat(declared) * 1000;
            return { settleMs: settleMs, timing: timing, transitionMs: transitionMs };
          })()`,
        );
        note(
          "declared clock",
          `settle=${clock.settleMs}ms timing=${clock.timing} transition=${clock.transitionMs}ms`,
        );
        expect(
          clock.transitionMs,
          "the entry region declares no transition of its own",
        ).toBe(0);
        // The band every window below is read against: the settle's own
        // duration, scaled by the same `--tug-timing` `deck-canvas.tsx` scales
        // by. It used to be read off the entry region's `transition-duration`,
        // which was the same number by construction — and that construction is
        // what claim 1 now refuses, so the band has to come from the property
        // itself.
        const beatMs = clock.settleMs * clock.timing;

        // Fold the wall, then watch the middle card come back out of it.
        for (const cardId of CARD_IDS) await setFolded(app, cardId, true);

        // ── 2. One clock, observed — the show ──
        const show = await census(app, SUBJECT, false);
        const showFold = windowOf(show, (s) => s.frame);
        const showWall = windowOf(show, (s) => s.neighbour);
        const showComposer = spread(crossingFrames(show), (s) => s.entry);
        note(
          "show",
          `fold=${JSON.stringify(showFold)} wall=${JSON.stringify(showWall)} composer spread=${showComposer.toFixed(2)}`,
        );
        expect(showFold, "the subject frame unfolds").not.toBeNull();
        expect(showWall, "the card below travels").not.toBeNull();
        if (showFold !== null && showWall !== null) {
          // They start together: neither waits for the other, which is what
          // rules out (a)'s and (b)'s split beats.
          expect(
            Math.abs(showFold.start - showWall.start),
            "the fold and the wall start together",
          ).toBeLessThan(80);
          // And end together, within one eased tail.
          expect(
            Math.abs(showFold.end - showWall.end),
            "the fold and the wall end together",
          ).toBeLessThan(0.35 * beatMs);
          // Neither runs past the beat it declared.
          expect(
            showFold.end - showFold.start,
            "the fold does not outrun its declared beat",
          ).toBeLessThan(1.35 * beatMs);
        }
        // And the interior held still through all of it — the same claim
        // at0563 makes on a free pane, made here in the shape where a wrong
        // clock moves somebody else's card.
        expect(
          showComposer,
          "the composer's box does not move while the wall does",
        ).toBeLessThan(1.5);
        await wait(AFTER_LAND_MS);

        // The draft is back, in an editor with its box back — the deferred
        // terminal state's whole reason ([L26]).
        const shown = await app.evalJS<{ text: string; height: number; fold: string | null }>(
          `(function () {
            var input = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            var card = document.querySelector(${JSON.stringify(CARD)});
            var entry = document.querySelector(${JSON.stringify(ENTRY)});
            return {
              text: input === null ? "" : input.textContent || "",
              height: entry === null ? -1 : entry.getBoundingClientRect().height,
              fold: card === null ? null : card.getAttribute("data-fold"),
            };
          })()`,
        );
        note("after the show", `entry=${Math.round(shown.height)}px fold=${shown.fold}`);
        expect(shown.text).toContain("outlives the fold");
        expect(shown.height).toBeGreaterThan(40);
        expect(shown.fold).toBeNull();

        // ── 2b. And the same on the way in ──
        const fold = await census(app, SUBJECT, true);
        const foldEntry = windowOf(fold, (s) => s.frame);
        const foldNeighbour = windowOf(fold, (s) => s.neighbour);
        const foldComposer = spread(crossingFrames(fold), (s) => s.entry);
        note(
          "fold",
          `fold=${JSON.stringify(foldEntry)} wall=${JSON.stringify(foldNeighbour)} composer spread=${foldComposer.toFixed(2)}`,
        );
        expect(foldEntry, "the subject frame folds").not.toBeNull();
        expect(foldNeighbour, "the card below travels back").not.toBeNull();
        if (foldEntry !== null && foldNeighbour !== null) {
          expect(
            Math.abs(foldEntry.start - foldNeighbour.start),
            "the fold and the wall start together",
          ).toBeLessThan(80);
          expect(
            Math.abs(foldEntry.end - foldNeighbour.end),
            "the fold and the wall end together",
          ).toBeLessThan(0.35 * beatMs);
          expect(
            foldEntry.end - foldEntry.start,
            "the fold does not outrun its declared beat",
          ).toBeLessThan(1.35 * beatMs);
        }
        expect(
          foldComposer,
          "the composer's box does not move while the wall does",
        ).toBeLessThan(1.5);
        await wait(AFTER_LAND_MS);

        // ── 3. The draft is still there, folded away ──
        const folded = await app.evalJS<{ text: string; fold: string | null }>(
          `(function () {
            var input = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            var card = document.querySelector(${JSON.stringify(CARD)});
            return {
              text: input === null ? "" : input.textContent || "",
              fold: card === null ? null : card.getAttribute("data-fold"),
            };
          })()`,
        );
        expect(folded.text).toContain("outlives the fold");
        expect(folded.fold).toBe("settled");

        // ── 4. A settle landing mid-fold does not land the card early ──
        //
        // Any deck change inside the fold's window retargets the settle: the
        // running tween is cancelled and a fresh one carries the frame the
        // rest of the way. The crossing is the SAME crossing — the edge has
        // not stopped — so the card must not reach its terminal form until it
        // does. The cancelled tween's own completion lands after the retarget
        // and is the one thing that could close the crossing early, and a
        // crossing closed early is the whole defect this file's design exists
        // to prevent, arriving 200ms into every fold that shares its window
        // with any other deck change.
        //
        // Read as a pair rather than as a window: on every frame the card
        // says `"settled"`, its edge is already where it was going. Eight
        // pixels of slack against an edge that travels hundreds.
        await setFolded(app, SUBJECT, false);
        const retarget = await retargetCensus(app);
        const restHeight = retarget[retarget.length - 1].frame;
        const early = retarget.filter(
          (s) => s.fold === "settled" && s.frame - restHeight > 8,
        );
        note(
          "retarget",
          `samples=${retarget.length} edge=${Math.round(Math.max(...retarget.map((s) => s.frame)))}..${Math.round(restHeight)} early settled=${early.length}${early.length === 0 ? "" : ` worst=${Math.round(Math.max(...early.map((s) => s.frame)) - restHeight)}px above rest`}`,
        );
        expect(
          retarget.some((s) => s.fold === "moving"),
          "the retargeted fold is sampled mid-motion",
        ).toBe(true);
        expect(
          early.length,
          "the card does not reach its terminal form before its edge stops",
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
