/**
 * at0498-masthead-pulse-file-open.test.ts — the pulse line's file reference
 * opens the file, on the line and in its history.
 *
 * A file-tool beat wears its target as a file reference — glyph, basename,
 * underline, the full path on hover — in the masthead's activity line and in
 * the recent-pulses popover that line opens. Both wore the affordance and
 * neither honoured it: the delegated layer that services an annotation was
 * mounted on the transcript root and on the Overview's scroller, and chrome is
 * neither. An underline that opens nothing is a lie the reader can only find
 * by clicking, so this pins the click.
 *
 * Three claims:
 *  1. The beat renders as a real annotation in the masthead — `file-path`,
 *     the whole path stamped, the focus-discipline marks with it.
 *  2. Clicking it opens the file, and does NOT also toggle the line's history
 *     popover. The line's own click gesture stands down when the press lands
 *     on the reference: one press, one act.
 *  3. The same reference inside the popover opens its file too — the popover
 *     is portalled out of the masthead's tree, so it carries the layer of its
 *     own, and a beat that has scrolled off the line is still actionable.
 *
 * No live commentator: the beats arrive through `publishPulseFrame`, which
 * runs the production parser and fold over bytes the wire would have carried.
 *
 * @covers tugdeck/src/components/tugways/use-annotation-clicks.ts
 * @covers tugdeck/src/components/tugways/pulse-beat-text.tsx
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 * @covers tugdeck/src/lib/pulse-line/beat-file-target.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// UUID-shaped so the bound session reads as a real one.
const SID = "a7c0d1ea-0000-4000-8000-000000000498";

const CARD = '[data-card-id="A"]';
const PANE = '.tug-pane[data-pane-id="p1"]';
const MASTHEAD = `${PANE} [data-slot="session-masthead"]`;
const STAGE = `${MASTHEAD} .session-masthead-stage`;
const LINE_REF = `${MASTHEAD} [data-slot="pulse-beat-text"] .tug-atom-ref`;
const HISTORY = '[data-slot="session-pulse-history"]';
const HISTORY_REF = `${HISTORY} [data-slot="pulse-beat-text"] .tug-atom-ref`;
const TEXT_CARD = '[data-slot="tug-text-card-editor"] .cm-content';

const OLDER_NAME = "older.md";
const NEWER_NAME = "newer.md";
const OLDER_BODY = ["alpha", "the-older-file-body", "omega"].join("\n");
const NEWER_BODY = ["alpha", "the-newer-file-body", "omega"].join("\n");

let projectDir = "";
let olderPath = "";
let newerPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0498-proj-")));
  olderPath = join(projectDir, OLDER_NAME);
  newerPath = join(projectDir, NEWER_NAME);
  writeFileSync(olderPath, OLDER_BODY, "utf8");
  writeFileSync(newerPath, NEWER_BODY, "utf8");
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
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

/** One PULSE frame body, scoped to this session, as the emitter writes it. */
function pulseFrame(text: string, beat: number): string {
  return JSON.stringify({
    type: "pulse",
    text,
    scopes: [SID],
    beat,
    at: Date.now(),
  });
}

/** Whether any open Text card is showing `needle`. */
const textCardShowsJS = (needle: string) => `(function(){
  return Array.from(document.querySelectorAll(${JSON.stringify(TEXT_CARD)}))
    .some(function(el){ return (el.textContent || "").indexOf(${JSON.stringify(needle)}) !== -1; });
})()`;

const countJS = (selector: string) =>
  `document.querySelectorAll(${JSON.stringify(selector)}).length`;

describe.skipIf(!SHOULD_RUN)(
  "AT0498: a pulse beat's file reference opens the file it names",
  () => {
    test(
      "the line's reference opens it without toggling the history; the popover's does too",
      async () => {
        const app = await launchTugApp({
          testName: "at0498-masthead-pulse-file-open",
        });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          // Bound, not resumed: the masthead is what this pins, and it needs
          // no transcript behind it.
          await app.bindSession("A", { tugSessionId: SID, projectDir });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MASTHEAD)}) !== null`,
            { timeoutMs: 20_000 },
          );

          // Two file beats, oldest first: the newer one is what the line
          // reads, the older one survives only in the history.
          await app.evalJS<boolean>(
            `window.__tug.publishPulseFrame(${JSON.stringify(pulseFrame(`Reading ${olderPath}`, 1))})`,
          );
          await app.evalJS<boolean>(
            `window.__tug.publishPulseFrame(${JSON.stringify(pulseFrame(`Writing ${newerPath} — 264 lines`, 2))})`,
          );

          // 1. The line's beat is a real annotation, not a picture of one.
          // The line is PACED — it walks the beats it was handed rather than
          // jumping to the newest — so the wait is for the newer beat to be
          // the one standing, not merely for a reference to exist.
          await app.waitForCondition<boolean>(
            `(function(){
               var el = document.querySelector(${JSON.stringify(LINE_REF)});
               return el !== null && el.getAttribute('data-path') === ${JSON.stringify(newerPath)};
             })()`,
            { timeoutMs: 20_000 },
          );
          const ref = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector(${JSON.stringify(LINE_REF)});
              return {
                kind: el.getAttribute('data-tug-annotation'),
                path: el.getAttribute('data-path'),
                label: (el.textContent || ""),
                focus: el.getAttribute('data-tug-focus'),
                noActivate: el.hasAttribute('data-no-activate'),
              };
            })())`),
          ) as Record<string, unknown>;
          expect(ref.kind).toBe("file-path");
          expect(ref.path).toBe(newerPath);
          // The label is the basename — the path itself is the hover's.
          expect(ref.label).toBe(NEWER_NAME);
          expect(ref.focus).toBe("refuse");
          expect(ref.noActivate).toBe(true);

          // 2. Clicking it opens the file it names…
          await app.click(LINE_REF);
          await app.waitForCondition<boolean>(textCardShowsJS("the-newer-file-body"), {
            timeoutMs: 20_000,
          });
          // …and the line's own gesture stood down: no history opened under it.
          expect(await app.evalJS<number>(countJS(HISTORY))).toBe(0);

          // 3. The history still opens on a press that is not the reference,
          //    and the reference inside it opens its own file.
          await app.click(STAGE);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(HISTORY)}) !== null`,
            { timeoutMs: 10_000 },
          );
          const olderRow = `${HISTORY_REF}[data-path="${olderPath}"]`;
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(olderRow)}) !== null`,
            { timeoutMs: 10_000 },
          );
          await app.click(olderRow);
          await app.waitForCondition<boolean>(textCardShowsJS("the-older-file-body"), {
            timeoutMs: 20_000,
          });

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0498] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
