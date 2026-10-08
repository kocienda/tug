/**
 * at0645-overview-visible-dots-pulse.test.ts — every session dot the Overview
 * shows pulses while its session works; only the ones out of view are still.
 *
 * Every Overview post rests on the session that wrote it, and the strip under
 * the post cites that session with the same chip every foreign surface shows —
 * a pill with the session's phase dot in it. While the session works, every
 * one of those dots on screen pulses. A dot scrolled out of view is stilled by
 * the off-screen rule (`lib/motion-guard/offscreen.ts`), which costs nothing to
 * show, and the moment it is scrolled back into view it pulses again.
 *
 * This replaces a "one live mark per session" rule that let only one citation
 * of a session pulse and stilled every other one on screen. It was never a
 * decision the user made: with a working session it put the pulse on the
 * oldest post in view while the newest sat still beneath it, which read as a
 * dot stuck on a stale post.
 *
 * ## What is asserted
 *
 * A session card is driven into a turn so its session reads `running`, and the
 * Overview is filled with a page of posts from that session. Then, with the
 * column pinned to its newest post: the chips that breathe are exactly the
 * chips inside the scroller's box — more than one, each with its own three
 * loops welded to one start time — and none of the chips under the fold
 * breathes. Scrolled to the top, the same holds of the new view: the top posts,
 * which were out of view, now breathe, and the newest posts, now out of view,
 * do not.
 *
 * `list()` inside the card says the same thing from the census's side: one
 * breath per visible dot.
 *
 * ## Occlusion
 *
 * Off-screen marks are stilled by an intersection observer, and an occluded
 * window reports nothing intersecting; the window is launched
 * `foreground: true` so the observer has a viewport to measure against.
 *
 * @covers tugdeck/src/lib/motion-guard/offscreen.ts
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 * @covers tugdeck/src/components/tugways/session-phase-dot.tsx
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/styles/tug.css
 *
 * @foreground — the off-screen rule needs a viewport to measure against, so
 * the launch takes the screen (`foreground: true` below).
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SESSION_ID = "aa11bb22-0000-4000-8000-0000000a0645";
const TAG = "brisk-lantern";
const PROJECT_DIR = "/Users/tester/src/tugtool";

const COMPOSER = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const MASTHEAD_DOT =
  '[data-slot="session-masthead"] [data-slot="tug-progress-indicator"]';
const CARD = '[data-testid="overview-card"]';
const SCROLLER = `${CARD} .overview-transcript`;
const CHIPS = `${CARD} .overview-post-refs [data-slot="tug-session-identity"]`;

/**
 * How many posts the column is filled with — well over a screen of them, and
 * under the Overview's row ceiling (`OVERVIEW_MAX_ROWS`, 150, in
 * `lib/overview-store.ts`). The store trims the column to that ceiling, so a
 * fill past it never mounts one chip per post and the count below waits for
 * a column that cannot exist.
 */
const POST_COUNT = 120;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 760, height: 460 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * The ledger's answer for the narrated session, through the production
 * `resolve_sessions_ok` handler, so the citation resolves to a found session
 * and draws its dot rather than an inert one.
 */
function resolveSessions(): string {
  return `window.__tug.dispatchControlAction("resolve_sessions_ok", ${JSON.stringify({
    sessions: [
      {
        queried: SESSION_ID,
        session: {
          session_id: SESSION_ID,
          workspace_key: "ws-1",
          project_dir: PROJECT_DIR,
          created_at: 1_754_600_000_000,
          last_used_at: 1_754_600_100_000,
          turn_count: 4,
          last_user_prompt: null,
          state: "open",
          card_id: "A",
          name: null,
          tag: TAG,
        },
      },
    ],
    unknown: [],
  })})`;
}

interface Marks {
  chips: number;
  /** Indices of the chips whose box meets the scroller's box. */
  visible: number[];
  /** Indices of the chips with a running loop. */
  breathing: number[];
  /** How many chips carry the off-screen mark. */
  offscreen: number;
  spreads: number[];
}

/** Every citation in the column: which are in the scroller's box, which breathe. */
const MARKS_JS = `(function(){
  var chips = document.querySelectorAll(${JSON.stringify(CHIPS)});
  var box = document.querySelector(${JSON.stringify(SCROLLER)}).getBoundingClientRect();
  var visible = [], breathing = [], offscreen = 0, spreads = [];
  for (var i = 0; i < chips.length; i++) {
    var chip = chips[i];
    var r = chip.getBoundingClientRect();
    if (r.bottom > box.top && r.top < box.bottom) visible.push(i);
    if (chip.querySelector("[data-tug-offscreen]") !== null) offscreen++;
    var loops = chip.getAnimations({ subtree: true })
      .filter(function (a) { return a instanceof CSSAnimation && a.playState === "running"; });
    if (loops.length > 0) {
      breathing.push(i);
      var st = loops.map(function (a) { return a.startTime; })
        .filter(function (t) { return t !== null; });
      if (st.length > 1) {
        spreads.push(Math.max.apply(null, st) - Math.min.apply(null, st));
      }
    }
  }
  return {
    chips: chips.length,
    visible: visible,
    breathing: breathing,
    offscreen: offscreen,
    spreads: Array.from(new Set(spreads)),
  };
})()`;

