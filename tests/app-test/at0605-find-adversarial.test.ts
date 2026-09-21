/**
 * at0605-find-adversarial.test.ts — the four ways find is actually used
 * that its machinery was never built for.
 *
 * ## Why this exists
 *
 * Each case here names one structural defect the brief found by reading the
 * code, in the smallest gesture that reaches it. Each description says what
 * the defect was and what stands in its place, because a test whose header
 * describes code that no longer exists is worse than one with no header.
 *
 *  **(a) Ten unawaited ⌘G presses.** The reveal WAS a
 *  `requestAnimationFrame` chain guarded by one shared boolean, so a second
 *  gesture arriving while the first was in flight did not supersede it —
 *  both loops ran, both wrote the scroller, and whichever finished last won.
 *  A user leaning on ⌘G is the ordinary way to produce that. It is now
 *  `TugListView.revealRange`, one live reveal per list view, and a new one
 *  settles the old as `superseded`. The assertion is only that the viewport
 *  and the chip agree at the end.
 *
 *  **(b) A hand scroll mid-reveal.** Nothing in the old reveal loop yielded
 *  to a user gesture: it kept nudging the scroller until the match was in
 *  its band or its budget ran out, and a user who took the scroller back was
 *  pulled off what they were reading. The scroll-intent doctrine says no
 *  deferred scroll write survives a user gesture; this is that rule, in a
 *  test, and the reveal now settles `cancelled` rather than fighting. Note
 *  the mover is a raw `scrollTop` write, not a `SmartScroll` call: the
 *  event-silent native scrollbar never raises `isUserScrolling`, which is
 *  exactly why a drift check is needed rather than a flag read.
 *
 *  **(c) A second card streaming while the first searches.** `CSS.highlights`
 *  names are document-GLOBAL and each Session card used to `delete` them, so
 *  a card that was not even searching erased the searching card's paint the
 *  moment it repainted. Thirty streamed frames into card `B` is what a live
 *  turn looks like. The two highlight objects are now registered once and
 *  shared, and a painter retracts only the ranges it added.
 *
 *  **(d) Typing the query one character at a time.** Every new query used to
 *  land on match 0 — the top of the document — which made the longest
 *  possible jump the default, and made a user reading mid-transcript watch
 *  the view fly to the top on the first keystroke. A search now anchors to
 *  where the user is; the assertion is the observable half of that, in both
 *  cards.
 *
 *  **(e) `revealRange` itself, with no find in sight.** The list view's own
 *  reveal is a machine with a deadline, a write budget, a supersede rule and
 *  a cancellation rule, and it lands here before any product code drives it.
 *  A machine like that has to be exercised while it is still the only thing
 *  in the frame — once the transcript host is on top of it, a red says
 *  "find is broken" and names nothing. The door is the list-view probe
 *  rather than the imperative handle, for the reason the probe registry's
 *  own docstring gives: nothing in the app drives these.
 *
 * ## Expected state
 *
 * Green, all five. (a)–(d) were red when written and each went green at the
 * step that fixed the defect it names; (e) was green from the step that
 * wrote it. A red here now is a regression in the reveal machine, the
 * shared highlights, or the anchored landing — the description of each case
 * says which.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/transcript-find-highlighter.ts
 * @covers tugdeck/src/lib/transcript-find-engine.ts
 * @covers tugdeck/src/lib/find-session.ts
 * @covers tugdeck/src/lib/find-trace.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-find-bar.tsx
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note, type App } from "./_harness";
import {
  SCROLLER,
  awaitRevealTerminal,
  chord,
  framer,
  markTrace,
  openFindBar,
  readChip,
  readReveal,
  sampleReveal,
  sessionDeckShape,
  sessionSelectors,
  standUpSession,
  tail,
  traceSince,
} from "./find-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const SEL = sessionSelectors("A");
const PROBE = "cobaltmarker";
const TURNS = 60;

function replyText(n: number): string {
  return [
    `## step ${n}`,
    "",
    `Reply number ${n} carries the ${PROBE} once, in prose long enough that`,
    "the row occupies real height and the transcript grows past a viewport.",
    "",
    `- line ${n}`,
  ].join("\n");
}

async function seedTurns(
  app: App,
  cardId: string,
  sid: string,
  turns: number,
): Promise<void> {
  const frame = framer(app, cardId, sid);
  for (let n = 0; n < turns; n += 1) {
    const msgId = `${sid}-m${n}`;
    await app.driveSession(cardId, { op: "send", text: `prompt ${n}` });
    await frame({ type: "prompt_anchor", promptUuid: `${sid}-u${n}` });
    await frame({ type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" });
    await frame({
      type: "assistant_text",
      msg_id: msgId,
      block_index: 0,
      text: replyText(n),
      is_partial: false,
    });
    await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
  }
}

async function standUpWalkable(app: App, sid: string): Promise<void> {
  await standUpSession(app, "A", sid, sessionDeckShape(["A"]));
  await seedTurns(app, "A", sid, TURNS);
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').length > 4`,
    { timeoutMs: 60_000 },
  );
  await new Promise((r) => setTimeout(r, 1200));
}

async function searchFor(app: App, probe: string): Promise<void> {
  await openFindBar(app);
  await app.nativeType(probe);
  await app.waitForCondition<boolean>(
    `(document.querySelector(${JSON.stringify(SEL.chip)})?.textContent || "") !== ""`,
    { timeoutMs: 20_000 },
  );
  await new Promise((r) => setTimeout(r, 1500));
}

// ---------------------------------------------------------------------------
// (a) Ten unawaited ⌘G presses
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("AT0605a: a burst of ⌘G ends somewhere coherent", () => {
  test(
    "ten presses with nothing awaited between them leave the viewport and the chip agreeing",
    async () => {
      const app = await launchTugApp({ testName: "at0605a-find-burst" });
      try {
        await standUpWalkable(app, "c7c0d1ea-0000-4000-8000-000000000605");
        await searchFor(app, PROBE);
        const total = Number((await readChip(app)).split(" of ")[1] ?? "0");
        expect(total, "there must be a match set to walk").toBeGreaterThan(10);

        const mark = await markTrace(app);
        // Ten presses, nothing awaited between the dispatches — the shape a
        // user leaning on the key produces.
        const bursts: Array<Promise<void>> = [];
        for (let i = 0; i < 10; i += 1) bursts.push(chord(app, "KeyG", "g", { meta: true }));
        await Promise.all(bursts);

        const terminal = await awaitRevealTerminal(app, mark, 20_000);
        note(`burst terminal event: ${JSON.stringify(terminal)}`);
        const samples = await sampleReveal(app, 800);
        const last10 = tail(samples);
        const events = await traceSince(app, mark);
        const outcomes = events
          .filter((e) => e.kind === "reveal")
          .map((e) => `${String(e.outcome)}:${String(e.reason)}`);
        note(`burst reveal outcomes: ${JSON.stringify(outcomes)}`);

        const reveal = await readReveal(app);
        const gesture = events.filter((e) => e.kind === "gesture").pop() ?? null;
        note(`burst settled reveal: ${JSON.stringify(reveal)}`);
        note(`burst last gesture: ${JSON.stringify(gesture)}`);

        expect(
          last10.every((s) => s.inView),
          `after the burst the active match is off band in ${last10.filter((s) => !s.inView).length}/10 frames`,
        ).toBe(true);
        expect(
          new Set(last10.map((s) => Math.round(s.scrollTop))).size,
          "the scroller must be still once the burst has settled",
        ).toBe(1);
        const ordinal = gesture === null ? null : (gesture.activeOrdinal as number | null);
        expect(ordinal, "the trace must know which match the burst landed on").not.toBeNull();
        expect(
          last10[last10.length - 1].chip.trim(),
          "the chip must name the match the viewport is showing",
        ).toBe(`${(ordinal ?? 0) + 1} of ${total}`);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// (b) A hand scroll mid-reveal
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("AT0605b: a hand scroll ends the reveal", () => {
  test(
    "taking the scroller back mid-reveal is not undone",
    async () => {
      const app = await launchTugApp({ testName: "at0605b-find-hand-scroll" });
      try {
        await standUpWalkable(app, "c7c0d1ea-0000-4000-8000-000000000606");
        await searchFor(app, PROBE);

        // Park at the live edge, so the next gesture is a long reveal with
        // real distance to cover.
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SEL.card} ${SCROLLER}');
  el.scrollTop = el.scrollHeight;
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 600));

        const mark = await markTrace(app);
        await chord(app, "KeyG", "g", { meta: true });
        // …and take the scroller back, in the same task: a wheel event (what
        // a trackpad sends) followed by a raw `scrollTop` write 400 px
        // further away. The raw write is the event-silent native scrollbar's
        // shape, which raises no `isUserScrolling` at all.
        const grabbed = await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SEL.card} ${SCROLLER}');
  el.dispatchEvent(new WheelEvent("wheel", {
    deltaY: 400, bubbles: true, cancelable: true, composed: true
  }));
  el.scrollTop = Math.min(el.scrollTop + 400, el.scrollHeight - el.clientHeight);
  return el.scrollTop;
})()`);
        note(`scroll offset after the hand grab: ${grabbed}`);

        const samples = await sampleReveal(app, 800);
        const events = await traceSince(app, mark);
        const reveals = events.filter((e) => e.kind === "reveal");
        const outcome = reveals.length === 0 ? null : String(reveals[reveals.length - 1].outcome);
        note(`hand-scroll reveal outcomes: ${JSON.stringify(reveals.map((e) => `${String(e.outcome)}:${String(e.reason)}`))}`);
        note(`hand-scroll offsets: ${JSON.stringify([...new Set(samples.map((s) => Math.round(s.scrollTop)))])}`);

        const last10 = tail(samples);
        // The user grabbed the scroller DOWN (away from the match, which is
        // above). A reveal that respects the gesture leaves it there; one
        // that does not pulls the offset back up toward the target.
        const pulledBack = last10.filter((s) => s.scrollTop < grabbed - 8);
        expect(
          reveals.length,
          "the reveal must report an outcome rather than staying armed",
        ).toBeGreaterThan(0);
        expect(
          outcome,
          `the reveal should stand down when the user scrolls, not run to its budget (got ${String(outcome)})`,
        ).toBe("cancelled");
        expect(
          pulledBack.length,
          `the scroller was pulled back toward the target in ${pulledBack.length}/10 frames after the hand grab`,
        ).toBe(0);
        // Every reveal ends in one of the four terminal outcomes. The
        // vocabulary is the guarantee: a reveal that neither landed nor
        // gave up used to be recordable ("legacy-armed"), and a chip over
        // one of those says "1 of N" about a match nobody can see.
        const TERMINAL = ["landed", "failed", "superseded", "cancelled"];
        const stray = reveals
          .map((e) => String(e.outcome))
          .filter((o) => !TERMINAL.includes(o));
        expect(
          stray,
          `reveal outcomes outside the four terminal values: ${JSON.stringify(stray)}`,
        ).toEqual([]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// (c) A streaming second card
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("AT0605c: a second card does not erase the first card's paint", () => {
  test(
    "streaming into card B leaves card A's find highlights intact",
    async () => {
      const app = await launchTugApp({ testName: "at0605c-find-two-cards" });
      try {
        const sidA = "c7c0d1ea-0000-4000-8000-000000000607";
        const sidB = "c7c0d1ea-0000-4000-8000-000000000608";
        await standUpSession(
          app,
          "A",
          sidA,
          sessionDeckShape(["A", "B"], { width: 700, height: 620 }),
        );
        await standUpSession(app, "B", sidB);
        await seedTurns(app, "A", sidA, 12);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').length > 3`,
          { timeoutMs: 40_000 },
        );
        await new Promise((r) => setTimeout(r, 1000));

        await searchFor(app, PROBE);
        const before = await app.evalJS<number>(`(function () {
  var hl = CSS.highlights.get('transcript-find-match');
  var n = 0; if (hl) { for (var _ of hl) n += 1; }
  return n;
})()`);
        note(`painted matches in card A before B streams: ${before}`);
        expect(before, "card A must be painting before B is asked to disturb it").toBeGreaterThan(0);

        // Thirty partial frames into B — what one live turn looks like.
        const frameB = framer(app, "B", sidB);
        await app.driveSession("B", { op: "send", text: "start streaming" });
        await frameB({ type: "prompt_anchor", promptUuid: `${sidB}-u0` });
        await frameB({
          type: "content_block_start",
          msg_id: `${sidB}-m0`,
          block_index: 0,
          kind: "text",
        });
        const losses: number[] = [];
        for (let i = 0; i < 30; i += 1) {
          await frameB({
            type: "assistant_text",
            msg_id: `${sidB}-m0`,
            block_index: 0,
            text: `streaming token ${i} `.repeat(i + 1),
            is_partial: true,
          });
          const state = await app.evalJS<{ inA: number; total: number }>(`(function () {
  var out = { inA: 0, total: 0 };
  for (var name of ['transcript-find-match', 'transcript-find-active']) {
    var hl = CSS.highlights.get(name);
    if (!hl) continue;
    for (var r of hl) {
      out.total += 1;
      var el = r.startContainer.parentElement;
      if (el && el.closest('${SEL.card}')) out.inA += 1;
    }
  }
  return out;
})()`);
          if (state.inA === 0) losses.push(i);
        }
        await frameB({ type: "turn_complete", msg_id: `${sidB}-m0`, result: "success" });

        note(`frames after which card A held no paint: ${JSON.stringify(losses)}`);
        expect(
          losses.length,
          `card A lost its find paint after ${losses.length} of 30 frames streamed into card B`,
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// (d) Stepwise typing never lands before the anchor
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("AT0605d: a new query starts where the user is", () => {
  test(
    "typing the probe one character at a time never lands above the anchor row",
    async () => {
      const app = await launchTugApp({ testName: "at0605d-find-anchor-transcript" });
      try {
        await standUpWalkable(app, "c7c0d1ea-0000-4000-8000-000000000609");

        // Park the reader mid-transcript, then open find from there.
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SEL.card} ${SCROLLER}');
  el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.6);
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 800));

        const anchorRow = await app.evalJS<number>(`(function () {
  var sc = document.querySelector('${SEL.card} ${SCROLLER}');
  var box = sc.getBoundingClientRect();
  var best = -1;
  document.querySelectorAll('${SEL.card} [data-tug-list-cell-index]').forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.top < box.bottom && r.bottom > box.top) {
      var n = Number(el.getAttribute("data-tug-list-cell-index"));
      if (n > best) best = n;
    }
  });
  return best;
})()`);
        note(`anchor row at ⌘F: ${anchorRow}`);
        expect(anchorRow, "the reader must be parked somewhere real").toBeGreaterThan(2);

        await openFindBar(app);
        const landings: Array<{ char: number; row: number; chip: string }> = [];
        for (let i = 1; i <= PROBE.length; i += 1) {
          await app.nativeType(PROBE[i - 1]);
          // The engine debounces search-on-type by 100 ms; give it that,
          // plus the reveal it provokes.
          await new Promise((r) => setTimeout(r, 900));
          const reveal = await readReveal(app);
          const chip = await readChip(app);
          if (reveal !== null) landings.push({ char: i, row: reveal.row, chip });
        }
        note(`stepwise landings: ${JSON.stringify(landings)}`);

        expect(
          landings.length,
          "typing must have produced landings to judge",
        ).toBeGreaterThan(0);

        // Two halves, and the second is the one the defect fails.
        //
        // "At or before the anchor" alone is satisfied by row 1 — the top of
        // the document — which is precisely the behaviour this case exists to
        // reject, so asserting it by itself would pass over the defect. The
        // rule is that the landing is the LAST match at or before the anchor,
        // so the active row must also be NEAR it. The fixture plants one match
        // per reply row, so the nearest such match is within a couple of rows
        // of the bottom-most visible one; the margin is the slack between the
        // bottom-most visible row and the last row that actually holds a match.
        const NEAR = 4;
        const below = landings.filter((l) => l.row >= 0 && l.row > anchorRow);
        const faraway = landings.filter((l) => l.row >= 0 && l.row < anchorRow - NEAR);
        expect(
          below.length,
          `the search landed BELOW the anchor row ${anchorRow} on ${below.length} keystroke(s): ${JSON.stringify(below)}`,
        ).toBe(0);
        expect(
          faraway.length,
          `the search left the reader: ${faraway.length} keystroke(s) landed more than ${NEAR} rows above the anchor row ${anchorRow} — ${JSON.stringify(faraway)}`,
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// (d, second half) The Text card's anchor
// ---------------------------------------------------------------------------

let textDir = "";
let textPath = "";
const TEXT_PROBE = "sorrelmark";
const TEXT_CARD = '[data-card-id="A"]';
const TEXT_EDITOR = `${TEXT_CARD} [data-slot="tug-text-card-editor"] .cm-content`;
const TEXT_SCROLLER = `${TEXT_CARD} [data-slot="tug-text-card-editor"] .cm-scroller`;
const TEXT_INPUT = `${TEXT_CARD} [data-slot="text-card-find-bar"] [data-testid="text-card-find-input"] .cm-content`;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  textDir = mkdtempSync(join(tmpdir(), "at0605-"));
  textPath = join(textDir, "anchor.txt");
  const lines: string[] = [];
  for (let i = 0; i < 2000; i += 1) {
    lines.push(i % 4 === 0 ? `line ${i}: ${TEXT_PROBE} here` : `line ${i}: filler`);
  }
  writeFileSync(textPath, lines.join("\n"));
});

afterAll(() => {
  if (textDir !== "" && existsSync(textDir)) {
    rmSync(textDir, { recursive: true, force: true });
  }
});

describe.skipIf(!SHOULD_RUN)("AT0605d: the Text card anchors too", () => {
  test(
    "typing a query mid-file never selects a match above the caret",
    async () => {
      const app = await launchTugApp({ testName: "at0605d-find-anchor-text" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({
          state: {
            cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
            panes: [
              {
                id: "p1",
                position: { x: 30, y: 30 },
                size: { width: 820, height: 620 },
                cardIds: ["A"],
                activeCardId: "A",
                title: "",
                acceptsFamilies: ["maker"],
              },
            ],
            activePaneId: "p1",
            hasFocus: true,
          },
          // The caret starts mid-file, which is the whole premise: a Text
          // card find must begin where the reader is. It is seeded rather
          // than clicked, because a 2,000-line document's `.cm-content` box
          // reaches far outside the WKWebView's visible frame and a native
          // click at its centre resolves to a coordinate the harness refuses.
          cardStates: {
            A: { content: { path: textPath, anchor: { line: 1200, ch: 0 }, scrollTop: 0 } },
          },
          focusCardId: "A",
        });
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(TEXT_EDITOR)});
            return el !== null && el.innerText.indexOf("${TEXT_PROBE}") !== -1;
          })()`,
          { timeoutMs: 40_000 },
        );

        // The seeded anchor put the caret on line 1,200; let the editor
        // settle its scroll around it before reading where "here" is.
        await app.focusElement(TEXT_EDITOR);
        await new Promise((r) => setTimeout(r, 800));

        const anchorPos = await app.evalJS<number>(`(function () {
  var sc = document.querySelector(${JSON.stringify(TEXT_SCROLLER)});
  return sc ? sc.scrollTop : -1;
})()`);
        note(`text card anchor scrollTop: ${anchorPos}`);

        await app.evalJS<boolean>(
          `(function(){
            var t = document.activeElement || document;
            return t.dispatchEvent(new KeyboardEvent("keydown", {
              code: "KeyF", key: "f", metaKey: true,
              bubbles: true, cancelable: true, composed: true,
            }));
          })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TEXT_INPUT)}) !== null`,
          { timeoutMs: 8000 },
        );

        const jumps: Array<{ char: number; scrollTop: number }> = [];
        for (let i = 1; i <= TEXT_PROBE.length; i += 1) {
          await app.nativeType(TEXT_PROBE[i - 1]);
          await new Promise((r) => setTimeout(r, 700));
          const top = await app.evalJS<number>(`(function () {
  var sc = document.querySelector(${JSON.stringify(TEXT_SCROLLER)});
  return sc ? Math.round(sc.scrollTop) : -1;
})()`);
          jumps.push({ char: i, scrollTop: top });
        }
        note(`text card stepwise scroll offsets: ${JSON.stringify(jumps)}`);

        // A search that anchors never runs the view BACK above where the
        // user was; one that always lands on match 0 flies to the top on
        // the first keystroke.
        const above = jumps.filter((j) => j.scrollTop < anchorPos - 40);
        expect(
          above.length,
          `the editor jumped above the caret on ${above.length} keystroke(s): ${JSON.stringify(above)} (anchor was ${anchorPos})`,
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// (e) revealRange on its own
// ---------------------------------------------------------------------------

const REVEAL_SID = "c7c0d1ea-0000-4000-8000-000000000606";

/**
 * Read one settled outcome, waiting for it. The reveal is asynchronous in
 * the page and `evalJS` cannot await a promise there, so the surface queues
 * outcomes and this drains one.
 */
