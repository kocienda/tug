/**
 * at0815-switch-under-streams-reading.test.ts — what running sessions cost a
 * workspace switch.
 *
 * A user-shaped deck of four workspaces, each with its five rail cards: two
 * hold Text cards only, two hold two Session cards and a Text card. The four
 * Session cards bind to stubbed sessions (`streaming-stub-fixture.ts`) whose
 * tugcode replays one long turn at a token cadence through tugcast's real
 * feed.
 *
 * The same round of switches is driven twice: with every session bound and
 * idle, then with all four streaming. Each switch notes its hold (`held_ms`,
 * `outcome`), how long the host's ground stood and why it lifted (the
 * shell's own frame, or the horizon), the longest gap on the shell page's
 * main thread and between its animation frames in the three seconds after
 * the gesture, and how many hidden pages the host marked stale and retook a
 * last frame of in that window. Asserts only that both rounds ran: the
 * comparison is the product.
 *
 * @covers tests/app-test/streaming-stub-fixture.ts
 * @covers tugapp/Sources/BodyFaceHandOver.swift
 * @covers tugapp/Sources/BodyCovers.swift
 * @covers tugdeck/src/body/body-staleness.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import type { SwitchHoldRecord } from "../_harness/client";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "../body-grounding/_bodies";
import { bindStreamingStubs, startStreams, STUB_TRANSCRIPT_DIR_ENV, stubDirectory, type StubCard } from "../streaming-stub-fixture";
import { cardsOf, layoutOf, space, type Space } from "./_workspace-deck";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 600_000;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
const SWITCHES = 12;
/** Longer than the host ground's horizon, so every switch's lift is in the log before the next. */
const REST_MS = 3_600;
const AHEAD_MS = 90_000;

const SPACES: Space[] = [
  space("g815", "home", ["text", "text"]),
  space("g815", "a", ["session", "session", "text"]),
  space("g815", "b", ["session", "session", "text"]),
  space("g815", "c", ["text", "text"]),
];
const sessionsOf = (s: Space): string[] => s.content.filter((c) => c.kind === "session").map((c) => c.id);

/** A sampler on the shell page: the longest main-thread gap and the longest gap between animation frames since `reset`. */
const INSTALL_LAG = `(function () {
  if (window.__g815) return null;
  var s = { task: 0, frame: 0, frames: 0, lastTask: performance.now(), lastFrame: performance.now() };
  window.__g815 = s;
  setInterval(function () { var n = performance.now(); if (n - s.lastTask > s.task) s.task = n - s.lastTask; s.lastTask = n; }, 5);
  (function tick() { var n = performance.now(); if (n - s.lastFrame > s.frame) s.frame = n - s.lastFrame; s.lastFrame = n; s.frames += 1; requestAnimationFrame(tick); })();
  return null;
})()`;
const RESET_LAG = "(function () { var s = window.__g815; s.task = 0; s.frame = 0; s.frames = 0; s.lastTask = performance.now(); s.lastFrame = performance.now(); return null; })()";
const READ_LAG = "JSON.stringify({ task: Math.round(window.__g815.task), frame: Math.round(window.__g815.frame), frames: window.__g815.frames })";

interface Row {
  to: string;
  held: number | null;
  outcome: string;
  ground: string;
  groundMs: number | null;
  task: number;
  frame: number;
  frames: number;
  stale: number;
  covers: number;
}

const r = (v: number | null | undefined): string => (v === null || v === undefined ? "none" : `${Math.round(v)}`);

function stats(xs: readonly number[]): string {
  if (xs.length === 0) return "none";
  const s = [...xs].sort((a, b) => a - b);
  return `median ${Math.round(s[Math.floor((s.length - 1) / 2)])}, max ${Math.round(s[s.length - 1])}`;
}

