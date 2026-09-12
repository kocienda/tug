/**
 * at0565-beat-skips-results.test.ts — a tool's result is evidence, not a beat.
 *
 * The digester writes one line per tool call and then one per tool RESULT:
 * the first 200 characters of whatever came back, behind an arrow. The result
 * is by construction newer than the call, and the masthead showed the newest
 * line, so for most of every turn the third line read a grep hit or a file's
 * first bytes — `→ 38: --tugx-progress-indicator-size: 16px;` — line noise to
 * a reader and evidence only to the Observer. The beat now walks past a
 * `result` to the call it answers, and shows an `error` result, which is news.
 *
 * Three claims, on the masthead's activity line:
 *  1. A `tool` beat followed by a `result` line: the line reads the tool beat.
 *  2. An `error` result after that: the line reads the error.
 *  3. A `wait` that a `result` follows: the line reads the call that ran,
 *     not the wait — the same reading a card mounting from the tail gets.
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
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// UUID-shaped so the bound session reads as a real one.
const SID = "a7c0d1ea-0000-4000-8000-000000000565";

const PANE = '.tug-pane[data-pane-id="p1"]';
const MASTHEAD = `${PANE} [data-slot="session-masthead"]`;
const BEAT = `${PANE} .session-masthead-row [data-slot="tug-activity-line-activity"]`;

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

/** Whether the masthead's activity line currently reads `text`. */
const lineReadsJS = (text: string) => `(function(){
  var el = document.querySelector(${JSON.stringify(BEAT)});
  return el !== null && (el.textContent || "").trim() === ${JSON.stringify(text)};
})()`;

describe.skipIf(!SHOULD_RUN)("AT0565: a tool's result is evidence, not a beat", () => {
  test(
    "the line reads the call, shows an error, and steps off a finished wait",
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
          `document.querySelector(${JSON.stringify(MASTHEAD)}) !== null`,
          { timeoutMs: 20_000 },
        );

        const publish = async (text: string, beat: number, kind: string) => {
          await app.evalJS<boolean>(
            `window.__tug.publishDigestFrame(${JSON.stringify(digestFrame(text, beat, kind))})`,
          );
        };

        // 1. The call, then its result. The line is paced, so the wait is for
        //    the call to be the one standing — and then it has to STAY, which
        //    a second wait past the dwell reads.
        await publish(SEARCH_BEAT, 1, "tool");
        await publish(SEARCH_RESULT, 2, "result");
        await app.waitForCondition<boolean>(lineReadsJS(SEARCH_BEAT), {
          timeoutMs: 20_000,
        });
        await new Promise((r) => setTimeout(r, 2_500));
        expect(
          await app.evalJS<boolean>(lineReadsJS(SEARCH_BEAT)),
          "the result never takes the line from the call it answers",
        ).toBe(true);

        // 2. An error result is news.
        await publish(LINT_ERROR, 3, "error");
        await app.waitForCondition<boolean>(lineReadsJS(LINT_ERROR), {
          timeoutMs: 20_000,
        });

        // 3. A wait is the beat while it is newest; the result that answers
        //    it is walked past, and so is the wait — the line reads the call.
        await publish(RUN_BEAT, 4, "tool");
        await publish(RUN_WAIT, 5, "wait");
        await app.waitForCondition<boolean>(lineReadsJS(RUN_WAIT), {
          timeoutMs: 20_000,
        });
        await publish(RUN_RESULT, 6, "result");
        await app.waitForCondition<boolean>(lineReadsJS(RUN_BEAT), {
          timeoutMs: 20_000,
        });

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
