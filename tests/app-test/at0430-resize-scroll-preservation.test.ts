/**
 * at0430-resize-scroll-preservation.test.ts — changing a card's width never
 * moves what the reader is looking at.
 *
 * The scroller survives a width change intact, and that is the whole problem:
 * `scrollTop` is faithfully preserved while the content it names re-wraps out
 * from under it. WebKit implements no CSS scroll anchoring, so before the
 * resize episode a bullseye toggle on a scrolled-up transcript left the reader
 * somewhere else in the document with nothing in the DOM to show for it.
 *
 * The invariant asserted here is the top edge: whatever row was at the
 * scroller's top edge is at the same offset from the top edge afterwards. Not
 * `scrollTop` — `scrollTop` is *expected* to move, and the diagnostics note how
 * far, because a case where it did not move proves nothing about anchoring.
 *
 * What each assertion is chosen to catch:
 *
 *  1. **The episode actually ran.** A `MutationObserver` on the frame's
 *     `data-resize-episode` stamp records every episode raised during the run,
 *     and each gesture is asserted to have raised one. Without it a card whose
 *     content happens not to reflow at that width passes every position
 *     assertion while the mechanism is dead, which is the exact shape of the
 *     bug this feature exists to fix.
 *  2. **Every raise site, not one.** The width popup and bullseye come in
 *     through the FLIP settle; the west-edge drag comes in at pointer-down and
 *     lives across a gesture the settle never sees; the deck-wide Card Width
 *     bypasses `movePane` entirely. Three doors, three different lifetimes.
 *  3. **Follow-bottom is not an anchor.** A transcript pinned to the bottom
 *     must still be pinned after the width change — an implementation that
 *     captured a top-edge anchor unconditionally would freeze it mid-document
 *     and quietly break the live-tail case, which is the state most transcripts
 *     spend most of their life in.
 *  4. **The displacement tripwire.** `data-scroll-displacements` counts
 *     `scrollTop` moves the list view could not account for. The episode writes
 *     `scrollTop` deliberately and repeatedly; if those writes are not
 *     attributed through SmartScroll the counter climbs, follow-bottom starts
 *     mistaking the machine's own corrections for the user scrolling, and the
 *     damage shows up far from here. Read before and after, asserted equal.
 *  5. **The generic fallback on a plain-flow card.** A card that never took
 *     over its own scrolling owns no anchor semantics and never claims the
 *     episode, so it is held by the module's own element anchor in the PANE's
 *     content box — a different code path from the transcript's resolver, and
 *     the one every future card inherits by default.
 *  6. **The document substrate, in its own unit.** A CodeMirror view claims
 *     the episode and holds the character under the top edge. Its assertion is
 *     WHICH LINE stands at the top rather than a pixel, because soft wrap
 *     means holding the top edge is exactly what makes the text beneath it
 *     move.
 *  7. **The PDF, where an element anchor is the wrong answer.** Its layout is
 *     derived from a scale that IS the card's width, so a page's top edge is
 *     not a fixed point. The assertion is the page and the fraction of the way
 *     down it — the two quantities a re-scale leaves alone.
 *
 * What this fixture deliberately does not prove:
 *
 *  - **Intermediate tween frames.** Background app-test windows run no rAF and
 *     an assertion hung on mid-flight motion is banned by the harness doctrine.
 *     Every measurement here is taken after the episode's stamp has cleared.
 *  - **`TugMarkdownView`.** It ships in the gallery only, and it claims
 *     nothing: the episode's own anchor descends past its aria-hidden spacers
 *     to the block under the top edge, which is the anchor a bespoke handler
 *     would have computed. The descent itself is pinned by the transcript and
 *     plain-flow cases here.
 *  - **A drag's resulting geometry.** The drag applies its width from a rAF
 *     loop, and a background app-test window suspends rAF, so the pane cannot
 *     actually move here. That door asserts its raise instead.
 *
 * @covers tugdeck/src/lib/resize-episode.ts
 * @covers tugdeck/src/lib/cm6-scroll-anchor.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/cards/pdf-view.tsx
 * @covers tugdeck/src/lib/pdf-layout.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { chooseWidth } from "./fixtures/card-width";
import { encodePdf } from "./fixtures/pdf";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import {
  openFixtureSession,
  SCROLLER,
  waitForTranscriptSettled,
} from "./fixtures/runner";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The pane `fixtures/runner`'s deck shape puts the session card in. */
const FRAME = '.tug-pane[data-pane-id="p1"]';

