/**
 * zz-probe-session-body-handoff.test.ts — the Session card's picker → body
 * handoff, sampled frame by frame.
 *
 * ## The question
 *
 * A new Session card arrives hidden and is revealed only when its PICKER is
 * quiet (`session-picker-quiet.ts`). The body — masthead, Z2, transcript,
 * composer — mounts later, on the binding flip, onto a card that is already
 * visible, behind a 200ms opacity ramp and nothing else. This probe watches
 * that second beat: once per animation frame from the instant the binding
 * lands, it records the card root's opacity and, for the Z2 row, which
 * status cells have a box, what each measures, and what the row's host and
 * the entry region measure. A cell that appears, disappears or changes width
 * on a tick AFTER the first one it was seen on is a change the user watched.
 *
 * ## What it can and cannot see
 *
 * `bindSession` takes the production flip — `cardSessionBindingStore` →
 * `cardServicesStore` → `useSyncExternalStore` — so the body's first commit is
 * the real one. But the harness runs in stub mode: no frames flow, so the
 * instruments' wire answers (context max, state changes, arc, activity) do
 * not land on their own. The second leg injects one `system_metadata` frame a
 * beat after the flip to stand in for the first of them.
 *
 * A diagnostic. It asserts only that the sampler was live (not suspended) and
 * prints its reading; the finding is in the `Diagnostics:` section.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.css
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/components/tugways/tug-status-cell.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
/** Long enough to cover the 200ms ramp and a few store answers after it. */
const WINDOW_MS = 700;
/** When the injected metadata frame lands, from the flip. */
const METADATA_AT_MS = 120;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 760, height: 560 },
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

interface Cell {
  p: string;
  display: string;
  w: number;
  h: number;
  x: number;
  text: string;
}

interface Tick {
  t: number;
  tl: number;
  opacity: string | null;
  inlineOpacity: string | null;
  anims: number;
  animTime: number | null;
  animStart: number | null;
  card: { w: number; h: number } | null;
  host: { w: number; h: number; display: string } | null;
  entry: { w: number; h: number } | null;
  cells: Cell[];
}

/**
 * Install the sampler and flip the binding IN ONE SCRIPT, so the first tick
 * precedes the body's first paint. Every read is a forced style/layout of the
 * frame that is about to paint — the pose the user sees on that tick.
 */
function armAndBind(cardId: string, opts: Record<string, unknown>): string {
  return `(function () {
    var card = ${JSON.stringify(CARD)};
    var probe = { ticks: [], raf: 0, t0: performance.now(), armed: true, bindDoneAt: -1, commitDoneAt: -1 };
    window.__handoffProbe = probe;
    function r(el) {
      var b = el.getBoundingClientRect();
      return { w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10, x: Math.round(b.left * 10) / 10 };
    }
    function tick(ts) {
      var root = document.querySelector(card + ' [data-slot="session-card"]');
      var rec = { t: Math.round((performance.now() - probe.t0) * 10) / 10, tl: Math.round(document.timeline.currentTime - probe.t0), opacity: null, inlineOpacity: null, anims: 0, animTime: null, animStart: null, card: null, host: null, entry: null, cells: [] };
      if (root !== null) {
        var cs = getComputedStyle(root);
        rec.opacity = cs.opacity;
        rec.inlineOpacity = root.style.opacity;
        var anims = root.getAnimations(); rec.anims = anims.length; rec.animTime = anims.length > 0 ? Math.round(anims[0].currentTime) : null; rec.animStart = anims.length > 0 && anims[0].startTime !== null ? Math.round(anims[0].startTime - probe.t0) : null;
        var cb = r(root); rec.card = { w: cb.w, h: cb.h };
        var host = root.querySelector('[data-slot="session-card-status-bar"]');
        if (host !== null) { var hb = host.getBoundingClientRect(); rec.host = { w: hb.width, h: hb.height, display: getComputedStyle(host).display }; }
        var entry = root.querySelector('[data-slot="session-card-entry-region"]');
        if (entry !== null) { var eb = r(entry); rec.entry = { w: eb.w, h: eb.h }; }
        var cells = root.querySelectorAll('[data-slot="tug-status-cell"]');
        for (var i = 0; i < cells.length; i++) {
          var c = cells[i]; var b = r(c);
          rec.cells.push({ p: c.getAttribute("data-priority") || "?", display: getComputedStyle(c).display, w: b.w, h: b.h, x: b.x, text: (c.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 32) });
        }
      }
      probe.ticks.push(rec);
      if (probe.armed) probe.raf = requestAnimationFrame(tick);
    }
    probe.raf = requestAnimationFrame(tick);
    window.__tug.bindSession(${JSON.stringify(cardId)}, ${JSON.stringify(opts)});
    probe.bindDoneAt = Math.round((performance.now() - probe.t0) * 10) / 10;
    queueMicrotask(function () { probe.commitDoneAt = Math.round((performance.now() - probe.t0) * 10) / 10; });
    return null;
  })()`;
}

const TAKE = `(function () {
  var p = window.__handoffProbe;
  if (!p) return null;
  p.armed = false;
  cancelAnimationFrame(p.raf);
  var ticks = p.ticks;
  delete window.__handoffProbe;
  return { ticks: ticks, bindDoneAt: p.bindDoneAt, commitDoneAt: p.commitDoneAt };
})()`;

/** One line per tick, and a `*` on the fields that changed since the tick before. */
const boxKey = (b: { w: number; h: number; display?: string } | null): string =>
  b === null ? "-" : `${b.w}x${b.h}/${b.display ?? ""}`;

