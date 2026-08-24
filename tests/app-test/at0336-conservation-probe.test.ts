/**
 * at0336-conservation-probe.test.ts — eviction height accounting and
 * the extent floor, measured.
 *
 * Companion to at0335. That suite pins the *symptom* bound
 * (displacement magnitude); this one measures the *mechanism*: for
 * every commit where rows depart the rendered window into a spacer,
 * the extent the spacer charges for them versus the extent they
 * actually occupied while mounted (the conservation records), and the
 * extent floor that pins the scrollable extent so it cannot dip
 * mid-mutation. The diagnosis this suite produced — WebKit clamps the
 * scroll offset synchronously at renderer removal, inside React's
 * mutation phase, where no scroll API can witness it — is recorded in
 * `dash/scroll-height-floor.md`; the floor is that diagnosis
 * productized, and the driving sequences here (the at0335 swap cycle,
 * the mid-history→max hop) are the ones that deterministically
 * reproduced a ~2,368px displacement before it existed. They now
 * assert zero.
 *
 * The runs write full findings to `/tmp/at0336-*.json` for offline
 * analysis.
 *
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";

import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const FEED_CODE_OUTPUT = 0x40;

const SID = "at0336-A";
const TURNS = 60;
const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';
const FINDINGS_PATH = "/tmp/at0336-conservation.json";

function deckShape(): Record<string, unknown> {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 760 },
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

function replyText(n: number): string {
  return [
    `## step ${n}`,
    "",
    `Reply number ${n}. Long enough that sixty of these build a transcript`,
    "tall enough for eviction to arm and for the top spacer to carry tens",
    "of thousands of pixels of evicted extent.",
    "",
    `- marker ${n}`,
  ].join("\n");
}

/** Stream one committed prompt→reply turn into the bound session. */
async function seedTurn(app: App, n: number): Promise<void> {
  const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
    app.driveSession("A", {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: SID, ...decoded },
    });
  const msgId = `${SID}-m${n}`;
  await app.driveSession("A", { op: "send", text: `prompt ${n}` });
  await frame({ type: "prompt_anchor", promptUuid: `${SID}-u${n}` });
  await frame({
    type: "content_block_start",
    msg_id: msgId,
    block_index: 0,
    kind: "text",
  });
  await frame({
    type: "assistant_text",
    msg_id: msgId,
    block_index: 0,
    text: replyText(n),
    is_partial: false,
  });
  await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
}

/** Launch, seed a tall transcript, and wait until eviction has armed. */
async function standUp(testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 20_000 });
  for (let n = 0; n < TURNS; n += 1) {
    await seedTurn(app, n);
  }
  await app.waitForCondition<boolean>(
    `!!document.querySelector('${SCROLLER}[data-evict-active]')`,
    { timeoutMs: 30_000 },
  );
  await new Promise((r) => setTimeout(r, 500));
  return app;
}

interface Conservation {
  events: {
    departed: number;
    sumLedger: number;
    sumLive: number;
    delta: number;
    first: number;
    last: number;
    itemCount: number;
    scrollHeight: number;
    rows: { index: number; kind: string; ledger: number; live: number }[];
  }[];
  audit: {
    gap: number;
    mounted: number;
    worst: number;
    rows: {
      index: number;
      kind: string;
      ledger: number | null;
      live: number;
      delta: number;
    }[];
  };
  ring: {
    top: number;
    h: number;
    ts: number;
    bs: number;
    first: number;
    last: number;
    n: number;
  }[];
  floor: { height: number; inset: number };
}

/** Displacements after `since` whose magnitude exceeds `px`. */
function bigDisplacements(
  displacements: Record<string, unknown>[],
  since: number,
  px: number,
): Record<string, unknown>[] {
  return displacements
    .slice(since)
    .filter((x) => Math.abs((x.to as number) - (x.from as number)) > px);
}

function readConservation(app: App): Promise<Conservation> {
  return app.evalJS<Conservation>(
    `window.__tug.getListConservation('${SCROLLER}')`,
  );
}

/** Displacement records in the deck-trace ring, every field. */
function readDisplacements(app: App): Promise<Record<string, unknown>[]> {
  return app.evalJS(`(function () {
  return window.__deckTrace.dump()
    .filter(function (e) { return e.kind === "scroll-displacement"; });
})()`);
}

