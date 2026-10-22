/**
 * at0750-dormant-body-cost-reading.test.ts — what a dormant body costs while
 * its session works, and what its reveal costs.
 *
 * The body lifecycle brief sets stage 2's eviction time from this number. A
 * Session body is filled with 500 turns through the streaming stub, and the
 * resident size of its WebContent process is read empty and full. Then one
 * turn of three long messages begins streaming, and the body's workspace is
 * parked: for the first window the body is hidden and awake, still ingesting;
 * past its delay it goes dormant for a minute while the turn streams on in
 * tugcast. The CPU its process spends in each window is read off `ps`, so the
 * dormant minute is judged against the same body hidden and awake. Shown
 * again, the body catches up: how long from the reveal to awake with the
 * turn's last words in, and the longest frame gap in its page across it.
 *
 * The numbers are noted, not barred; the thresholds they inform are written
 * in the brief. What is asserted is that the arm runs end to end: the body
 * slept, missed the turn's end, and caught up on reveal.
 *
 * The body's process is found by its growth: the one WebContent whose
 * resident size grew most across the fill.
 *
 * @foreground
 * @covers tugdeck/src/body/body-dormancy.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { bodyOf, pollFor, promptPhase, sessionPane, waitForBody } from "../body-grounding/_bodies";
import { webContentProcesses, type WebContentProcess } from "../session-body-fixture";
import { STREAM_PACE_MS, STUB_TRANSCRIPT_DIR_ENV, stubDirectory, streamingTranscript } from "../streaming-stub-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 420_000;

const A = "r50-a";
const FILL_TURNS = 500;
/** The long turn: three messages, streaming for about a minute, so it ends while the body sleeps. */
const LONG_MESSAGES = 3;
const LONG_WORDS = 800;
const AWAKE_WINDOW_MS = 20_000;
const DORMANT_WINDOW_MS = 60_000;
const MARKER = "dormant-reading-turn-ends-here";
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

/** A filled turn's one message: a short reply, whole. */
function shortText(index: number): string {
  return `Reply ${index + 1}: the walk took ${(index * 7) % 23 + 1} ms and the cache held ${120 + ((index * 37) % 900)} rows.`;
}

/** A long message of plain words; the last one ends with the marker. */
function longText(index: number): string {
  const words = Array.from({ length: LONG_WORDS - 1 }, (_, i) => `word${index}-${i}`).join(" ");
  return index === LONG_MESSAGES - 1 ? `${words} ${MARKER}` : words;
}

/**
 * 500 one-message turns that arrive whole, then one turn of three long
 * messages that stream: the long turn's ids and sequence numbers follow the
 * filled turns' so the two read as one session.
 */
function transcript(): unknown {
  const fill = streamingTranscript(1, FILL_TURNS, shortText, 1);
  const long = streamingTranscript(LONG_MESSAGES, 1, longText, 0).turns[0] as { outputs: Record<string, unknown>[] };
  const outputs = long.outputs.map((o) => ({
    ...o,
    ...(typeof o.msg_id === "string" ? { msg_id: o.msg_id.replace("stub-msg-", "stub-long-") } : {}),
    ...(typeof o.seq === "number" ? { seq: o.seq + FILL_TURNS } : {}),
  }));
  return { ...fill, turns: [...fill.turns, { index: FILL_TURNS, description: "the long turn", outputs }] };
}

/** The pid of the WebContent process that grew most from `before` to `after`. */
function grewMost(before: WebContentProcess[], after: WebContentProcess[]): WebContentProcess | null {
  const was = new Map(before.map((p) => [p.pid, p.rssKb]));
  let best: WebContentProcess | null = null;
  let growth = -Infinity;
  for (const p of after) {
    const g = p.rssKb - (was.get(p.pid) ?? 0);
    if (g > growth) {
      growth = g;
      best = p;
    }
  }
  return best;
}

const mb = (kb: number): string => (kb / 1024).toFixed(0);
const rssOf = (pid: number): number => webContentProcesses().find((p) => p.pid === pid)?.rssKb ?? 0;

/** Seconds of CPU `pid` has spent, from `ps`'s `[[dd-]hh:]mm:ss.cc`. */
function cpuSecs(pid: number): number {
  const out = Bun.spawnSync(["ps", "-o", "time=", "-p", String(pid)]).stdout.toString().trim();
  const parts = out.split(":").map(Number);
  return parts.reduce((s, v) => s * 60 + v, 0);
}

interface Read {
  dormant: boolean;
  shown: boolean;
  phase: string | null;
  ended: boolean;
}

const READ = `(function () {
  var d = window.__tug.bodyDormancy();
  var t = document.querySelector('[data-testid="session-card-transcript"]');
  return { dormant: d.dormant, shown: d.shown, phase: ${promptPhase}, ended: t !== null && (t.textContent || "").indexOf(${JSON.stringify(MARKER)}) >= 0 };
})()`;

/** In the page: send `count` prompts, each after the last turn has come back to idle. */
const FILL = (count: number): string => `(function () {
  var w = (window.__at0750 = { done: 0, err: null });
  var phase = function () { return ${promptPhase}; };
  var one = function (i) {
    return new Promise(function (resolve, reject) {
      var left = false;
      var started = performance.now();
      var tick = function () {
        var p = phase();
        if (p !== null && p !== "idle") left = true;
        if (left && p === "idle") return resolve();
        if (performance.now() - started > 10000) return reject(new Error("turn " + i + " never ran"));
        requestAnimationFrame(tick);
      };
      window.__tug.driveSession(${JSON.stringify(A)}, { op: "send", text: "turn " + (i + 1) });
      requestAnimationFrame(tick);
    });
  };
  (async function () {
    for (var i = 0; i < ${count}; i++) { await one(i); w.done = i + 1; }
  })().catch(function (e) { w.err = String(e); });
  return null;
})()`;

