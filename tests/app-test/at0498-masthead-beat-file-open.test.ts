/**
 * at0498-masthead-beat-file-open.test.ts — the beat is off the masthead's
 * line and one click away in its history, where its file reference still
 * opens the file.
 *
 * The masthead's account run does not read the digest's newest line: a beat
 * of the "Editing foo.ts, 37 lines" kind is too low-level to tell one session
 * from another, so the line says what the Observer wrote during a turn and
 * the rest sentence at rest, and the beat keeps the history popover the
 * account run opens. A file-tool beat there wears its target as a file
 * reference — glyph, basename, underline, the full path on hover — and the
 * popover, portalled out of the masthead's tree, carries an annotation layer
 * of its own so the underline is honoured: an underline that opens nothing
 * is a lie the reader can only find by clicking, so this pins the click.
 *
 * Three claims:
 *  1. Two file beats published for the session put NO beat on the masthead's
 *     line — the account run reads the rest sentence, and no beat-text
 *     reference stands anywhere in the masthead.
 *  2. Clicking the account run opens the history, and the newest beat there
 *     is a real annotation — `file-path`, the whole path stamped, the
 *     basename as its label, the focus-discipline marks with it.
 *  3. Clicking a reference in the popover opens the file it names — the
 *     older beat as much as the newer, since the history is where a beat that
 *     is no longer the newest is still actionable.
 *
 * No live commentator: the beats arrive through `publishDigestFrame`, which
 * runs the production parser and fold over bytes the wire would have carried.
 *
 * @covers tugdeck/src/components/tugways/use-annotation-clicks.ts
 * @covers tugdeck/src/components/tugways/beat-text.tsx
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/lib/beat-line/beat-file-target.ts
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
/** The account run's text — the activity primitive's full reading. */
const LINE_TEXT = `${STAGE} .tug-activity-line-activity-full`;
/** Any beat rendered as a beat, anywhere on the masthead. */
const LINE_BEAT = `${MASTHEAD} [data-slot="beat-text"]`;
const HISTORY = '[data-slot="session-beat-history"]';
const HISTORY_REF = `${HISTORY} [data-slot="beat-text"] .tug-atom-ref`;
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

/** One DIGEST frame body, scoped to this session, as the emitter writes it. */
function digestFrame(text: string, beat: number): string {
  return JSON.stringify({
    type: "digest",
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
  "AT0498: the beat is off the line, and its file reference opens from the history",
  () => {
    test(
      "no beat on the line; the history's references open their files",
      async () => {
        const app = await launchTugApp({
          testName: "at0498-masthead-beat-file-open",
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
            `window.__tug.publishDigestFrame(${JSON.stringify(digestFrame(`Reading ${olderPath}`, 1))})`,
          );
          await app.evalJS<boolean>(
            `window.__tug.publishDigestFrame(${JSON.stringify(digestFrame(`Writing ${newerPath} — 264 lines`, 2))})`,
          );

          // 1. The line does not read the beat. Two beats are in the store
          // and the account run still says the session is at rest — there
          // is no turn in flight, and a beat is not a rung of the ladder
          // either way. Read once the history has opened below, which is
          // the proof the frames landed; nothing here waits on a line that
          // is not going to change.
          await app.click(STAGE);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(HISTORY)}) !== null`,
            { timeoutMs: 10_000 },
          );
          const newerRow = `${HISTORY_REF}[data-path="${newerPath}"]`;
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(newerRow)}) !== null`,
            { timeoutMs: 10_000 },
          );
          expect(await app.evalJS<number>(countJS(LINE_BEAT))).toBe(0);
          const lineText = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(LINE_TEXT)}) || {}).textContent || ""`,
          );
          expect(lineText).not.toContain(NEWER_NAME);
          expect(lineText).not.toContain(OLDER_NAME);
          expect(lineText).toContain("Ready");

          // 2. The history's newest beat is a real annotation, not a picture
          // of one.
          const ref = JSON.parse(
            await app.evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector(${JSON.stringify(newerRow)});
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

          // 3. Clicking it opens the file it names…
          await app.click(newerRow);
          await app.waitForCondition<boolean>(textCardShowsJS("the-newer-file-body"), {
            timeoutMs: 20_000,
          });
          // …and so does the older one, which is no longer the newest and is
          // still actionable from the history. The Text card opening may
          // have dismissed the popover; reopen it from the account run if so.
          if ((await app.evalJS<number>(countJS(HISTORY))) === 0) {
            await app.click(STAGE);
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(HISTORY)}) !== null`,
              { timeoutMs: 10_000 },
            );
          }
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
