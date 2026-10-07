/**
 * at0719-restore-reveal-cover.test.ts — the deck says "busy" for exactly as
 * long as a restore's reveal makes it busy, and never for a wait on the wire.
 *
 * ## What this gates
 *
 * A cold restore's reveal is a Session card's first transcript list mount
 * and settle. It is one uninterruptible task on the main thread every card
 * shares, so the deck raises an app-wide busy cover over it. The cover is
 * allowed under [L33] only because nothing outside the deck opens or closes
 * it, and this test holds the three halves of that:
 *
 *   1. **Present across each reveal.** Every card's first list mount lands
 *      while the cover is up, and the cover names the work.
 *   2. **Absent while a card only waits on the wire.** Two cards sit inside
 *      an open replay bracket with nothing completing, and the cover never
 *      opens for them.
 *   3. **A silent relay never holds it.** One of those cards never hears
 *      `replay_complete`. Its own silence deadline ends its restore, its list
 *      mounts to show the failure, and the cover stays down throughout.
 *
 * ## How
 *
 * Two cards resume real transcripts through the genuine
 * `spawn_session(resume)` chain, the at0192 vehicle, with generated fixtures
 * large enough that each reveal is real work. Two more are bound in resume
 * mode with frames fed through the real `routeFrame` path, as in at0600, so
 * their replay brackets are wholly the test's: `W` completes when the test
 * says so, and `S` never does.
 *
 * Truth is read off the DOM by a recorder installed before anything is
 * restored. A `MutationObserver` logs every change of the cover's
 * `data-state` and the first appearance of each card's list region. Its
 * callback runs in the same task as the commit that mounted the list, so
 * the cover state it reads is the state the reveal ran under, and the
 * scrim's computed opacity it reads is what the user sees for the length
 * of that task: fully opaque, not part-way through an entrance fade.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/restore-reveal-queue.ts
 * @covers tugdeck/src/lib/restore-reveal-store.ts
 * @covers tugdeck/src/components/tugways/tug-restore-reveal-cover.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** `FeedId.CODE_OUTPUT`, hardcoded because the app-test graph does not import tugdeck. */
const CODE_OUTPUT_FEED = 0x40;

/** The two real-chain cards and their claude session ids. */
const REAL = ["R1", "R2"] as const;
const REAL_SIDS = REAL.map(() => randomUUID());
/** The controlled cards: `W` completes on cue, `S` never does. */
const SID_W = "test-session-at0719-w";
const SID_S = "test-session-at0719-s";

/** `REPLAY_SILENCE_DEADLINE_MS` is 15 s; this is a ceiling, not the expectation. */
const SILENCE_WAIT_MS = 35_000;

const COVER = '[data-slot="tug-restore-reveal-cover"]';

let projectDir = "";
let fixtureDir = "";

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
const encodeProjectDir = (absDir: string): string => absDir.replace(/[^A-Za-z0-9-]/g, "-");

/**
 * A resumable transcript of `turns` committed turns, each answer carrying
 * enough markdown (a heading, a list, a code block) that the reveal lays out
 * real rows rather than one-liners.
 */
