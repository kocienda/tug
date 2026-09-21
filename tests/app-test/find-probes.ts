/**
 * find-probes.ts — the shared instrument the at06xx find tests read through.
 *
 * ## Why this exists
 *
 * Find's failures are failures of motion, and a one-shot settle read has
 * passed a broken motion fix in this codebase before: the view was correct
 * in the frame the test looked at and wrong in the twenty frames around it.
 * So every "is it in view / did it move" assertion in the find suite reads
 * through {@link sampleReveal} — a `requestAnimationFrame` loop *inside the
 * page under test* that records the whole window and hands back the array.
 * Assertions are over the array (the last ten samples all in band, the
 * scroll offset constant across them), never over one reading.
 *
 * The sampler is test code that happens to live in the page. It is not
 * product polling: nothing it does survives the `evalJS` that reads it.
 *
 * **A covered harness window stalls `requestAnimationFrame`.** A sampler
 * that comes back with fewer than {@link MIN_SAMPLES} frames is reporting
 * occlusion, not a find defect — `expectSamples` says so in the failure
 * message rather than letting it read as a reveal that never settled.
 *
 * The second instrument is the product's own find trace
 * (`tugdeck/src/lib/find-trace.ts`, bound at `window.__findTrace`).
 * {@link markTrace} / {@link traceSince} bracket a gesture, and
 * {@link awaitRevealTerminal} is what a walk waits on between ⌘G presses:
 * the reveal's own terminal event, rather than a sleep long enough to
 * usually be enough.
 *
 * @module tests/app-test/find-probes
 */

import type { App } from "./_harness";

/** The transcript scroller's stable scroll key. */
export const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';

/** Selectors for one Session card, by deck card id. */
export function sessionSelectors(cardId = "A"): {
  card: string;
  editor: string;
  findBar: string;
  findInput: string;
  chip: string;
} {
  const card = `[data-card-id="${cardId}"]`;
  const findBar = `${card} [data-slot="session-card-find-bar"]`;
  return {
    card,
    editor: `${card} [data-slot="tug-prompt-entry"] [data-slot="tug-text-editor"] .cm-content`,
    findBar,
    findInput: `${findBar} [data-testid="session-card-find-input"] .cm-content`,
    chip: `${card} [data-slot="find-count-value"]`,
  };
}