describe.skipIf(!SHOULD_RUN)("at0645 — every visible session dot pulses", () => {
  test(
    "a column of posts from one working session breathes at every visible citation, and the breath follows the view",
    async () => {
      const app = await launchTugApp({
        testName: "at0645-overview-visible-dots-pulse",
        foreground: true,
      });
      try {
        // ---- A working session: the card, bound and mid-turn. -----------
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.bindSession("A", {
          tugSessionId: SESSION_ID,
          projectDir: PROJECT_DIR,
        });
        await app.evalJS<boolean>(
          `window.__tug.publishSessionUpdated(${JSON.stringify(
            JSON.stringify({
              session_id: SESSION_ID,
              fields: { tag: TAG, name: null, name_user_set: false },
            }),
          )})`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.driveSession("A", { op: "send", text: "at0645 keep working" });
        await app.waitForCondition<boolean>(
          `(function(){
             var el = document.querySelector(${JSON.stringify(MASTHEAD_DOT)});
             return el !== null && el.getAttribute('data-state') === 'running';
           })()`,
          { timeoutMs: 20_000 },
        );

        // ---- The Overview, filled with that session's posts. ------------
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) !== null`,
          { timeoutMs: 10_000 },
        );
        await app.evalJS<unknown>(resolveSessions());
        const published = await app.evalJS<number>(`(function(){
          var n = 0;
          for (var i = 0; i < ${POST_COUNT}; i++) {
            var ok = window.__tug.publishOverviewPost(JSON.stringify({
              id: 9645000 + i,
              at_ms: 1754600000000 + i * 1000,
              author: "observer",
              session_id: ${JSON.stringify(SESSION_ID)},
              body: "Post " + i + " of a long working session.",
              refs: [],
              project_dir: ${JSON.stringify(PROJECT_DIR)},
            }));
            if (ok) n++;
          }
          return n;
        })()`);
        expect(published).toBe(POST_COUNT);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(CHIPS)}).length === ${POST_COUNT}`,
          { timeoutMs: 30_000 },
        );
        // The off-screen marks land on the observer's first delivery; wait
        // for the breathing set to be exactly the set in view.
        const breathesInView = `(function(){
          var m = ${MARKS_JS};
          return m.visible.length > 1
            && JSON.stringify(m.breathing) === JSON.stringify(m.visible);
        })()`;
        await app.waitForCondition<boolean>(breathesInView, { timeoutMs: 15_000 });
        const pinned = await app.evalJS<Marks>(MARKS_JS);
        note("at0645 pinned to the newest post", pinned);
        expect(pinned.chips).toBe(POST_COUNT);
        // Every citation on screen breathes — not one of them, all of them —
        // and the newest post's is among them.
        expect(pinned.visible.length).toBeGreaterThan(1);
        expect(pinned.breathing).toEqual(pinned.visible);
        expect(pinned.breathing).toContain(POST_COUNT - 1);
        // Most of the column is under the fold, marked so, and still.
        expect(pinned.offscreen).toBeGreaterThan(POST_COUNT / 2);
        expect(pinned.breathing).not.toContain(0);
        // Each breathing dot is one figure: its three loops on one clock.
        expect(pinned.spreads).toEqual([0]);

        const census = await app.evalJS<{
          longRunning: number;
          byName: Record<string, number>;
        }>(
          `(function(){
             var c = window.__tugMotion.list({ within: ${JSON.stringify(CARD)} });
             var byName = {};
             c.entries.forEach(function (e) {
               if (e.iterations === null) byName[e.name] = (byName[e.name] || 0) + 1;
             });
             return { longRunning: c.longRunning, byName: byName };
           })()`,
        );
        note("at0645 census inside the Overview", census);
        // Read by name rather than as a total: the card has loops of its own
        // that are not the session's mark, and this claim is about the dot.
        // One breath, one ring expanding, one ring fading per visible dot.
        const shown = pinned.visible.length;
        expect(census.byName["tugx-progress-pulsing-dot-breathe"]).toBe(shown);
        expect(census.byName["tugx-progress-pulsing-dot-emit-expand"]).toBe(shown);
        expect(census.byName["tugx-progress-pulsing-dot-emit-fade"]).toBe(shown);

        // ---- Scrolled to the top: the dots coming into view pulse. -------
        await app.evalJS<null>(`(function(){
          document.querySelector(${JSON.stringify(SCROLLER)}).scrollTop = 0;
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `(function(){
             var m = ${MARKS_JS};
             return m.visible[0] === 0 && ${breathesInView};
           })()`,
          { timeoutMs: 15_000 },
        );
        const scrolled = await app.evalJS<Marks>(MARKS_JS);
        note("at0645 scrolled to the top", scrolled);
        // The posts that were out of view now breathe, every one on screen…
        expect(scrolled.breathing).toEqual(scrolled.visible);
        expect(scrolled.breathing).toContain(0);
        // …and the newest, scrolled away, are still.
        expect(scrolled.breathing).not.toContain(POST_COUNT - 1);
        expect(scrolled.spreads).toEqual([0]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
