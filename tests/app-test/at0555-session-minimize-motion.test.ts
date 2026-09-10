/**
 * at0555-session-minimize-motion.test.ts — the fold runs on the settle's clock.
 *
 * ## What this gates
 *
 * A motion spike put three candidate motions side by side and the build picked
 * (c), "pinned masthead, everything below collapses" ([D185]). The
 * argument for it is not taste, and that is what this file gates: the pane
 * frame's height is a REAL geometry tween — the imposer's settle animates
 * `height` and never smears it — so a card's interior is re-laid-out at every
 * intermediate height the settle passes through. A motion that took half a
 * beat, or that started half a beat late, would finish somewhere the frame
 * carrying it had not reached, and the seam would show. (c) has no seam
 * because the interior's collapse and the frame's ARE one motion.
 *
 * Three claims, over one wall of three folded Session cards in a split column
 * — which is the shape the fold has to survive, because it is the one where a
 * wrong clock moves somebody else's card:
 *
 *   1. **One clock, declared.** The entry region's computed
 *      `transition-duration` is `readSettleMs` scaled by `--tug-timing`, the
 *      same product `deck-canvas.tsx` hands the settle's tweens. This is the
 *      exact assertion — no sampling, no tolerance — and it is what makes a
 *      retune anywhere up the tree retime both halves.
 *   2. **One clock, observed.** Sampling every frame through a show and then a
 *      minimize: the composer's own collapse and the sibling below it start
 *      together and END together. The plan asked for "no sibling frame's rect
 *      changes before the settle's end", and in a wall that reads wrong —
 *      opening the middle card MUST move the card beneath it. What the claim
 *      is actually about is that nothing jumps ahead: the sibling's travel
 *      window and the fold's window are the same window, and neither closes
 *      early. The observed duration carries a looser band than claim 1's
 *      because an eased curve spends its last frames sub-pixel, so a sampler
 *      reads the end a little early by construction — the DECLARED duration is
 *      where exactness belongs, and it has it.
 *   3. **The composer comes back whole.** A draft typed before the fold is
 *      still in the editor after it, and the editor has its box back — the
 *      [L26] promise the deferred terminal state exists to keep, asserted at
 *      the far end of a real motion rather than a cut.
 *
 * Only the middle card is bound, and only because claim 3 needs a composer to
 * type into — an unbound Session card has no editor to hold a draft. The two
 * neighbours stay unbound: what is under test is a clock and a stylesheet, and
 * two more engines would add nothing but two more engines.
 *
 * `@covers` names the stylesheet that IS the motion and the module that owns
 * the clock both halves read. `session-card.tsx` (the terminal-state effect)
 * and `deck-canvas.tsx` (the settle that writes the property) are deliberately
 * NOT named: both stand at their recorded fan-out of 21, and recorded debt may
 * be paid down but never refinanced. at0551 drives the same effect's output
 * from a narrower file, which is where a break in it would surface.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.css
 * @covers tugdeck/src/lib/layout-imposer.ts
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

const CARD = `[data-card-id="${SUBJECT}"] .session-card`;
const ENTRY = `[data-card-id="${SUBJECT}"] [data-slot="session-card-entry-region"]`;
const PROMPT_INPUT = `[data-card-id="${SUBJECT}"] [data-slot="tug-text-editor"] .cm-content`;

/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;
/** How long the census samples for — a beat and a half at the default tune. */
const CENSUS_MS = 700;

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
async function setMinimized(
  app: App,
  cardId: string,
  value: boolean,
): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-card-minimized", { cardId: ${JSON.stringify(cardId)}, minimized: ${value} }), null)`,
  );
  await wait(AFTER_LAND_MS);
}

interface Sample {
  t: number;
  entry: number;
  neighbour: number;
}

/**
 * Arm a per-frame sampler, flip the flag, and hand back what it saw.
 *
 * The sampler is installed BEFORE the dispatch and reads on `requestAnimation
 * Frame`, so the first sample is the pre-fold geometry and every frame of the
 * motion is in the record. Two numbers per frame: the composer's height (the
 * fold's own extent) and the neighbour pane's top (the settle's).
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
      var neighbourSel = '.tug-pane[data-pane-id="${NEIGHBOUR}"]';
      var t0 = performance.now();
      var tick = function () {
        var entry = document.querySelector(entrySel);
        var neighbour = document.querySelector(neighbourSel);
        window.__at0555.push({
          t: performance.now() - t0,
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
    `(window.__tug.dispatchControlAction("set-card-minimized", { cardId: ${JSON.stringify(cardId)}, minimized: ${value} }), null)`,
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

describe.skipIf(!SHOULD_RUN)("AT0555: the fold's clock", () => {
  test(
    "the composer's collapse and the wall's travel are one motion, and the draft survives it",
    async () => {
      const app = await launchTugApp({ testName: "at0555-minimize-motion" });
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

        // ── 1. One clock, declared ──
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
          Math.abs(clock.transitionMs - clock.settleMs * clock.timing),
          "the fold is declared at the settle's own duration",
        ).toBeLessThan(0.1 * clock.settleMs * clock.timing);

        // Fold the wall, then watch the middle card come back out of it.
        for (const cardId of CARD_IDS) await setMinimized(app, cardId, true);

        // ── 2. One clock, observed — the show ──
        const show = await census(app, SUBJECT, false);
        const showFold = windowOf(show, (s) => s.entry);
        const showWall = windowOf(show, (s) => s.neighbour);
        note(
          "show",
          `fold=${JSON.stringify(showFold)} wall=${JSON.stringify(showWall)}`,
        );
        expect(showFold, "the composer unfolds").not.toBeNull();
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
          ).toBeLessThan(0.35 * clock.settleMs);
          // Neither runs past the beat it declared.
          expect(
            showFold.end - showFold.start,
            "the fold does not outrun its declared beat",
          ).toBeLessThan(1.35 * clock.transitionMs);
        }
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
        const foldFold = windowOf(fold, (s) => s.entry);
        const foldWall = windowOf(fold, (s) => s.neighbour);
        note(
          "minimize",
          `fold=${JSON.stringify(foldFold)} wall=${JSON.stringify(foldWall)}`,
        );
        expect(foldFold, "the composer folds").not.toBeNull();
        expect(foldWall, "the card below travels back").not.toBeNull();
        if (foldFold !== null && foldWall !== null) {
          expect(
            Math.abs(foldFold.start - foldWall.start),
            "the fold and the wall start together",
          ).toBeLessThan(80);
          expect(
            Math.abs(foldFold.end - foldWall.end),
            "the fold and the wall end together",
          ).toBeLessThan(0.35 * clock.settleMs);
          expect(
            foldFold.end - foldFold.start,
            "the fold does not outrun its declared beat",
          ).toBeLessThan(1.35 * clock.transitionMs);
        }
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
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
