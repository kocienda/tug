/**
 * `SmartScroll`'s idle intent rule against growth, and the record a
 * follow-bottom flip leaves behind.
 *
 * A field capture caught a transcript releasing the live edge in three
 * scroll events: pinned at the edge twice while the document grew, then
 * `scrollTop` 20492 → 20491 in the same frame `scrollHeight` went
 * 21712 → 21778. One pixel of sub-pixel rounding read as "scrolled up",
 * and the arriving content put the live distance over the 60px band. The
 * rule now judges an upward move against the extent the user was last
 * SHOWN as well as the live one, so growth cannot read as the user
 * leaving — while a real unattributed move of the same kind (a native
 * scrollbar drag delivers nothing else) still releases the edge.
 *
 * A flip tagged `unattributed-scroll-up` says only that SmartScroll could
 * not attribute the move, so every flip record carries the scroller's
 * identity, the page's focus / visibility state, and the `scroll` events
 * that led there. The record's shape is pinned on a wheel-up, the one
 * disengage whose cause is never in doubt.
 *
 * These cases drive a real `SmartScroll` on a jsdom scroller whose geometry
 * the rig controls; the `scroll` events the browser would deliver are
 * dispatched by hand, one per position the rig sets.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { deckTrace } from "../deck-trace";
import { SmartScroll } from "../lib/smart-scroll";

/** The field capture's geometry: pinned at the live edge. */
const VIEWPORT = 1220;
const CONTENT = 21712;
const AT_BOTTOM = CONTENT - VIEWPORT;

/** SmartScroll's at-bottom jitter band. */
const AT_BOTTOM_PX = 60;

interface Rig {
  smartScroll: SmartScroll;
  el: HTMLElement;
  win: Window & typeof globalThis;
  /** Set the scroller's extent. */
  setHeight(px: number): void;
  /** Set `scrollTop` and deliver the `scroll` event the browser would. */
  scrollTo(top: number): void;
  dispose(): void;
}

let priorGlobals: Record<string, unknown> | null = null;
let rig: Rig | null = null;

function makeRig(): Rig {
  const dom = new JSDOM(
    "<!doctype html><div data-card-id='card-A'>" +
      "<div id='scroller' data-tug-scroll-key='session-card-transcript'></div></div>",
  );
  const win = dom.window as unknown as Window & typeof globalThis;
  const globals = globalThis as Record<string, unknown>;
  priorGlobals = {
    window: globals.window,
    document: globals.document,
    requestAnimationFrame: globals.requestAnimationFrame,
    cancelAnimationFrame: globals.cancelAnimationFrame,
  };
  globals.window = win;
  globals.document = win.document;
  globals.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    setTimeout(() => cb(0), 0) as unknown as number;
  globals.cancelAnimationFrame = (id: number): void => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  };

  const el = win.document.getElementById("scroller") as HTMLElement;
  let height = CONTENT;
  let top = AT_BOTTOM;
  Object.defineProperty(el, "scrollHeight", { get: () => height });
  Object.defineProperty(el, "clientHeight", { get: () => VIEWPORT });
  Object.defineProperty(el, "clientWidth", { get: () => 400 });
  Object.defineProperty(el, "offsetWidth", { get: () => 400 });
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, height - VIEWPORT));
    },
  });

  const smartScroll = new SmartScroll({ scrollContainer: el, followBottom: true });
  return {
    smartScroll,
    el,
    win,
    setHeight: (px) => {
      height = px;
    },
    scrollTo: (next) => {
      el.scrollTop = next;
      el.dispatchEvent(new win.Event("scroll"));
    },
    dispose: () => smartScroll.dispose(),
  };
}

/** Follow-bottom flips in the deck-trace ring, oldest first. The kind is
 *  always recorded, so no trace opt-in is needed to read it. */
function flips(): { following: boolean; source: string }[] {
  return deckTrace
    .dump()
    .filter((e) => e.kind === "follow-bottom")
    .map((e) => {
      const f = e as unknown as { following: boolean; source: string };
      return { following: f.following, source: f.source };
    });
}

afterEach(() => {
  rig?.dispose();
  rig = null;
  deckTrace.clear();
  if (priorGlobals !== null) {
    const globals = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(priorGlobals)) {
      // Assigned, never `delete`d: deleting a global leaves JSC unable to
      // cache global lookups for the rest of the run, slowing every later
      // file.
      globals[key] = value;
    }
    priorGlobals = null;
  }
});

