/**
 * at0761-restore-gate-counts-sessions.test.ts — the restore gate counts
 * sessions, over a total fixed when it opens, and one session shows a
 * spinner.
 *
 * ## What this gates
 *
 * `TugRestoreGate` used to read "n of m turns", summed over the cards
 * holding it. Turns arrive in one or two jumps at the very end of a
 * restore, and a finished card left the sum, so the readout sat still and
 * then ran backwards. It now counts sessions: "Restoring sessions" over
 * "n of N sessions", where N is fixed when the gate opens — the cards the
 * restore pass is resuming plus the cards holding then — and n only rises.
 * A single session shows a spinner and no count. This file pins what the
 * user sees:
 *
 *   1. one session resumed: every open frame totals 1, says "Restoring
 *      session", shows a spinner and no "n of m";
 *   2. three sessions resumed by the real restore pass a workspace switch
 *      runs: every open frame totals 3, the done count never falls, the
 *      title is "Restoring sessions" with no number and nothing about turns.
 *
 * ## How
 *
 * One launch from a tugbank layout of two workspaces: the active one holds
 * Session card `S`, a parked one holds `R1`–`R3`, each the active card of
 * its own pane. Four resumable transcripts are written where claude keeps
 * them. Leg 1 resumes `S` through the at0720 vehicle. Leg 2 states the
 * ledger's reply for `R1`–`R3` (`publishCardBindings`, as at0579 does) and
 * activates the parked workspace, so `restoreSpaceSessions` resumes them and
 * names them to the gate. Leg 2 reads its log only once all three transcripts
 * have mounted and the gate is down, since the gate may close between staged
 * pages and reopen on the same round. A `MutationObserver` in the overlay page, where
 * the gate is drawn, records the gate's `data-sessions-*` attributes, its
 * title, whether it shows a spinner, and its text on every change. The count
 * is read from the attributes only: the bar's readout keeps a full-scale
 * width ghost ("3 of 3 sessions") in its text, and a done of 0 draws no
 * readout at all.
 *
 * One window capture is taken in leg 2 once the log holds a frame whose done
 * count is 1 or more — the first count drawn — and copied to
 * `/tmp/at0761-gate.png`. The window's paint can trail the DOM, so the
 * picture may still show the moving bar that precedes the first count.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/restore-gate-store.ts
 * @covers tugdeck/src/lib/restore-gate-round.ts
 * @covers tugdeck/src/components/tugways/tug-restore-gate.tsx
 * @covers tugdeck/src/lib/session-restore.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note, type App } from "./_harness";
import { claudeProjectDir } from "./_harness/claude-home";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "./_harness/tugbank-helpers";
import { overlayReady, restoreGateGone } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const ACTIVE_SPACE = "space-active";
const PARKED_SPACE = "space-parked";
const LONE = "S";
const RESTORED = ["R1", "R2", "R3"] as const;
const SIDS: Record<string, string> = Object.fromEntries([LONE, ...RESTORED].map((c) => [c, randomUUID()]));

const GATE = '[data-slot="tug-restore-gate"]';
const SHOT = "/tmp/at0761-gate.png";

let projectDir = "";
let fixtureDir = "";
let tugbankPath = "";

// Kept local, as at0720 keeps its own: the shared one-turn transcript is
// `oneTurnSessionJsonl` in `_harness/fixtures.ts`, and this file wants turns
// enough that a reveal is real work.
/**
 * A resumable transcript of `turns` committed turns, each answer carrying
 * enough markdown (a heading, a list, a code block) that the reveal lays
 * out real rows rather than one-liners.
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

function pane(cardId: string, x: number) {
  return {
    id: `p-${cardId}`,
    position: { x, y: 40 },
    size: { width: 420, height: 560 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
  };
}

function sessionCard(cardId: string) {
  return { id: cardId, componentId: "session", title: `Session ${cardId}`, closable: true };
}

/** Two workspaces: `S` alone in the active one, `R1`–`R3` side by side in the parked one. */
const LAYOUT = {
  version: 5,
  activeSpaceId: ACTIVE_SPACE,
  spaces: [
    {
      id: ACTIVE_SPACE,
      name: "Active",
      deck: {
        cards: [sessionCard(LONE)],
        panes: [pane(LONE, 40)],
        activePaneId: `p-${LONE}`,
        imposition: { sidebars: {} },
      },
    },
    {
      id: PARKED_SPACE,
      name: "Parked",
      deck: {
        cards: RESTORED.map(sessionCard),
        panes: RESTORED.map((c, i) => pane(c, 20 + i * 440)),
        activePaneId: `p-${RESTORED[0]}`,
        imposition: { sidebars: {} },
      },
    },
  ],
};

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0761-")));
  writeFileSync(join(projectDir, "README.md"), "at0761\n");
  fixtureDir = claudeProjectDir(projectDir);
  mkdirSync(fixtureDir, { recursive: true });
  for (const [, sid] of Object.entries(SIDS)) {
    writeFileSync(join(fixtureDir, `${sid}.jsonl`), buildFixtureJsonl(projectDir, sid, 20));
  }
  tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath);
  tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
  if (fixtureDir !== "" && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  if (tugbankPath !== "") rmTempTugbank(tugbankPath);
});

