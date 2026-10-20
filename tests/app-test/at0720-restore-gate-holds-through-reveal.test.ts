/**
 * at0720-restore-gate-holds-through-reveal.test.ts — the restore gate is
 * still up when a restored transcript first paints, and down once it has
 * settled.
 *
 * ## What this gates
 *
 * `TugRestoreGate` used to close on `replay_complete`. A windowed replay
 * ingests in under 100 ms, and the reveal behind it — the list's first
 * mount and the settle of its heights — runs for seconds on the release
 * deck while the card still shows nothing, so the gate closed before
 * anyone saw it and a cold launch read as blank cards with no sheet. The
 * gate now holds through the reveal (`deriveRestoreGateHold`) and lets go
 * on each card's first settle. This test pins both ends:
 *
 *   1. each card's first list mount lands while the gate is open;
 *   2. the gate closes by itself once both cards have settled.
 *
 * ## How
 *
 * Two cards resume generated transcripts through the genuine
 * `spawn_session(resume)` chain (the at0192 vehicle), with fixtures large
 * enough that each reveal is real work. `MutationObserver`s installed
 * before the spawns log every change of the gate's presence (in the
 * overlay page, where the app-modal lives) and the first appearance of each
 * card's list region (in that card's body), all on one wall clock; a
 * mount's callback runs in the task of the commit that mounted the list,
 * and the gate's state at that moment is read off the gate's log.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/restore-gate-store.ts
 * @covers tugdeck/src/components/tugways/tug-restore-gate.tsx
 * @covers tugdeck/src/lib/session-card-restore-gate.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note, type App } from "./_harness";
import { claudeProjectDir } from "./_harness/claude-home";
import { overlayReady } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARDS = ["R1", "R2"] as const;
const SIDS = CARDS.map(() => randomUUID());

const GATE = '[data-slot="tug-restore-gate"]';

let projectDir = "";
let fixtureDir = "";

// Kept local: this is the transcript this file replays. The shared one-turn
// transcript is `oneTurnSessionJsonl` in `_harness/fixtures.ts`.
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

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0720-")));
  writeFileSync(join(projectDir, "README.md"), "at0720\n");
  fixtureDir = claudeProjectDir(projectDir);
  mkdirSync(fixtureDir, { recursive: true });
  SIDS.forEach((sid) => {
    writeFileSync(join(fixtureDir, `${sid}.jsonl`), buildFixtureJsonl(projectDir, sid, 60));
  });
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
  if (fixtureDir !== "" && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
});

function deckShape() {
  return {
    cards: CARDS.map((id) => ({ id, componentId: "session", title: `Session ${id}`, closable: true })),
    panes: CARDS.map((id, i) => ({
      id: `p${id}`,
      position: { x: 20 + i * 560, y: 20 },
      size: { width: 540, height: 640 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
    })),
    activePaneId: "pR1",
    hasFocus: true,
  };
}

/** One recorded event: the gate appearing or going, or a card's list first mounting. */
interface Ev {
  t: number;
  kind: "gate" | "mount";
  card?: string;
  gate: boolean;
}

/**
 * The gate's recorder, in the overlay page: the gate is an app-modal at its
 * root. Times are wall-clock (`timeOrigin + now`), so they order against
 * the mount times each card's body records on its own page.
 */
const INSTALL_GATE_RECORDER = `(function(){
  var log = [];
  var stamp = function(){ return performance.timeOrigin + performance.now(); };
  var gateUp = function(){ return document.querySelector(${JSON.stringify(GATE)}) !== null; };
  var last = gateUp();
  log.push({ t: stamp(), kind: "gate", gate: last });
  var check = function(){
    var now = gateUp();
    if (now !== last) { log.push({ t: stamp(), kind: "gate", gate: now }); last = now; }
  };
  check();
  var mo = new MutationObserver(check);
  mo.observe(document.body, { subtree: true, childList: true });
  window.__at0720 = { log: log, stop: function(){ mo.disconnect(); } };
  return null;
})()`;

/**
 * A card's recorder, in that card's body: its list mounts there. Logs the
 * list's first appearance, in the task of the commit that mounted it, on
 * the same wall clock as the gate's recorder. The transcript's list, not the
 * picker's: an unbound Session card shows its picker's session list before
 * the spawn, and that list is no restore's.
 */