function buildFixtureJsonl(cwd: string, sessionId: string, turns: number): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const lines: unknown[] = [];
  let parent: string | null = null;
  const t0 = Date.now() - 3_600_000;
  for (let i = 0; i < turns; i++) {
    const u = randomUUID();
    const a = randomUUID();
    lines.push({
      ...base,
      parentUuid: parent,
      type: "user",
      uuid: u,
      timestamp: new Date(t0 + i * 2000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: `Question ${i}: how does part ${i} work?` }] },
    });
    const body = [
      `## Part ${i}`,
      "",
      `Part ${i} reads its input, checks it, and hands it on.`,
      "",
      ...Array.from({ length: 6 }, (_, k) => `- step ${k}: the ${k}th thing part ${i} does, said at some length so it wraps`),
      "",
      "```ts",
      ...Array.from({ length: 12 }, (_, k) => `const v${k} = compute(${i}, ${k}); // line ${k}`),
      "```",
    ].join("\n");
    lines.push({
      ...base,
      parentUuid: u,
      type: "assistant",
      uuid: a,
      timestamp: new Date(t0 + i * 2000 + 1000).toISOString(),
      message: {
        id: `msg-${sessionId.slice(-6)}-${i}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: body }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 8000 },
      },
    });
    parent = a;
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0719-")));
  writeFileSync(join(projectDir, "README.md"), "at0719\n");
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(projectDir));
  mkdirSync(fixtureDir, { recursive: true });
  REAL_SIDS.forEach((sid) => {
    writeFileSync(join(fixtureDir, `${sid}.jsonl`), buildFixtureJsonl(projectDir, sid, 60));
  });
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
  if (fixtureDir !== "" && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
});

const ALL = ["R1", "R2", "W", "S"] as const;

function deckShape() {
  return {
    cards: ALL.map((id) => ({ id, componentId: "session", title: `Session ${id}`, closable: true })),
    panes: ALL.map((id, i) => ({
      id: `p${id}`,
      position: { x: 20 + (i % 2) * 560, y: 20 + Math.floor(i / 2) * 420 },
      size: { width: 540, height: 400 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
    })),
    activePaneId: "pR1",
    hasFocus: true,
  };
}

/** One recorded event: the cover changing state, or a card's list region first appearing. */
interface Ev {
  t: number;
  kind: "cover" | "mount";
  card?: string;
  state: "open" | "closed";
  text?: string;
  /** At a mount: the cover scrim's computed opacity, or null with no scrim. */
  opacity?: string | null;
}

/**
 * Install the recorder. It logs the cover's `data-state` changes, with the
 * text the cover showed when it opened, and each card's first list mount,
 * with the cover state at that moment.
 */
const INSTALL_RECORDER = `(function(){
  var cards = ${JSON.stringify(ALL)};
  var log = [];
  var seen = {};
  var coverState = function(){
    var c = document.querySelector(${JSON.stringify(COVER)});
    return c === null ? "missing" : c.getAttribute("data-state");
  };
  var last = coverState();
  log.push({ t: performance.now(), kind: "cover", state: last });
  var check = function(){
    var now = coverState();
    if (now !== last) {
      var c = document.querySelector(${JSON.stringify(COVER)});
      log.push({ t: performance.now(), kind: "cover", state: now, text: c ? (c.textContent || "") : "" });
      last = now;
    }
    for (var i = 0; i < cards.length; i++) {
      var id = cards[i];
      if (seen[id]) continue;
      if (document.querySelector('[data-card-id="' + id + '"] [data-slot="tug-list-view"]') !== null) {
        seen[id] = true;
        var scrim = document.querySelector(${JSON.stringify(COVER + " .tug-alert-overlay")});
        log.push({ t: performance.now(), kind: "mount", card: id, state: now, opacity: scrim === null ? null : getComputedStyle(scrim).opacity });
      }
    }
  };
  check();
  var mo = new MutationObserver(check);
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
  window.__at0719 = { log: log, unmountedNow: function(){
    var out = [];
    for (var i = 0; i < cards.length; i++) {
      if (document.querySelector('[data-card-id="' + cards[i] + '"] [data-slot="tug-list-view"]') === null) out.push(cards[i]);
    }
    return out;
  },
  // A resume-mode card's list is up until its bracket opens, and that is not
  // a reveal. Called once every card is held: forget every mount seen so far,
  // so only what mounts after this point is recorded.
  reset: function(){
    for (var j = log.length - 1; j >= 0; j--) if (log[j].kind === "mount") log.splice(j, 1);
    seen = {};
  },
  stop: function(){ mo.disconnect(); } };
  return null;
})()`;

const readLog = "window.__at0719.log";
const coverIs = (state: "open" | "closed") =>
  `(document.querySelector(${JSON.stringify(COVER)}) || {}).getAttribute && document.querySelector(${JSON.stringify(COVER)}).getAttribute("data-state") === ${JSON.stringify(state)}`;
const mountedAfter = (card: string) =>
  `window.__at0719.log.some(function(e){ return e.kind === "mount" && e.card === ${JSON.stringify(card)}; })`;

const userMsg = (sid: string, text: string) => ({
  type: "add_user_message",
  tug_session_id: sid,
  content: [{ type: "text", text }],
});
const asstText = (sid: string, msgId: string, text: string, seq: number) => ({
  type: "assistant_text",
  tug_session_id: sid,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq,
});
const turnDone = (sid: string, msgId: string) => ({
  type: "turn_complete",
  tug_session_id: sid,
  msg_id: msgId,
  result: "success",
});

describe.skipIf(!SHOULD_RUN)("at0719 — the restore reveal cover is the deck's own work", () => {
  test(
    "the cover is up across every reveal, down while cards wait on the wire, and a silent relay never holds it",
    async () => {
      const app = await launchTugApp({ testName: "at0719-restore-reveal-cover" });
      const ingest = (card: string, decoded: unknown) =>
        app.driveSession(card, { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });

      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "R1" });
        for (const id of ALL) {
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(id)})`,
            { timeoutMs: 30_000 },
          );
        }

        // ── S and W open replay brackets and wait on the wire ─────────
        await app.bindSession("S", { tugSessionId: SID_S, sessionMode: "resume" });
        await app.bindSession("W", { tugSessionId: SID_W, sessionMode: "resume" });
        await app.evalJS<null>(INSTALL_RECORDER);
        await ingest("S", { type: "replay_started", tug_session_id: SID_S });
        await ingest("S", userMsg(SID_S, "anyone there"));
        await ingest("S", asstText(SID_S, "s1", "The relay is about to go quiet.", 1));
        await ingest("S", turnDone(SID_S, "s1"));
        await ingest("W", { type: "replay_started", tug_session_id: SID_W });
        await ingest("W", userMsg(SID_W, "first question"));
        await ingest("W", asstText(SID_W, "w1", "A first answer, restored from the wire.", 1));
        await ingest("W", turnDone(SID_W, "w1"));

        // Both are inside their brackets with their lists held back...
        await app.waitForCondition<boolean>(
          `(function(){ var u = window.__at0719.unmountedNow(); return u.indexOf("S") !== -1 && u.indexOf("W") !== -1; })()`,
          { timeoutMs: 8000 },
        );
        await app.evalJS<null>("(window.__at0719.reset(), null)");
        // ...and two cards waiting on the wire cost the deck nothing.
        await new Promise((r) => setTimeout(r, 400));
        expect(await app.evalJS<boolean>(coverIs("closed"))).toBe(true);
        const quietLog = await app.evalJS<Ev[]>(readLog);
        expect(quietLog.filter((e) => e.kind === "cover" && e.state === "open")).toEqual([]);

        // ── two real cards resume and reveal ──────────────────────────
        await app.evalJS<null>(
          `(function(){ ${REAL.map(
            (c, i) =>
              `window.__tug.spawnSessionResume(${JSON.stringify(c)}, ${JSON.stringify({ tugSessionId: REAL_SIDS[i], projectDir })});`,
          ).join(" ")} return null; })()`,
        );
        await app.waitForCondition<boolean>(`${mountedAfter("R1")} && ${mountedAfter("R2")}`, { timeoutMs: 60_000 });
        await app.waitForCondition<boolean>(coverIs("closed"), { timeoutMs: 8000 });

        // ── W completes on cue and reveals ────────────────────────────
        // One more bracket frame first, so W's own silence deadline is
        // measured from now rather than from before the real replays.
        await ingest("W", userMsg(SID_W, "second question"));
        await ingest("W", asstText(SID_W, "w2", "A second answer.", 2));
        await ingest("W", turnDone(SID_W, "w2"));
        await ingest("W", { type: "replay_complete", tug_session_id: SID_W });
        await app.waitForCondition<boolean>(mountedAfter("W"), { timeoutMs: 15_000 });
        await app.waitForCondition<boolean>(coverIs("closed"), { timeoutMs: 8000 });
        const afterW = (await app.evalJS<Ev[]>(readLog)).length;

        // ── S never completes; its own deadline ends its restore ──────
        await app.waitForCondition<boolean>(mountedAfter("S"), { timeoutMs: SILENCE_WAIT_MS });
        await new Promise((r) => setTimeout(r, 300));
        const log = await app.evalJS<Ev[]>(readLog);
        await app.evalJS<null>("(window.__at0719.stop(), null)");
        note("cover and mount log (ms)", log.map((e) => ({ ...e, t: Math.round(e.t) })));

        const mounts = Object.fromEntries(
          log.filter((e) => e.kind === "mount").map((e) => [e.card as string, e]),
        );

        // 1. Present across each reveal, and saying what it is.
        for (const card of ["R1", "R2", "W"]) {
          expect(mounts[card]?.state, `${card}'s first list mount ran under the cover`).toBe("open");
          expect(mounts[card]?.opacity, `${card}'s reveal ran under a fully drawn cover`).toBe("1");
        }
        const opens = log.filter((e) => e.kind === "cover" && e.state === "open");
        expect(opens.length).toBeGreaterThan(0);
        for (const open of opens) {
          expect(open.text ?? "").toContain("Restoring sessions");
        }

        // 2 and 3. S, the card whose relay went silent, mounted with the
        // cover down, and nothing after W's reveal raised the cover.
        expect(mounts.S?.state, "S's failure mount ran with the cover down").toBe("closed");
        expect(log.slice(afterW).filter((e) => e.kind === "cover" && e.state === "open")).toEqual([]);
        expect(await app.evalJS<boolean>(coverIs("closed"))).toBe(true);
        // And no alert chrome is left in the DOM by a closed cover.
        expect(
          await app.evalJS<number>(`document.querySelectorAll(${JSON.stringify(`${COVER} .tug-alert-overlay`)}).length`),
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
