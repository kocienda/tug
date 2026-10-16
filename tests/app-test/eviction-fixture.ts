/**
 * eviction-fixture.ts — the shared stand-up and instruments the
 * at0330-eviction-* files read the session transcript's eviction through.
 *
 * The transcript renders through `evictOffscreen`: rows more than a viewport
 * from the scrollport are UNMOUNTED, their exact measured heights standing in
 * the list's spacers. Each file launches into its own deck and transcript;
 * what they share is how that transcript is seeded and read.
 *
 * The transcript is seeded with COMPLETE TURNS, not with many messages in one
 * turn: consecutive assistant messages inside a turn coalesce into a single
 * assistant-run row, so row count comes from turns. Each turn goes to the
 * card as one `driveSessionBatch` run — never several turns to a run, which
 * stopped the app answering.
 *
 * @module tests/app-test/eviction-fixture
 */

import { launchTugApp, type App } from "./_harness";
import type { SessionDriveAction } from "./_harness/client";
import { sessionCardShape } from "./_harness/shapes";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 300_000;
export const FEED_CODE_OUTPUT = 0x40;

export const SID = "at0330-A";
export const TURNS = 60;
export const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';

export function replyText(n: number): string {
  return [
    `## step ${n}`,
    "",
    `Reply number ${n}. The band is measured from the canvas, not observed,`,
    "so the offset re-resolves on reflow and the row keeps its height.",
    "",
    `- marker ${n}`,
  ].join("\n");
}

/** Seed `turns` committed prompt→reply turns, numbered from `start`; every
 *  third one holds a tool block, so an expand gesture has something to open.
 *  `afterSend` runs between each turn's composer send and its feed frames,
 *  which then go as a run of their own. */
export async function seedTurns(
  app: App,
  turns: number,
  start = 0,
  afterSend?: () => Promise<void>,
): Promise<void> {
  const frame = (decoded: Record<string, unknown>): SessionDriveAction => ({
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, ...decoded },
  });
  for (let n = start; n < start + turns; n += 1) {
    const msgId = `${SID}-m${n}`;
    const actions: SessionDriveAction[] = [{ op: "send", text: `prompt ${n}` }];
    if (afterSend !== undefined) {
      await app.driveSessionBatch("A", actions.splice(0));
      await afterSend();
    }
    actions.push(
      frame({ type: "prompt_anchor", promptUuid: `${SID}-u${n}` }),
      frame({
        type: "content_block_start",
        msg_id: msgId,
        block_index: 0,
        kind: "text",
      }),
      frame({
        type: "assistant_text",
        seq: 0,
        rev: 0,
        status: "complete",
        msg_id: msgId,
        block_index: 0,
        text: replyText(n),
        is_partial: false,
      }),
    );
    if (n % 3 === 0) {
      const tuId = `${SID}-tu${n}`;
      actions.push(
        frame({
          type: "tool_use",
          seq: 0,
          msg_id: msgId,
          tool_use_id: tuId,
          tool_name: "Bash",
          input: { command: `echo step ${n}`, description: `step ${n}` },
        }),
        frame({
          type: "tool_result",
          tool_use_id: tuId,
          output: `step ${n} done`,
          is_error: false,
        }),
      );
    }
    actions.push(frame({ type: "turn_complete", seq: 0, msg_id: msgId, result: "success" }));
    await app.driveSessionBatch("A", actions);
  }
}

/** Launch, seed, and wait until eviction has armed. */
export async function standUp(testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 760 }), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 20_000 });
  await seedTurns(app, TURNS);
  await app.waitForCondition<boolean>(
    `!!document.querySelector('${SCROLLER}[data-evict-active]')`,
    { timeoutMs: 30_000 },
  );
  return app;
}

/**
 * Wait for a condition the next assertion reads, and answer whether it came.
 * A timeout is not the failure: the assertion after it reads the state and
 * says what it found, which a bare `TimeoutError` would not.
 */
export async function settleOn(
  app: App,
  script: string,
  opts: { timeoutMs: number; pollMs?: number },
): Promise<boolean> {
  try {
    await app.waitForCondition<boolean>(script, opts);
    return true;
  } catch {
    return false;
  }
}

