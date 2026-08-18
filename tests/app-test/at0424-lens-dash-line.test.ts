/**
 * at0424-lens-dash-line.test.ts — the dash a session is working is a LINE of
 * that session's row in the Lens's Cards section, not a row beside it.
 *
 * The Cards section is organized by CARDS, so a dash's place in it is inside
 * the session that is on it: the reader is looking at the session, and the
 * dash is what that session is doing. A dash drawn as its own list row took
 * its own alternating-stripe band and hung its mark at the list's outer
 * gutter — left of the session's own text — so it read as a stray sibling
 * rather than as a fact about the row it belongs to.
 *
 * The structural claim is therefore CONTAINMENT, and that is what is asserted:
 * the line is a descendant of the session's own row element, and the session
 * still occupies exactly one list cell with the dash bound. Two counts make
 * the second half falsifiable rather than incidental — the number of list
 * cells before and after the bind.
 *
 * The dash's NAME lives in the title's identity run — `#<dash>`, everywhere a
 * session is named, with no opt-out — so the line does not repeat it: it
 * carries what the run cannot, the stage, the step counters, and the review
 * mark. Both halves are pinned: the line appears carrying no name, and the
 * title says the dash exactly once while it does.
 *
 * The counters are the reason the line exists, so their arrival is driven
 * rather than assumed: the fixture dash adopts a plan with no step started,
 * the line is read for the explicit missing-step state, a real
 * `tugutil dash step … start` runs through the same shell route, and the line
 * is read again for `1/1` in three forms — the data attributes a test can
 * assert on, the custom properties CSS can compute over, and the numerals a
 * reader actually sees.
 *
 * Everything is real. `tugutil dash bind` runs through the card's own `$` shell
 * route (the route that stamps `TUG_SESSION_ID`), and the line appears because
 * the dash's `bound_sessions` moved in the account-global aggregate the row's
 * own leaf subscription reads. `dash unbind` takes it away the same way, which
 * is the round trip that proves the line is derived on every beat rather than
 * latched at first sight.
 *
 * @covers tugdeck/src/components/lens/sections/cards-data-source.ts
 * @covers tugdeck/src/components/lens/sections/cards-section.tsx
 * @covers tugdeck/src/components/lens/sections/cards-session-cell.tsx
 * @covers tugdeck/src/components/lens/sections/dash-facts.tsx
 * @covers tugdeck/src/components/lens/sections/dash-facts.css
 * @covers tugdeck/src/lib/dash-session-index.ts
 * @covers tugdeck/src/components/tugways/tug-session-row.tsx
 * @covers tugdeck/src/components/tugways/tug-session-row.css
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createDash,
  discardDash,
  recordAdoptedPlan,
  tugutilPath,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0424-session";
const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const CARDS = '.lens-section[data-lens-section="cards"]';
const SESSION_ROW = `${CARDS} [data-session-id="${SID}"]`;
const SESSION_ROW_DASH = `${SESSION_ROW} [data-slot="session-identity-dash"]`;
const DASH_NAME = "at0424-line";
const DASH_LINE = `${SESSION_ROW} [data-slot="tug-session-row-dashline"]`;
const DASH_FACTS = `${DASH_LINE} [data-slot="lens-dashes-facts"]`;
const LIST_CELLS = `${CARDS} .tug-list-view-cell`;

const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));

beforeAll(() => {
  if (!SHOULD_RUN) return;
  const dash = createDash(PROJECT_DIR, DASH_NAME, "at0424 fixture");
  // A plan adopted and no step started — the state the line must not be
  // silent about, and the state the counters replace once a step opens.
  recordAdoptedPlan(PROJECT_DIR, DASH_NAME, dash.worktree);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  discardDash(PROJECT_DIR, DASH_NAME);
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

/** Run `command` through the card's `$` shell route and wait for its exit. */
async function shellAndSettle(
  app: App,
  command: string,
  expectedIndex = 0,
): Promise<void> {
  await app.nativeClickAtElement(PROMPT);
  await app.nativeType(`/shell ${command}`);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
  await app.waitForCondition<boolean>(
    `(function(){
       var rows = document.querySelectorAll(${JSON.stringify(SHELL_ROWS)});
       if (rows.length !== ${expectedIndex + 1}) return false;
       var foot = rows[${expectedIndex}].querySelector('[data-slot="session-z1b-end-state"]');
       return foot !== null && foot.textContent.indexOf("exit") !== -1;
     })()`,
    { timeoutMs: 30_000 },
  );
}

const dashRunsOnSessionRow = (app: App): Promise<number> =>
  app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(SESSION_ROW_DASH)}).length`,
  );

const listCellCount = (app: App): Promise<number> =>
  app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(LIST_CELLS)}).length`,
  );

