/**
 * at0645-overview-one-live-mark.test.ts — the Overview draws one live session
 * as one live mark, not as one per post.
 *
 * Every Overview post rests on the session that wrote it, and the strip under
 * the post cites that session with the same chip every foreign surface shows —
 * a pill with the session's phase dot in it. A working session posts often,
 * so a column of a few hundred posts from one session used to be a few hundred
 * breathing dots for one thing, most of them under the fold. That is wrong
 * before it is expensive: a mark is the session's presence, and presence is
 * one thing.
 *
 * The rule (`lib/motion-guard/one-live-mark.ts`) is that the session is drawn
 * live once per view. Every citation of a session in the column registers
 * under the session's id, the first one in view breathes, and every other one
 * is an **understudy** — it shows the same pose still, because the stylesheet
 * turns its loop off under `data-tug-understudy`, the knob the off-screen rule
 * and the circuit breaker already turn. The reader sees the session's state on
 * every reference and its breath on one.
 *
 * ## What is asserted
 *
 * A session card is driven into a turn so its session reads `running`, and the
 * Overview is filled with a page of posts from that session. Then, with the
 * column pinned to its newest post: every citation is a member of one group,
 * all but one are understudies, and exactly one chip in the whole column has
 * a running loop — three loops, welded to one start time, because it is the
 * dot's own figure. Scrolled to the top, the breath moves: still exactly one
 * chip breathes, and it is the first citation in the column. The count of live
 * figures per live session is bounded by what is on screen, and it is one.
 *
 * `list()` inside the card says the same thing from the census's side: one
 * dot's three loops for a column of hundreds of references.
 *
 * ## Occlusion
 *
 * Off-screen marks are stilled by an intersection observer, and an occluded
 * window reports nothing intersecting; the window is launched
 * `foreground: true` so the election has a viewport to elect against.
 *
 * @covers tugdeck/src/lib/motion-guard/one-live-mark.ts
 * @covers tugdeck/src/lib/motion-guard/offscreen.ts
 * @covers tugdeck/src/lib/motion-guard/diagnostics.ts
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 * @covers tugdeck/src/components/tugways/session-phase-dot.tsx
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/styles/tug.css
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

/** How many posts the column is filled with — well over a screen of them. */
const POST_COUNT = 240;

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
  understudies: number;
  offscreen: number;
  breathing: number[];
  spreads: number[];
  groups: { groups: number; members: number; understudies: number };
}

/** Every citation in the column: which are understudies, which breathe. */
const MARKS_JS = `(function(){
  var chips = document.querySelectorAll(${JSON.stringify(CHIPS)});
  var understudies = 0, offscreen = 0, breathing = [], spreads = [];
  for (var i = 0; i < chips.length; i++) {
    var chip = chips[i];
    if (chip.hasAttribute("data-tug-understudy")) understudies++;
    if (chip.hasAttribute("data-tug-offscreen")) offscreen++;
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
    understudies: understudies,
    offscreen: offscreen,
    breathing: breathing,
    spreads: Array.from(new Set(spreads)),
    groups: window.__tugMotion.liveMarks(),
  };
})()`;

describe.skipIf(!SHOULD_RUN)("at0645 — one live mark per live session", () => {
  test(
    "a column of posts from one working session breathes in exactly one place, and the breath follows the view",
    async () => {
      const app = await launchTugApp({
        testName: "at0645-overview-one-live-mark",
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
        // The election settles after the observer's first delivery; wait for
        // the understudies to be marked and for one chip to be breathing.
        await app.waitForCondition<boolean>(
          `(function(){
             var m = ${MARKS_JS};
             return m.understudies === ${POST_COUNT - 1} && m.breathing.length === 1;
           })()`,
          { timeoutMs: 15_000 },
        );
        const pinned = await app.evalJS<Marks>(MARKS_JS);
        note("at0645 pinned to the newest post", pinned);
        expect(pinned.chips).toBe(POST_COUNT);
        expect(pinned.groups.groups).toBe(1);
        expect(pinned.groups.members).toBe(POST_COUNT);
        expect(pinned.understudies).toBe(POST_COUNT - 1);
        // Most of the column is under the fold and marked so.
        expect(pinned.offscreen).toBeGreaterThan(POST_COUNT / 2);
        // One breath, on one figure, welded.
        expect(pinned.breathing.length).toBe(1);
        expect(pinned.spreads).toEqual([0]);
        // And the one that breathes is in view: not the first post, which is
        // far above the fold with the column pinned to its newest.
        expect(pinned.breathing[0]).toBeGreaterThan(0);

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
        // One breath, one ring expanding, one ring fading — one figure.
        expect(census.byName["tugx-progress-pulsing-dot-breathe"]).toBe(1);
        expect(census.byName["tugx-progress-pulsing-dot-emit-expand"]).toBe(1);
        expect(census.byName["tugx-progress-pulsing-dot-emit-fade"]).toBe(1);

        // ---- Scrolled to the top: the breath moves to the first in view. --
        await app.evalJS<null>(`(function(){
          document.querySelector(${JSON.stringify(SCROLLER)}).scrollTop = 0;
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `(function(){
             var m = ${MARKS_JS};
             return m.breathing.length === 1 && m.breathing[0] === 0;
           })()`,
          { timeoutMs: 15_000 },
        );
        const scrolled = await app.evalJS<Marks>(MARKS_JS);
        note("at0645 scrolled to the top", scrolled);
        expect(scrolled.understudies).toBe(POST_COUNT - 1);
        expect(scrolled.breathing).toEqual([0]);
        expect(scrolled.spreads).toEqual([0]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
