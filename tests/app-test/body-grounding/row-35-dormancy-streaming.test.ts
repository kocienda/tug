/**
 * row-35-dormancy-streaming.test.ts — a body shown while a turn streams, with
 * turns behind that one that finished while it slept, catches up on every
 * finished turn once and follows the streaming one to its end.
 *
 * A Session card's own session runs one turn, heard whole, and then a long
 * second the card sends itself. Its workspace is parked under the second;
 * the body goes dormant past its delay and the second ends unheard. Two more
 * prompts reach the session from outside the card while it sleeps, as the
 * arc wheel's do: a short third, which finishes, and a long fourth, still
 * streaming when the workspace is shown again. Revealed, the body asks for
 * what it missed before it re-subscribes, and sets aside whatever the session
 * says between the two until the bracket that answers opens: the second and
 * third turns land committed, each once, and the fourth arrives as the
 * bracket's snapshot and streams on live to its end — once, and whole.
 *
 * @covers tugdeck/src/body/body-dormancy.ts
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/lib/code-session-store.ts
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
import { STUB_TRANSCRIPT_DIR_ENV, STREAM_PACE_MS, stubDirectory, streamingTranscript } from "../streaming-stub-fixture";
import { bodyOf, pollFor, promptPhase, sessionPane, waitForBody } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r35s-a";
/** The body's delay before dormancy, shortened from a minute for the row. */
const DORMANT_AFTER_MS = 800;
/** Words in the long turns: the one slept through, and the one streaming at reveal. */
const HELD_WORDS = 80;
const STREAMING_WORDS = 200;
/** The last words of the turn streaming at reveal: present only once its end has reached the page. */
const MARKER = "streaming-turn-ends-here";
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

/** Turn `t`'s one message: the first and third a word, the second and fourth long, the fourth ending with the marker. */
function text(t: number): string {
  const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${t}-${i}`).join(" ");
  if (t === 1) return words(HELD_WORDS);
  if (t === 3) return `${words(STREAMING_WORDS - 1)} ${MARKER}`;
  return `turn${t}-short`;
}

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** How many times turn `t`'s message is in the card's transcript, read from the store: the list renders only the rows in view. */
const turnCount = (t: number): string => `ids.filter(function (id) { return id === "stub-msg-${t}"; }).length`;

/** In the body: its dormancy, its prompt phase, each turn's count, and how often the marker is in the transcript's text. */
const READ = `(function () {
  var d = window.__tug.bodyDormancy();
  var ids = [];
  try { ids = window.__tug.inkRestoreFacts(${JSON.stringify(A)}).order.map(function (t) { return t.msgId; }); } catch (e) {}
  var text = ((document.querySelector('[data-testid="session-card-transcript"]') || {}).textContent || "");
  return { dormant: d.dormant, phase: ${promptPhase}, turns: ids.length, first: ${turnCount(0)}, held: ${turnCount(1)}, behind: ${turnCount(2)}, streamed: ${turnCount(3)}, ended: text.split(${JSON.stringify(MARKER)}).length - 1 };
})()`;

interface Read {
  dormant: boolean;
  phase: string | null;
  turns: number;
  first: number;
  held: number;
  behind: number;
  streamed: number;
  ended: number;
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 35: a turn streaming at reveal", () => {
  test(
    "a body shown mid-turn lands the turns that finished behind it once and follows the streaming one to its end",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "body-grounding-row-35-dormancy-streaming", env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r35s-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(1, 4, text)));
        await app.spawnSessionNew(A, { tugSessionId, projectDir });
        await waitForBody(app, A);
        const body = app.body(A);
        await body.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.body-dormancy", "dormantAfterMs", { kind: "i64", value: ${DORMANT_AFTER_MS} }), null)`,
        );
        await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 10_000 });

        // ---- The first turn, heard whole; the second sent, and the workspace parked under it ----
        await body.driveSession({ op: "send", text: "The first turn." });
        await pollFor(() => body.evalJS<Read>(READ), (r) => r.first === 1 && r.phase === "idle", 10_000);
        await body.driveSession({ op: "send", text: "The second turn, slept through." });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 10_000 });
        const heldAt = Date.now();
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        await pollFor(() => body.evalJS<Read>(READ), (r) => r.dormant, 5_000);

        // ---- Asleep: two prompts reach the session from outside the card ----
        await body.driveSession({ op: "promptElsewhere", text: "The third turn, finished behind." });
        await body.driveSession({ op: "promptElsewhere", text: "The fourth turn, streaming at the reveal." });
        // The stub paces its turns one after another: show the body once the
        // second has ended and the fourth is well under way.
        const heldMs = (HELD_WORDS + 3) * STREAM_PACE_MS;
        await Bun.sleep(Math.max(0, heldAt + heldMs + 1_200 - Date.now()));
        const asleep = await body.evalJS<Read>(READ);
        note(`asleep: ${JSON.stringify(asleep)}`);
        expect(asleep, "nothing sent while the body slept reached it").toMatchObject({ dormant: true, held: 0, behind: 0, streamed: 0 });

        // ---- Shown again: the finished turns land, and the streaming one goes on ----
        const revealAt = Date.now();
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        const caught = await pollFor(() => body.evalJS<Read>(READ), (r) => !r.dormant && r.behind > 0, 10_000);
        note(`caught up ${Date.now() - revealAt} ms after the switch: ${JSON.stringify(caught)}`);
        expect(caught, "awake with the turns that finished behind the streaming one, each once, and that one still running").toMatchObject({
          dormant: false,
          phase: "streaming",
          first: 1,
          held: 1,
          behind: 1,
          streamed: 0,
        });

        const done = await pollFor(() => body.evalJS<Read>(READ), (r) => r.phase === "idle" && r.streamed > 0, 15_000);
        note(`settled ${Date.now() - revealAt} ms after the switch: ${JSON.stringify(done)}`);
        expect(done, "the streaming turn ended once and whole, every turn before it once").toMatchObject({
          dormant: false,
          phase: "idle",
          turns: 4,
          first: 1,
          held: 1,
          behind: 1,
          streamed: 1,
          ended: 1,
        });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
