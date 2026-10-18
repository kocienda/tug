/**
 * record-reading.test.ts — the reading of record for body motion, taken with
 * three bodies streaming.
 *
 * Not a row of the bar: a reading. The program record wants one line per
 * gesture — ⌘N, fold, slot, split, flow slide, bullseye and rails — giving
 * its lead, its worst in-motion gap and its land, beside the window's own
 * frames over the motion, on a deck whose sessions are mid-turn. This file
 * stands that deck up with body views on and reads each gesture once
 * through `tugtool deck motion settle`, the verb the record is read with:
 * first with `--quiet-instruments`, which is the reading of record
 * (`briefs/motion-record-honesty-brief.md` [B01]–[B03]), then with
 * the verb's own instruments on for attribution (its heartbeat, mutation
 * observer and commit census), labelled as instrumented. Not `--tasks`: it
 * reloads the shell page to install its recorder, and a deck of bodies does
 * not come back from that reload inside the verb's wait.
 *
 * The streams are stub turns replayed through tugcast's real feed
 * (`streaming-stub-fixture.ts`), one per body. The verb's own `--streaming`
 * count reads prompt entries in the shell's document, and a body's entry is
 * in its own page, so the file passes `--streaming 0` (the busy floor, read
 * rather than refused) and checks every body's phase itself before and
 * after each drive. A drive made with fewer than three bodies streaming
 * fails the file rather than entering the record.
 *
 * What is asserted is that the record could be read: every drive exited
 * cleanly, read every gesture, and was made under three streams. The bar
 * itself is the per-gesture settle files' and the rows'; this file only
 * notes what it read.
 *
 * @foreground
 * @covers tugrust/crates/tugtool/src/commands/deck_motion_settle.rs
 * @covers tugrust/crates/tugtool/src/commands/deck_motion_settle.js
 * @covers tugdeck/src/lib/body-placement.ts
 */

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, promptPhase, sessionPane, spawnStub, waitForBody } from "../body-grounding/_bodies";

const TEST_NAME = "body-grounding-record-reading";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 900_000;

/** A turn this long streams past every drive the file makes. */
const STREAM_MESSAGES = 200;
const SETTLE_MS = 2_000;

const BODIES = ["r20-a", "r20-b", "r20-c"] as const;
const OTHERS = ["r20-n0", "r20-n4", "r20-n5"] as const;
const RAIL_WIDTH = 240;

/** Six session cards in a four-up flow, bodies in slots 1–3, and a Layout card on the right rail. */
function flowDeck(): Record<string, unknown> {
  const ids = [OTHERS[0], BODIES[0], BODIES[1], BODIES[2], OTHERS[1], OTHERS[2]];
  return {
    cards: [
      ...ids.map((id) => ({ id, componentId: "session", title: id, closable: true })),
      { id: "r20-l1", componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...ids.map((id, slot) => sessionPane(id, slot)),
      {
        id: "r20-pl1",
        position: { x: 0, y: 0 },
        size: { width: RAIL_WIDTH, height: 900 },
        cardIds: ["r20-l1"],
        activeCardId: "r20-l1",
        title: "Layout",
        acceptsFamilies: [] as string[],
      },
    ],
    activePaneId: `${BODIES[0]}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: { layout: { side: "right" } } },
    hasFocus: true,
  };
}

/** Each gesture of the record, with the verb flags that drive it. */
const GESTURES: readonly { name: string; flags: string[] }[] = [
  { name: "⌘N (appear)", flags: ["--gesture", "appear"] },
  { name: "fold", flags: ["--gesture", "fold", "--card", BODIES[0]] },
  { name: "slot", flags: ["--gesture", "slot", "--card", BODIES[0], "--slot", "2"] },
  { name: "split", flags: ["--gesture", "split", "--slot", "1", "--mode", "split"] },
  { name: "flow slide", flags: ["--gesture", "slide", "--card", OTHERS[2]] },
  { name: "bullseye", flags: ["--gesture", "bullseye", "--pane", `${BODIES[0]}-pane`] },
  { name: "rails", flags: ["--gesture", "rails"] },
];

/** Readings per gesture: a toggle reads both ways and leaves the deck where it stood. */
const COUNT = 2;

/** The bundle's own `tugtool`, beside the app binary the harness launched. */
function tugtoolPath(): string {
  const app = process.env.TUGAPP_DEBUG_PATH;
  if (app === undefined || app === "") {
    throw new Error("TUGAPP_DEBUG_PATH is unset; run this file through `just app-test`");
  }
  return join(dirname(app), "tugtool");
}

/** Run `tugtool deck …` against this instance and parse its envelope. */
function deck(port: string, args: string[]): { exit: number; json: Record<string, unknown> | null; stderr: string } {
  const run = Bun.spawnSync([tugtoolPath(), "deck", ...args, "--port", port, "--json"], { stdout: "pipe", stderr: "pipe" });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(run.stdout.toString()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { exit: run.exitCode ?? -1, json, stderr: run.stderr.toString() };
}

/** Every body is mid-turn and streaming text. */
async function expectStreaming(app: App, when: string): Promise<void> {
  for (const id of BODIES) {
    const phase = await app.body(id).evalJS<string>(promptPhase);
    expect(phase, `${id} is streaming ${when}`).toBe("streaming");
  }
}

/** Every WebContent process on the machine, with its resident size in KB. */
function webContentProcesses(): { pid: number; rssKb: number }[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,rss=,comm="]).stdout.toString();
  const found: { pid: number; rssKb: number }[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m && m[3]!.includes("com.apple.WebKit.WebContent")) found.push({ pid: Number(m[1]), rssKb: Number(m[2]) });
  }
  return found;
}

/** One line per reading: what the record's cells are read from. */
function noteReadings(label: string, data: Record<string, unknown>): void {
  const readings = (data.readings ?? []) as Record<string, unknown>[];
  readings.forEach((r, i) => {
    const pick = {
      lead_ms: r.lead_ms,
      longest_gap_ms: r.longest_gap_ms,
      motion: r.motion,
      land: r.land,
      window_row: r.window_row,
      window_absent: r.window_absent,
      main_thread: r.main_thread,
      commits: Array.isArray(r.commits) ? r.commits.length : null,
    };
    note(`${label} #${i + 1}: ${JSON.stringify(pick)}`);
  });
}