function render(ticks: Tick[]): string[] {
  const lines: string[] = [];
  let prev: Tick | null = null;
  for (const t of ticks) {
    const cellsKey = (x: Tick): string =>
      x.cells
        .map((c) => `${c.p}${c.display === "none" ? "×" : ""}:${c.w}@${c.x}`)
        .join(" ");
    const shown = t.cells.filter((c) => c.display !== "none").map((c) => c.p);
    const marks: string[] = [];
    if (prev !== null) {
      if ((prev.card === null) !== (t.card === null)) marks.push("root");
      if (cellsKey(prev) !== cellsKey(t)) marks.push("cells");
      // Compare by formatted fields, not JSON: an object crossing the Swift
      // round trip comes back with its keys in no promised order, and a
      // JSON comparison then marks ticks whose values are identical.
      if (boxKey(prev.host) !== boxKey(t.host)) marks.push("host");
      if (boxKey(prev.entry) !== boxKey(t.entry)) marks.push("entry");
      if (prev.cells.map((c) => c.text).join("|") !== t.cells.map((c) => c.text).join("|")) marks.push("ink");
    }
    lines.push(
      `${String(t.t).padStart(6)}ms tl=${t.tl} op=${t.opacity ?? "-"}${t.inlineOpacity ? `(inline ${t.inlineOpacity})` : ""} anim=${t.anims}${t.animTime !== null ? `@${t.animTime}ms start=${t.animStart}` : ""}` +
        ` card=${t.card ? `${t.card.w}x${t.card.h}` : "-"}` +
        ` host=${t.host ? `${t.host.w}x${t.host.h}/${t.host.display}` : "-"}` +
        ` entry=${t.entry ? `${t.entry.w}x${t.entry.h}` : "-"}` +
        ` cells=[${shown.join(",")}] ${cellsKey(t)}` +
        (marks.length > 0 ? `   * ${marks.join(",")}` : ""),
    );
    prev = t;
  }
  return lines;
}

async function seed(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  // The picker is the card until the binding lands — wait for it so the flip
  // below is the picker → body handoff and not a mount onto an empty host.
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(CARD)}) !== null && document.querySelector(${JSON.stringify(CARD)} + ' [data-slot="session-card"]') === null`,
    { timeoutMs: 8_000 },
  );
  await wait(400);
}

function firstBodyTick(ticks: Tick[]): number {
  return ticks.findIndex((t) => t.card !== null);
}

/** Ticks after the first body tick on which the Z2 census or the ink changed. */
function changesAfterFirstPaint(ticks: Tick[]): number[] {
  const first = firstBodyTick(ticks);
  if (first < 0) return [];
  const out: number[] = [];
  const key = (t: Tick): string =>
    JSON.stringify([t.cells.map((c) => [c.p, c.display, c.w, c.x, c.text]), boxKey(t.host), boxKey(t.entry)]);
  for (let i = first + 1; i < ticks.length; i++) {
    if (key(ticks[i]!) !== key(ticks[i - 1]!)) out.push(i);
  }
  return out;
}

describe.skipIf(!SHOULD_RUN)("zz probe — session picker → body handoff", () => {
  test(
    "leg 1: the body's first frames, with no wire",
    async () => {
      const app = await launchTugApp({ testName: "zz-probe-session-body-handoff-1" });
      try {
        await seed(app);
        await app.evalJS<null>(armAndBind("A", {}));
        await wait(WINDOW_MS);
        const taken = await app.evalJS<{ ticks: Tick[]; bindDoneAt: number; commitDoneAt: number }>(TAKE);
        expect(taken, "the sampler was installed").not.toBeNull();
        const ticks = taken.ticks;
        note(`leg 1: bindSession returned at ${taken.bindDoneAt}ms; the microtask after it (React's sync commit of the body) ran at ${taken.commitDoneAt}ms; ${ticks.length} ticks over ${WINDOW_MS}ms; first body tick at index ${firstBodyTick(ticks)}`);
        const changed = changesAfterFirstPaint(ticks);
        note(`leg 1: ticks with a Z2/entry change after first body paint: [${changed.join(", ")}]`);
        for (const line of render(ticks)) note(line);
        expect(ticks.length, "the window was being served (rAF not suspended)").toBeGreaterThan(20);
        expect(firstBodyTick(ticks), "the body mounted inside the window").toBeGreaterThanOrEqual(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "leg 2: one metadata frame landing inside the ramp",
    async () => {
      const app = await launchTugApp({ testName: "zz-probe-session-body-handoff-2" });
      try {
        await seed(app);
        await app.evalJS<null>(armAndBind("A", {}));
        await wait(METADATA_AT_MS);
        await app.ingestSessionMetadata("A", {
          type: "system_metadata",
          model: "claude-opus-5",
          ipc_version: 2,
          cwd: "/tmp/test-project",
        });
        await wait(WINDOW_MS - METADATA_AT_MS);
        const taken = await app.evalJS<{ ticks: Tick[]; bindDoneAt: number; commitDoneAt: number }>(TAKE);
        expect(taken, "the sampler was installed").not.toBeNull();
        const ticks = taken.ticks;
        note(`leg 2: bindSession returned at ${taken.bindDoneAt}ms; commit microtask at ${taken.commitDoneAt}ms; ${ticks.length} ticks; first body tick at index ${firstBodyTick(ticks)}; metadata injected at ~${METADATA_AT_MS}ms`);
        const changed = changesAfterFirstPaint(ticks);
        note(`leg 2: ticks with a Z2/entry change after first body paint: [${changed.join(", ")}]`);
        for (const line of render(ticks)) note(line);
        expect(ticks.length, "the window was being served (rAF not suspended)").toBeGreaterThan(20);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