/** One recorded frame of the overlay page. */
interface Rec {
  t: number;
  open: boolean;
  done: number | null;
  total: number | null;
  title: string | null;
  spinner: boolean;
  text: string | null;
}

/**
 * The gate's recorder, in the overlay page. Logs a record whenever what the
 * gate shows changes — present or not, its counts, its title, its spinner,
 * its text — so the log is the sequence of frames the user could have seen.
 */
const INSTALL_RECORDER = `(function(){
  var log = [];
  var lastKey = null;
  var read = function(){
    var g = document.querySelector(${JSON.stringify(GATE)});
    if (g === null) return { open: false, done: null, total: null, title: null, spinner: false, text: null };
    var title = g.querySelector(".tug-alert-title");
    return {
      open: true,
      done: Number(g.getAttribute("data-sessions-done")),
      total: Number(g.getAttribute("data-sessions-total")),
      title: title === null ? null : title.textContent,
      spinner: g.querySelector('[data-variant="spinner"]') !== null,
      text: g.textContent,
    };
  };
  var check = function(){
    var r = read();
    var key = JSON.stringify(r);
    if (key === lastKey) return;
    lastKey = key;
    r.t = performance.timeOrigin + performance.now();
    log.push(r);
  };
  check();
  var mo = new MutationObserver(check);
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  window.__at0761 = {
    log: log,
    clear: function(){ log.length = 0; lastKey = null; check(); },
    stop: function(){ mo.disconnect(); },
  };
  return null;
})()`;

const readLog = "window.__at0761.log";

/** Wait until the host holds `cardId`'s body ready, so its page can be reached. */
async function waitForBodyReady(app: App, cardId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await app.bodies()).some((b) => b.cardId === cardId && b.state === "ready")) return;
    if (Date.now() >= deadline) throw new Error(`card ${cardId}'s body was not ready within ${timeoutMs} ms`);
    await Bun.sleep(50);
  }
}

