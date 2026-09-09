/**
 * at0499-arcs-scroll.test.ts — the Arcs card hands its overflow to its own
 * scroller rather than growing past its rail.
 *
 * A rail card takes its pane's height and its list carries the overflow. The
 * Arcs surface did not take part: its inner shell carried an automatic block
 * min-content, and a scroll container does NOT shrink an ancestor's
 * min-content — so the column stood at the full intrinsic height of its rows
 * however many there were, and a checkout with more arcs than the rail can
 * show simply ran the last ones off the bottom with no way to reach them.
 *
 * The scroller is the CARD ROOT, not the list. A sidebar card's height is
 * measured from a content element holding everything the card draws, and an
 * element whose own list scrolled would stand at the height of the pane it
 * was measured for ([B01], [B02]) — so the list stands at the sum of its rows
 * and the card root carries what does not fit.
 *
 * The fixture makes that real rather than arguing it: forty arcs, each a
 * document-only arc (a directory under `.tug/arcs/` holding a brief), which
 * is the cheapest real arc there is — no branch, no worktree, and the card
 * renders every one as a row. Forty two-line rows are taller than any rail
 * this harness opens, so the card genuinely overflows.
 *
 * Three marks, and the first two are what failed before:
 *
 *   - the card is a live scroller — its scroll height exceeds its client
 *     height, so there is something to scroll and a way to scroll it, and the
 *     list inside it scrolls nothing of its own;
 *   - the card does not spill — the list's bottom edge lands inside the card's
 *     scrollable content, not past what the card can reach;
 *   - the bottom row is reachable — scrolled to the end, the last row sits
 *     inside the card's own viewport.
 *
 * @covers tugdeck/src/components/arcs/arcs-card.css
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000499";

/** Enough two-line rows that the band cannot fit them at any rail height this
 *  harness opens. Below this the test would pass without proving anything, so
 *  the overflow itself is asserted before the marks that depend on it. */
const ARC_COUNT = 40;
const ARC_NAMES = Array.from(
  { length: ARC_COUNT },
  (_, i) => `at0499-plan-${String(i + 1).padStart(2, "0")}`,
);
const LAST_ARC = ARC_NAMES[ARC_NAMES.length - 1] ?? "";

const CARD = '.arcs-section';
const LIST = `${CARD} .tug-list-view.arcs-list`;
const ROWS = `${CARD} [data-slot="arc-document-row"]`;
const LAST_ROW = `${CARD} [data-slot="arc-document-row"][data-arc="${LAST_ARC}"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/**
 * A document-only arc: a directory under `.tug/arcs/` holding a brief and
 * nothing else. `tugarc_core::document_arcs` lists exactly this shape, so
 * the row the section renders is a real arc the aggregate reported — there is
 * no fixture path into that list other than the files themselves.
 */
function seedDocumentArc(repo: string, name: string): void {
  const dir = join(repo, ".tug", "arcs", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "brief.md"),
    `# ${name}\n\nA brief the Arcs band has to find room for.\n`,
  );
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0499", checkout: CHECKOUT });
  for (const name of ARC_NAMES) seedDocumentArc(projectDir(), name);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
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

describe.skipIf(!SHOULD_RUN)("AT0499: the Arcs card scrolls its own rows", () => {
  test(
    "an overflowing card keeps its bottom row reachable",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0499-arcs-scroll",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A spawned session, not a bound one: spawning is what registers the
        // scratch repo as a workspace, so its arcs reach the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(ROWS)}).length === ${ARC_COUNT}`,
          { timeoutMs: 30000 },
        );

        const geometry = await app.evalJS<{
          overflowY: string;
          listScrollHeight: number;
          listClientHeight: number;
          cardScrollHeight: number;
          cardClientHeight: number;
          listBottom: number;
          cardBottom: number;
        }>(
          `(() => {
             const list = document.querySelector(${JSON.stringify(LIST)});
             const card = document.querySelector(${JSON.stringify(CARD)});
             return {
               overflowY: getComputedStyle(card).overflowY,
               listScrollHeight: list.scrollHeight,
               listClientHeight: list.clientHeight,
               cardScrollHeight: card.scrollHeight,
               cardClientHeight: card.clientHeight,
               listBottom: list.getBoundingClientRect().bottom,
               cardBottom: card.getBoundingClientRect().bottom,
             };
           })()`,
        );
        note("at0499 card geometry", JSON.stringify(geometry));

        // The precondition, asserted rather than assumed: forty rows really
        // are more than the card can show. If this ever fails the rail grew,
        // and the fixture owes it more arcs — everything below is vacuous
        // without it.
        expect(geometry.cardScrollHeight).toBeGreaterThan(geometry.cardClientHeight);
        // The card root is the scroller, and the list is not: the overflow
        // belongs to one place, and that place has to hold everything the card
        // draws so the column inside it can be measured ([B01]). `scroll`
        // rather than `auto`, because a sidebar scroller reserves the bar's
        // lane at all times ([D182]).
        expect(geometry.overflowY).toBe("scroll");
        // The list stands at the sum of its rows — nothing of its own to
        // scroll, which is what keeps the card's content column independent of
        // the run the card was given ([B02]).
        expect(geometry.listScrollHeight).toBeLessThanOrEqual(
          geometry.listClientHeight + 1,
        );

        note("at0499 the Arcs card overflowing", (await app.screenshot()).path);

        // Scrolled to the end, the last arc sits inside the list's viewport —
        // the whole point of the scroller, and the thing a person could not do
        // before it existed.
        const reachable = await app.evalJS<{
          rowTop: number;
          rowBottom: number;
          viewTop: number;
          viewBottom: number;
        }>(
          `(() => {
             const card = document.querySelector(${JSON.stringify(CARD)});
             card.scrollTop = card.scrollHeight;
             const row = document.querySelector(${JSON.stringify(LAST_ROW)});
             const view = card.getBoundingClientRect();
             const rect = row.getBoundingClientRect();
             return {
               rowTop: rect.top,
               rowBottom: rect.bottom,
               viewTop: view.top,
               viewBottom: view.bottom,
             };
           })()`,
        );
        note("at0499 last row after scrolling to the end", JSON.stringify(reachable));
        expect(reachable.rowTop).toBeGreaterThanOrEqual(reachable.viewTop - 1);
        expect(reachable.rowBottom).toBeLessThanOrEqual(reachable.viewBottom + 1);

        note("at0499 arcs card, bottom of the arcs band", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
