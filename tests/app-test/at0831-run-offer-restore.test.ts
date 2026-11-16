/**
 * at0831-run-offer-restore.test.ts — a runnable offer's result survives a
 * reload, under the fence it was run from.
 *
 * A committed assistant turn carries a `tugrun` fence. Its Play is pressed,
 * the command runs through the card's real shell session, and tugcast ledgers
 * the exchange with the offer's key beside it. Then the card's own page is
 * reloaded: a real `spawn_session(resume)` replays the turn from a fixture
 * JSONL while the ledgered exchange restores through `list_shell_exchanges`.
 * The test holds the reloaded card to three things:
 *
 *   1. **The result is back under its fence.** The same output, exit and
 *      directory are read inside the offer's frame, though nothing ran after
 *      the reload.
 *   2. **It did not come back as a turn.** The transcript holds no shell row:
 *      the ledger row was recognised as the offer's and seated there.
 *   3. **The result still offers itself to the model.** Add to context is on
 *      the restored result, and a press queues it.
 *
 * The fixture's assistant message carries the same id the live frames do,
 * which is what makes this a round trip: the key the press wrote is the key
 * the replayed message derives.
 *
 * @covers tugdeck/src/lib/run-offer-store.ts
 * @covers tugdeck/src/lib/run-offer-binding.ts
 * @covers tugdeck/src/lib/markdown/enhance-run-offer.ts
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugdeck/src/components/tugways/cards/use-run-offers.ts
 * @covers tugrust/crates/tugcast/src/shell_ledger.rs
 * @covers tugrust/crates/tugcast/src/feeds/shell.rs
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";
import { waitForBodyReady } from "./_harness/card-reach";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";
import { claudeProjectDir } from "./_harness/claude-home";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

// UUID-shaped so the reload's real `claude --resume` accepts it.
const SID = "a7c0d1ea-0000-4000-8000-000000000831";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const FRAME = `${CARD} .tugx-md-run`;
const PLAY = `${FRAME} .tugx-md-run-play`;
const ADD = `${FRAME} .tugx-md-run-add`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const MSG_ID = "msg-offer-831";
const MARK = "offer-survives-reload";
const REPLY = "Run this to check:\n\n```tugrun\necho " + MARK + "\n```\n";

/**
 * The turn the reload replays: the same question and the same reply the live
 * frames carried, under the same assistant message id. Carries claude's own
 * session-JSONL fields so a real `claude --resume` accepts the file.
 */
function buildFixtureJsonl(cwd: string, sessionId: string): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const t0 = new Date(Date.now() - 2000).toISOString();
  const t1 = new Date(Date.now() - 1000).toISOString();
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "00000000-0000-4000-8000-000000831e01",
      timestamp: t0,
      message: { role: "user", content: [{ type: "text", text: "how do I check it" }] },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000831e01",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000831e02",
      timestamp: t1,
      message: {
        id: MSG_ID,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: REPLY }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1200,
          output_tokens: 50,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 8000,
        },
      },
    },
  ];
  return lines.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

let projectDir = "";
let fixtureDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // realpath: tugcode/claude resolve `/var` → `/private/var` before encoding
  // the claude-projects subdir, and the shell reports the resolved path.
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0831-proj-")));
  fixtureDir = claudeProjectDir(projectDir);
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${SID}.jsonl`), buildFixtureJsonl(projectDir, SID));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
  if (fixtureDir !== "" && existsSync(fixtureDir)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

interface ResultFacts {
  frames: number;
  tone: string;
  output: string;
  status: string;
  cwd: string;
  addShown: boolean;
  addPressed: string;
  shellRows: number;
}

function resultFacts(app: App): Promise<ResultFacts> {
  return app.body("A").evalJS<ResultFacts>(
    `(function(){
      var frames = document.querySelectorAll(${JSON.stringify(FRAME)});
      var frame = frames[0] || null;
      var q = function(sel){ return frame ? frame.querySelector(sel) : null; };
      var text = function(sel){ var el = q(sel); return el ? el.textContent : ""; };
      var result = q(".tugx-md-run-result");
      var add = q(".tugx-md-run-add");
      return {
        frames: frames.length,
        tone: result ? (result.getAttribute("data-tone") || "") : "",
        output: text(".tugx-md-run-output"),
        status: text(".tugx-md-run-status"),
        cwd: text(".tugx-md-run-cwd"),
        addShown: add !== null && getComputedStyle(add).display !== "none",
        addPressed: add ? (add.getAttribute("aria-pressed") || "") : "",
        shellRows: document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}).length,
      };
    })()`,
  );
}

/** Block until the offer's frame holds a settled result. */
function awaitSettledResult(app: App, timeoutMs: number): Promise<boolean> {
  return app.body("A").waitForCondition<boolean>(
    `(function(){
      var result = document.querySelector(${JSON.stringify(`${FRAME} .tugx-md-run-result`)});
      return result !== null && result.getAttribute("data-tone") === "ok";
    })()`,
    { timeoutMs },
  );
}

/**
 * Where Add to context is, and whether a click at its centre would land on
 * it. A native click goes to a point, so a control scrolled out of the card
 * or covered by another element is a miss, not a press.
 */
function addPlace(app: App): Promise<{ top: number; hit: string }> {
  return app.body("A").evalJS<{ top: number; hit: string }>(
    `(function(){
      var add = document.querySelector(${JSON.stringify(ADD)});
      if (add === null) return { top: -1, hit: "absent" };
      var r = add.getBoundingClientRect();
      var at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      var hit = at === null ? "nothing" : add.contains(at) ? "add" : (at.tagName + "." + at.className);
      return { top: Math.round(r.top), hit: hit };
    })()`,
  );
}

/**
 * Press Add to context and block until it reads `pressed`.
 *
 * The result has only just been drawn, and the transcript follows its own
 * foot as it grows, so the control is pressed once it has stopped moving.
 */
async function pressAdd(app: App, pressed: "true" | "false"): Promise<void> {
  let place = await addPlace(app);
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 120));
    const next = await addPlace(app);
    const still = next.top === place.top && next.hit === place.hit;
    place = next;
    if (still) break;
  }
  expect(place.hit, "a click at Add to context's centre lands on it").toBe("add");
  // What the page saw of the press, for a failure to name.
  await app.body("A").evalJS<null>(
    `(window.__at0831Click = "none", document.addEventListener("click", function(e){
      var t = e.target;
      window.__at0831Click = (t && t.tagName ? t.tagName : "?") + "." + (t && t.getAttribute ? (t.getAttribute("class") || "") : "");
    }, { capture: true, once: true }), null)`,
  );
  await app.body("A").nativeClickAtElement(ADD);
  try {
    await app.body("A").waitForCondition<boolean>(
      `(function(){
        var add = document.querySelector(${JSON.stringify(ADD)});
        return add !== null && add.getAttribute("aria-pressed") === ${JSON.stringify(pressed)};
      })()`,
      { timeoutMs: 4000 },
    );
  } catch (err) {
    const seen = await app.body("A").evalJS<string>(`String(window.__at0831Click)`);
    const after = await addPlace(app);
    throw new Error(
      `Add to context never read aria-pressed=${pressed}; the page's click target was ` +
        `"${seen}", the control sat at top ${place.top} before and ${after.top} after ` +
        `(hit: ${after.hit})`,
      { cause: err },
    );
  }
}