/** One Session card in one pane, at the given size. */
export function sessionDeckShape(
  cardIds: readonly string[] = ["A"],
  size: { width: number; height: number } = { width: 900, height: 760 },
): Record<string, unknown> {
  return {
    cards: cardIds.map((id) => ({
      id,
      componentId: "session",
      title: `Session ${id}`,
      closable: true,
    })),
    panes: cardIds.map((id, i) => ({
      id: `p${i + 1}`,
      position: { x: 40 + i * (size.width + 30), y: 40 },
      size,
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
    })),
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * Synthetic chord at the active element — the at0339 precedent. The
 * keybinding matcher keys on code + modifiers, so this is indistinguishable
 * from the real press as far as the pipeline is concerned.
 */
export async function chord(
  app: App,
  code: string,
  key: string,
  mods: { meta?: boolean; shift?: boolean } = {},
): Promise<void> {
  await app.evalJS<boolean>(
    `(function(){
      var t = document.activeElement || document;
      return t.dispatchEvent(new KeyboardEvent("keydown", {
        code: ${JSON.stringify(code)},
        key: ${JSON.stringify(key)},
        metaKey: ${mods.meta === true},
        shiftKey: ${mods.shift === true},
        ctrlKey: false,
        altKey: false,
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    })()`,
  );
}

// ---------------------------------------------------------------------------
// The reveal reading
// ---------------------------------------------------------------------------

export interface Reveal {
  /** The list row index the active range sits in, or `-1` when unresolved. */
  row: number;
  text: string;
  rectTop: number;
  rectBottom: number;
  bandTop: number;
  bandBottom: number;
  scrollTop: number;
  inView: boolean;
}

/**
 * The active match's rect against the scroller's visible band, as one
 * expression — lifted from `at0494-find-reveal-in-view.test.ts`, which
 * keeps its own copy deliberately (this step does not edit that file).
 *
 * The band's top is the scroller's own top plus the ENTRY-scoped pin stack,
 * read from an element inside the active match's entry: the pin stack is
 * written per entry, and read from the host root it computes zero.
 */
export function revealExpr(cardId = "A"): string {
  const sel = `[data-card-id="${cardId}"] ${SCROLLER}`;
  return `(function () {
  var sc = document.querySelector(${JSON.stringify(sel)}) ||
           document.querySelector(${JSON.stringify(SCROLLER)});
  var hl = CSS.highlights.get('transcript-find-active');
  if (!sc || !hl) return null;
  var range = null;
  for (var r of hl) { range = r; break; }
  if (range === null) return null;
  var rect = range.getBoundingClientRect();
  var box = sc.getBoundingClientRect();
  var el = range.startContainer.parentElement;
  var pin = el ? (parseFloat(getComputedStyle(el).getPropertyValue("--tugx-pin-stack-top")) || 0) : 0;
  var cell = el ? el.closest("[data-tug-list-cell-index]") : null;
  return {
    row: cell ? Number(cell.getAttribute("data-tug-list-cell-index")) : -1,
    text: range.toString(),
    rectTop: rect.top,
    rectBottom: rect.bottom,
    bandTop: box.top + pin,
    bandBottom: box.bottom,
    scrollTop: sc.scrollTop,
    inView: rect.top >= box.top + pin && rect.bottom <= box.bottom
  };
})()`;
}

export async function readReveal(app: App, cardId = "A"): Promise<Reveal | null> {
  return app.evalJS<Reveal | null>(revealExpr(cardId));
}

/** The find chip's text (`"3 of 17"`), or the empty string when unpainted. */
export async function readChip(app: App, cardId = "A"): Promise<string> {
  return app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(
      sessionSelectors(cardId).chip,
    )})?.textContent || "").trim()`,
  );
}

// ---------------------------------------------------------------------------
// The sampler ([P10])
// ---------------------------------------------------------------------------

/** One recorded frame of the window a motion assertion is made over. */
export interface RevealSample {
  t: number;
  scrollTop: number;
  activeText: string;
  rectTop: number;
  rectBottom: number;
  bandTop: number;
  bandBottom: number;
  chip: string;
  inView: boolean;
}

/**
 * Fewer frames than this over a 600 ms window means the harness window was
 * occluded (a covered `WKWebView` suspends `requestAnimationFrame`), not
 * that the reveal misbehaved. Ten frames is ~170 ms of animation at 60 Hz,
 * comfortably under any window a caller asks for.
 */
export const MIN_SAMPLES = 10;

/**
 * Record every frame for `ms` and return them in order. The loop runs in
 * the page; this function starts it, waits out the window in Node, and
 * reads the array back.
 */
export async function sampleReveal(
  app: App,
  ms = 600,
  cardId = "A",
): Promise<RevealSample[]> {
  const sel = sessionSelectors(cardId);
  await app.evalJS<boolean>(`(function () {
  window.__findSamples = [];
  var deadline = performance.now() + ${ms};
  function tick() {
    var r = ${revealExpr(cardId)};
    var chipEl = document.querySelector(${JSON.stringify(sel.chip)});
    window.__findSamples.push({
      t: performance.now(),
      scrollTop: r ? r.scrollTop : -1,
      activeText: r ? r.text : "",
      rectTop: r ? r.rectTop : -1,
      rectBottom: r ? r.rectBottom : -1,
      bandTop: r ? r.bandTop : -1,
      bandBottom: r ? r.bandBottom : -1,
      chip: (chipEl ? chipEl.textContent : "") || "",
      inView: r ? r.inView : false
    });
    if (performance.now() < deadline) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return true;
})()`);
  await new Promise((r) => setTimeout(r, ms + 250));
  return app.evalJS<RevealSample[]>(`(window.__findSamples || [])`);
}

/**
 * The last `n` samples, with the occlusion case named. Throws rather than
 * returning a short array, because a caller asserting "all ten in band"
 * over three samples is asserting nothing.
 */
export function tail(samples: readonly RevealSample[], n = MIN_SAMPLES): RevealSample[] {
  if (samples.length < n) {
    throw new Error(
      `occlusion: the sampler recorded ${samples.length} frame(s), fewer than ${n}. ` +
        "A covered harness window suspends requestAnimationFrame; this is not a find failure.",
    );
  }
  return samples.slice(-n);
}

// ---------------------------------------------------------------------------
// The find trace
// ---------------------------------------------------------------------------

export interface FindTraceEventLike {
  kind: "gesture" | "reveal" | "divergence";
  seq: number;
  t: number;
  [key: string]: unknown;
}

/** The trace's current `seq`, to bracket a gesture with. */
export async function markTrace(app: App): Promise<number> {
  return app.evalJS<number>(`(window.__findTrace ? window.__findTrace.mark() : 0)`);
}

/** Everything the trace recorded after `mark`. */
export async function traceSince(
  app: App,
  mark: number,
): Promise<FindTraceEventLike[]> {
  return app.evalJS<FindTraceEventLike[]>(
    `(window.__findTrace ? window.__findTrace.dump({ since: ${mark} }) : [])`,
  );
}

/**
 * Wait for the reveal a gesture started to reach a terminal event, and
 * return it. This is what a walk waits on between ⌘G presses: the reveal's
 * own outcome, rather than a sleep long enough to usually be enough.
 *
 * Returns `null` on timeout rather than throwing — a reveal that never
 * reports is itself one of the defects the suite is here to catch, and the
 * caller is better placed to say so.
 */
export async function awaitRevealTerminal(
  app: App,
  mark: number,
  timeoutMs = 10_000,
): Promise<FindTraceEventLike | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await traceSince(app, mark);
    const reveal = events.filter((e) => e.kind === "reveal").pop();
    if (reveal !== undefined) return reveal;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** The trace's view of the last gesture recorded after `mark`. */
export async function lastGesture(
  app: App,
  mark: number,
): Promise<FindTraceEventLike | null> {
  const events = await traceSince(app, mark);
  return events.filter((e) => e.kind === "gesture").pop() ?? null;
}

// ---------------------------------------------------------------------------
// Standing a Session card up
// ---------------------------------------------------------------------------

/** Bring a Session card to the point where frames can be fed into it. */
export async function standUpSession(
  app: App,
  cardId: string,
  sessionId: string,
  shape?: Record<string, unknown>,
): Promise<void> {
  await app.enableDeckTrace(true);
  if (shape !== undefined) {
    await app.seedDeckState({ state: shape, focusCardId: cardId });
  }
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(cardId)})`,
    { timeoutMs: 15_000 },
  );
  await app.bindSession(cardId, { tugSessionId: sessionId });
  await app.awaitEngineReady(cardId, { timeoutMs: 20_000 });
}

/** Feed one decoded frame into a bound Session card. */
export function framer(
  app: App,
  cardId: string,
  sessionId: string,
): (decoded: Record<string, unknown>) => Promise<unknown> {
  return (decoded) =>
    app.driveSession(cardId, {
      op: "ingestFrame",
      feedId: 0x40,
      decoded: { tug_session_id: sessionId, ...decoded },
    });
}

/** Open the find bar on a Session card and wait for its field. */
export async function openFindBar(app: App, cardId = "A"): Promise<void> {
  const sel = sessionSelectors(cardId);
  await app.nativeClickAtElement(sel.editor);
  await chord(app, "KeyF", "f", { meta: true });
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(sel.findInput)}) !== null`,
    { timeoutMs: 8000 },
  );
}
