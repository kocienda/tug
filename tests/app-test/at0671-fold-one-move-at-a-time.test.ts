/**
 * at0671-fold-one-move-at-a-time.test.ts — a fold is prepare, then move, and
 * nothing is written inside the card while the edge is travelling.
 *
 * ## What this gates
 *
 * at0563 gates WHERE the card's boxes are during a fold: nothing inside moves
 * but Z2, which rides the edge. It cannot see WORK. A fold's commit changes the
 * card's interior — on an unfold the transcript slot comes back from
 * `display: none` — and what answers that change arrives a frame later:
 * observers' rAF-coalesced writes, the after-paint React notify. Left to land
 * under the tween, those held the main thread for 30–47ms right after the
 * first moving frame on a real deck, exactly where the spring covers most of
 * its travel, so the edge crossed half the card in a hole and the fold read as
 * a jump rather than a sweep.
 *
 * The remedy is sequencing: a settle that opens a fold crossing stands at
 * First for `FOLD_PREPARE_MS` before its first beat moves, so the answers land
 * in a frame where nothing is in motion. Two claims, both directions:
 *
 *   1. **There is a prepare frame.** After the frame that carries the commit,
 *      at least one more marked frame stands at the First height before the
 *      edge moves.
 *   2. **The move is only the move.** From the first moved frame to the last
 *      marked one, no attribute or child-list mutation lands inside the pane.
 *      A tween is not a mutation, so a clean fold records none. The one
 *      exemption is `data-tug-offscreen`, which the motion registry writes as
 *      the travelling edge clips a resident animation's figure — a write the
 *      move itself causes, and the reason it exists is to stop work.
 *
 * @covers tugdeck/src/fold.ts
 * @covers tugdeck/src/lib/fold-crossing.ts
 * @covers tugdeck/src/components/tugways/blocks/block-chrome.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0671-session";
const PANE_ID = "p1";
const CARD = '[data-card-id="A"]';
const FRAME = `.tug-pane[data-pane-id="${PANE_ID}"]`;
const TRANSCRIPT = `${CARD} .session-view-slot .session-view-pane[data-view="transcript"]`;

/** How long the sampler runs — a beat and a half at the default tune. */
const CENSUS_MS = 700;
/** The settle window, with room for the tween to land. */
const AFTER_LAND_MS = 900;
/** Mutations the move itself causes; see the header. */
const EXEMPT = new Set(["data-tug-offscreen"]);

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** One Session card, alone in a one-up. */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session A", closable: true },
    ],
    panes: [
      {
        id: PANE_ID,
        position: { x: 40, y: 40 },
        size: { width: 800, height: 700 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
        slot: 0,
      },
    ],
    activePaneId: PANE_ID,
    imposition: { kind: "one-up" },
    hasFocus: true,
  };
}

interface Sample {
  t: number;
  mark: string;
  frameHeight: number;
}

interface Mutation {
  t: number;
  what: string;
}

interface Census {
  samples: Sample[];
  mutations: Mutation[];
}

/** Arm a per-frame sampler and a mutation log on the pane, flip the flag, and hand back both. */
async function census(app: App, folded: boolean): Promise<Census> {
  await app.evalJS<null>(
    `(function () {
      var frame = document.querySelector(${JSON.stringify(FRAME)});
      var rec = (window.__at0671 = { samples: [], mutations: [] });
      var t0 = performance.now();
      var mo = new MutationObserver(function (list) {
        var t = performance.now() - t0;
        for (var i = 0; i < list.length; i += 1) {
          var m = list[i];
          // The frame's own attributes are the imposer's marks and holds; the
          // claim is about what is written INSIDE it.
          if (m.target === frame) continue;
          rec.mutations.push({
            t: t,
            what: m.type === "attributes" ? m.attributeName : m.type,
          });
        }
      });
      mo.observe(frame, { subtree: true, childList: true, attributes: true });
      var tick = function () {
        rec.samples.push({
          t: performance.now() - t0,
          mark: frame.getAttribute("data-fold-crossing") || "",
          frameHeight: frame.getBoundingClientRect().height,
        });
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
        else mo.disconnect();
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("set-card-folded", { cardId: "A", folded: ${folded} }), null)`,
  );
  await wait(CENSUS_MS + 300);
  return app.evalJS<Census>(`window.__at0671`);
}

function assertOneMove(label: string, { samples, mutations }: Census): void {
  const marked = samples.filter((s) => s.mark !== "");
  expect(
    marked.length,
    `${label}: the crossing must be sampled mid-motion`,
  ).toBeGreaterThan(5);
  const first = marked[0].frameHeight;
  const movedAt = marked.findIndex(
    (s) => Math.abs(s.frameHeight - first) >= 0.5,
  );
  expect(movedAt, `${label}: the edge moves`).toBeGreaterThan(0);
  const moveStart = marked[movedAt].t;
  // The mark comes off in the landing's own commit, so the last marked sample
  // is the last frame of the motion.
  const moveEnd = marked[marked.length - 1].t;
  const under = mutations.filter(
    (m) => m.t >= moveStart && m.t <= moveEnd && !EXEMPT.has(m.what),
  );
  note(
    label,
    `marked=${marked.length} still before the move=${movedAt} move=${Math.round(moveStart)}..${Math.round(moveEnd)}ms mutations under the move=${under.length}${under.length > 0 ? ` (${[...new Set(under.map((m) => m.what))].join(", ")})` : ""}`,
  );

  // 1. A prepare frame: the commit's own frame, and at least one more.
  expect(
    movedAt,
    `${label}: a frame stands at First between the commit and the move`,
  ).toBeGreaterThanOrEqual(2);

  // 2. Nothing is written inside the pane while the edge travels.
  expect(
    under.map((m) => `${Math.round(m.t)}ms ${m.what}`),
    `${label}: no mutation lands inside the pane under the move`,
  ).toEqual([]);
}

describe.skipIf(!SHOULD_RUN)("AT0671: a fold is one move at a time", () => {
  test(
    "the edge waits a frame after the commit, and nothing is written under it, in both directions",
    async () => {
      const app = await launchTugApp({ testName: "at0671-fold-one-move" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
          { timeoutMs: 15_000 },
        );

        assertOneMove("fold", await census(app, true));
        await wait(AFTER_LAND_MS);
        assertOneMove("show", await census(app, false));
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
