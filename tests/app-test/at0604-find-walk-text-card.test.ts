/**
 * at0604-find-walk-text-card.test.ts — the Text card's find walk over a
 * large wrapped file, including the ordinal past the enumeration cap.
 *
 * ## Why this exists
 *
 * The Text card's engine is CM6's own search, which works off the document
 * and is therefore virtualization-proof — the transcript's index/DOM split
 * does not exist here. What DOES break is the same walk-shaped complaint:
 * a step that selects a match the editor never scrolls to, and a chip that
 * stops being able to say where you are.
 *
 * The chip's failure is exact and predictable from the code. `getMatchInfo`
 * enumerates from the start of the document and stops at
 * `MATCH_INFO_CAP` (5,000), so a file with more matches than that reports a
 * capped count — and, for any active match past the cap, `activeOrdinal`
 * stays `null` and the chip loses its `n` entirely. A user 6,000 matches
 * into a file is told only how many there are, not where they are.
 *
 * So: a generated file of 12,000 lines with a probe on every other line
 * (6,000 matches), soft wrap on, several lines long enough to wrap. Walk 40
 * steps from the top; then jump to line 11,000 and walk 10 more, which puts
 * the active match past the cap. At every step, over a sampled window:
 * the selected match's text satisfies the query, its rect is inside the
 * editor's own scrollport and still, and the chip names a position.
 *
 * ## Expected state
 *
 * Green. The cap case was the red one — a Text card past the match cap
 * reported an ordinal the capped set could not hold — and the walk's first
 * 40 steps were green from the start, because CM6 reveals its own selection.
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

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 900_000;

/** Enumerated from the document start; 5,000 in `tug-text-card-editor.tsx`. */
const MATCH_INFO_CAP = 5000;
const LINES = 12_000;
const PROBE = "auriclemark";
/** One per even-numbered line. */
const EXPECTED_MATCHES = LINES / 2;

let dir = "";
let filePath = "";

const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-card-editor"] .cm-content`;
const SCROLL_DOM = `${CARD} [data-slot="tug-text-card-editor"] .cm-scroller`;
const BAR = `${CARD} [data-slot="text-card-find-bar"]`;
const INPUT = `${BAR} [data-testid="text-card-find-input"] .cm-content`;
const CHIP = `${BAR} [data-slot="find-count"] [data-slot="find-count-value"]`;
const SELECTED = `${CARD} [data-slot="tug-text-card-editor"] .cm-searchMatch-selected`;

function fileBody(): string {
  const out: string[] = [];
  for (let i = 0; i < LINES; i += 1) {
    if (i % 2 === 0) {
      // Every twentieth match line is long enough to soft-wrap.
      out.push(
        i % 20 === 0
          ? `line ${i}: ${PROBE} ${"padding words that make this line long ".repeat(6)}`
          : `line ${i}: ${PROBE} here`,
      );
    } else {
      out.push(`line ${i}: nothing of interest`);
    }
  }
  return out.join("\n");
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = mkdtempSync(join(tmpdir(), "at0604-"));
  filePath = join(dir, "walk.txt");
  writeFileSync(filePath, fileBody());
});

