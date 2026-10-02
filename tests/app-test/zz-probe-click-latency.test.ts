/**
 * zz-probe-click-latency.test.ts — what the gesture scope's hold costs an
 * ordinary click.
 *
 * The scope holds every store-driven React update until after the next painted
 * frame. A click that launches no motion gains nothing from that, so the
 * question is what it pays. `PerformanceEventTiming` cannot answer it: its
 * input-to-next-paint ends at the first paint after the handlers ran, which is
 * exactly the paint the hold moves React past — the held update is not in it.
 * And it reports trusted input only, so no synthesized click is timed at all.
 *
 * So this reads the paint that carries the click's response. Each click is
 * watched for the named DOM change that IS its response — the pane's
 * `data-focused` turning `true` when the click activates a card, the
 * checkbox's `data-state`, the row's `data-selected`, the menu leaving the
 * document — and every animation frame is time-stamped from the click. A
 * change is painted by the first frame that starts after it. Watching named
 * changes rather than "the last mutation" matters: the bypass below also
 * stills every tween, and a tween's end writes the DOM too.
 *
 * The same clicks run with the hold on and with it bypassed — `--tug-motion: 0`
 * inline on the root, which is the switch `GestureScope.open` reads — on the
 * same build, same deck.
 *
 * Each control is clicked twice in a row: the first click activates its card
 * (a store-driven change the hold holds), the second lands in a card already
 * active. The readings are notes, not bars: this file asserts only that the
 * instrument saw frames and mutations, so an occluded window that suspends
 * `requestAnimationFrame` reads as a failure rather than as zeros.
 *
 * A menu item is not among them: its click plays the item's blink before the
 * menu closes, so it launches motion, and the bypass — which stills motion —
 * would change the very thing being timed.
 *
 * @covers tugdeck/src/lib/gesture-scope.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Rounds per control per hold setting; each round is one activating and one warm click. */
const ROUNDS = 6;
/** How long after a click the recorder watches. Past the hold's 50 ms deadline. */
const WINDOW_MS = 160;
/** Quiet between clicks, so one click's tail is not the next one's head. */
const SETTLE_MS = 250;

interface Control {
  name: string;
  cardId: string;
  paneId: string;
  componentId: string;
  /** Found inside the card's host root. */
  target: string;
  /** Click this first, unmeasured, to reach the target (the menu's button). */
  opener?: string;
  /** The control's own response, beside the pane's focus. */
  response?: Watch;
}

/** A named DOM change: an attribute set on a match, or a match leaving the document. */
type Watch =
  | { name: string; selector: string; attr: string; value?: string }
  | { name: string; removed: string };

const CONTROLS: Control[] = [
  { name: "button", cardId: "B", paneId: "p0", componentId: "gallery-buttons", target: "button" },
  {
    name: "checkbox",
    cardId: "C",
    paneId: "p1",
    componentId: "gallery-checkbox",
    target: "[data-slot=tug-checkbox]:not([disabled])",
    response: { name: "checked state", selector: '[data-card-id="C"] [data-slot=tug-checkbox]', attr: "data-state" },
  },
  {
    name: "list row",
    cardId: "L",
    paneId: "p2",
    componentId: "gallery-list-view",
    target: "[data-tug-list-cell-index]:nth-child(2)",
  },
];

/**
 * The page half: click `selector`'s first match from a task, and record the
 * first time each watched change lands and every frame, for `windowMs`. The
 * result lands on `window.__clickLatency` for the shell to read.
 */
function recordScript(selector: string, watches: Watch[], windowMs: number): string {
  return `(function () {
  window.__clickLatency = null;
  var sel = ${JSON.stringify(selector)};
  var watches = ${JSON.stringify(watches)};
  var el = document.querySelector(sel);
  if (!el) { window.__clickLatency = { error: "no element: " + sel }; return true; }
  setTimeout(function () {
    var hits = {};
    var frames = [];
    var t0 = performance.now();
    var mo = new MutationObserver(function (records) {
      var t = performance.now() - t0;
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        for (var j = 0; j < watches.length; j++) {
          var w = watches[j];
          if (hits[w.name] !== undefined) continue;
          if (w.attr !== undefined) {
            if (r.type !== "attributes" || r.attributeName !== w.attr) continue;
            if (!(r.target instanceof Element) || !r.target.matches(w.selector)) continue;
            if (w.value !== undefined && r.target.getAttribute(w.attr) !== w.value) continue;
            hits[w.name] = t;
          } else if (r.type === "childList") {
            for (var k = 0; k < r.removedNodes.length; k++) {
              var n = r.removedNodes[k];
              if (n instanceof Element && (n.matches(w.removed) || n.querySelector(w.removed))) { hits[w.name] = t; break; }
            }
          }
        }
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    function tick() {
      var t = performance.now() - t0;
      frames.push(t);
      if (t < ${windowMs}) { requestAnimationFrame(tick); return; }
      mo.disconnect();
      window.__clickLatency = { hits: hits, frames: frames };
    }
    requestAnimationFrame(tick);
    setTimeout(function () {
      if (window.__clickLatency === null) {
        mo.disconnect();
        window.__clickLatency = { hits: hits, frames: frames, stalled: true };
      }
    }, ${windowMs} + 400);
    window.__tug.click(sel);
  }, 0);
  return true;
})()`;
}

