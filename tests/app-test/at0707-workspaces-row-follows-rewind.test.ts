/**
 * at0707-workspaces-row-follows-rewind.test.ts — after a rewind fork, the
 * Workspaces row shows the conversation that is left.
 *
 * A forking rewind writes everything after it under a new segment id, pushes
 * `session_updated` for that id, and announces it as the card's seat with
 * `session_line_seated`. The card's address (`tugSessionId`) does not move.
 * The row used to read its facts off the address, so its turn count and last
 * prompt stayed at their pre-rewind values for good: nothing writes that
 * segment's row again.
 *
 * Store-only, like `at0097`: there is no live claude, so the frames tugcast
 * sends around a rewind are delivered through the production handlers
 * (`session_updated`, `session_line_seated`) in the order the bridge sends
 * them. Three readings on one Workspaces row:
 *
 *  1. The three-turn session reads `3 turns` and its third prompt.
 *  2. The rewind's fork row and seat land; the row reads `2 turns` and the
 *     second prompt, and still files under the card's address.
 *  3. A late push about the pre-rewind segment does not move the row back,
 *     and the next turn on the fork does move it.
 *
 * @covers tugdeck/src/components/cards/cards-session-cell.tsx
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/lib/card-session-binding-store.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// UUID-shaped so the bound session and its fork read as real ones.
const SID = "a7c0d1ea-0000-4000-8000-000000000707";
const FORK = "a7c0d1ea-0000-4000-8000-0000000f0707";
const LINE = "a7c0d1ea-0000-4000-8000-00000011e707";

const PROMPT_2 = "Teach the lexer about raw strings";
const PROMPT_3 = "Rework the parser around the new tokens";
const PROMPT_NEXT = "Add a test for raw strings instead";

const ROW = `.cards-card [data-session-id="${SID}"]`;

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0707-proj-")));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
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

/** A `session_updated` body carrying a whole ledger row, as the supervisor
 *  pushes it after a write. */
function sessionUpdated(sessionId: string, turns: number, prompt: string, at: number): string {
  return JSON.stringify({
    session_id: sessionId,
    fields: {
      session_id: sessionId,
      line_id: LINE,
      workspace_key: projectDir,
      project_dir: projectDir,
      created_at: at - 60_000,
      last_used_at: at,
      turn_count: turns,
      last_user_prompt: prompt,
      state: "live",
      card_id: "A",
      background: false,
      name: null,
      name_user_set: false,
    },
  });
}

async function publish(app: App, body: string): Promise<void> {
  expect(await app.evalJS<boolean>(`window.__tug.publishSessionUpdated(${JSON.stringify(body)})`)).toBe(
    true,
  );
}

const rowText = (app: App): Promise<string> =>
  app.evalJS<string>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(ROW)});
       return el === null ? "" : (el.textContent || "").replace(/\\s+/g, " ").trim();
     })()`,
  );

async function waitForRow(app: App, turns: string, prompt: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(ROW)});
       if (el === null) return false;
       var t = (el.textContent || "").replace(/\\s+/g, " ");
       return t.indexOf(${JSON.stringify(turns)}) !== -1 && t.indexOf(${JSON.stringify(prompt)}) !== -1;
     })()`,
    { timeoutMs: 20_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0707: the Workspaces row follows a rewind", () => {
  test(
    "a fork rewind drops the row's turn count and last prompt",
    async () => {
      const app = await launchTugApp({ testName: "at0707-workspaces-row-follows-rewind" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID, projectDir });
        await app.dispatchControlAction("toggle-cards");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 20_000 },
        );

        // 1. Three turns on the card's own segment.
        const before = Date.now();
        await publish(app, sessionUpdated(SID, 3, PROMPT_3, before));
        await waitForRow(app, "3 turns", PROMPT_3);
        note("at0707 before rewind", await rowText(app));

        // 2. The rewind forks: the kept two turns are written under a new id,
        //    which is pushed and then announced as the card's seat.
        await publish(app, sessionUpdated(FORK, 2, PROMPT_2, before + 1_000));
        await app.dispatchControlAction("session_line_seated", {
          card_id: "A",
          session_id: FORK,
          line_id: LINE,
        });
        await waitForRow(app, "2 turns", PROMPT_2);
        const after = await rowText(app);
        note("at0707 after rewind", after);
        expect(after, "the rewound prompt is gone from the row").not.toContain(PROMPT_3);
        expect(after).not.toContain("3 turns");
        // The row still files under the card's address.
        expect(
          await app.evalJS<number>(`document.querySelectorAll(${JSON.stringify(ROW)}).length`),
        ).toBe(1);

        // 3. The pre-rewind segment's row stays live, and a push about it does
        //    not move the row back onto the conversation that was rewound away.
        //    The next turn on the fork does move it, and since pushes are
        //    handled in order, seeing it means the stale push was handled too.
        await publish(app, sessionUpdated(SID, 3, PROMPT_3, before + 2_000));
        await publish(app, sessionUpdated(FORK, 3, PROMPT_NEXT, before + 3_000));
        await waitForRow(app, "3 turns", PROMPT_NEXT);
        const late = await rowText(app);
        note("at0707 next turn on the fork", late);
        expect(late).not.toContain(PROMPT_3);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
