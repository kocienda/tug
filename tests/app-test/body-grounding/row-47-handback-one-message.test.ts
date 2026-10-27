/**
 * row-47-handback-one-message.test.ts — a workspace hidden mid-turn hands
 * its card back with the turn's one user message, once.
 *
 * A Session card sends a prompt and its turn streams. Its workspace is
 * parked under the turn; the body goes dormant past its delay and hears
 * nothing more. Shown again while the turn still streams, the body catches
 * up: the bracket that answers carries the turn in flight as a snapshot,
 * opened by a copy of the same user message, with the submission's id. The
 * card holds the message it sent and the copy is the same submission, so
 * the card reads the prompt once — at the catch-up, and again once the turn
 * has ended.
 *
 * The turn streams on the streaming stub, not on tugcode's session: the
 * snapshot opener under test is the stub's (`openerFields` in
 * `stub-replay.ts`), and what this row proves is the deck's half — the body
 * catching up and the reducer keeping one submission one message, counted in
 * the store. That production's snapshot opener carries the submission's id
 * is owned by `tugcode/src/__tests__/inflight-turn-snapshot.test.ts`, and the
 * JSONL-then-snapshot sequence by the reducer's `catch-up.test.ts`.
 *
 * @family row-47
 * @covers tugdeck/src/body/body-dormancy.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugcode/src/stub-replay.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory, streamingTranscript } from "../streaming-stub-fixture";
import { bodyOf, pollFor, promptPhase, sessionPane, settleFor, waitForBody } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r47m-a";
/** The body's delay before dormancy, shortened from a minute for the row. */
const DORMANT_AFTER_MS = 800;
/** Words in the turn: long enough to be streaming still at the reveal. */
const WORDS = 240;
/** A word only the prompt carries. */
const MARKER = "handback-one-message-marker";
const PROMPT = `The one message, ${MARKER}.`;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** In the body: its dormancy, its prompt phase, and how many of the card's user messages are the prompt. */
const READ = `(function () {
  var texts = window.__tug.userMessageTexts(${JSON.stringify(A)}) || [];
  return {
    dormant: window.__tug.bodyDormancy().dormant,
    phase: ${promptPhase},
    users: texts.length,
    prompts: texts.filter(function (t) { return t.indexOf(${JSON.stringify(MARKER)}) >= 0; }).length,
  };
})()`;

interface Read {
  dormant: boolean;
  phase: string | null;
  users: number;
  prompts: number;
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 47: a hidden card's hand-back", () => {
  test(
    "a body shown mid-turn after sleeping through part of it holds the turn's user message once",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "body-grounding-row-47-handback-one-message", env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r47m-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        const words = Array.from({ length: WORDS }, (_, i) => `word${i}`).join(" ");
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(1, 1, () => words)));
        await app.spawnSessionNew(A, { tugSessionId, projectDir });
        await waitForBody(app, A);
        const body = app.body(A);
        await app.bodyDelays({ dormantAfterMs: DORMANT_AFTER_MS });
        await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 10_000 });

        // ---- The prompt goes out and its turn streams; the workspace is parked under it ----
        await body.driveSession({ op: "send", text: PROMPT });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 10_000 });
        const sent = await body.evalJS<Read>(READ);
        expect(sent, "the card holds the prompt it sent").toMatchObject({ users: 1, prompts: 1 });
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        await pollFor(() => body.evalJS<Read>(READ), (r) => r.dormant, 5_000);

        // ---- Shown again mid-turn: the catch-up's snapshot is the same submission ----
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        const caught = await settleFor(() => body.evalJS<Read>(READ), (r) => !r.dormant && r.phase === "streaming", 10_000);
        note(`caught up: ${JSON.stringify(caught)}`);
        expect(caught, "awake mid-turn, with the prompt once").toMatchObject({ dormant: false, phase: "streaming", users: 1, prompts: 1 });

        const done = await settleFor(() => body.evalJS<Read>(READ), (r) => r.phase === "idle", 15_000);
        note(`settled: ${JSON.stringify(done)}`);
        expect(done, "the turn ended with the prompt once").toMatchObject({ dormant: false, phase: "idle", users: 1, prompts: 1 });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
