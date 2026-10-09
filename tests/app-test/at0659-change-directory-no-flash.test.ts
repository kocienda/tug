/**
 * at0659-change-directory-no-flash.test.ts — `/cd` goes straight from the
 * pre-move transcript to the post-move one, with no frame between them that
 * shows an empty card.
 *
 * ## Why this exists
 *
 * A directory change re-binds the card to a new tug session, and the card's
 * transcript is drawn by that session's replay. If the deck swaps the
 * transcript store at the re-bind, the card is empty for as long as tugcode
 * takes to start and replay — the "horrid flash" the user reported. A
 * final-state assertion cannot see that: the card ends up correct either way.
 * So this file arms a per-frame recorder before `/cd` is sent and reads every
 * frame the window painted, from the keystroke to the settled post-move card.
 *
 * ## What it reads
 *
 * Once per animation frame the recorder notes whether the card's transcript
 * is mounted, how many entries it holds, whether its text still carries the
 * pre-move conversation's word, whether the `Directory changed` divider is
 * there, and which tug session the card is bound to. A frame that lacks the
 * word — an empty card, or a card showing anything but the carried turn — is
 * a flash frame, and any one of them fails the file. The census of those
 * frames (where they start relative to the re-bind, how long they last) is
 * noted either way, because it is what says what a flash actually is.
 *
 * A covered window suspends `requestAnimationFrame`, and a suspended recorder
 * sees no frames at all — which would read as no flash. So the file also
 * fails when the move window yields too few frames to have been watched.
 *
 * ## The gate
 *
 * The move spawns a real `claude --resume … --fork-session`, as every
 * `spawnSessionResume` app-test does, but sends no prompt, so it needs no
 * credentials the harness lacks: it waits on the replay, never on claude's
 * connect, and a run takes seconds. So it runs in the ordinary selection.
 *
 * Sampled against an immediate swap, the flash was the card's re-bind frame:
 * the transcript stays mounted but drops to zero entries the frame the binding
 * moves, and stays empty until the new session's replay lands — four or five
 * frames, 37–45 ms. The held swap in `card-services-store.ts` is what this
 * file holds to.
 *
 * @covers tugdeck/src/lib/card-services-store.ts
 * @covers tugdeck/src/lib/directory-change.ts
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { claudeProjectDir } from "./_harness/claude-home";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 300_000;

/** The parent session in `A`. `claude --resume` needs a UUID. */
const PARENT_SID = "a7c0d1ea-0000-4000-8000-000000000659";
/** The word the pre-move conversation carries. */
const WORD = "AMBER-KESTREL";

const CARD = '[data-card-id="A"]';
const TRANSCRIPT = `${CARD} .session-card-transcript`;
const DIVIDER = `${TRANSCRIPT} [data-boundary="relocation"]`;
const ENTRY = `${TRANSCRIPT} .tug-transcript-entry`;
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;

/**
 * The fewest frames the move window must yield to count as watched. The
 * window runs from the keystroke through a tugcode start and a replay — well
 * over a second on any machine — so a served 60 Hz window paints far more.
 */
const MIN_FRAMES = 30;

let dirA = "";
let dirB = "";