/**
 * How far the anchored row's top edge may sit from where it was.
 *
 * The anchor resolves through measured row heights that the width change has
 * just invalidated and re-measured, so the arithmetic runs on sub-pixel box
 * heights rounded at two different widths. `at0190` allows the same 2px for the
 * same reason on the cold-boot path. The failure this guards against is not a
 * pixel — it is tens or hundreds of them.
 */
const ANCHOR_TOLERANCE_PX = 2;

/**
 * The same bound for a soft-wrapped CodeMirror document, where the unit is a
 * wrapped row rather than a pixel: narrowing the card adds rows to the line
 * under the top edge, so how far into that line the viewport sits can only be
 * held to the row the re-wrap created.
 */
const WRAPPED_ROW_TOLERANCE_PX = 24;

/** The settle window (`IMPOSITION_SETTLE_MS`) with room for the tween. */
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * One gallery card in a pane short enough that its content overflows the
 * PANE's own content box — the scroller a card that never took over its
 * scrolling gets by default. Seeded wide, so narrowing it to slim is a real
 * reflow rather than a nudge.
 */
function galleryDeck(): Record<string, unknown> {
  return {
    cards: [
      {
        id: "A",
        componentId: "gallery-accordion",
        title: "Accordion",
        closable: true,
      },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 1100, height: 420 },
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

/** One Text card, seeded wide so narrowing it to slim is a real re-wrap. */
function textDeck(): Record<string, unknown> {
  return {
    cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 1100, height: 560 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** A row at the scroller's top edge, and how far its top sits from that edge. */
interface Anchor {
  /** The list view's absolute data-source index — stable across a re-render. */
  index: string;
  /** The row's top edge measured from the scroller's viewport top. Negative when partly scrolled past. */
  delta: number;
  scrollTop: number;
}

/**
 * Record every episode the frame raises, so a gesture that raised none is
 * distinguishable from one that raised one and did nothing.
 */
async function armEpisodeWatch(app: App, frame: string): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var frame = document.querySelector(${JSON.stringify(frame)});
      if (frame === null) throw new Error("frame not found: " + ${JSON.stringify(frame)});
      window.__at0430 = { seen: [] };
      var mo = new MutationObserver(function () {
        var v = frame.getAttribute("data-resize-episode");
        if (v !== null && window.__at0430.seen.indexOf(v) === -1) {
          window.__at0430.seen.push(v);
        }
      });
      mo.observe(frame, { attributes: true, attributeFilter: ["data-resize-episode"] });
      return null;
    })()`,
  );
}

const episodeCount = (app: App): Promise<number> =>
  app.evalJS<number>(`window.__at0430.seen.length`);

/** Wait until no episode is open on the frame, then let the settle finish. */
async function waitForEpisodesClosed(app: App, frame: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(frame)}).getAttribute("data-resize-episode") === null`,
    { timeoutMs: 10_000 },
  );
  await wait(AFTER_LAND_MS);
}

/**
 * Claim the first paragraph-ish box fully inside the viewport as the subject,
 * and remember it on `window` so the same node is re-measured afterwards.
 *
 * The subject is chosen the way a reader would point at one — the first whole
 * block below the top edge — and deliberately NOT the way the implementation
 * chooses its anchor, so the assertion is a claim about the document rather
 * than a restatement of the mechanism. A block's top edge moves only when
 * content ABOVE it changes height, which is exactly the displacement the
 * episode exists to absorb.
 */
async function claimSubject(app: App, scroller: string): Promise<Anchor> {
  const anchor = await app.evalJS<Anchor | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(scroller)});
      if (el === null) return null;
      var top = el.getBoundingClientRect().top;
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
      var node = walker.nextNode();
      while (node !== null) {
        var r = node.getBoundingClientRect();
        if (r.top >= top && r.height > 4 && r.height < el.clientHeight && node.childElementCount === 0) {
          window.__at0430subject = node;
          var cell = node.closest("[data-tug-list-cell-index]");
          return {
            index: cell === null ? "?" : cell.getAttribute("data-tug-list-cell-index"),
            delta: Math.round(r.top - top),
            scrollTop: Math.round(el.scrollTop),
          };
        }
        node = walker.nextNode();
      }
      return null;
    })()`,
  );
  if (anchor === null) throw new Error(`no anchorable block in "${scroller}"`);
  return anchor;
}

/** Where the claimed subject sits now, or null if it has left the document. */
async function readSubject(
  app: App,
  scroller: string,
): Promise<{ delta: number; scrollTop: number } | null> {
  return app.evalJS<{ delta: number; scrollTop: number } | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(scroller)});
      var node = window.__at0430subject;
      if (el === null || node === undefined || !el.contains(node)) return null;
      return {
        delta: Math.round(node.getBoundingClientRect().top - el.getBoundingClientRect().top),
        scrollTop: Math.round(el.scrollTop),
      };
    })()`,
  );
}