describe.skipIf(!SHOULD_RUN)("AT0831: a runnable offer's result survives a reload", () => {
  test(
    "the result is ledgered with its offer and restores under the same fence",
    async () => {
      // Persisted and restored as the app is, so the reloaded page comes
      // back holding its card.
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: "at0831-run-offer-restore",
        persistInTestMode: true,
        restoreInTestMode: true,
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({
          state: sessionCardShape(SESSION_CARD_SIZE_SHORT, { title: "Session A" }),
          focusCardId: "A",
        });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID, projectDir });
        await app.awaitEngineReady("A");

        // --- A committed turn whose reply offers a command. ---
        await app.driveSession("A", { op: "send", text: "how do I check it" });
        const frame = (decoded: Record<string, unknown>) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: { tug_session_id: SID, ...decoded },
          });
        await frame({ type: "prompt_anchor", promptUuid: "uuid-1" });
        await frame({ type: "content_block_start", msg_id: MSG_ID, block_index: 0, kind: "text" });
        await frame({
          type: "assistant_text",
          seq: 0,
          rev: 0,
          status: "complete",
          msg_id: MSG_ID,
          block_index: 0,
          text: REPLY,
          is_partial: false,
        });
        await frame({ type: "turn_complete", seq: 0, msg_id: MSG_ID, result: "success" });
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var play = document.querySelector(${JSON.stringify(PLAY)});
            return play !== null && !play.disabled;
          })()`,
          { timeoutMs: 8000 },
        );

        // --- One press runs it through the real shell, and it is ledgered. ---
        await app.body("A").nativeClickAtElement(PLAY);
        await awaitSettledResult(app, 20_000);
        const live = await resultFacts(app);
        expect(live.output, "the live run's output is under the command").toContain(MARK);
        expect(live.addShown, "a settled result offers Add to context").toBe(true);
        expect(live.addPressed, "nothing is queued until it is pressed").toBe("false");
        expect(live.shellRows).toBe(0);
        // A press queues the result, and a second takes it back out.
        await pressAdd(app, "true");
        await pressAdd(app, "false");

        // --- The card's own page reloads: resume replay + ledger restore. ---
        await app.body("A").evalJS<boolean>(`(window.__at0831Before = true)`);
        await app.body("A").evalJS<null>(`(location.reload(), null)`);
        await app.body("A").waitForCondition<boolean>(
          `window.__at0831Before !== true && typeof window.__tug !== "undefined"`,
          { timeoutMs: 15_000 },
        );
        await waitForBodyReady(app, "A");
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir });

        // Nothing runs after the reload: the result can only be the ledger's.
        await awaitSettledResult(app, 20_000);
        const restored = await resultFacts(app);
        expect(restored.frames, "the replayed turn draws its one offer").toBe(1);
        expect(restored.output, "the ledgered output is back under the command").toContain(MARK);
        expect(restored.status).toBe("exit 0");
        expect(restored.cwd, "the footer still names the directory it ran in").toBe(projectDir);
        expect(restored.shellRows, "the offer's ledger row did not restore as a turn").toBe(0);

        // --- The restored result still offers itself to the model. ---
        expect(restored.addShown).toBe(true);
        await pressAdd(app, "true");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