describe.skipIf(!SHOULD_RUN)("AT0424: the Lens dash line", () => {
  test(
    "binding grows the session's row by a line, not the list by a row",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0424-lens-dash-line",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          projectDir: PROJECT_DIR,
          workspaceKey: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        app.seedLedger({
          sessions: [
            {
              session_id: SID,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              card_id: "A",
              name: "at0424 work",
            },
          ],
        });

        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SESSION_ROW)}) !== null`,
          { timeoutMs: 20000 },
        );
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(DASH_LINE)}).length`,
          ),
        ).toBe(0);
        const bareCells = await listCellCount(app);

        // ── Bind, for real ────────────────────────────────────────────────
        await shellAndSettle(app, `${tugutilPath(PROJECT_DIR)} dash bind ${DASH_NAME}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DASH_LINE)}) !== null`,
          { timeoutMs: 30000 },
        );

        const line = await app.evalJS<{
          text: string;
          insideSessionRow: boolean;
          sameCellAsSession: boolean;
          belowActivity: boolean;
          indentedPastSubLines: number;
        }>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(DASH_LINE)});
             const session = document.querySelector(${JSON.stringify(SESSION_ROW)});
             const cellOf = (n) => n.closest(".tug-list-view-cell");
             const description = session.querySelector(".tug-session-row-description");
             const pulse = session.querySelector(".tug-pulse");
             const pad = (n) =>
               parseFloat(getComputedStyle(n).paddingInlineStart) || 0;
             return {
               text: (el.querySelector(".lens-dashes-facts")?.textContent ?? "").trim(),
               // The structural claim: the line is INSIDE the session's row.
               insideSessionRow: session.contains(el),
               sameCellAsSession: cellOf(el) === cellOf(session),
               belowActivity:
                 pulse !== null &&
                 el.getBoundingClientRect().top >=
                   pulse.getBoundingClientRect().top,
               // One step further in than the sub-lines it hangs off.
               indentedPastSubLines:
                 description === null ? 0 : pad(el) - pad(description),
             };
           })()`,
        );
        note("at0424 dash line", JSON.stringify(line));
        // The name is the title run's to say; the line says only the doing.
        expect(line.text).not.toContain(`◊${DASH_NAME}`);
        // A freshly created dash with no round and no dirt is `created`.
        expect(line.text).toContain("created");
        expect(line.insideSessionRow).toBe(true);
        expect(line.sameCellAsSession).toBe(true);
        expect(line.belowActivity).toBe(true);
        expect(line.indentedPastSubLines).toBeGreaterThan(0);

        // And the list did not grow a row to hold it — the whole point of the
        // redesign, and the half a containment assertion alone would miss.
        expect(await listCellCount(app)).toBe(bareCells);

        // The row says the dash's name exactly once, and the title's identity
        // run is where — the sigil rides the session's name wherever the
        // session is named.
        expect(await dashRunsOnSessionRow(app)).toBe(1);
        note("at0424 lens with the dash line", (await app.screenshot()).path);

        // ── The step it is on — first its absence, then its arrival ───────
        // The dash carries a plan and no started step, so the line says so
        // rather than dropping to a bare stage word. Silence here is how a
        // whole run's declarations went unnoticed once.
        const before = await app.evalJS<{
          missing: boolean;
          current: string | null;
          total: string | null;
        }>(
          `(() => {
             const facts = document.querySelector(${JSON.stringify(DASH_FACTS)});
             return {
               missing: facts.getAttribute("data-step-missing") === "true",
               current: facts.getAttribute("data-step-current"),
               total: facts.getAttribute("data-step-total"),
             };
           })()`,
        );
        note("at0424 before the step", JSON.stringify(before));
        expect(before.missing).toBe(true);
        expect(before.current).toBeNull();
        expect(before.total).toBeNull();

        await shellAndSettle(
          app,
          `${tugutilPath(PROJECT_DIR)} dash step ${DASH_NAME} start 1 --plan plan.md`,
          1,
        );
        await app.waitForCondition<boolean>(
          `(() => {
             const facts = document.querySelector(${JSON.stringify(DASH_FACTS)});
             return facts !== null && facts.getAttribute("data-step-current") === "1";
           })()`,
          { timeoutMs: 30000 },
        );

        const stepped = await app.evalJS<{
          missing: boolean;
          current: string | null;
          total: string | null;
          counters: string;
          propCurrent: string;
          propTotal: string;
        }>(
          `(() => {
             const facts = document.querySelector(${JSON.stringify(DASH_FACTS)});
             const step = facts.querySelector(".lens-dashes-step");
             const style = getComputedStyle(facts);
             return {
               missing: facts.getAttribute("data-step-missing") === "true",
               current: facts.getAttribute("data-step-current"),
               total: facts.getAttribute("data-step-total"),
               counters: (step?.textContent ?? "").trim(),
               propCurrent: style.getPropertyValue("--dash-step-current").trim(),
               propTotal: style.getPropertyValue("--dash-step-total").trim(),
             };
           })()`,
        );
        note("at0424 with the step", JSON.stringify(stepped));
        // The fixture plan holds exactly one step.
        expect(stepped.current).toBe("1");
        expect(stepped.total).toBe("1");
        // The numerals are real text, not `content` — selectable and readable.
        expect(stepped.counters).toBe("1/1");
        // And the same fact in the form CSS can compute over.
        expect(stepped.propCurrent).toBe("1");
        expect(stepped.propTotal).toBe("1");
        // A declared step is not a missing one.
        expect(stepped.missing).toBe(false);
        note("at0424 lens with the counters", (await app.screenshot()).path);

        // ── Unbind, for real ──────────────────────────────────────────────
        await shellAndSettle(app, `${tugutilPath(PROJECT_DIR)} dash unbind`, 2);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(DASH_LINE)}).length === 0`,
          { timeoutMs: 30000 },
        );
        expect(await listCellCount(app)).toBe(bareCells);
        expect(await dashRunsOnSessionRow(app)).toBe(0);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