const paneWidth = (app: App, frame: string): Promise<number> =>
  app.evalJS<number>(
    `Math.round(document.querySelector(${JSON.stringify(frame)}).getBoundingClientRect().width)`,
  );

const displacements = (app: App, scroller: string): Promise<number> =>
  app.evalJS<number>(
    `Number(document.querySelector(${JSON.stringify(scroller)}).getAttribute("data-scroll-displacements"))`,
  );

const isAtBottom = (app: App, scroller: string): Promise<boolean> =>
  app.evalJS<boolean>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(scroller)});
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    })()`,
  );

describe.skipIf(!SHOULD_RUN)(
  "at0430 — a width change never moves what the reader is looking at",
  () => {
    test(
      "a virtualized transcript holds its anchored row through every width door",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const seeded = await seedFixtureSession(
          "session-transcript-basic",
          "at0430",
        );
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.dev",
          "recent-projects",
          "json",
          JSON.stringify({ paths: [seeded.projectDir] }),
        );

        const app = await launchTugApp({
          testName: "at0430-transcript",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
        });
        try {
          await openFixtureSession(app, seeded);
          await waitForTranscriptSettled(app);
          await armEpisodeWatch(app, FRAME);

          const displacementsBefore = await displacements(app, SCROLLER);

          // Wheel-up disengages follow-bottom, then land at ~40% of the range:
          // a mid anchor with document above and below it, so a width change
          // can move the position in either direction.
          await app.evalJS<number>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(SCROLLER)});
              el.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true, cancelable: true }));
              el.scrollTop = Math.max(0, Math.floor((el.scrollHeight - el.clientHeight) * 0.4));
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return el.scrollTop;
            })()`,
          );
          await wait(400);

          /**
           * Run one width gesture and assert the anchored row did not move.
           * The anchor is re-read before each gesture rather than carried
           * across all of them: each door is a separate claim, and a chain
           * that drifted a pixel per door would otherwise read as one failure
           * at the end instead of at the door that caused it.
           */
          const holdsThrough = async (
            label: string,
            gesture: () => Promise<void>,
          ): Promise<void> => {
            const before = await claimSubject(app, SCROLLER);
            const widthBefore = await paneWidth(app, FRAME);
            const episodesBefore = await episodeCount(app);

            await gesture();
            await waitForEpisodesClosed(app, FRAME);

            const widthAfter = await paneWidth(app, FRAME);
            expect(widthAfter).not.toBe(widthBefore);
            // The mechanism ran. Without this the position assertion below is
            // satisfied by content that simply did not reflow.
            expect(await episodeCount(app)).toBeGreaterThan(episodesBefore);

            const after = await readSubject(app, SCROLLER);
            expect(after).not.toBeNull();
            note(
              `${label}: width ${widthBefore}→${widthAfter}, subject in row ${before.index}` +
                ` delta ${before.delta}→${after!.delta},` +
                ` scrollTop ${before.scrollTop}→${after!.scrollTop}`,
            );
            expect(Math.abs(after!.delta - before.delta)).toBeLessThanOrEqual(
              ANCHOR_TOLERANCE_PX,
            );
          };

          // ── Door 1: the width popup, through the FLIP settle. ────────────
          await holdsThrough("wide", async () => {
            await chooseWidth(app, "p1", "wide");
          });

          // ── Door 2: bullseye in, a 400-odd pixel narrowing. ──────────────
          await holdsThrough("bullseye on", async () => {
            await app.nativeKey("b", ["ctrl", "cmd"]);
          });

          // ── Door 3: bullseye out, the same distance back. ────────────────
          await holdsThrough("bullseye off", async () => {
            await app.nativeKey("b", ["ctrl", "cmd"]);
          });

          // ── Door 4: the popup again, the other way. ──────────────────────
          await holdsThrough("slim", async () => {
            await chooseWidth(app, "p1", "slim");
          });

          // ── Door 5: a west-edge drag — the gesture the settle never sees. ─
          // The episode is raised at pointer-down and lives across the whole
          // drag, so this is the one door whose lifetime is bounded by the
          // user's hand rather than by an animation.
          //
          // Only the raise is asserted. The drag applies its geometry from a
          // rAF loop and a background app-test window suspends rAF entirely,
          // so the width cannot move here and the position claim the other
          // four doors make would have nothing to bite on. What this door
          // contributes is the pointer-down raise — the episode must open
          // while the pre-gesture layout is still on screen, not at the move
          // latch — and that is what fails if the call is removed.
          const beforeDrag = await claimSubject(app, SCROLLER);
          const episodesBeforeDrag = await episodeCount(app);
          const handle = await app.evalJS<{ x: number; y: number }>(
            `(function () {
              var h = document.querySelector(${JSON.stringify(`${FRAME} .tug-pane-resize-w`)});
              if (h === null) throw new Error("west resize handle not found");
              var r = h.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()`,
          );
          // Rightward narrows the pane from its west edge, which keeps the
          // drag inside the canvas wherever the pane happens to sit.
          await app.nativeDrag(handle, { x: handle.x + 180, y: handle.y });
          await waitForEpisodesClosed(app, FRAME);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBeforeDrag);
          // And a gesture that changed no geometry left the reader alone.
          const afterDrag = await readSubject(app, SCROLLER);
          expect(afterDrag).not.toBeNull();
          note(`west-edge drag: subject delta ${beforeDrag.delta}→${afterDrag!.delta}`);
          expect(
            Math.abs(afterDrag!.delta - beforeDrag.delta),
          ).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);

          // ── Follow-bottom is not an anchor. ──────────────────────────────
          // A transcript riding the tail must still be riding it afterwards.
          await app.evalJS<null>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(SCROLLER)});
              el.scrollTop = el.scrollHeight;
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return null;
            })()`,
          );
          await wait(600);
          expect(await isAtBottom(app, SCROLLER)).toBe(true);

          const episodesBeforeTail = await episodeCount(app);
          await chooseWidth(app, "p1", "wide");
          await waitForEpisodesClosed(app, FRAME);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBeforeTail);
          expect(await isAtBottom(app, SCROLLER)).toBe(true);

          // ── The tripwire. ────────────────────────────────────────────────
          // Every `scrollTop` the episode wrote was attributed; nothing in
          // this run looked to the list view like an unexplained move.
          const displacementsAfter = await displacements(app, SCROLLER);
          note(`displacements ${displacementsBefore} → ${displacementsAfter}`);
          expect(displacementsAfter).toBe(displacementsBefore);
        } finally {
          await app.close();
          seeded.cleanup();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a plain-flow card is held by the generic element anchor",
      async () => {
        // A card that never took over its own scrolling scrolls in the PANE's
        // content box, owns no anchor semantics, and never claims the episode
        // — so the module's own element anchor holds it. That is the path
        // every card inherits without writing a line of code, and it is what
        // lets the invariant be stated for cards of all types rather than for
        // the ones that opted in.
        //
        // The gesture is the deck-wide Card Width, a third raise site and the
        // one that bypasses `movePane` entirely.
        const app = await launchTugApp({ testName: "at0430-plain-flow" });
        try {
          await app.seedDeckState({ state: galleryDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 1`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          const scroller = `${FRAME} .tug-pane-content`;
          await app.waitForCondition<boolean>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(scroller)});
              return el !== null && el.scrollHeight > el.clientHeight + 200;
            })()`,
            { timeoutMs: 10_000 },
          );
          await armEpisodeWatch(app, FRAME);

          await app.evalJS<null>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(scroller)});
              el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * 0.4);
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return null;
            })()`,
          );
          await wait(300);

          const before = await claimSubject(app, scroller);
          const widthBefore = await paneWidth(app, FRAME);
          const episodesBefore = await episodeCount(app);

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-content-width", { preset: "slim" }), null)`,
          );
          await waitForEpisodesClosed(app, FRAME);

          const widthAfter = await paneWidth(app, FRAME);
          expect(widthAfter).not.toBe(widthBefore);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBefore);

          const after = await readSubject(app, scroller);
          expect(after).not.toBeNull();
          note(
            `plain flow: width ${widthBefore}→${widthAfter},` +
              ` subject delta ${before.delta}→${after!.delta},` +
              ` scrollTop ${before.scrollTop}→${after!.scrollTop}`,
          );
          expect(Math.abs(after!.delta - before.delta)).toBeLessThanOrEqual(
            ANCHOR_TOLERANCE_PX,
          );
          // Stated separately because it is the failure this leg actually
          // caught: a scroller the module could find no anchor element for
          // used to resolve to the TOP, so "we could not find your place"
          // was answered by throwing the reader back to the beginning of the
          // document — worse than the drift the module exists to prevent, and
          // invisible to a delta-only assertion on content that happens to
          // reflow. Zero is not a preserved position.
          expect(after!.scrollTop).toBeGreaterThan(0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a CodeMirror document holds its viewport-top line",
      async () => {
        // The CM6 substrate claims the episode with an anchor of its own, in
        // the unit that survives a re-wrap: the line. The file is long, soft
        // wrapped, and made of lines far wider than the card, so narrowing it
        // genuinely re-flows the document rather than nudging it.
        const dir = mkdtempSync(join(tmpdir(), "at0430-"));
        const file = join(dir, "wrap.txt");
        writeFileSync(
          file,
          Array.from(
            { length: 300 },
            (_unused, i) =>
              `line ${i}: ` + "the quick brown fox jumps over the lazy dog. ".repeat(6),
          ).join("\n") + "\n",
          "utf8",
        );

        const app = await launchTugApp({ testName: "at0430-text-card" });
        try {
          await app.seedDeckState({
            state: textDeck(),
            cardStates: {
              A: { content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            },
            focusCardId: "A",
          });
          const editor = `${FRAME} [data-slot="tug-text-card-editor"] .cm-scroller`;
          await app.waitForCondition<boolean>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(editor)});
              return el !== null && el.scrollHeight > el.clientHeight + 200;
            })()`,
            { timeoutMs: 15_000 },
          );
          await wait(AFTER_LAND_MS);
          await armEpisodeWatch(app, FRAME);

          await app.evalJS<null>(
            `(function () {
              var el = document.querySelector(${JSON.stringify(editor)});
              el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * 0.4);
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return null;
            })()`,
          );
          await wait(400);

          // The claim is measured on the document's own unit, read straight
          // from the DOM: WHICH LINE stands at the viewport top.
          //
          // The pixel form the other cases use does not transfer here, and
          // the reason is soft wrap. Narrowing the card makes the line under
          // the top edge taller by a row or more, so every block below it
          // moves down by that much no matter how exactly the reader's place
          // is kept — holding the top edge is precisely what makes the text
          // beneath it shift. What must not change is the line the reader is
          // looking at, and how far into it they are, to within the row the
          // re-wrap added.
          const topLineJS = `(function () {
            var el = document.querySelector(${JSON.stringify(editor)});
            var top = el.getBoundingClientRect().top;
            var lines = el.querySelectorAll(".cm-line");
            for (var i = 0; i < lines.length; i++) {
              var r = lines[i].getBoundingClientRect();
              if (r.bottom > top + 1) {
                return {
                  text: (lines[i].textContent || "").slice(0, 40),
                  delta: Math.round(r.top - top),
                  scrollTop: Math.round(el.scrollTop),
                };
              }
            }
            return null;
          })()`;
          const before = await app.evalJS<{
            text: string;
            delta: number;
            scrollTop: number;
          }>(topLineJS);
          const widthBefore = await paneWidth(app, FRAME);
          const episodesBefore = await episodeCount(app);

          await chooseWidth(app, "p1", "slim");
          await waitForEpisodesClosed(app, FRAME);

          const widthAfter = await paneWidth(app, FRAME);
          expect(widthAfter).not.toBe(widthBefore);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBefore);

          const after = await app.evalJS<{
            text: string;
            delta: number;
            scrollTop: number;
          }>(topLineJS);
          note(
            `text card: width ${widthBefore}→${widthAfter},` +
              ` top line "${before.text.slice(0, 12)}"→"${after.text.slice(0, 12)}",` +
              ` delta ${before.delta}→${after.delta},` +
              ` scrollTop ${before.scrollTop}→${after.scrollTop}`,
          );
          // The same line, still at the top. Unanchored this lands hundreds
          // of lines away, so the string compare is the sharp end of the
          // assertion and the pixel bound below is the fine adjustment.
          expect(after.text).toBe(before.text);
          expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(
            WRAPPED_ROW_TOLERANCE_PX,
          );
          // Narrowing a soft-wrapped document makes it taller, so holding the
          // same place means `scrollTop` MOVED. A number that did not move is
          // a document that did not re-wrap, and this case would be proving
          // nothing at all.
          expect(after.scrollTop).not.toBe(before.scrollTop);
        } finally {
          await app.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a PDF holds its page and how far down it the reader is",
      async () => {
        // The PDF surface is the one place where holding an element's top edge
        // is the WRONG answer. Every number in its layout comes from a scale,
        // and under fit-width the scale is the card's width — narrowing the
        // card renders every page smaller, so a page's top edge is not a fixed
        // point and the reader slides up it. The page and the fraction of the
        // way down it are what survive, and that is what this asserts.
        const dir = mkdtempSync(join(tmpdir(), "at0430-pdf-"));
        const file = join(dir, "twelve-pages.pdf");
        writeFileSync(file, encodePdf(12));

        const app = await launchTugApp({
          testName: "at0430-pdf",
          skipAccessibilityPreflight: true,
        });
        try {
          await app.dispatchControlAction("open-file", { path: file });
          const surface = '[data-slot="file-view-pdf"]';
          await app.waitForCondition<boolean>(
            `document.querySelector('${surface} [data-pdf-page-status="rendered"]') !== null`,
            { timeoutMs: 30_000 },
          );
          await wait(AFTER_LAND_MS);

          const pdfFrame = await app.evalJS<string>(
            `(function () {
              var pane = document.querySelector('${surface}').closest(".tug-pane");
              if (pane === null) throw new Error("the PDF is not in a pane");
              return '.tug-pane[data-pane-id="' + pane.getAttribute("data-pane-id") + '"]';
            })()`,
          );
          await armEpisodeWatch(app, pdfFrame);

          // A third of the way down a page well into the document, so both
          // the page number and the fraction are non-trivial.
          const placeJS = `(function () {
            var el = document.querySelector('${surface}');
            var top = el.getBoundingClientRect().top;
            var pages = el.querySelectorAll('[data-slot="pdf-page"]');
            for (var i = 0; i < pages.length; i++) {
              var r = pages[i].getBoundingClientRect();
              if (r.bottom > top + 1) {
                return {
                  page: Number(pages[i].dataset.pdfPage),
                  fraction: (top - r.top) / r.height,
                  scrollTop: Math.round(el.scrollTop),
                };
              }
            }
            return null;
          })()`;
          await app.evalJS<null>(
            `(function () {
              var el = document.querySelector('${surface}');
              el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * 0.35);
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return null;
            })()`,
          );
          await wait(500);

          const before = await app.evalJS<{
            page: number;
            fraction: number;
            scrollTop: number;
          }>(placeJS);
          const widthBefore = await paneWidth(app, pdfFrame);
          const episodesBefore = await episodeCount(app);

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-content-width", { preset: "slim" }), null)`,
          );
          await waitForEpisodesClosed(app, pdfFrame);

          const widthAfter = await paneWidth(app, pdfFrame);
          expect(widthAfter).not.toBe(widthBefore);
          expect(await episodeCount(app)).toBeGreaterThan(episodesBefore);

          const after = await app.evalJS<{
            page: number;
            fraction: number;
            scrollTop: number;
          }>(placeJS);
          note(
            `pdf: width ${widthBefore}→${widthAfter},` +
              ` page ${before.page}→${after.page},` +
              ` fraction ${before.fraction.toFixed(3)}→${after.fraction.toFixed(3)},` +
              ` scrollTop ${before.scrollTop}→${after.scrollTop}`,
          );
          expect(after.page).toBe(before.page);
          // A page's own height scales with the card, so the fraction is the
          // scale-free statement of the reader's place — a hundredth of a
          // page is under a millimetre of paper.
          expect(Math.abs(after.fraction - before.fraction)).toBeLessThanOrEqual(
            0.01,
          );
        } finally {
          await app.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