interface Reading {
  hits: Record<string, number>;
  frames: number[];
  stalled?: boolean;
  error?: string;
}

/** The frame that paints `t`: the first frame starting after it. */
function paintOf(frames: number[], t: number): number | null {
  for (const f of frames) if (f > t) return f;
  return null;
}

async function measure(app: App, selector: string, watches: Watch[]): Promise<Reading> {
  await app.evalJS(recordScript(selector, watches, WINDOW_MS));
  await app.waitForCondition<boolean>("window.__clickLatency !== null", { timeoutMs: 3000 });
  return app.evalJS<Reading>("window.__clickLatency");
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.floor(s.length / 2)];
};

describe.skipIf(!SHOULD_RUN)("zz-probe: click latency, hold on vs bypassed", () => {
  test(
    "an ordinary click's response paint, with the gesture scope holding and bypassed",
    async () => {
      const app = await launchTugApp({ testName: "zz-probe-click-latency" });
      try {
        await app.seedDeckState({
          state: {
            cards: CONTROLS.map((c) => ({ id: c.cardId, componentId: c.componentId, title: c.name, closable: true })),
            panes: CONTROLS.map((c, i) => ({
              id: `p${i}`,
              position: { x: 20 + (i % 2) * 470, y: 20 + Math.floor(i / 2) * 360 },
              size: { width: 450, height: 340 },
              cardIds: [c.cardId],
              activeCardId: c.cardId,
              title: "",
              acceptsFamilies: ["maker"],
            })),
            activePaneId: "p0",
            hasFocus: true,
          },
          focusCardId: CONTROLS[0].cardId,
        });
        await app.waitForCondition<boolean>(
          CONTROLS.map((c) => `window.__tug.assertHostRootRegistered(${JSON.stringify(c.cardId)})`).join(" && "),
        );
        await wait(500);

        const scoped = (c: Control, sel: string) => `[data-card-id="${c.cardId}"] ${sel}`;
        // A menu's items are portalled out of the card.
        const targetSel = (c: Control) => (c.opener ? c.target : scoped(c, c.target));

        const results: Record<string, number[]> = {};
        const push = (key: string, v: number | null) => {
          if (v === null) return;
          (results[key] ??= []).push(v);
        };
        let framesSeen = 0;
        let hitsSeen = 0;

        for (const hold of ["on", "bypassed"] as const) {
          await app.evalJS(
            hold === "bypassed"
              ? `document.documentElement.style.setProperty("--tug-motion", "0"), true`
              : `document.documentElement.style.removeProperty("--tug-motion"), true`,
          );
          for (let round = 0; round < ROUNDS; round += 1) {
            for (const c of CONTROLS) {
              // The menu's opener activates its card first, so its item click is never an activating one.
              const kinds = c.opener ? ["warm"] : ["activating", "warm"];
              for (const kind of kinds) {
                if (c.opener) {
                  await app.click(scoped(c, c.opener));
                  await wait(SETTLE_MS);
                }
                const focus: Watch = {
                  name: "pane focused",
                  selector: `.tug-pane[data-pane-id="${c.paneId}"]`,
                  attr: "data-focused",
                  value: "true",
                };
                const watches: Watch[] = kind === "activating" ? [focus] : [];
                if (c.response) watches.push(c.response);
                if (watches.length === 0) continue;
                const r = await measure(app, targetSel(c), watches);
                if (r.error !== undefined) {
                  note(`${c.name} ${kind} hold ${hold}: ${r.error}`);
                  await app.evalJS(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
                  await wait(SETTLE_MS);
                  continue;
                }
                if (r.stalled) note(`${c.name} ${kind} hold ${hold}: frames stalled (${r.frames.length} frames)`);
                const gaps = r.frames.slice(1).map((f, i) => f - r.frames[i]);
                push(`frame interval | hold ${hold}`, gaps.length > 0 ? median(gaps) : null);
                framesSeen = Math.max(framesSeen, r.frames.length);
                push(`${c.name} | ${kind} | hold ${hold} | first frame`, r.frames.length > 0 ? r.frames[0] : null);
                for (const w of watches) {
                  const t = r.hits[w.name];
                  const key = `${c.name} | ${kind} | hold ${hold} | ${w.name}`;
                  if (t === undefined) {
                    push(`${key} | MISSED`, 0);
                    continue;
                  }
                  hitsSeen += 1;
                  push(`${key} | lands`, t);
                  push(`${key} | painted`, paintOf(r.frames, t));
                }
                await wait(SETTLE_MS);
              }
            }
          }
        }
        await app.evalJS(`document.documentElement.style.removeProperty("--tug-motion"), true`);

        for (const key of Object.keys(results).sort()) {
          const xs = results[key];
          note(`${key}: median ${median(xs).toFixed(1)} ms over ${xs.length} [${xs.map((x) => x.toFixed(0)).join(" ")}]`);
        }

        // The instrument, not the deck: frames were painted and mutations were seen.
        expect(framesSeen).toBeGreaterThan(4);
        expect(hitsSeen).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
