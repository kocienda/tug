/**
 * at0406-masthead-dash-run.test.ts — the bound dash as a run in the Session
 * card's masthead title, bound and unbound by the real CLI through the card's
 * own shell route.
 *
 * The whole loop is real. `tugutil dash bind` resolves the calling session
 * from `TUG_SESSION_ID` — which is exactly what the `$` shell route stamps on
 * the child — and POSTs `/api/dash` to the instance whose ledger owns that
 * session, so the session is seeded into this instance's ledger first
 * (`seedLedger`) or the command exits with `no session`. The run that appears
 * is driven by the dash's `bound_sessions` moving in the account-global
 * changeset aggregate, with no reload and no card involvement; `dash unbind`
 * takes it away the same way.
 *
 * The run is the identity's, not the masthead's — the masthead renders no
 * dash chrome of its own, which is why the pins here are all on the title's
 * grammar. The whole title is one string, `name:project/callsign#dash`, with
 * every separator a character inside a run rather than a gap between boxes;
 * that spelling is pinned here on the line tier and in at0423 on the atom,
 * because one identity worn two ways is the defect both tests exist to catch.
 *
 * Two things are pinned besides the name. The run sits inside the title line's
 * content box, i.e. inside the width the masthead already reserves against the
 * pane's control cluster, so it cannot collide with pane chrome by
 * construction. And the 72px chrome tier does not change height when the run
 * arrives: a card that reflows when a dash is bound would move the transcript
 * under the reader's eyes.
 *
 * The run also carries the dash plan's review state, as its own tone rather
 * than as a second mark beside the name — neither register has room for two.
 * The dash drives a real stamped plan, so the run arrives unmarked; editing
 * the plan past its stamp is what makes the mark appear.
 *
 * The fixture's dash name is long on purpose, and the pin is that it renders
 * WHOLE. A run elides when its container is out of room and never because of a
 * number authored in the stylesheet, so a name that fits in a roomy masthead
 * must show every character. The elision machinery is pinned alongside it
 * (`text-overflow`, `nowrap`, and the first glyph painting inside its box) —
 * text with no elidable box of its own overflows a centred flex row in both
 * directions and clips off both ends, and that mechanism has to stay in place
 * for the squeeze that does come.
 *
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 * @covers tugdeck/src/lib/dash-session-index.ts
 * @covers tugdeck/src/lib/dash-review.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  createDash,
  makePlanStale,
  recordStampedPlan,
  discardDash,
  tugutilPath,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0406-session";
const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
// The masthead renders in the pane title bar, ABOVE the card host — not
// inside the card element.
const MASTHEAD = '[data-slot="session-masthead"]';
const RUN = `${MASTHEAD} [data-slot="session-identity-dash"]`;
const IDENTITY_RUN = `${MASTHEAD} .tug-session-identity-run`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
// Long on purpose: far past any width a stylesheet could plausibly have
// capped, so "shown whole" is a claim about available room and nothing else.
const DASH_NAME = "at0406-dash-name-shown-whole";
const SESSION_NAME = "at0406 work";
/** The user's own name, from a `/rename` — what puts a `:` in the grammar. */
const RENAME = "Grammar work";
let planPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  const created = createDash(PROJECT_DIR, DASH_NAME, "at0406 fixture");
  // The dash drives a real plan, reviewed and stamped — so the chip's resting
  // state carries no review attribute at all, and the one that appears later
  // can only be the edit.
  planPath = recordStampedPlan(PROJECT_DIR, DASH_NAME, created.worktree);
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

/** Run `command` through the card's `$` shell route and wait for its row to
 *  settle with an exit label — the route is what stamps `TUG_SESSION_ID`. */
