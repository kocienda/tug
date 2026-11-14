/**
 * at0826-skeleton-through-reveal.test.ts — a resumed Session card's skeleton
 * stands until its transcript has settled.
 *
 * ## What this gates
 *
 * A resumed card's page used to say its content painted once its session was
 * out of the replay, or a quarter second after it mounted. The reveal behind
 * the replay — the list's first mount and the settle of its heights — came
 * after, so the host took the skeleton down onto an empty card, and the
 * transcript arrived and placed itself in view. The page now says `painted`
 * when the card's restore is over (`restorePaintQuiet`), so the host's
 * picture for the card is a skeleton through the replay and the reveal, and
 * live only over a settled list.
 *
 * ## How
 *
 * One launch from a tugbank layout of two workspaces: the active one holds
 * an unbound Session card, a parked one holds `R1`, whose resumable
 * transcript is written where claude keeps them. The ledger's reply for `R1`
 * is stated (`publishCardBindings`, as at0761 does) and the parked workspace
 * activated, so the restore pass resumes it into a page made then: the shape
 * of a workspace's first visit, and of a launch. The host's layer rows are
 * sampled across it, each carrying the card's picture on the wall clock. In
 * `R1`'s page, reachable from its ready on, a recorder notes the wall time
 * its restore settled (`restoreSettled`, the reading the restore gate folds).
 * No row before that time shows the card live, and the card is live at the
 * end.
 *
 * The restore gate tells the same arrival, once. A recorder in the overlay
 * page, where the gate is drawn, logs each change of its presence on the
 * same wall clock: it opens once and closes once, stays up at least its
 * floor of 1.25 s, and closes with or after the card's skeleton comes down.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/body/body-publisher.ts
 * @covers tugdeck/src/lib/session-card-restore-gate.ts
 * @covers tugdeck/src/lib/restore-gate-store.ts
 * @covers tugdeck/src/lib/restore-gate-round.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note, type App } from "./_harness";
import type { BodyLayersReading } from "./_harness/client";
import { claudeProjectDir } from "./_harness/claude-home";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "./_harness/tugbank-helpers";
import { settleFor } from "./body-grounding/_bodies";
import { overlayReady } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const ACTIVE_SPACE = "space-active";
const PARKED_SPACE = "space-parked";
const LONE = "S";
const RESUMED = "R1";
const SID = randomUUID();
const TURNS = 40;
/** The sampled window: the switch, the replay, the reveal, and the frames after it. */
const LAYERS_MS = 5_000;
/** The least time an opened gate stays up (`GATE_FLOOR_MS`), ms. */
const GATE_FLOOR_MS = 1_250;
const GATE = '[data-slot="tug-restore-gate"]';

/** One change of the gate's presence, wall-clock ms. */
interface GateEdge {
  t: number;
  open: boolean;
}

/** The gate's recorder, in the overlay page: every change of its presence from here on. */
const INSTALL_GATE_RECORDER = `(function(){
  var log = [];
  var up = function(){ return document.querySelector(${JSON.stringify(GATE)}) !== null; };
  var last = up();
  var check = function(){
    var now = up();
    if (now !== last) { log.push({ t: performance.timeOrigin + performance.now(), open: now }); last = now; }
  };
  var mo = new MutationObserver(check);
  mo.observe(document.body, { subtree: true, childList: true });
  window.__at0826gate = { log: log, startedOpen: last, stop: function(){ mo.disconnect(); } };
  return null;
})()`;

let projectDir = "";
let fixtureDir = "";
let tugbankPath = "";