describe.skipIf(!SHOULD_RUN)("at0761 — the restore gate counts sessions", () => {
  test(
    "one session shows a spinner; three resumed by a workspace switch count up to a fixed total of three",
    async () => {
      const app = await launchTugApp({
        testName: "at0761-restore-gate-counts-sessions",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(LONE)})`,
          { timeoutMs: 15_000 },
        );
        const overlay = await overlayReady(app);
        await overlay.evalJS<null>(INSTALL_RECORDER);

        // ---- Leg 1: one session.
        await waitForBodyReady(app, LONE, 15_000);
        await app.evalJS<null>(
          `(window.__tug.spawnSessionResume(${JSON.stringify(LONE)}, ${JSON.stringify({ tugSessionId: SIDS[LONE], projectDir })}), null)`,
        );
        await overlay.waitForCondition<boolean>(
          `window.__at0761.log.some(function(r){ return r.open; })`,
          { timeoutMs: 10_000 },
        );
        await restoreGateGone(app, 10_000);
        const leg1 = await overlay.evalJS<Rec[]>(readLog);
        note("leg 1 records", leg1);
        const open1 = leg1.filter((r) => r.open);
        expect(open1.length, "the gate opened for the one session").toBeGreaterThan(0);
        for (const r of open1) {
          expect(r.total, "one session totals 1").toBe(1);
          expect(r.title).toBe("Restoring session");
          expect(r.spinner, "one session shows a spinner").toBe(true);
          expect(r.text ?? "", "one session shows no count").not.toMatch(/\d+ of \d+/);
        }

        // ---- Leg 2: three sessions through the real restore pass.
        await overlay.evalJS<null>("(window.__at0761.clear(), null)");
        await app.evalJS<null>(
          `(window.__tug.publishCardBindings(${JSON.stringify(
            RESTORED.map((c) => ({
              card_id: c,
              session_id: SIDS[c],
              project_dir: projectDir,
              state: "closed",
              turn_count: 20,
              has_jsonl: true,
            })),
          )}), null)`,
        );
        // `cachedRowIsLive` counts a row with `has_jsonl`, so all three
        // standing in the cache is what lets the switch resume them at once.
        await app.waitForCondition<boolean>(
          `window.tugdeck.lab.spaceHoldsLiveSessions(${JSON.stringify(PARKED_SPACE)}) === 3`,
          { timeoutMs: 5_000 },
        );
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(PARKED_SPACE)} }), null)`,
        );

        // Watch the log until the gate has been and gone, capturing the
        // window once, at the first frame that draws a count.
        let captured: "count" | "open" | null = null;
        const deadline = Date.now() + 15_000;
        for (;;) {
          const log = await overlay.evalJS<Rec[]>(readLog);
          if (captured === null) {
            const counted = log.some((r) => r.open && (r.done ?? 0) >= 1);
            const last = log[log.length - 1];
            if (counted && last?.open === true) {
              const shot = await app.captureWindow();
              copyFileSync(shot.path, SHOT);
              captured = "count";
            }
          }
          const sawOpen = log.some((r) => r.open);
          if (sawOpen && log[log.length - 1]?.open === false) break;
          if (Date.now() >= deadline) throw new Error("the gate did not open and close within 15 s of the switch");
          await Bun.sleep(25);
        }
        if (captured === null) {
          // The gate closed between polls before a count was drawn on one:
          // say so, and capture what is left so the reading has a picture.
          const shot = await app.captureWindow();
          copyFileSync(shot.path, SHOT);
          captured = "open";
        }
        // The first close is not the end: pages are made at most two at a
        // time, so the gate can drop while the third card's restore is still
        // to come and reopen when it holds, continuing the same round. Wait
        // until every card's transcript has mounted — each mount lands under
        // its own hold — and then for the gate to be down for good, so the
        // log covers every frame of the restore.
        for (const id of RESTORED) {
          await waitForBodyReady(app, id, 15_000);
          await app.body(id).waitForCondition<boolean>(
            `document.querySelector('[data-card-id=${JSON.stringify(id)}] [data-slot="session-card-transcript"] [data-slot="tug-list-view"]') !== null`,
            { timeoutMs: 15_000 },
          );
        }
        await restoreGateGone(app, 10_000);
        const leg2 = await overlay.evalJS<Rec[]>(readLog);
        await overlay.evalJS<null>("(window.__at0761.stop(), null)");
        note("leg 2 records", leg2);
        note("window capture", {
          path: SHOT,
          at:
            captured === "count"
              ? "once the log held a frame with a count (the window's paint can lag the DOM by a frame)"
              : "after the gate closed (no count frame caught)",
        });

        const open2 = leg2.filter((r) => r.open);
        note("leg 2 gate-open edges", leg2.filter((r, i) => r.open && leg2[i - 1]?.open !== true).length);
        expect(open2.length, "the gate opened for the switch").toBeGreaterThan(0);
        for (const r of open2) {
          expect(r.total, "the total is three from the first open frame on").toBe(3);
          expect(r.title, "the title carries no number").toBe("Restoring sessions");
          expect(r.text ?? "", "nothing about turns").not.toContain("turns");
        }
        const dones = open2.map((r) => r.done ?? 0);
        for (let i = 1; i < dones.length; i++) {
          expect(dones[i]!, "the done count never falls").toBeGreaterThanOrEqual(dones[i - 1]!);
        }
        expect(dones[dones.length - 1]!).toBeLessThanOrEqual(3);
        expect(leg2[leg2.length - 1]?.open, "the gate is gone at the end").toBe(false);
      } finally {
        await app.close().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
