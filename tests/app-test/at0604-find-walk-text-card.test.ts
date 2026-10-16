/**
 * at0604-find-walk-text-card.test.ts — the Text card's find, typed and
 * walked from deep inside a large wrapped file: it starts where the reader
 * is, and its chip still says where they are past the enumeration cap.
 *
 * ## Why this exists
 *
 * The Text card's engine is CM6's own search, which works off the document
 * and is therefore virtualization-proof — the transcript's index/DOM split
 * does not exist here. What DOES break is the same walk-shaped complaint:
 * a step that selects a match the editor never scrolls to, a first
 * keystroke that flies the view to the top of the file, and a chip that
 * stops being able to say where you are.
 *
 * The chip's failure is exact and predictable from the code. `getMatchInfo`
 * enumerates from the start of the document and stops at
 * `MATCH_INFO_CAP` (5,000), so a file with more matches than that reports a
 * capped count — and, for any active match past the cap, `activeOrdinal`
 * stays `null` and the chip loses its `n` entirely. A user 5,500 matches
 * into a file is told only how many there are, not where they are.
 *
 * So, two Text cards in one deck, each with its caret seeded deep in its
 * file, taken in order:
 *
 *  1. **The anchor** (card `B`: 2,000 lines, a match on every fourth, caret
 *     at line 1,200). The query is typed one character at a time, and at no
 *     keystroke may the editor scroll back above where the reader was. A
 *     search that always lands on match 0 flies to the top on the first.
 *     Every new query used to. This leg keeps its own sparse file: on a file
 *     where every line matches, the landing is the scrollport's top line,
 *     and when that line is clipped by a fraction the landing is "not on
 *     screen" and is centred — half a viewport above the reader, which this
 *     leg's 40 px margin reads as a jump (seen 2026-10-16: 215 px).
 *
 * Card `A` holds a generated file of 6,000 lines with the probe on every
 * line (6,000 matches), soft wrap on, every twentieth line long enough to
 * wrap, and the caret at line 5,500 — past the cap:
 *
 *  2. **The precondition.** With the full query in, the search has settled
 *     near the caret rather than at the top of the document — the chip's
 *     behaviour past the cap is unobservable otherwise, so this is asserted
 *     first and names itself.
 *  3. **The walk past the cap.** Three steps, each over a sampled window:
 *     the selected match's text satisfies the query, its rect is inside the
 *     editor's own scrollport and still, and the chip names a position past
 *     the cap.
 *
 * ## Expected state
 *
 * Green. The cap case was the red one — a Text card past the match cap
 * reported an ordinal the capped set could not hold. A walk of forty steps
 * from the top of the file also lived here, green from the start because
 * CM6 reveals its own selection; the steps below run the same per-step
 * checks.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card-find-bar.tsx
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/lib/find-session.ts
 * @covers tugdeck/src/lib/find-trace.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note, type App } from "./_harness";
import { awaitGesture, markTrace, waitFrames } from "./find-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

/** Enumerated from the document start; 5,000 in `tug-text-card-editor.tsx`. */
const MATCH_INFO_CAP = 5000;
const LINES = 6000;
/** The caret's line: ~92% of the way down, and match ~5,500 — past the cap. */
const CARET_LINE = 5500;
const PROBE = "auriclemark";
/** One per line. */
const EXPECTED_MATCHES = LINES;
const STEPS = 3;

/** Card `B`'s file: a match on every fourth line, the caret mid-file. */
const ANCHOR_LINES = 2000;
const ANCHOR_CARET_LINE = 1200;
const ANCHOR_PROBE = "sorrelmark";

let dir = "";
let filePath = "";
let anchorPath = "";

/** The selectors one Text card is read through. */
function textCard(id: string): {
  card: string;
  editor: string;
  scroller: string;
  input: string;
} {
  const card = `[data-card-id="${id}"]`;
  return {
    card,
    editor: `${card} [data-slot="tug-text-card-editor"] .cm-content`,
    scroller: `${card} [data-slot="tug-text-card-editor"] .cm-scroller`,
    input: `${card} [data-slot="text-card-find-bar"] [data-testid="text-card-find-input"] .cm-content`,
  };
}

const CAP = textCard("A");
const ANCHOR = textCard("B");

const CARD = CAP.card;
const SCROLL_DOM = CAP.scroller;
const BAR = `${CARD} [data-slot="text-card-find-bar"]`;
const CHIP = `${BAR} [data-slot="find-count"] [data-slot="find-count-value"]`;
const SELECTED = `${CARD} [data-slot="tug-text-card-editor"] .cm-searchMatch-selected`;