// Kept local, as at0720 and at0761 keep theirs: this file wants turns enough
// that the reveal is real work.
function buildFixtureJsonl(cwd: string, sessionId: string, turns: number): string {
  const base = { isSidechain: false, userType: "external", cwd, sessionId, version: "2.1.105", gitBranch: "main" };
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

function deckOf(cardId: string) {
  return {
    cards: [{ id: cardId, componentId: "session", title: `Session ${cardId}`, closable: true }],
    panes: [
      {
        id: `p-${cardId}`,
        position: { x: 40, y: 40 },
        size: { width: 560, height: 620 },
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `p-${cardId}`,
    imposition: { sidebars: {} },
  };
}

const LAYOUT = {
  version: 5,
  activeSpaceId: ACTIVE_SPACE,
  spaces: [
    { id: ACTIVE_SPACE, name: "Active", deck: deckOf(LONE) },
    { id: PARKED_SPACE, name: "Parked", deck: deckOf(RESUMED) },
  ],
};

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0826-")));
  writeFileSync(join(projectDir, "README.md"), "at0826\n");
  fixtureDir = claudeProjectDir(projectDir);
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${SID}.jsonl`), buildFixtureJsonl(projectDir, SID, TURNS));
  tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath);
  tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
  if (fixtureDir !== "" && existsSync(fixtureDir)) rmSync(fixtureDir, { recursive: true, force: true });
  if (tugbankPath !== "") rmTempTugbank(tugbankPath);
});

/** What the card's own page recorded, wall-clock ms. */
interface Reading {
  installedAt: number;
  /** The restore was already over when the recorder was installed. */
  settledAtInstall: boolean;
  /** When the restore was first read as over. */
  settledAt: number | null;
  /** When the transcript's list was first in the document. */
  listAt: number | null;
}

/**
 * The recorder, in the card's page: the wall time its restore was first read
 * as over, and its list first mounted, read every millisecond and on every
 * mutation.
 */
const INSTALL_RECORDER = `(function(){
  var stamp = function(){ return performance.timeOrigin + performance.now(); };
  var settled = function(){ return window.__tug.restoreSettled(${JSON.stringify(RESUMED)}) === true; };
  var list = function(){
    return document.querySelector('[data-card-id=${JSON.stringify(RESUMED)}] [data-slot="session-card-transcript"] [data-slot="tug-list-view"]') !== null;
  };
  var r = { installedAt: stamp(), settledAtInstall: settled(), settledAt: null, listAt: null };
  var timer = null;
  var mo = null;
  var check = function(){
    if (r.listAt === null && list()) r.listAt = stamp();
    if (r.settledAt === null && settled()) r.settledAt = stamp();
    if (r.settledAt !== null && r.listAt !== null) {
      if (timer !== null) clearInterval(timer);
      if (mo !== null) mo.disconnect();
    }
  };
  check();
  timer = setInterval(check, 1);
  mo = new MutationObserver(check);
  mo.observe(document.body, { subtree: true, childList: true });
  window.__at0826 = r;
  return null;
})()`;

/** Wait until the host holds `cardId`'s body ready, so its page can be reached. */
async function waitForBodyReady(app: App, cardId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await app.bodies()).some((b) => b.cardId === cardId && b.state === "ready")) return;
    if (Date.now() >= deadline) throw new Error(`card ${cardId}'s body was not ready within ${timeoutMs} ms`);
    await Bun.sleep(10);
  }
}

describe.skipIf(!SHOULD_RUN)("at0826 — a resumed card's skeleton stands through its reveal", () => {
  test(
    "the card's picture is a skeleton until its transcript settles, and live after",
    async () => {
      const app = await launchTugApp({
        testName: "at0826-skeleton-through-reveal",
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
        await app.evalJS<null>(
          `(window.__tug.publishCardBindings(${JSON.stringify([
            { card_id: RESUMED, session_id: SID, project_dir: projectDir, state: "closed", turn_count: TURNS, has_jsonl: true },
          ])}), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.tugdeck.lab.spaceHoldsLiveSessions(${JSON.stringify(PARKED_SPACE)}) === 1`,
          { timeoutMs: 5_000 },
        );

        const overlay = await overlayReady(app);
        await overlay.evalJS<null>(INSTALL_GATE_RECORDER);
        await app.bodyLayers({ op: "arm", windowMs: LAYERS_MS });
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(PARKED_SPACE)} }), null)`,
        );
        await waitForBodyReady(app, RESUMED, 10_000);
        const page = app.body(RESUMED);
        await page.evalJS<null>(INSTALL_RECORDER);
        try {
          await page.waitForCondition<boolean>("window.__at0826.settledAt !== null && window.__at0826.listAt !== null", {
            timeoutMs: 8_000,
          });
        } catch (error) {
          // Where the restore stood when the wait ran out, read once here so
          // a red run says which half never came.
          note("the restore did not settle", {
            reading: await page.evalJS<Reading>("window.__at0826"),
            text: await page.evalJS<string>("document.body.innerText.slice(0, 300)"),
            slots: await page.evalJS<string[]>(
              `Array.from(document.querySelectorAll('[data-card-id=${JSON.stringify(RESUMED)}] [data-slot]')).slice(0, 40).map(function (e) { return e.getAttribute("data-slot"); })`,
            ),
            body: (await app.bodies()).find((b) => b.cardId === RESUMED),
            rows: ((await app.bodyLayers({ op: "read" })) as BodyLayersReading).rows.filter((r) => r.cardId === RESUMED).slice(-3),
          });
          throw error;
        }
        const reading = await page.evalJS<Reading>("window.__at0826");
        const layers = (await settleFor(
          () => app.bodyLayers({ op: "read" }) as Promise<BodyLayersReading>,
          (x) => x.done === true,
          LAYERS_MS + 10_000,
        )) as BodyLayersReading;

        const rows = layers.rows.filter((r) => r.cardId === RESUMED);
        expect(rows.length, "the card was sampled across its arrival").toBeGreaterThan(0);
        // The settle the page read. A restore over before the recorder stood
        // settled no later than the install, which bounds it from above.
        const settledAt = reading.settledAtInstall ? reading.installedAt : (reading.settledAt as number);
        const before = rows.filter((r) => r.wall < settledAt);
        // By the picture alone: a row's `painted` is any paint the page has
        // said, its chrome's included, and the picture is what the user sees.
        const liveEarly = before.filter((r) => r.picture === "live");
        const skeletonsShown = rows.filter((r) => r.shown && r.picture === "skeleton");
        const firstLive = rows.find((r) => r.picture === "live");
        const last = rows[rows.length - 1];
        note("skeleton through the reveal (ms)", {
          settledBeforeRecorder: reading.settledAtInstall,
          listToSettle: reading.listAt === null ? null : Math.round(settledAt - reading.listAt),
          rowsBeforeSettle: before.length,
          skeletonStood:
            skeletonsShown.length === 0 ? 0 : Math.round(skeletonsShown[skeletonsShown.length - 1]!.wall - skeletonsShown[0]!.wall),
          settleToLive: firstLive === undefined ? null : Math.round(firstLive.wall - settledAt),
        });

        expect(skeletonsShown.length, "the card stood a skeleton while its restore ran").toBeGreaterThan(0);
        expect(liveEarly.length, "no sampled frame shows the card live before its transcript settled").toBe(0);
        expect(firstLive, "the card went live").toBeDefined();
        expect(firstLive!.wall, "live only after the settle").toBeGreaterThanOrEqual(settledAt);
        expect(last?.picture, "the card is live at the end").toBe("live");
        // The list was in the document before the skeleton came down: the
        // picture came down onto a transcript, not onto an empty card.
        expect(reading.listAt, "the transcript's list mounted").not.toBeNull();
        expect(reading.listAt as number, "the list mounted under the skeleton").toBeLessThan(firstLive!.wall);

        // The gate: one open, one close, up at least its floor, and down
        // with or after the skeleton.
        await overlay.waitForCondition<boolean>(
          `window.__at0826gate.log.length > 0 && document.querySelector(${JSON.stringify(GATE)}) === null`,
          { timeoutMs: 10_000 },
        );
        const startedOpen = await overlay.evalJS<boolean>("window.__at0826gate.startedOpen");
        const edges = await overlay.evalJS<GateEdge[]>("window.__at0826gate.log");
        await overlay.evalJS<null>("(window.__at0826gate.stop(), null)");
        const opens = edges.filter((e) => e.open);
        const closes = edges.filter((e) => !e.open);
        note("the gate over the arrival (ms)", {
          edges: edges.map((e) => ({ open: e.open, t: Math.round(e.t) })),
          up: opens.length === 1 && closes.length === 1 ? Math.round(closes[0]!.t - opens[0]!.t) : null,
          closeAfterLive: closes.length === 0 ? null : Math.round(closes[closes.length - 1]!.t - firstLive!.wall),
        });
        expect(startedOpen, "no gate stood before the switch").toBe(false);
        expect(opens.length, "the gate opened once").toBe(1);
        expect(closes.length, "the gate closed once").toBe(1);
        // Read in the overlay, which draws what the shell's store says a bus
        // delivery later at each end: a frame and a half of slack.
        expect(closes[0]!.t - opens[0]!.t, "the gate stayed up at least its floor").toBeGreaterThanOrEqual(GATE_FLOOR_MS - 25);
        expect(opens[0]!.t, "the gate was up before the skeleton came down").toBeLessThan(firstLive!.wall);
        // A frame of slack: the page's settle and the host's row are two processes' clocks.
        expect(closes[0]!.t, "the gate closed with or after the skeleton").toBeGreaterThanOrEqual(firstLive!.wall - 17);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
