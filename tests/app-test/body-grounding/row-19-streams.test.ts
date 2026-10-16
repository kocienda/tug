/**
 * row-19-streams.test.ts — a body streams through the shell's settle.
 *
 * The bar's nineteenth row. The settle's motion gate is the shell's: its
 * engine closes it when the beats launch and opens it after the land, and
 * while it is closed the shell's connection parks every session batch so no
 * store commits under the motion. A body's frames are its own process's,
 * and the host carries its view on the shell's beats without the body
 * drawing them, so a body's connection is held behind a gate that never
 * closes (`NEVER_HELD`, `lib/gesture-scope.ts`) and its stream keeps landing
 * through every settle.
 *
 * Body cards are bound to stub sessions and each is sent a prompt whose
 * turn streams for minutes. While they stream, the row drives a flow slide
 * out and back (three bodies) and a cross-column stack move (two, one per
 * column of a two-up), each judged by row 14's motion bar. Across each
 * gesture it taps the shell's trace for the gate's close and open rows, and
 * each body's trace for its `ingest-batch` rows, each stamped on the wall
 * clock (`performance.timeOrigin` plus `performance.now()`, page by page) as
 * it is offered. Every body applied at least one batch between the close and
 * the open, and none of its batches was parked.
 *
 * @foreground
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/connection.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, pollFor, promptPhase, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { carryLeg, standUp, type Rect, type Standing } from "./_motion";

const TEST_NAME = "body-grounding-row-19-streams";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 360_000;

/** A turn this long streams for minutes, past every gesture the row drives. */
const STREAM_MESSAGES = 40;
const SETTLE_MS = 6_000;

/** Six session cards in a four-up flow, body cards in slots 1, 2 and 3. */
function flowDeck(bodies: readonly string[]): Record<string, unknown> {
  const ids = ["r19-n0", bodies[0], bodies[1], bodies[2], "r19-n4", "r19-n5"];
  return {
    cards: ids.map((id) => ({ id, componentId: "session", title: id, closable: true })),
    panes: ids.map((id, slot) => sessionPane(id, slot)),
    activePaneId: `${bodies[0]}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: {} },
    hasFocus: true,
  };
}

/** Two session cards, one per column of a two-up, both body cards. */
function twoUpDeck(bodies: readonly string[]): Record<string, unknown> {
  return {
    cards: bodies.map((id) => ({ id, componentId: "session", title: id, closable: true })),
    panes: bodies.map((id, slot) => ({ ...sessionPane(id, slot), size: { width: 675, height: 620 } })),
    activePaneId: `${bodies[0]}-pane`,
    imposition: { kind: "two-up" },
    hasFocus: true,
  };
}

/**
 * Tap `page`'s trace for `kind`: every row of it the page offers
 * `__deckTrace.record` is kept, on the wall clock, in a list of its own. The
 * trace is left off: a ring of every kind fills in under a second while a
 * body streams, and recording every kind captures a stack per row under the
 * beats. The tap is installed once and emptied on each call.
 */
const tapTrace = (kind: string): string =>
  `(function () {
    var trace = window.__deckTrace;
    if (window.__r19Tap === undefined) {
      var record = trace.record;
      window.__r19Tap = [];
      trace.record = function (event) {
        if (event.kind === ${JSON.stringify(kind)}) {
          var row = { t: performance.timeOrigin + performance.now() };
          for (var k in event) if (k !== "kind") row[k] = event[k];
          window.__r19Tap.push(row);
        }
        return record.call(trace, event);
      };
    }
    window.__r19Tap.length = 0;
    return null;
  })()`;

/** What `page`'s tap has kept since it was last emptied. */
const TAPPED = `window.__r19Tap.slice()`;

/** The closed spans: each close, to the first open after it. */
function closedSpans(edges: readonly { phase: string; t: number }[]): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let from: number | null = null;
  for (const e of edges) {
    if (e.phase === "close" && from === null) from = e.t;
    else if (e.phase === "open" && from !== null) {
      spans.push({ from, to: e.t });
      from = null;
    }
  }
  return spans;
}

/** Bind each body to a long stub turn and wait for it to stand ready. */
async function bindStubs(app: App, bodies: readonly string[], stubDir: string): Promise<void> {
  for (const id of bodies) await spawnStub(app, id, stubDir, STREAM_MESSAGES);
  for (const id of bodies) await waitForBody(app, id);
}

/**
 * Set every body streaming. After the standing reading, which judges a
 * body's fill against its own surface and so wants it at rest, not inked.
 */
async function startStreaming(app: App, bodies: readonly string[]): Promise<void> {
  for (const id of bodies) await app.body(id).driveSession({ op: "send", text: "Walk the module and report each pass." });
  for (const id of bodies) await app.body(id).waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 30_000 });
  note(`${bodies.join(", ")} are streaming`);
}

/**
 * One gesture, carried as row 14 carries it, with every body's stream read
 * across the shell's closed gate the moment the settle is over.
 */
async function streamLeg(
  app: App,
  card: string,
  moved: readonly string[],
  bodies: readonly string[],
  label: string,
  js: string,
  { standing, crop }: { standing: Standing; crop: Rect },
): Promise<void> {
  await app.evalJS<null>(tapTrace("settle-gate"));
  for (const id of bodies) await app.body(id).evalJS<null>(tapTrace("ingest-batch"));

  await carryLeg(app, card, moved, label, js, standing, crop, async () => {
    // The open is written after the land; wait for the edge that pairs the close.
    const edges = await pollFor(
      () => app.evalJS<{ phase: string; t: number }[]>(TAPPED),
      (rows) => closedSpans(rows).length > 0 && rows[rows.length - 1].phase === "open",
      2_000,
    );
    const spans = closedSpans(edges);
    note(`${label}: the shell's gate stood closed over ${spans.map((s) => `${(s.to - s.from).toFixed(0)} ms`).join(", ") || "nothing"}`);
    expect(spans.length, `${label}: the shell's motion gate closed and opened`).toBeGreaterThan(0);

    for (const id of bodies) {
      const batches = await app.body(id).evalJS<{ t: number; parked: boolean; patches: number }[]>(TAPPED);
      const inside = batches.filter((b) => spans.some((s) => b.t > s.from && b.t < s.to));
      const parked = batches.filter((b) => b.parked).length;
      note(
        `${label}: ${id} applied ${batches.length} batch(es) across the gesture, ${inside.length} inside the closed gate ` +
          `(${inside.reduce((n, b) => n + b.patches, 0)} patches), ${parked} parked`,
      );
      expect(inside.length, `${label}: ${id} applied batches while the shell's gate stood closed`).toBeGreaterThan(0);
      expect(parked, `${label}: ${id} parked nothing`).toBe(0);
    }
  });
}