describe.skipIf(!SHOULD_RUN)("at0815 — a switch with sessions streaming", () => {
  test(
    "twelve switches with four sessions idle, twelve with them streaming, each noted",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(layoutOf(SPACES)));
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: "at0815-switch-under-streams-reading",
        env: { TUGBANK_PATH: tugbankPath, [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const go = async (id: string): Promise<void> => {
          await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(id)} }), null)`);
          await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (x) => x === id, 5_000);
        };
        // Bind each workspace's sessions while it is the one on screen.
        const stubs: StubCard[] = [];
        for (const s of SPACES.filter((x) => sessionsOf(x).length > 0)) {
          await go(s.id);
          await Bun.sleep(1_500);
          stubs.push(...(await bindStreamingStubs(app, sessionsOf(s), stubDir)));
        }
        await go(SPACES[0].id);
        const at = Date.now();
        let ready = 0;
        const all = SPACES.flatMap(cardsOf);
        for (const id of all) {
          const b = await settleFor(() => bodyOf(app, id), (x) => x?.state === "ready" && x.painted === true, Math.max(1_000, AHEAD_MS - (Date.now() - at)));
          if (b?.state === "ready" && b.painted === true) ready += 1;
        }
        note(`deck: ${SPACES.length} workspaces, ${all.length} cards, ${ready} pages ready, ${stubs.length} sessions bound`);
        await app.evalJS<null>(INSTALL_LAG);
        let current = SPACES[0].id;
        const run = async (label: string): Promise<Row[]> => {
          const rows: Row[] = [];
          for (let i = 0; i < SWITCHES; i++) {
            const to = SPACES[(SPACES.findIndex((s) => s.id === current) + 1) % SPACES.length];
            const logAt = app.tugappLog().length;
            await app.evalJS<null>(RESET_LAG);
            const cut = Date.now();
            await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(to.id)} }), null)`);
            await Bun.sleep(REST_MS);
            const lag = JSON.parse(await app.evalJS<string>(READ_LAG, { timeoutMs: 15_000 })) as { task: number; frame: number; frames: number };
            await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === to.id, 5_000);
            current = to.id;
            const hold: SwitchHoldRecord | null =
              ((await app.handOvers()).switchHolds ?? []).filter((h) => h.fromWall >= cut - 50 && h.toWall !== null).at(-1) ?? null;
            const log = app.tugappLog().slice(logAt).split("\n");
            const lift = log.filter((l) => l.includes("switch ground lifted")).at(-1) ?? "";
            const why = /why=(\S+)/.exec(lift)?.[1] ?? "no ground";
            const stood = /stood_until_ms=(\d+)/.exec(lift)?.[1];
            const row: Row = {
              to: to.id.replace(/g815-|-space/g, ""),
              held: hold?.heldMs ?? null,
              outcome: hold?.outcome ?? "no hold",
              ground: why,
              groundMs: stood === undefined ? null : Number(stood),
              task: lag.task,
              frame: lag.frame,
              frames: lag.frames,
              stale: log.filter((l) => l.includes(": stale card=")).length,
              covers: log.filter((l) => l.includes("park cover card=")).length,
            };
            rows.push(row);
            note(
              `${label} ${String(i + 1).padStart(2)} → ${row.to.padEnd(4)}: held ${r(row.held)} ${row.outcome}; ground ${row.ground} ${r(row.groundMs)}; ` +
                `shell longest task gap ${row.task}, frame gap ${row.frame}, frames ${row.frames}; stale ${row.stale}, retakes ${row.covers}`,
            );
          }
          return rows;
        };
        const idle = await run("idle");
        for (const s of SPACES.filter((x) => sessionsOf(x).length > 0)) {
          await go(s.id);
          await Bun.sleep(1_500);
          await startStreams(app, stubs.filter((c) => sessionsOf(s).includes(c.cardId)));
        }
        await go(SPACES[0].id);
        current = SPACES[0].id;
        await Bun.sleep(4_000);
        const streaming = await run("streaming");
        // The user's deck wears a theme per workspace: alternate a dark and a light one, still streaming.
        for (const [i, s] of SPACES.entries()) {
          await app.evalJS<null>(`(window.__tug.chooseSpaceTheme(${JSON.stringify(s.id)}, ${JSON.stringify(i % 2 === 0 ? "ironclad" : "sloop")}), null)`);
        }
        await Bun.sleep(3_000);
        const themed = await run("themed");
        for (const [label, rows] of [["idle", idle], ["streaming", streaming], ["themed", themed]] as const) {
          const stood = rows.map((x) => x.groundMs).filter((x): x is number => x !== null);
          note(
            `${label}: held ${stats(rows.map((x) => x.held).filter((x): x is number => x !== null))}; ` +
              `ground stood ${rows.filter((x) => x.groundMs !== null).length}/${rows.length}, ${stats(stood)}, ${rows.filter((x) => x.ground === "horizon").length} to the horizon; ` +
              `shell task gap ${stats(rows.map((x) => x.task))}, frame gap ${stats(rows.map((x) => x.frame))}; ` +
              `stale ${stats(rows.map((x) => x.stale))}, retakes ${stats(rows.map((x) => x.covers))}`,
          );
        }
        expect(idle.length + streaming.length + themed.length).toBe(SWITCHES * 3);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