afterAll(() => {
  if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function deckShape(): Record<string, unknown> {
  return {
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
async function sampleSteps(app: App, ms = 500): Promise<Step[]> {
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
 * Mount the card with its caret on `anchorLine`. The caret is SEEDED rather
 * than clicked into place: a 12,000-line document's `.cm-content` box reaches
 * tens of thousands of pixels outside the WKWebView's visible frame, and a
 * native click at its centre resolves to a coordinate the harness refuses
 * outright. Seeding is also what a card restored from a saved deck does.
 */
async function mountCard(app: App, anchorLine: number): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({
    state: deckShape(),
    cardStates: {
      A: { content: { path: filePath, anchor: { line: anchorLine, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(EDITOR)});
      return el !== null && el.innerText.indexOf("${PROBE}") !== -1;
    })()`,
    { timeoutMs: 40_000 },
  );
}

async function openBar(app: App): Promise<void> {
  await app.focusElement(EDITOR);
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

describe.skipIf(!SHOULD_RUN)("AT0604: the Text card's find walk", () => {
  test(
    "40 steps from the top all land, stay put, and say where they are",
    async () => {
      const app = await launchTugApp({ testName: "at0604-find-walk-text-card" });
      try {
        await mountCard(app, 1);
        await openBar(app);
        await app.nativeType(PROBE);
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(CHIP)})?.textContent || "") !== ""`,
          { timeoutMs: 30_000 },
        );
        await new Promise((r) => setTimeout(r, 1200));

        const openingChip = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(CHIP)})?.textContent || "").trim()`,
        );
        note(`opening chip: ${JSON.stringify(openingChip)} (file holds ${EXPECTED_MATCHES} matches)`);

        const failures: string[] = [];

        // --- The first 40 steps, from the top. ---
        for (let step = 0; step < 40; step += 1) {
          await stepForward(app);
          const samples = await sampleSteps(app, 500);
          const last = checkStep(`top step ${step}`, samples, failures);
          if (last !== null && !/^\d+ of /.test(last.chip.trim())) {
            failures.push(
              `top step ${step}: the chip does not name a position — ${JSON.stringify(last.chip)}`,
            );
          }
        }

        for (const f of failures.slice(0, 25)) note(f);
        if (failures.length > 25) note(`…and ${failures.length - 25} more`);
        expect(
          failures.length,
          `${failures.length} of the first 40 steps disagreed with themselves; see Diagnostics`,
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * The cap case, in its own card. The caret is seeded at line 11,000 — match
 * ~5,500, past `MATCH_INFO_CAP` — rather than walked or clicked there: 5,500
 * Enter presses is not a test, and a click into a 12,000-line document's
 * content box resolves outside the WKWebView's frame. A card restored from a
 * saved deck arrives exactly this way, so the fixture is the real case.
 *
 * **The case has a precondition, and it is asserted first.** The chip's
 * behaviour past the cap is unobservable unless the search STARTS past the
 * cap: a search that lands on match 1 at the top of the file can only reach
 * match 5,000 by 5,000 presses, which is not a gesture. So the first
 * assertion is that the search settled near the caret rather than at the top
 * of the document, and it names itself as the precondition; the chip
 * assertions below it are only meaningful once it holds.
 */
describe.skipIf(!SHOULD_RUN)("AT0604: the Text card's chip past the cap", () => {
  test(
    "ten steps past match 5000 still say which match is active",
    async () => {
      const app = await launchTugApp({ testName: "at0604-find-past-cap" });
      try {
        await mountCard(app, 11_000);
        await openBar(app);
        await app.nativeType(PROBE);
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(CHIP)})?.textContent || "") !== ""`,
          { timeoutMs: 30_000 },
        );
        await new Promise((r) => setTimeout(r, 1200));
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
        note(`opening state at line 11,000: ${JSON.stringify(opening)}`);

        // The precondition. Line 11,000 of 12,000 is ~92% of the way down;
        // match 1 is at the very top. Anything in the first half of the
        // document means the search abandoned the caret, and the cap is out
        // of reach for the rest of this test.
        const settledFraction = opening.max > 0 ? opening.scrollTop / opening.max : 0;
        expect(
          settledFraction,
          `the search abandoned the caret: it settled ${Math.round(settledFraction * 100)}% down a document whose caret was at 92%, ` +
            "so no gesture in this test can reach a match past the cap",
        ).toBeGreaterThan(0.5);

        const failures: string[] = [];
        for (let step = 0; step < 10; step += 1) {
          await stepForward(app);
          const samples = await sampleSteps(app, 500);
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

        for (const f of failures.slice(0, 25)) note(f);
        if (failures.length > 25) note(`…and ${failures.length - 25} more`);
        expect(
          failures.length,
          `${failures.length} of 10 steps past match ${MATCH_INFO_CAP} could not say where they were; see Diagnostics`,
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