/** Every body is still mid-turn: the stream outlasted the gestures, so it ran through them. */
async function expectStillStreaming(app: App, bodies: readonly string[]): Promise<void> {
  for (const id of bodies) {
    const phase = await app.body(id).evalJS<string>(promptPhase);
    expect(phase, `${id} streamed through every gesture`).toBe("streaming");
  }
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 19: a body streams through the shell's settle", () => {
  test(
    "three streaming bodies keep applying batches through a flow slide out and back",
    async () => {
      const stubDir = stubDirectory();
      const bodies = ["r19-a", "r19-b", "r19-c"];
      const app = await launchTugApp({
        testName: `${TEST_NAME}-flow`,
        foreground: true,
        bodies: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: flowDeck(bodies), focusCardId: bodies[0] });
        await bindStubs(app, bodies, stubDir);
        await focusBody(app, bodies[0], { composer: false });
        await Bun.sleep(400);
        const stood = await standUp(app, bodies[0]);
        await startStreaming(app, bodies);
        await streamLeg(app, bodies[0], bodies, bodies, "go to slot 2", `window.__tug.dispatchControlAction("go-to-slot", { value: 2 })`, stood);
        await streamLeg(app, bodies[0], bodies, bodies, "go to slot 1", `window.__tug.dispatchControlAction("go-to-slot", { value: 1 })`, stood);
        await expectStillStreaming(app, bodies);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "two streaming bodies keep applying batches through a cross-column stack move",
    async () => {
      const stubDir = stubDirectory();
      const bodies = ["r19-s", "r19-m"];
      const mover = bodies[1];
      const app = await launchTugApp({
        testName: `${TEST_NAME}-stack`,
        foreground: true,
        bodies: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: twoUpDeck(bodies), focusCardId: mover });
        await bindStubs(app, bodies, stubDir);
        // Slot 0 stacks, so the mover crosses into it as one move beat.
        await app.evalJS<null>(`(window.__tug.dispatchControlAction("set-column-mode", { slot: 0, mode: "stack" }), null)`);
        await pollFor(
          () => app.evalJS<boolean>(`document.querySelector("[data-deck-canvas-background]")?.hasAttribute("data-imposer-settling") ?? false`),
          (v) => !v,
          SETTLE_MS,
        );
        await focusBody(app, mover, { composer: false });
        await Bun.sleep(400);
        const stood = await standUp(app, mover);
        await startStreaming(app, bodies);
        await streamLeg(
          app,
          mover,
          [mover],
          bodies,
          "stack move",
          `window.__tug.dispatchControlAction("assign-slot", { cardId: ${JSON.stringify(mover)}, slot: 0 })`,
          stood,
        );
        await expectStillStreaming(app, bodies);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