describe.skipIf(!SHOULD_RUN)("at0750 — a dormant body's cost, and its reveal", () => {
  test(
    "500 turns, hidden awake then dormant for a minute while a turn streams; the reveal catches up",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "at0750-dormant-body-cost", foreground: true, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0750-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(transcript()));
        await app.spawnSessionNew(A, { tugSessionId, projectDir });
        await waitForBody(app, A);
        const body = app.body(A);
        await app.bodyDelays({ dormantAfterMs: AWAKE_WINDOW_MS });

        // ---- The fill: 500 turns, whole ----
        await Bun.sleep(1_000);
        const empty = webContentProcesses();
        const fillAt = Date.now();
        await body.evalJS<null>(FILL(FILL_TURNS));
        const filled = await pollFor(
          () => body.evalJS<{ done: number; err: string | null }>("window.__at0750"),
          (w) => w.done >= FILL_TURNS || w.err !== null,
          240_000,
        );
        expect(filled.err, "every filled turn ran").toBeNull();
        await Bun.sleep(3_000);
        const full = webContentProcesses();
        const proc = grewMost(empty, full);
        expect(proc, "a WebContent process grew across the fill").not.toBeNull();
        const pid = proc!.pid;
        const emptyKb = empty.find((p) => p.pid === pid)?.rssKb ?? 0;
        const fullKb = rssOf(pid);
        note(
          `fill: ${FILL_TURNS} turns in ${((Date.now() - fillAt) / 1000).toFixed(1)} s; body pid ${pid}: ${mb(emptyKb)} MB empty, ${mb(fullKb)} MB full at rest (+${mb(fullKb - emptyKb)} MB); WebContent ${full.length} processes, ${mb(full.reduce((s, p) => s + p.rssKb, 0))} MB`,
        );

        // ---- The long turn streams; the workspace is parked under it ----
        await body.driveSession({ op: "send", text: "Stream the long turn." });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 10_000 });
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        const hiddenAt = Date.now();
        const cpuHidden = cpuSecs(pid);

        // ---- Hidden and awake, then dormant for a minute ----
        const asleep = await pollFor(() => body.evalJS<Read>(READ), (r) => r.dormant, AWAKE_WINDOW_MS + 10_000);
        expect(asleep.dormant, "the hidden body went dormant past its delay").toBe(true);
        const dormantAt = Date.now();
        const cpuDormant = cpuSecs(pid);
        const rssDormantStart = rssOf(pid);
        await Bun.sleep(DORMANT_WINDOW_MS);
        const cpuEnd = cpuSecs(pid);
        const rssDormantEnd = rssOf(pid);
        const unheard = await body.evalJS<Read>(READ);
        const awakeSecs = (dormantAt - hiddenAt) / 1000;
        const dormantSecs = DORMANT_WINDOW_MS / 1000;
        note(
          `hidden awake ${awakeSecs.toFixed(1)} s: CPU ${(cpuDormant - cpuHidden).toFixed(2)} s (${(((cpuDormant - cpuHidden) / awakeSecs) * 100).toFixed(1)}%); ` +
            `dormant ${dormantSecs} s: CPU ${(cpuEnd - cpuDormant).toFixed(2)} s (${(((cpuEnd - cpuDormant) / dormantSecs) * 100).toFixed(2)}%); ` +
            `RSS ${mb(rssDormantStart)} MB at sleep, ${mb(rssDormantEnd)} MB a minute on; the turn's end ${unheard.ended ? "reached" : "never reached"} the page`,
        );
        expect(unheard.ended, "the turn's end, streamed while the body slept, never reached it").toBe(false);

        // ---- The reveal ----
        await body.evalJS<null>(`(function () {
          var f = (window.__at0750Frames = []);
          var tick = function (t) { f.push(t); if (f.length < 600) requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
          return null;
        })()`);
        const revealAt = Date.now();
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        let shownAt: number | null = null;
        let wokeAt: number | null = null;
        let last: Read | null = null;
        while (Date.now() < revealAt + 15_000) {
          const b = await bodyOf(app, A);
          if (shownAt === null && b?.visible === true) shownAt = Date.now();
          last = await body.evalJS<Read>(READ);
          if (wokeAt === null && !last.dormant) wokeAt = Date.now();
          if (shownAt !== null && wokeAt !== null && last.ended) break;
        }
        const caughtAt = Date.now();
        await Bun.sleep(1_000);
        const frames = await body.evalJS<number[]>("window.__at0750Frames.slice(0, 120)");
        const gaps = frames.slice(1).map((t, i) => t - frames[i]);
        const period = (await bodyOf(app, A))?.displayPeriodMs ?? 16.7;
        const longest = gaps.length === 0 ? 0 : Math.max(...gaps);
        note(
          `reveal: shown ${shownAt === null ? "never" : `${shownAt - revealAt} ms`}, awake ${wokeAt === null ? "never" : `${wokeAt - revealAt} ms`}, the turn's end in ${caughtAt - revealAt} ms after the switch; ` +
            `first ${frames.length} page frames, longest gap ${longest.toFixed(1)} ms ≈ ${(longest / period).toFixed(1)} display periods of ${period.toFixed(1)} ms; RSS ${mb(rssOf(pid))} MB after the catch-up`,
        );
        expect(last, "the revealed body caught up: awake, with the turn's end in").toMatchObject({ dormant: false, ended: true });
        note(`stream pace ${STREAM_PACE_MS} ms a word; the long turn streams for ~${Math.round((LONG_MESSAGES * LONG_WORDS * STREAM_PACE_MS) / 1000)} s`);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