describe.skipIf(!SHOULD_RUN)("body-grounding record reading: seven gestures with three bodies streaming", () => {
  test(
    "every gesture of the record reads quiet and instrumented under three streams",
    async () => {
      const stubDir = stubDirectory();
      const standing = new Set(webContentProcesses().map((p) => p.pid));
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: flowDeck(), focusCardId: BODIES[0] });
        for (const id of BODIES) await spawnStub(app, id, stubDir, STREAM_MESSAGES);
        for (const id of BODIES) await waitForBody(app, id);
        await focusBody(app, BODIES[0], { composer: false });
        for (const id of BODIES) await app.body(id).driveSession({ op: "send", text: "Walk the module and report each pass." });
        for (const id of BODIES) await app.body(id).waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 30_000 });
        await Bun.sleep(SETTLE_MS);

        const port = await app.evalJS<string>("location.port");
        expect(port, "the page reports its tugcast port").toMatch(/^\d+$/);
        const enable = deck(port, ["motion", "enable"]);
        expect(enable.exit, `deck motion enable: ${enable.stderr}`).toBe(0);

        const added = webContentProcesses().filter((p) => !standing.has(p.pid));
        note(
          `record processes: ${added.length} WebContent this launch added, ${Math.round(added.reduce((s, p) => s + p.rssKb, 0) / 1024)} MB resident ` +
            `(each MB: ${JSON.stringify(added.map((p) => Math.round(p.rssKb / 1024)))})`,
        );
        const pages = deck(port, ["pages"]);
        note(`record pages: exit ${pages.exit} ${JSON.stringify(pages.json?.data ?? pages.stderr)}`);

        for (const g of GESTURES) {
          for (const [kind, instruments] of [
            ["quiet", ["--quiet-instruments"]],
            ["instrumented", []],
          ] as const) {
            await expectStreaming(app, `before the ${g.name} ${kind} drive`);
            const run = deck(port, ["motion", "settle", ...g.flags, "--count", String(COUNT), ...instruments, "--streaming", "0"]);
            const data = (run.json?.data ?? null) as Record<string, unknown> | null;
            expect(run.exit, `${g.name} ${kind} exited ${run.exit}: ${run.stderr} ${JSON.stringify(run.json)}`).toBe(0);
            expect(data).not.toBeNull();
            noteReadings(`record ${g.name} (${kind})`, data!);
            expect(((data!.readings ?? []) as unknown[]).length, `${g.name} ${kind}: every drive read`).toBe(COUNT);
            await expectStreaming(app, `after the ${g.name} ${kind} drive`);
            await Bun.sleep(SETTLE_MS);
          }
        }
        deck(port, ["motion", "disable"]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