describe("growth under a pixel of jitter", () => {
  test("a pixel of jitter under fresh growth does not release the live edge", () => {
    deckTrace.clear();
    rig = makeRig();
    expect(rig.smartScroll.isFollowingBottom).toBe(true);

    // Pinned at the edge twice while the document was shown at its
    // resting extent.
    rig.scrollTo(AT_BOTTOM);
    rig.scrollTo(AT_BOTTOM);

    // Growth and jitter in ONE step, as in the capture: no scroll event
    // is delivered between them, so the rule sees the new position
    // against the grown extent while the extent the user was last shown
    // is still the old one.
    const before = { sh: rig.el.scrollHeight, top: rig.el.scrollTop };
    rig.setHeight(CONTENT + 200);
    rig.scrollTo(before.top - 1);
    const drive = {
      grewBy: rig.el.scrollHeight - before.sh,
      movedBy: rig.el.scrollTop - before.top,
      liveDist: Math.round(
        rig.el.scrollHeight - rig.el.clientHeight - rig.el.scrollTop,
      ),
    };

    // The drive has to have produced the failing conditions, or the
    // assertion below passes for the wrong reason.
    expect(drive.grewBy).toBeGreaterThan(AT_BOTTOM_PX);
    expect(drive.movedBy).toBe(-1);
    expect(drive.liveDist).toBeGreaterThan(AT_BOTTOM_PX);

    // One pixel is not a gesture, and content arriving is not the user
    // leaving.
    expect(flips().filter((f) => f.source === "unattributed-scroll-up"))
      .toHaveLength(0);
    expect(rig.smartScroll.isFollowingBottom).toBe(true);

    // The control, on the same scroller moments later: a real upward
    // move of the same unattributed kind still releases the edge. The
    // rule got narrower, not weaker.
    rig.setHeight(CONTENT);
    rig.scrollTo(rig.el.scrollTop - 900);
    expect(flips().filter((f) => f.source === "unattributed-scroll-up"))
      .not.toHaveLength(0);
    expect(rig.smartScroll.isFollowingBottom).toBe(false);
  });
});

describe("the flip record", () => {
  test("a flip record names the scroller and carries the scroll events behind it", () => {
    deckTrace.clear();
    rig = makeRig();
    const r = rig;

    // Scroll events before the gesture, so the ring has history to carry.
    r.scrollTo(AT_BOTTOM);
    r.scrollTo(AT_BOTTOM);
    r.scrollTo(AT_BOTTOM);

    for (let i = 0; i < 6; i += 1) {
      r.el.dispatchEvent(
        new r.win.WheelEvent("wheel", { deltaY: -400, bubbles: true, cancelable: true }),
      );
      r.scrollTo(Math.max(0, r.el.scrollTop - 400));
    }

    const rows = deckTrace
      .dump()
      .filter((e) => e.kind === "follow-bottom")
      .map((e) => e as unknown as {
        source: string;
        following: boolean;
        scrollKey: string;
        cardId: string;
        visibility: string;
        windowFocused: boolean;
        top: number;
        dist: number;
        sinceInputMs: number | null;
        ring: string;
      })
      .filter((e) => e.following === false);
    expect(rows.length).toBeGreaterThan(0);
    const flip = rows[rows.length - 1]!;

    expect(flip.source).toBe("wheel-up");
    // Which scroller, in a deck that can hold several transcripts.
    expect(flip.scrollKey).toBe("session-card-transcript");
    expect(flip.cardId.length).toBeGreaterThan(0);
    // What the page was doing. The value is whatever the window state is —
    // the contract is that it is RECORDED, since a scroller the user
    // cannot see is one they cannot have scrubbed.
    expect(typeof flip.visibility).toBe("string");
    expect(typeof flip.windowFocused).toBe("boolean");
    // The gesture is fresh, and the geometry is real. `dist` is read at
    // the flip, which for `wheel-up` is the wheel event itself — before
    // the movement it stands for — so it carries no lower bound here.
    expect(flip.sinceInputMs).not.toBeNull();
    expect(flip.sinceInputMs!).toBeGreaterThanOrEqual(0);
    expect(flip.top).toBeGreaterThan(0);
    expect(Number.isFinite(flip.dist)).toBe(true);
    // The ring: `Δms,top,scrollHeight,clientHeight` tuples, oldest first,
    // every Δ non-positive (they precede the flip).
    const samples = flip.ring.split("|").filter((s) => s.length > 0);
    expect(samples.length).toBeGreaterThan(1);
    for (const sample of samples) {
      const parts = sample.split(",").map(Number);
      expect(parts).toHaveLength(4);
      expect(parts[0]!).toBeLessThanOrEqual(0);
      expect(parts[2]!).toBeGreaterThan(0);
      expect(parts[3]!).toBeGreaterThan(0);
    }
  });
});