/** Scroll to a fraction of the range and let the window settle. */
export async function scrollTo(app: App, frac: number): Promise<void> {
  await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ${frac});
  return el.scrollTop;
})()`);
  await new Promise((r) => setTimeout(r, 500));
}

/** The transcript's row count: 1 + the largest row index mounted while it
 *  rests at the bottom. The list publishes no item count. */
export async function readRowCount(app: App): Promise<number> {
  await scrollTo(app, 1);
  return app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var max = -1;
  el.querySelectorAll("[data-tug-list-cell-index]").forEach(function (c) {
    var i = Number(c.getAttribute("data-tug-list-cell-index"));
    if (i > max) max = i;
  });
  return max + 1;
})()`);
}

/** Start an in-page rAF sampler of the scroller's mounted row count. It
 *  also records whether `data-evict-stale` was ever seen, so a drain that
 *  starts and ends between two polls is still witnessed. */
export async function startMountSampler(app: App): Promise<void> {
  await app.evalJS<boolean>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var s = { peak: 0, sawStale: false, done: false };
  window.__at0330Sampler = s;
  var tick = function () {
    if (s.done) return;
    var n = el.querySelectorAll("[data-tug-list-cell-index]").length;
    if (n > s.peak) s.peak = n;
    if (el.hasAttribute("data-evict-stale")) s.sawStale = true;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`);
}

/** Stop the sampler and read what it saw. */
export async function stopMountSampler(app: App): Promise<{ peak: number; sawStale: boolean }> {
  return app.evalJS(`(function () {
  var s = window.__at0330Sampler;
  s.done = true;
  return { peak: s.peak, sawStale: s.sawStale };
})()`);
}

/**
 * Remember the element under the scrollport's top edge — the block the
 * reader's line is in (`p`, `li`, `h2`, `pre`) — as `window.__at0330Line`,
 * and return its top's distance below the edge, in layout px (the viewport
 * delta over the deck root's zoom factor). An edge that falls in the gap
 * between two blocks takes the first block below it, as the list's own
 * element anchor does. Null with no block in reach.
 *
 * Found by rect, not by hit-test: the transcript's sticky entry pin stands
 * over the scrollport's top edge, so `elementFromPoint` there answers the pin.
 */
export async function rememberTopLine(app: App): Promise<{ delta: number; text: string } | null> {
  return app.evalJS(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var deck = document.getElementById("deck-container");
  var f = deck.getBoundingClientRect().width / deck.offsetWidth;
  var port = el.getBoundingClientRect();
  var line = port.top + 1;
  var node = null;
  var below = null;
  el.querySelectorAll("[data-tug-list-cell-index] p, [data-tug-list-cell-index] li, [data-tug-list-cell-index] h2, [data-tug-list-cell-index] pre").forEach(function (b) {
    var r = b.getBoundingClientRect();
    if (r.top > line) {
      if (r.top < port.top + port.height / 2 && (below === null || r.top < below.getBoundingClientRect().top)) below = b;
      return;
    }
    if (r.bottom <= line) return;
    if (node === null || r.height < node.getBoundingClientRect().height) node = b;
  });
  if (node === null) node = below;
  if (node === null) return null;
  window.__at0330Line = node;
  return { delta: (node.getBoundingClientRect().top - port.top) / f, text: (node.textContent || "").slice(0, 40) };
})()`);
}

/** The remembered element's delta now, in layout px; null once it has left the document. */
export async function readTopLine(app: App): Promise<number | null> {
  return app.evalJS(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var node = window.__at0330Line;
  if (!node || !el.contains(node)) return null;
  var deck = document.getElementById("deck-container");
  var f = deck.getBoundingClientRect().width / deck.offsetWidth;
  return (node.getBoundingClientRect().top - el.getBoundingClientRect().top) / f;
})()`);
}

/** Switch eviction off, wait for the whole transcript to mount, and read
 *  the fully-mounted document's height: the exactness reference. */
export async function readFullHeight(app: App, scroller = SCROLLER): Promise<number> {
  await app.evalJS<boolean>(
    `(window.__tug.setTranscriptEvictionDisabled(true), true)`,
  );
  await app.waitForCondition<boolean>(
    `!document.querySelector('${scroller}').hasAttribute("data-evict-active")`,
    { timeoutMs: 20_000, pollMs: 250 },
  );
  return app.evalJS<number>(`document.querySelector('${scroller}').scrollHeight`);
}
