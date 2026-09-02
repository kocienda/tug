/**
 * at0499-dashes-scroll.test.ts — the Arcs card hands its overflow to its own
 * list's scroller rather than growing past its rail.
 *
 * A rail card takes its pane's height and its list carries the overflow. The
 * Dashes surface did not take part: its inner shell carried an automatic block
 * min-content, and a scroll container does NOT shrink an ancestor's
 * min-content — so the column stood at the full intrinsic height of its rows
 * however many there were, and a checkout with more dashes than the rail can
 * show simply ran the last ones off the bottom with no way to reach them.
 *
 * The fixture makes that real rather than arguing it: forty dashes, each a
 * document-only dash (a directory under `.tug/arcs/` holding a brief), which
 * is the cheapest real dash there is — no branch, no worktree, and the card
 * renders every one as a row. Forty two-line rows are taller than any rail
 * this harness opens, so the card genuinely overflows.
 *
 * Three marks, and the first two are what failed before:
 *
 *   - the list is a live scroller — its scroll height exceeds its client
 *     height, so there is something to scroll and a way to scroll it;
 *   - the card does not spill — the list's bottom edge lands inside the card,
 *     not past it;
 *   - the bottom row is reachable — scrolled to the end, the last row sits
 *     inside the list's own viewport.
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
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000499";

/** Enough two-line rows that the band cannot fit them at any rail height this
 *  harness opens. Below this the test would pass without proving anything, so
 *  the overflow itself is asserted before the marks that depend on it. */
const DASH_COUNT = 40;
const DASH_NAMES = Array.from(
  { length: DASH_COUNT },
  (_, i) => `at0499-plan-${String(i + 1).padStart(2, "0")}`,
);
const LAST_DASH = DASH_NAMES[DASH_NAMES.length - 1] ?? "";

const CARD = '.dashes-section';
const LIST = `${CARD} .tug-list-view.dashes-list`;
const ROWS = `${CARD} [data-slot="dash-document-row"]`;
const LAST_ROW = `${CARD} [data-slot="dash-document-row"][data-dash="${LAST_DASH}"]`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/**
 * A document-only dash: a directory under `.tug/arcs/` holding a brief and
 * nothing else. `tugarc_core::document_arcs` lists exactly this shape, so
 * the row the section renders is a real dash the aggregate reported — there is
 * no fixture path into that list other than the files themselves.
 */
function seedDocumentDash(repo: string, name: string): void {
  const dir = join(repo, ".tug", "arcs", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "brief.md"),
    `# ${name}\n\nA brief the Dashes band has to find room for.\n`,
  );
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0499", checkout: CHECKOUT });
  for (const name of DASH_NAMES) seedDocumentDash(projectDir(), name);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmDashScratchRepo(scratch);
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
        testName: "at0499-dashes-scroll",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A spawned session, not a bound one: spawning is what registers the
        // scratch repo as a workspace, so its dashes reach the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(ROWS)}).length === ${DASH_COUNT}`,
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
               overflowY: getComputedStyle(list).overflowY,
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
        // and the fixture owes it more dashes — everything below is vacuous
        // without it.
        expect(geometry.listScrollHeight).toBeGreaterThan(geometry.listClientHeight);
        // The list is the scroller, and the card is not: the overflow belongs
        // to one place, which is what makes the scrollbar land around the rows
        // rather than around the card.
        expect(geometry.overflowY).toBe("auto");
        expect(geometry.cardScrollHeight).toBeLessThanOrEqual(
          geometry.cardClientHeight + 1,
        );
        // And the list stays inside the card instead of running past its foot.
        expect(geometry.listBottom).toBeLessThanOrEqual(geometry.cardBottom + 1);

        note("at0499 the Arcs card overflowing", (await app.screenshot()).path);

        // Scrolled to the end, the last dash sits inside the list's viewport —
        // the whole point of the scroller, and the thing a person could not do
        // before it existed.
        const reachable = await app.evalJS<{
          rowTop: number;
          rowBottom: number;
          viewTop: number;
          viewBottom: number;
        }>(
          `(() => {
             const list = document.querySelector(${JSON.stringify(LIST)});
             list.scrollTop = list.scrollHeight;
             const row = document.querySelector(${JSON.stringify(LAST_ROW)});
             const view = list.getBoundingClientRect();
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

        note("at0499 dashes card, bottom of the dashes band", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