function fileBody(): string {
  const out: string[] = [];
  for (let i = 0; i < LINES; i += 1) {
    // Every twentieth line is long enough to soft-wrap.
    out.push(
      i % 20 === 0
        ? `line ${i}: ${PROBE} ${"padding words that make this line long ".repeat(6)}`
        : `line ${i}: ${PROBE} here`,
    );
  }
  return out.join("\n");
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = mkdtempSync(join(tmpdir(), "at0604-"));
  filePath = join(dir, "walk.txt");
  writeFileSync(filePath, fileBody());
  anchorPath = join(dir, "anchor.txt");
  const lines: string[] = [];
  for (let i = 0; i < ANCHOR_LINES; i += 1) {
    lines.push(i % 4 === 0 ? `line ${i}: ${ANCHOR_PROBE} here` : `line ${i}: filler`);
  }
  writeFileSync(anchorPath, lines.join("\n"));
});

afterAll(() => {
  if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function deckShape(): Record<string, unknown> {
  return {
    cards: [
      { id: "A", componentId: "text", title: "File", closable: true },
      { id: "B", componentId: "text", title: "Anchor", closable: true },
    ],
    panes: ["A", "B"].map((id, i) => ({
      id: `p${i + 1}`,
      position: { x: 30 + i * 730, y: 30 },
      size: { width: 700, height: 620 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
    })),
    activePaneId: "p2",
    hasFocus: true,
  };
}

/** The selected match's rect against the editor's own scrollport. */
const STEP_EXPR = `(function () {
  var sc = document.querySelector(${JSON.stringify(SCROLL_DOM)});
  var el = document.querySelector(${JSON.stringify(SELECTED)});
  var chipEl = document.querySelector(${JSON.stringify(CHIP)});
  var chip = (chipEl ? chipEl.textContent : "") || "";
  if (!sc) return null;
  if (!el) return { present: false, chip: chip, scrollTop: -1, text: "", inView: false,
                    rectTop: -1, rectBottom: -1, portTop: -1, portBottom: -1 };
  var rect = el.getBoundingClientRect();
  var box = sc.getBoundingClientRect();
  return {
    present: true,
    chip: chip,
    scrollTop: sc.scrollTop,
    text: (el.textContent || ""),
    rectTop: rect.top,
    rectBottom: rect.bottom,
    portTop: box.top,
    portBottom: box.bottom,
    inView: rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5
  };
})()`;

interface Step {
  present: boolean;
  chip: string;
  scrollTop: number;
  text: string;
  rectTop: number;
  rectBottom: number;
  portTop: number;
  portBottom: number;
  inView: boolean;
}

/** Sample the editor's own state every frame for `ms`, then read it back. */
async function sampleSteps(app: App, ms = 300): Promise<Step[]> {
  await app.evalJS<boolean>(`(function () {
  window.__textFindSamples = [];
  var deadline = performance.now() + ${ms};
  function tick() {
    window.__textFindSamples.push(${STEP_EXPR});
    if (performance.now() < deadline) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return true;
})()`);
  await new Promise((r) => setTimeout(r, ms + 200));
  return app.evalJS<Step[]>(`(window.__textFindSamples || []).filter(Boolean)`);
}

/**
 * The editor's scroll offset once it has held still for `still` frames. The
 * restore lands on CM6's estimated height map and then re-measures the lines
 * it mounts, so the first offset after the caret's line appears is not yet
 * where the reader is.
 */
async function settledScrollTop(app: App, scroller: string, still = 6): Promise<number> {
  await app.evalJS<boolean>(`(function () {
  window.__textFindSettled = null;
  var sc = document.querySelector(${JSON.stringify(scroller)});
  var last = -1, same = 0;
  function tick() {
    var top = sc ? Math.round(sc.scrollTop) : -1;
    same = top === last ? same + 1 : 0;
    last = top;
    if (same >= ${still}) { window.__textFindSettled = top; return; }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return true;
})()`);
  // Wrapped, so a settled offset of 0 is still a truthy answer.
  const settled = await app.waitForCondition<{ top: number }>(
    `(window.__textFindSettled === null ? null : { top: window.__textFindSettled })`,
    { timeoutMs: 5000 },
  );
  return settled.top;
}

async function readScrollTop(app: App, scroller: string): Promise<number> {
  return app.evalJS<number>(`(function () {
  var sc = document.querySelector(${JSON.stringify(scroller)});
  return sc ? Math.round(sc.scrollTop) : -1;
})()`);
}

/**
 * Mount both cards with their carets deep in their files. The caret is
 * SEEDED rather than clicked into place: a large document's `.cm-content`
 * box reaches far outside the WKWebView's visible frame, and a native click
 * at its centre resolves to a coordinate the harness refuses outright.
 * Seeding is also what a card restored from a saved deck does.
 *
 * The probe being on screen says nothing about where an editor is — card
 * `A` has it on every line — so the wait is for each restore to have
 * scrolled its caret's line into the scrollport.
 */
async function mountCards(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({
    state: deckShape(),
    cardStates: {
      A: { content: { path: filePath, anchor: { line: CARET_LINE, ch: 0 }, scrollTop: 0 } },
      B: {
        content: { path: anchorPath, anchor: { line: ANCHOR_CARET_LINE, ch: 0 }, scrollTop: 0 },
      },
    },
    focusCardId: "B",
  });
  for (const [sel, line] of [
    [CAP.editor, CARET_LINE],
    [ANCHOR.editor, ANCHOR_CARET_LINE],
  ] as const) {
    await app.waitForCondition<boolean>(
      `(function(){
        var el = document.querySelector(${JSON.stringify(sel)});
        return el !== null && el.innerText.indexOf("line ${line}: ") !== -1;
      })()`,
      { timeoutMs: 40_000 },
    );
  }
}

async function openBar(app: App, card: { editor: string; input: string }): Promise<void> {
  const INPUT = card.input;
  await app.focusElement(card.editor);
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
    `document.querySelector(${JSON.stringify(INPUT)}) !== null`,
    { timeoutMs: 8000 },
  );
  await app.waitForCondition<boolean>(
    `(function () {
      var input = document.querySelector(${JSON.stringify(INPUT)});
      return input !== null && document.activeElement !== null &&
        (input.contains(document.activeElement) || input === document.activeElement);
    })()`,
    { timeoutMs: 8000 },
  );
}

/** Enter in the query field advances; Shift-Enter retreats. */
async function stepForward(app: App): Promise<void> {
  await app.evalJS<boolean>(
    `(function(){
      var t = document.activeElement || document;
      return t.dispatchEvent(new KeyboardEvent("keydown", {
        code: "Enter", key: "Enter",
        bubbles: true, cancelable: true, composed: true,
      }));
    })()`,
  );
}

function checkStep(label: string, samples: Step[], failures: string[]): Step | null {
  if (samples.length < 10) {
    failures.push(
      `${label}: the sampler recorded ${samples.length} frame(s) — occlusion, not a find failure`,
    );
    return null;
  }
  const last10 = samples.slice(-10);
  const missing = last10.filter((s) => !s.present);
  if (missing.length > 0) {
    failures.push(`${label}: no selected match in ${missing.length}/10 frames`);
    return last10[last10.length - 1];
  }
  const texts = new Set(last10.map((s) => s.text.toLowerCase()));
  if (texts.size !== 1 || !texts.has(PROBE)) {
    failures.push(`${label}: selected text over the window was ${JSON.stringify([...texts])}`);
  }
  const off = last10.filter((s) => !s.inView);
  if (off.length > 0) {
    const s = off[0];
    failures.push(
      `${label}: ${off.length}/10 frames outside the scrollport — rect ${s.rectTop}..${s.rectBottom} vs port ${s.portTop}..${s.portBottom}`,
    );
  }
  const offsets = new Set(last10.map((s) => Math.round(s.scrollTop)));
  if (offsets.size !== 1) {
    failures.push(`${label}: the editor was still scrolling — offsets ${JSON.stringify([...offsets])}`);
  }
  return last10[last10.length - 1];
}

/**
 * The cap case. The caret is seeded at line 5,500 — match ~5,500, past
 * `MATCH_INFO_CAP` — rather than walked or clicked there: 5,500 Enter
 * presses is not a test, and a click into a 6,000-line document's content
 * box resolves outside the WKWebView's frame. A card restored from a saved
 * deck arrives exactly this way, so the fixture is the real case.
 */
describe.skipIf(!SHOULD_RUN)("AT0604: the Text card's find from deep in a file", () => {
  test(
    "typing never scrolls above the caret, and steps past match 5000 still say which match is active",
    async () => {
      const app = await launchTugApp({ testName: "at0604-find-past-cap" });
      try {
        await mountCards(app);

        // ── 1. The anchor: card B, one keystroke at a time ────────────────
        await app.focusElement(ANCHOR.editor);
        const anchorPos = await settledScrollTop(app, ANCHOR.scroller);
        note(`card B anchor scrollTop at line ${ANCHOR_CARET_LINE}: ${anchorPos}`);
        await openBar(app, ANCHOR);
        const jumps: Array<{ char: number; scrollTop: number }> = [];
        for (let i = 1; i <= ANCHOR_PROBE.length; i += 1) {
          const mark = await markTrace(app);
          await app.nativeType(ANCHOR_PROBE[i - 1]);
          // The engine's own record of this keystroke's search, then the
          // frames CM6 measures and scrolls its selection in.
          await awaitGesture(app, mark, ANCHOR_PROBE.slice(0, i));
          await waitFrames(app);
          jumps.push({ char: i, scrollTop: await readScrollTop(app, ANCHOR.scroller) });
        }
        note(`card B stepwise scroll offsets: ${JSON.stringify(jumps)}`);
        // A search that anchors never runs the view BACK above where the
        // user was; one that always lands on match 0 flies to the top on
        // the first keystroke.
        const above = jumps.filter((j) => j.scrollTop < anchorPos - 40);
        expect(
          above.length,
          `the editor jumped above the caret on ${above.length} keystroke(s): ${JSON.stringify(above)} (anchor was ${anchorPos})`,
        ).toBe(0);

        // ── 2. The precondition: card A, the full query ───────────────────
        // ⌘F goes to the active card, and focusing an editor does not raise
        // its card; the raise is the deck's own gesture.
        await app.evalJS<void>(`window.__tug.activateCard("A")`);
        await openBar(app, CAP);
        const typed = await markTrace(app);
        await app.nativeType(PROBE);
        await awaitGesture(app, typed, PROBE, 30_000);
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(CHIP)})?.textContent || "") !== ""`,
          { timeoutMs: 30_000 },
        );
        await waitFrames(app);
        const opening = await app.evalJS<{ chip: string; scrollTop: number; max: number }>(
          `(function () {
  var sc = document.querySelector(${JSON.stringify(SCROLL_DOM)});
  var chipEl = document.querySelector(${JSON.stringify(CHIP)});
  return {
    chip: ((chipEl ? chipEl.textContent : "") || "").trim(),
    scrollTop: sc ? Math.round(sc.scrollTop) : -1,
    max: sc ? Math.round(sc.scrollHeight - sc.clientHeight) : -1
  };
})()`,
        );
        note(
          `opening state at line ${CARET_LINE}: ${JSON.stringify(opening)} (file holds ${EXPECTED_MATCHES} matches)`,
        );

        // Line 5,500 of 6,000 is ~92% of the way down; match 1 is at the
        // very top. Anything in the first half of the document means the
        // search abandoned the caret, and the cap is out of reach for the
        // rest of this test.
        const settledFraction = opening.max > 0 ? opening.scrollTop / opening.max : 0;
        expect(
          settledFraction,
          `the search abandoned the caret: it settled ${Math.round(settledFraction * 100)}% down a document whose caret was at 92%, ` +
            "so no gesture in this test can reach a match past the cap",
        ).toBeGreaterThan(0.5);

        // ── 3. The walk past the cap ──────────────────────────────────────
        const failures: string[] = [];
        for (let step = 0; step < STEPS; step += 1) {
          await stepForward(app);
          const samples = await sampleSteps(app, 300);
          const last = checkStep(`past-cap step ${step}`, samples, failures);
          if (last === null) continue;
          const chip = last.chip.trim();
          const m = /^(\d+) of /.exec(chip);
          if (m === null) {
            failures.push(
              `past-cap step ${step}: the chip lost its position past match ${MATCH_INFO_CAP} — ${JSON.stringify(chip)}`,
            );
          } else if (Number(m[1]) <= MATCH_INFO_CAP) {
            failures.push(
              `past-cap step ${step}: the chip reports ${JSON.stringify(chip)}, an ordinal inside the cap for a match past it`,
            );
          }
        }

        for (const f of failures) note(f);
        expect(
          failures.length,
          `${failures.length} of ${STEPS} steps past match ${MATCH_INFO_CAP} could not say where they were; see Diagnostics`,
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