async function nextRevealOutcome(
  app: App,
  timeoutMs = 12_000,
): Promise<string> {
  const started = Date.now();
  for (;;) {
    const got = await app.evalJS<string | null>(
      `window.__tug.takeListRevealOutcome()`,
    );
    if (got !== null) return got;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`no reveal outcome within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** The row's top edge against the scroller's band, after the reveal. */
async function rowBand(
  app: App,
  index: number,
): Promise<{ top: number; bandTop: number; bandBottom: number } | null> {
  return app.evalJS<{ top: number; bandTop: number; bandBottom: number } | null>(
    `(function () {
  var sc = document.querySelector('${SEL.card} ${SCROLLER}');
  var cell = document.querySelector('${SEL.card} [data-tug-list-cell-index="${index}"]');
  if (!sc || !cell) return null;
  var box = sc.getBoundingClientRect();
  var r = cell.getBoundingClientRect();
  return { top: r.top, bandTop: box.top, bandBottom: box.bottom };
})()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0605e: revealRange lands, supersedes, and stands down", () => {
  test(
    "a far row lands in band; a second reveal supersedes; a hand scroll cancels",
    async () => {
      const app = await launchTugApp({ testName: "at0605e-reveal-range" });
      try {
        await standUpWalkable(app, REVEAL_SID);
        const scroller = `${SEL.card} ${SCROLLER}`;
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${scroller}');
  el.scrollTop = 0;
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 600));

        // ---- A far row lands, in band ----
        // Row 90 is far past the mounted window, so this is the
        // estimated-jump path: mount, measure, place, verify.
        await app.evalJS<boolean>(
          `(window.__tug.startListReveal(${JSON.stringify(scroller)}, 90), true)`,
        );
        const landed = await nextRevealOutcome(app);
        note(`far-row reveal outcome: ${landed}`);
        expect(landed, "a far row must land, not expire").toBe("landed");
        const band = await rowBand(app, 90);
        note(`far-row band: ${JSON.stringify(band)}`);
        expect(band, "the revealed row must be mounted at the end").not.toBeNull();
        expect(
          band!.top >= band!.bandTop - 0.5 && band!.top < band!.bandBottom,
          `row 90 top ${band!.top} outside band ${band!.bandTop}..${band!.bandBottom}`,
        ).toBe(true);

        // ---- A second reveal supersedes the first ----
        // Both calls in ONE evalJS, so the second starts while the first is
        // still waiting for its row to mount.
        await app.evalJS<boolean>(
          `(function () {
  window.__tug.startListReveal(${JSON.stringify(scroller)}, 10);
  window.__tug.startListReveal(${JSON.stringify(scroller)}, 100);
  return true;
})()`,
        );
        const first = await nextRevealOutcome(app);
        const second = await nextRevealOutcome(app);
        note(`supersede outcomes: ${JSON.stringify([first, second])}`);
        expect(
          first,
          "the reveal that was overtaken must say so, not simply vanish",
        ).toBe("superseded");
        expect(second, "and the newer one runs to its own answer").toBe("landed");

        // ---- A hand scroll cancels ----
        // A raw `scrollTop` write, which is attribution-identical to the
        // event-silent native scrollbar: `isUserScrolling` never goes true
        // for it, so only the drift read-back can catch it.
        await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${scroller}');
  el.scrollTop = 0;
  return true;
})()`);
        await new Promise((r) => setTimeout(r, 600));
        await app.evalJS<boolean>(`(function () {
  window.__tug.startListReveal(${JSON.stringify(scroller)}, 110);
  var el = document.querySelector('${scroller}');
  el.scrollTop = el.scrollTop + 900;
  return true;
})()`);
        const cancelled = await nextRevealOutcome(app);
        note(`hand-scroll reveal outcome: ${cancelled}`);
        expect(
          cancelled,
          "a reveal must stand down when the user takes the scroller",
        ).toBe("cancelled");

        // ---- An out-of-range index clamps ----
        await app.evalJS<boolean>(
          `(window.__tug.startListReveal(${JSON.stringify(scroller)}, 99999), true)`,
        );
        const clamped = await nextRevealOutcome(app);
        note(`clamped reveal outcome: ${clamped}`);
        expect(
          clamped,
          "an out-of-range index clamps to the last row rather than failing",
        ).toBe("landed");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