const installMountRecorder = (card: string): string => `(function(){
  var log = [];
  var seen = false;
  var check = function(){
    if (seen) return;
    if (document.querySelector('[data-card-id=${JSON.stringify(card)}] [data-slot="session-card-transcript"] [data-slot="tug-list-view"]') !== null) {
      seen = true;
      log.push({ t: performance.timeOrigin + performance.now(), kind: "mount", card: ${JSON.stringify(card)} });
    }
  };
  check();
  var mo = new MutationObserver(check);
  mo.observe(document.body, { subtree: true, childList: true });
  window.__at0720 = { log: log, stop: function(){ mo.disconnect(); } };
  return null;
})()`;

const readLog = "window.__at0720.log";
const mounted = (card: string) =>
  `window.__at0720.log.some(function(e){ return e.kind === "mount" && e.card === ${JSON.stringify(card)}; })`;
const gateDown = `document.querySelector(${JSON.stringify(GATE)}) === null`;

/** Wait until the host holds `cardId`'s body ready, so its page can be reached. */
async function waitForBodyReady(app: App, cardId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await app.bodies()).some((b) => b.cardId === cardId && b.state === "ready")) return;
    if (Date.now() >= deadline) throw new Error(`card ${cardId}'s body was not ready within ${timeoutMs} ms`);
    await Bun.sleep(50);
  }
}

/**
 * The gate's state at each mount, read off the gate's own log: the last
 * gate event at or before the mount. What the single-page recorder read
 * synchronously in the mount's task, read here across the two pages' logs.
 */
function gateAt(gateLog: readonly Ev[], t: number): boolean {
  let state = false;
  for (const e of gateLog) if (e.t <= t) state = e.gate;
  return state;
}

describe.skipIf(!SHOULD_RUN)("at0720 — the restore gate holds through each card's reveal", () => {
  test(
    "every first list mount lands under the gate, and the gate closes once both cards have settled",
    async () => {
      const app = await launchTugApp({ testName: "at0720-restore-gate-holds-through-reveal" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "R1" });
        for (const id of CARDS) {
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(id)})`,
            { timeoutMs: 30_000 },
          );
        }
        // The gate is drawn in the overlay page, so its recorder stands there.
        const overlay = await overlayReady(app);
        await overlay.evalJS<null>(INSTALL_GATE_RECORDER);
        for (const id of CARDS) {
          await waitForBodyReady(app, id, 30_000);
          await app.body(id).evalJS<null>(installMountRecorder(id));
        }

        await app.evalJS<null>(
          `(function(){ ${CARDS.map(
            (c, i) =>
              `window.__tug.spawnSessionResume(${JSON.stringify(c)}, ${JSON.stringify({ tugSessionId: SIDS[i], projectDir })});`,
          ).join(" ")} return null; })()`,
        );
        for (const id of CARDS) {
          await app.body(id).waitForCondition<boolean>(mounted(id), { timeoutMs: 60_000 });
        }
        await overlay.waitForCondition<boolean>(gateDown, { timeoutMs: 20_000 });
        const gateLog = await overlay.evalJS<Ev[]>(readLog);
        await overlay.evalJS<null>("(window.__at0720.stop(), null)");
        const mountLog: Ev[] = [];
        for (const id of CARDS) {
          const own = await app.body(id).evalJS<Ev[]>(readLog);
          await app.body(id).evalJS<null>("(window.__at0720.stop(), null)");
          mountLog.push(...own.map((e) => ({ ...e, gate: gateAt(gateLog, e.t) })));
        }
        const log = [...gateLog, ...mountLog].sort((a, b) => a.t - b.t);
        note("gate and mount log (ms)", log.map((e) => ({ ...e, t: Math.round(e.t) })));

        const mounts = Object.fromEntries(log.filter((e) => e.kind === "mount").map((e) => [e.card as string, e]));
        for (const card of CARDS) {
          expect(mounts[card]?.gate, `${card}'s first list mount ran under the gate`).toBe(true);
        }
        // The gate came up once for the restore and went down once, after
        // the last mount — never blinking between the two cards.
        const ups = log.filter((e) => e.kind === "gate" && e.gate);
        const downs = log.filter((e) => e.kind === "gate" && !e.gate && e.t > 0);
        expect(ups.length).toBe(1);
        expect(downs.filter((d) => d.t > ups[0]!.t).length).toBe(1);
        const lastMountT = Math.max(...CARDS.map((c) => mounts[c]!.t));
        expect(downs[downs.length - 1]!.t).toBeGreaterThan(lastMountT);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