async function shellAndSettle(
  app: App,
  command: string,
  expectedIndex: number,
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

const mastheadHeight = (app: App): Promise<number> =>
  app.evalJS<number>(
    `Math.round(document.querySelector(${JSON.stringify(MASTHEAD)}).getBoundingClientRect().height)`,
  );

describe.skipIf(!SHOULD_RUN)("AT0406: the masthead's dash run", () => {
  test(
    "a real dash bind paints the run on the title line and unbind takes it away",
    async () => {
      const app = await launchTugApp({ testName: "at0406-masthead-dash-run" });
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
        // The bind verb resolves the instance whose ledger OWNS this session;
        // a client-side binding alone is invisible to it. After launch, not
        // before: tugcast demotes every `live` row to `closed` at startup.
        app.seedLedger({
          sessions: [
            {
              session_id: SID,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              card_id: "A",
              name: SESSION_NAME,
            },
          ],
        });

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MASTHEAD)}) !== null`,
          { timeoutMs: 10000 },
        );
        expect(await app.evalJS<number>(
          `document.querySelectorAll(${JSON.stringify(RUN)}).length`,
        )).toBe(0);
        const bareHeight = await mastheadHeight(app);

        // ── Bind, for real ────────────────────────────────────────────────
        await shellAndSettle(app, `${tugutilPath(PROJECT_DIR)} dash bind ${DASH_NAME}`, 0);
        note(
          "at0406 bind row",
          await app.evalJS<string>(
            `(document.querySelectorAll(${JSON.stringify(SHELL_ROWS)})[0]?.textContent ?? "").trim().slice(0, 400)`,
          ),
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RUN)}) !== null`,
          { timeoutMs: 15000 },
        );

        // A user name, so the grammar's `:` has something to separate. It
        // arrives the way a real `/rename` does — on the ledger row — because
        // the whole format is only observable on a session that has all three
        // parts at once.
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishSessionUpdated(${JSON.stringify(
              JSON.stringify({
                session_id: SID,
                fields: { name: RENAME, name_user_set: true },
              }),
            )})`,
          ),
        ).toBe(true);
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(IDENTITY_RUN)})?.textContent ?? "").indexOf(${JSON.stringify(RENAME)}) === 0`,
          { timeoutMs: 10000 },
        );

        const run = await app.evalJS<{
          text: string;
          grammar: string;
          svgCount: number;
          inIdentity: boolean;
          title: string | null;
          label: string | null;
          overflowsLine: boolean;
        }>(
          `(() => {
             const run = document.querySelector(${JSON.stringify(RUN)});
             const identity = run.closest('[data-slot="tug-session-identity"]');
             const line = run.closest(".tug-session-row-name-line");
             const whole = document.querySelector(${JSON.stringify(IDENTITY_RUN)});
             const r = run.getBoundingClientRect();
             const l = line.getBoundingClientRect();
             return {
               text: (run.textContent ?? "").trim(),
               grammar: (whole.textContent ?? "").trim(),
               svgCount: run.querySelectorAll("svg").length,
               inIdentity: identity !== null,
               title: run.getAttribute("title"),
               label: run.getAttribute("aria-label"),
               overflowsLine: r.right > l.right + 1,
             };
           })()`,
        );
        note("at0406 title grammar", run.grammar);
        // The sigil is inside the run, so the run's own text carries it: an
        // ellipsized dash still says it is a dash.
        expect(run.text).toBe(`^${DASH_NAME}`);
        // One format, spelled out end to end — the callsign is minted per
        // session, so it is the only part matched loosely. What is exact is
        // the punctuation: a bare `:` and a bare `^`, no spaces anywhere.
        expect(run.grammar).toMatch(
          new RegExp(`^${RENAME}:tugtool/[a-z0-9-]+\\^${DASH_NAME}$`),
        );
        // The glyph left the grammar when the sigil replaced it.
        expect(run.svgCount).toBe(0);
        // Inside the identity itself — the run is part of the title's grammar,
        // not a slot beside it, which is what keeps it inside the width the
        // masthead reserves against the pane's control cluster.
        expect(run.inIdentity).toBe(true);
        expect(run.overflowsLine).toBe(false);
        expect(run.title).toBe(`Working on dash ${DASH_NAME}`);
        // The sigil is decorative; the run says the sentence a reader hears.
        expect(run.label).toBe(`On dash ${DASH_NAME}`);
        // The chrome tier does not grow to make room for the run.
        expect(await mastheadHeight(app)).toBe(bareHeight);

        // ── There is room, so the name is shown whole ─────────────────────
        // `overflows` is the load-bearing pin, and it is measured rather than
        // pattern-matched against an ellipsis character: a run that fits its
        // box has `scrollWidth === clientWidth`, and a ceiling authored in the
        // stylesheet would make that false no matter how much free width the
        // masthead has. The elision machinery is asserted alongside it because
        // it must survive for the squeeze that does come — `firstGlyphInside`
        // is where the name's first character actually paints, and text with
        // no elidable box of its own overflows a centred flex row in both
        // directions, putting that glyph to the LEFT of its own box.
        const elision = await app.evalJS<{
          hasNameSpan: boolean;
          overflows: boolean;
          maxInlineSize: string;
          textOverflow: string;
          whiteSpace: string;
          firstGlyphInside: boolean;
        }>(
          `(() => {
             const run = document.querySelector(${JSON.stringify(RUN)});
             const span = run.querySelector(".tug-session-identity-dash-name");
             if (span === null) {
               return { hasNameSpan: false, overflows: true, maxInlineSize: "",
                        textOverflow: "", whiteSpace: "", firstGlyphInside: false };
             }
             const cs = getComputedStyle(span);
             const node = span.firstChild;
             const r = document.createRange();
             r.setStart(node, 0);
             r.setEnd(node, 1);
             const glyph = r.getBoundingClientRect();
             const box = span.getBoundingClientRect();
             return {
               hasNameSpan: true,
               overflows: span.scrollWidth > span.clientWidth,
               maxInlineSize: cs.maxInlineSize,
               textOverflow: cs.textOverflow,
               whiteSpace: cs.whiteSpace,
               firstGlyphInside: glyph.left >= box.left - 1,
             };
           })()`,
        );
        note("at0406 dash run width", JSON.stringify(elision));
        expect(elision.hasNameSpan).toBe(true);
        expect(elision.overflows).toBe(false);
        // The ceiling is gone at the source, not merely out-measured.
        expect(elision.maxInlineSize).toBe("none");
        expect(elision.textOverflow).toBe("ellipsis");
        expect(elision.whiteSpace).toBe("nowrap");
        expect(elision.firstGlyphInside).toBe(true);

        const shot = await app.screenshot();
        note("at0406 masthead with the dash run", shot.path);

        // ── The plan drifts past its review; the run says so ──────────────
        // The mark is the run's own tone rather than a second glyph beside the
        // first, so the contract is the attribute.
        expect(
          await app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(RUN)}).getAttribute("data-review")`,
          ),
        ).toBeNull();
        makePlanStale(planPath);
        const nudge = join(PROJECT_DIR, "at0406-nudge.txt");
        writeFileSync(nudge, "at0406 recompose nudge\n");
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RUN)})?.getAttribute("data-review") === "stale"`,
            { timeoutMs: 30000 },
          );
        } finally {
          rmSync(nudge, { force: true });
        }
        expect(
          await app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(RUN)}).getAttribute("title")`,
          ),
        ).toContain("changed since");
        // A tinted run is still the same run: no reflow of the chrome tier.
        expect(await mastheadHeight(app)).toBe(bareHeight);

        // ── Unbind, for real ──────────────────────────────────────────────
        await shellAndSettle(app, `${tugutilPath(PROJECT_DIR)} dash unbind`, 1);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RUN)}) === null`,
          { timeoutMs: 15000 },
        );
        expect(await mastheadHeight(app)).toBe(bareHeight);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