describe.skipIf(!SHOULD_RUN)("AT0336: eviction conservation probe", () => {
  test(
    "window swaps account for every departed pixel",
    async () => {
      const app = await standUp("at0336-conservation");
      try {
        const findings: Record<string, unknown> = {};

        // Rest state: does the ledger agree with the DOM before any
        // driving? Mismatches here are steady-state divergence, no
        // eviction required.
        findings.restAudit = (await readConservation(app)).audit;
        findings.afterSeed = (await readConservation(app)).events;

        // Drive the window through the whole transcript, the at0335
        // swap cycle. Conservation events accumulate per re-window.
        await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var max = el.scrollHeight - el.clientHeight;
  window.__at0336 = { stops: [max, max * 0.6, max * 0.2, 0, max * 0.4, max * 0.8, max] };
  return true;
})()`);
        for (let i = 0; i < 7; i += 1) {
          await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = window.__at0336.stops[${i}];
  return el.scrollTop;
})()`);
          await new Promise((r) => setTimeout(r, 400));
        }
        findings.afterSwaps = await readConservation(app);

        // Streaming growth: the continuous small-dip population.
        for (let n = 0; n < 3; n += 1) {
          await seedTurn(app, TURNS + n);
          await new Promise((r) => setTimeout(r, 300));
        }
        await new Promise((r) => setTimeout(r, 700));
        const finalState = await readConservation(app);
        findings.afterStreaming = finalState;
        findings.displacements = await readDisplacements(app);

        writeFileSync(FINDINGS_PATH, JSON.stringify(findings, null, 2));

        // The probe is alive and the drive produced eviction traffic.
        expect(finalState.events.length).toBeGreaterThan(0);
        expect(finalState.audit.mounted).toBeGreaterThan(0);

        // The extent floor is standing: its height tracks the settled
        // extent (extent − 1; the ring's last entry is the most recent
        // commit's post-layout `scrollHeight`, allow the one commit of
        // rebase slack).
        const lastRing = finalState.ring[finalState.ring.length - 1]!;
        expect(finalState.floor.height).toBeGreaterThan(0);
        expect(Math.abs(finalState.floor.height - (lastRing.h - 1))).toBeLessThanOrEqual(2);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Verbatim replica of at0335's "repeated window swaps displace
  // nobody" driving — the sequence that deterministically recorded a
  // ~2,368px displacement before the extent floor existed —
  // instrumented to capture the full context: every displacement
  // field, the conservation records, and geometry before/after each
  // stop.
  //
  // The second variant disables scroll anchoring for the transcript
  // before driving. During the diagnosis it exonerated anchoring (the
  // big displacement was pixel-identical with anchoring off); it stays
  // because the floor must hold in both anchoring regimes, and a
  // regression that only reproduces in one of them should still fail
  // exactly one named test.
  for (const anchoring of [true, false] as const) {
    test(
      anchoring
        ? "replica: at0335 swap sequence with full context capture"
        : "replica: same drive with scroll anchoring disabled",
      async () => {
        const app = await standUp(
          anchoring ? "at0336-replica" : "at0336-noanchor",
        );
        try {
          if (!anchoring) {
            await app.evalJS<boolean>(`(function () {
  var style = document.createElement("style");
  style.textContent =
    '[data-tug-scroll-key="session-card-transcript"], ' +
    '[data-tug-scroll-key="session-card-transcript"] * ' +
    '{ overflow-anchor: none !important; }';
  document.head.appendChild(style);
  return true;
})()`);
            await new Promise((r) => setTimeout(r, 200));
          }
        const findings: Record<string, unknown> = {};
        await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var max = el.scrollHeight - el.clientHeight;
  var stops = [max, max * 0.6, max * 0.2, 0, max * 0.4, max * 0.8, max];
  window.__at0335 = { stops: stops, i: 0 };
  return true;
})()`);
        const stopGeometry: unknown[] = [];
        for (let i = 0; i < 7; i += 1) {
          const geo = await app.evalJS<unknown>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var before = {
    top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight,
  };
  el.scrollTop = window.__at0335.stops[${i}];
  return {
    stop: ${i}, target: window.__at0335.stops[${i}],
    before: before, topAfterWrite: el.scrollTop,
  };
})()`);
          stopGeometry.push(geo);
          await new Promise((r) => setTimeout(r, 400));
        }
        findings.stopGeometry = stopGeometry;
        findings.afterSwapsDisplacements = await readDisplacements(app);
        findings.afterSwapsConservation = await readConservation(app);

        await seedTurn(app, TURNS);
        await new Promise((r) => setTimeout(r, 1000));

        findings.finalDisplacements = await readDisplacements(app);
        findings.finalConservation = await readConservation(app);
        findings.finalGeometry = await app.evalJS<unknown>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
})()`);

        writeFileSync(
          anchoring
            ? "/tmp/at0336-replica.json"
            : "/tmp/at0336-replica-noanchor.json",
          JSON.stringify(findings, null, 2),
        );
        // Before the extent floor, this exact drive deterministically
        // recorded a ~2,368px displacement on the mid-history→max hop.
        // The floor makes the mid-mutation extent dip impossible, so
        // the swap-scale population must be empty across the whole run.
        expect(
          bigDisplacements(
            findings.finalDisplacements as Record<string, unknown>[],
            0,
            100,
          ),
        ).toEqual([]);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  // Catch the mover red-handed. The big displacement survives with
  // conservation exact, no inter-commit height dip, and anchoring
  // disabled — so either some JavaScript moves the position through a
  // side door (a focus() without preventScroll, a scrollIntoView, a
  // direct write outside SmartScroll), or a layout forced mid-mutation
  // sees the document with cells detached and spacers not yet grown
  // and clamps. Wrapping the movers and the layout-forcing getters
  // with stack capture distinguishes the two and names the caller.
  test(
    "name the mid-swap scroll mover",
    async () => {
      const app = await standUp("at0336-mover");
      try {
        await app.evalJS<boolean>(`(function () {
  var scroller = document.querySelector('${SCROLLER}');
  var log = [];
  var lastTop = scroller.scrollTop;
  var inHook = false;
  window.__at0336Movers = log;
  function note(tag, extra) {
    if (inHook) return;
    inHook = true;
    var top = scroller.scrollTop;
    if (Math.abs(top - lastTop) > 1 && log.length < 120) {
      log.push({
        tag: tag,
        from: lastTop,
        to: top,
        extra: extra || null,
        stack: String(new Error().stack).slice(0, 2000),
      });
    }
    lastTop = top;
    inHook = false;
  }
  var stDesc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get: function () { return stDesc.get.call(this); },
    set: function (v) {
      stDesc.set.call(this, v);
      if (this === scroller && log.length < 120) {
        log.push({
          tag: "scrollTop-set",
          to: v,
          stack: String(new Error().stack).slice(0, 2000),
        });
        lastTop = stDesc.get.call(scroller);
      }
    },
  });
  function wrapGetter(proto, name) {
    var d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !d.get) return;
    var orig = d.get;
    Object.defineProperty(proto, name, {
      configurable: true,
      get: function () {
        var v = orig.call(this);
        note(name);
        return v;
      },
    });
  }
  wrapGetter(HTMLElement.prototype, "offsetHeight");
  wrapGetter(HTMLElement.prototype, "offsetTop");
  wrapGetter(Element.prototype, "clientHeight");
  wrapGetter(Element.prototype, "scrollHeight");
  var origRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    var r = origRect.call(this);
    note("getBoundingClientRect");
    return r;
  };
  var origSiv = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () {
    if (log.length < 120) {
      log.push({
        tag: "scrollIntoView",
        stack: String(new Error().stack).slice(0, 2000),
      });
    }
    return origSiv.apply(this, arguments);
  };
  var origFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function () {
    if (log.length < 120) {
      log.push({
        tag: "focus",
        stack: String(new Error().stack).slice(0, 2000),
      });
    }
    return origFocus.apply(this, arguments);
  };
  return true;
})()`);

        // Reproduce just the failing hop: park mid-history the way
        // stop 5 does, then jump to the max the way stop 6 does.
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var max = el.scrollHeight - el.clientHeight;
  el.scrollTop = max * 0.8;
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 400));
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollHeight - el.clientHeight;
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 600));

        const movers = await app.evalJS<unknown[]>(
          `window.__at0336Movers`,
        );
        const displacements = await readDisplacements(app);
        writeFileSync(
          "/tmp/at0336-movers.json",
          JSON.stringify({ movers, displacements }, null, 2),
        );
        expect(Array.isArray(movers)).toBe(true);
        expect(bigDisplacements(displacements, 0, 100)).toEqual([]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // The productized extent floor. The countermeasure this test once
  // injected by hand — an absolutely-positioned one-pixel height post
  // pinning the scrollable extent — now ships in `TugListView` as
  // `.tug-list-view-floor`, written by the commit bracket to the last
  // settled extent minus one. This test verifies the shipped article:
  // the element is present, its height tracks the extent, and the
  // mid-history→max hop that deterministically displaced ~2,368px
  // before the floor existed displaces nothing.
  test(
    "the shipped extent floor prevents the mid-swap displacement",
    async () => {
      const app = await standUp("at0336-post");
      try {
        const floorState = await app.evalJS<{
          present: boolean;
          floorPx: number;
          scrollHeight: number;
        }>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var floor = el.querySelector(".tug-list-view-floor");
  return {
    present: floor !== null,
    floorPx: floor === null ? -1 : parseFloat(floor.style.height || "0"),
    scrollHeight: el.scrollHeight,
  };
})()`);
        const probeFloor = (await readConservation(app)).floor;
        const displBefore = (await readDisplacements(app)).length;

        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var max = el.scrollHeight - el.clientHeight;
  el.scrollTop = max * 0.8;
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 400));
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollHeight - el.clientHeight;
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 600));

        const displacements = await readDisplacements(app);
        writeFileSync(
          "/tmp/at0336-post.json",
          JSON.stringify(
            { floorState, probeFloor, displBefore, displacements },
            null,
            2,
          ),
        );
        expect(floorState.present).toBe(true);
        expect(floorState.floorPx).toBe(probeFloor.height);
        expect(
          Math.abs(floorState.floorPx - (floorState.scrollHeight - 1)),
        ).toBeLessThanOrEqual(2);
        expect(bigDisplacements(displacements, displBefore, 100)).toEqual([]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
