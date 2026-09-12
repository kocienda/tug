/**
 * at0565-beat-skips-results.test.ts — a tool's result is evidence, not a beat,
 * and no beat is the masthead's account run.
 *
 * The digester writes one line per tool call and then one per tool RESULT:
 * the first 200 characters of whatever came back, behind an arrow. The result
 * is by construction newer than the call, and when the masthead showed the
 * newest line, for most of every turn its lower line read a grep hit or a
 * file's first bytes — `→ 38: --tugx-progress-indicator-size: 16px;` — line
 * noise to a reader and evidence only to the Observer. The newest-beat reading
 * walks past a `result` to the call it answers and shows an `error` result,
 * which is news; that walk is `latestBeatForScope`'s, pinned by its own unit
 * tests, and its one live reader is the row's copy menu now.
 *
 * Because the masthead reads no beat at all any more ([D185]): the account
 * run under the standing sentence says what the Observer wrote during a turn
 * and the rest sentence otherwise, and the digest's lines — calls, results,
 * errors, waits — are one click away in the history the run opens. So what
 * this pins on the masthead is the other half of the same decision:
 *
 *  1. A `tool` beat, its `result`, an `error` result, a second call, a
 *     `wait` and the result that answers it: through all six frames the
 *     account run reads the rest sentence. A turn is in flight and no post
 *     and no ask have landed, so there is nothing for the run to climb to,
 *     and no beat of any kind takes it.
 *  2. The history, one click away, carries the call, the error and the wait
 *     as rows — the reader who wants the beat still has it.
 *
 * The Cards rail's session row renders the same `SessionIdentityRow`, so the
 * rule holds there by construction and is not re-pinned here.
 *
 * No live digester: the frames arrive through `publishDigestFrame`, the
 * production parser and fold over bytes the wire would have carried.
 *
 * @covers tugdeck/src/lib/digest-store.ts
 * @covers tugdeck/src/lib/session-activity-line.ts
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// UUID-shaped so the bound session reads as a real one.
const SID = "a7c0d1ea-0000-4000-8000-000000000565";

const PANE = '.tug-pane[data-pane-id="p1"]';
const MASTHEAD = `${PANE} [data-slot="session-masthead"]`;
const STAGE = `${MASTHEAD} .session-masthead-stage`;
/** The account run's text — the activity primitive's full reading. */
const LINE_TEXT = `${STAGE} .tug-activity-line-activity-full`;
/** Any beat rendered as a beat, anywhere on the masthead. */
const LINE_BEAT = `${MASTHEAD} [data-slot="beat-text"]`;
const HISTORY = '[data-slot="session-beat-history"]';
const HISTORY_ROW = `${HISTORY} .session-beat-history-beat`;

const SEARCH_BEAT = "Searching tugx-progress";
const SEARCH_RESULT = "→ 38: --tugx-progress-indicator-size: 16px;";
const LINT_ERROR = "→ error: lint found 2 problems";
const RUN_BEAT = "Running just lint";
const RUN_WAIT = "Waiting for permission: Running just lint";
const RUN_RESULT = "→ lint clean";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0565-proj-")));
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
function digestFrame(text: string, beat: number, kind: string): string {
  return JSON.stringify({
    type: "digest",
    text,
    scopes: [SID],
    beat,
    at: Date.now(),
    kind,
  });
}

/** The account run's text, flattened. */
const lineTextJS = `(function(){
  var el = document.querySelector(${JSON.stringify(LINE_TEXT)});
  return el === null ? "" : (el.textContent || "").replace(/\\s+/g, " ").trim();
})()`;

/** Whether some history row reads `text`. */
const historyHasJS = (text: string) => `Array.from(document.querySelectorAll(${JSON.stringify(HISTORY_ROW)}))
  .some(function(el){ return (el.textContent || "").trim() === ${JSON.stringify(text)}; })`;

describe.skipIf(!SHOULD_RUN)("AT0565: a tool's result is evidence, not a beat", () => {
  test(
    "no beat takes the account run, and the history carries the call, the error and the wait",
    async () => {
      const app = await launchTugApp({ testName: "at0565-beat-skips-results" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID, projectDir });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LINE_TEXT)}) !== null`,
          { timeoutMs: 20_000 },
        );

        const publish = async (text: string, beat: number, kind: string) => {
          await app.evalJS<boolean>(
            `window.__tug.publishDigestFrame(${JSON.stringify(digestFrame(text, beat, kind))})`,
          );
        };

        // The run at rest, before any frame: the rest sentence.
        await app.waitForCondition<boolean>(`${lineTextJS}.endsWith("Ready.")`, {
          timeoutMs: 20_000,
        });
        const atRest = await app.evalJS<string>(lineTextJS);
        note("at0565 account run at rest", atRest);

        // 1. Six frames — a call, its result, an error, a second call, a wait
        //    and the result that answers it. The `tool` kind puts the turn in
        //    flight, and still nothing climbs onto the run: no post and no
        //    ask have landed, and a beat is not a rung. The run is paced, so
        //    a wait past the dwell reads what STAYED rather than what
        //    flashed.
        await publish(SEARCH_BEAT, 1, "tool");
        await publish(SEARCH_RESULT, 2, "result");
        await publish(LINT_ERROR, 3, "error");
        await publish(RUN_BEAT, 4, "tool");
        await publish(RUN_WAIT, 5, "wait");
        await publish(RUN_RESULT, 6, "result");
        await new Promise((r) => setTimeout(r, 2_500));
        const during = await app.evalJS<string>(lineTextJS);
        note("at0565 account run mid-turn", during);
        expect(during, "the account run holds the rest sentence through the turn").toBe(atRest);
        for (const beat of [SEARCH_BEAT, SEARCH_RESULT, LINT_ERROR, RUN_BEAT, RUN_WAIT, RUN_RESULT]) {
          expect(during, `no beat reaches the account run: ${beat}`).not.toContain(beat);
        }
        expect(
          await app.evalJS<number>(`document.querySelectorAll(${JSON.stringify(LINE_BEAT)}).length`),
          "no beat is rendered as a beat anywhere on the masthead",
        ).toBe(0);

        // 2. The history is where the beat went. One click on the run opens
        //    it, and the call, the error and the wait are rows in it.
        await app.click(STAGE);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(HISTORY)}) !== null`,
          { timeoutMs: 10_000 },
        );
        await app.waitForCondition<boolean>(historyHasJS(RUN_WAIT), { timeoutMs: 10_000 });
        for (const beat of [SEARCH_BEAT, LINT_ERROR, RUN_BEAT]) {
          expect(
            await app.evalJS<boolean>(historyHasJS(beat)),
            `the history carries the beat: ${beat}`,
          ).toBe(true);
        }

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0565] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