/** The parent's history: one turn that carries the word. */
function seedParent(): void {
  mkdirSync(claudeProjectDir(dirA), { recursive: true });
  const base = {
    isSidechain: false,
    userType: "external",
    cwd: dirA,
    sessionId: PARENT_SID,
    version: "2.1.105",
    gitBranch: "main",
  };
  const rows = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "00000000-0000-4000-8000-000000065901",
      timestamp: new Date(Date.now() - 2000).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: `Please remember the code word ${WORD}.` }],
      },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000065901",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000065902",
      timestamp: new Date(Date.now() - 1000).toISOString(),
      message: {
        id: "msg-at0659-parent",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: `Understood — the code word is ${WORD}.` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 20 },
      },
    },
  ];
  writeFileSync(
    join(claudeProjectDir(dirA), `${PARENT_SID}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dirA = realpathSync(mkdtempSync(join(tmpdir(), "at0659-A-")));
  dirB = realpathSync(mkdtempSync(join(tmpdir(), "at0659-B-")));
  seedParent();
});

afterAll(() => {
  for (const dir of [dirA, dirB]) {
    if (dir === "") continue;
    rmSync(dir, { recursive: true, force: true });
    rmSync(claudeProjectDir(dir), { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
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

/** One painted frame, as the recorder saw it. */
interface Frame {
  /** `performance.now()` at the frame, relative to the keystroke. */
  t: number;
  mounted: boolean;
  entries: number;
  word: boolean;
  divider: boolean;
  sid: string;
}

/** Arm the recorder. It runs until `__at0659.stop` is set. */
const ARM = `(() => {
  const rec = { frames: [], stop: false, sentAt: performance.now() };
  window.__at0659 = rec;
  const tick = (now) => {
    const tr = document.querySelector(${JSON.stringify(TRANSCRIPT)});
    const text = tr?.textContent ?? "";
    let sid = "";
    try { sid = window.__tug.cardLineFacts("A").tugSessionId; } catch { sid = "?"; }
    rec.frames.push({
      now,
      mounted: tr !== null,
      entries: document.querySelectorAll(${JSON.stringify(ENTRY)}).length,
      word: text.includes(${JSON.stringify(WORD)}),
      divider: document.querySelector(${JSON.stringify(DIVIDER)}) !== null,
      sid,
    });
    if (!rec.stop && rec.frames.length < 20000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

/** The carried turn, then the divider naming both directories. */
const carriedThenDivider = (): string => `(() => {
  const divider = document.querySelector(${JSON.stringify(DIVIDER)});
  if (divider === null) return false;
  const text = divider.textContent ?? "";
  if (!text.includes(${JSON.stringify(dirA)}) || !text.includes(${JSON.stringify(dirB)})) return false;
  const all = document.querySelector(${JSON.stringify(TRANSCRIPT)})?.textContent ?? "";
  const word = all.indexOf(${JSON.stringify(WORD)});
  return word !== -1 && word < all.indexOf(text);
})()`;

/** Stop the recorder and read its frames back, timed from the keystroke. */
async function collect(app: App): Promise<Frame[]> {
  return app.evalJS<Frame[]>(`(() => {
    const rec = window.__at0659;
    rec.stop = true;
    return rec.frames.map((f) => ({
      t: Math.round((f.now - rec.sentAt) * 10) / 10,
      mounted: f.mounted, entries: f.entries, word: f.word, divider: f.divider, sid: f.sid,
    }));
  })()`);
}

/** Each run of consecutive flash frames, with the frames either side of it. */
function flashRuns(frames: Frame[]): Array<{ from: number; to: number; frames: number; shape: string }> {
  const runs: Array<{ from: number; to: number; frames: number; shape: string }> = [];
  let start = -1;
  for (let i = 0; i <= frames.length; i++) {
    const bad = i < frames.length && !frames[i].word;
    if (bad && start === -1) start = i;
    if (!bad && start !== -1) {
      const first = frames[start];
      const last = frames[i - 1];
      runs.push({
        from: first.t,
        to: last.t,
        frames: i - start,
        shape: JSON.stringify({
          before: frames[start - 1] ?? null,
          first,
          last,
          after: frames[i] ?? null,
        }),
      });
      start = -1;
    }
  }
  return runs;
}

describe.skipIf(!SHOULD_RUN)("AT0659: /cd never shows an empty card", () => {
  test(
    "every frame from the keystroke to the settled move shows the pre-move conversation",
    async () => {
      const app = await launchTugApp({ testName: "at0659-change-directory-no-flash" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: PARENT_SID, projectDir: dirA });
        // The replay is what draws the card, and it lands before claude's own
        // connect settles, which this file does not wait for (as at0192).
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(TRANSCRIPT)})?.textContent ?? "").includes(${JSON.stringify(WORD)})`,
          { timeoutMs: 30_000 },
        );

        // Type the command and dismiss its completion popup, then arm the
        // recorder immediately before the one key that sends it.
        await app.nativeClickAtElement(EDITOR);
        await app.nativeType(`/cd ${dirB}`);
        await new Promise((r) => setTimeout(r, 200));
        await app.nativeKey("Escape");
        await new Promise((r) => setTimeout(r, 200));
        await app.evalJS<boolean>(ARM);
        await app.nativeKey("Return", ["cmd"]);

        await app.waitForCondition<boolean>(
          `(() => { try {
             const f = window.__tug.cardLineFacts("A");
             return f.projectDir === ${JSON.stringify(dirB)} && f.tugSessionId !== ${JSON.stringify(PARENT_SID)};
           } catch { return false; } })()`,
          { timeoutMs: 60_000 },
        );
        await app.waitForCondition<boolean>(carriedThenDivider(), { timeoutMs: 60_000 });
        // A few more frames past the settle, so a late re-mount is caught too.
        await new Promise((r) => setTimeout(r, 750));
        const frames = await collect(app);

        const rebind = frames.find((f) => f.sid !== PARENT_SID && f.sid !== "?");
        const settled = frames.find((f) => f.word && f.divider);
        const runs = flashRuns(frames);
        note(
          "at0659 move window",
          JSON.stringify({
            frames: frames.length,
            spanMs: frames.length > 0 ? frames[frames.length - 1].t : 0,
            rebindAtMs: rebind?.t ?? null,
            settledAtMs: settled?.t ?? null,
            flashFrames: runs.reduce((n, r) => n + r.frames, 0),
          }),
        );
        for (const run of runs) {
          note(`at0659 flash ${run.from}–${run.to} ms (${run.frames} frames)`, run.shape);
        }

        expect(
          frames.length,
          `the move window was watched (${frames.length} frames; a covered window suspends rAF)`,
        ).toBeGreaterThanOrEqual(MIN_FRAMES);
        expect(rebind, "the recorder saw the card re-bind to the new session").toBeDefined();
        expect(settled, "the recorder saw the settled post-move card").toBeDefined();
        expect(
          runs.map((r) => `${r.from}–${r.to} ms, ${r.frames} frames`),
          "no frame shows the card without its pre-move conversation",
        ).toEqual([]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
