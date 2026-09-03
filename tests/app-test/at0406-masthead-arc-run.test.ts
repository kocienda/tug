/**
 * at0406-masthead-arc-run.test.ts — the bound arc as a run in the Session
 * card's masthead title, bound and unbound by the real CLI through the card's
 * own shell route.
 *
 * The whole loop is real. `tugtool arc bind` resolves the calling session
 * from `TUG_SESSION_ID` — which is exactly what the `$` shell route stamps on
 * the child — and POSTs `/api/arc` to the instance whose ledger owns that
 * session, so the session is seeded into this instance's ledger first
 * (`seedLedger`) or the command exits with `no session`. The run that appears
 * is driven by the arc's `bound_sessions` moving in the account-global
 * changeset aggregate, with no reload and no card involvement; `arc unbind`
 * takes it away the same way.
 *
 * The run is the identity's, not the masthead's — the masthead renders no
 * arc chrome of its own, which is why the pins here are all on the title's
 * grammar. The whole title is one string — `name^arc` for a custom-named
 * session, since the name REMOVES the callsign run unless two sessions
 * collide on one name ([D141]) — with every separator a character inside a
 * run rather than a gap between boxes; that spelling is pinned here on the
 * line tier and in at0423 on the atom, because one identity worn two ways is
 * the defect both tests exist to catch.
 *
 * Two things are pinned besides the name. The run sits inside the title line's
 * content box, i.e. inside the width the masthead already reserves against the
 * pane's control cluster, so it cannot collide with pane chrome by
 * construction. And the 72px chrome tier does not change height when the run
 * arrives: a card that reflows when an arc is bound would move the transcript
 * under the reader's eyes.
 *
 * The run never carries the plan's review state as a TINT. A session's
 * identity line says what the session is; a plan's review hygiene is not that,
 * and a color with no legend beside it cannot be decoded. The state reaches
 * the reader in words instead, through the run's hover sentence — so editing
 * the plan past its stamp changes what the run SAYS and never how it paints.
 *
 * The fixture's arc name is long on purpose, and the pin is that it renders
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
 * @covers tugdeck/src/lib/arc-session-index.ts
 * @covers tugdeck/src/lib/arc-review.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  createArc,
  makeArcScratchRepo,
  makePlanStale,
  recordStampedPlan,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  shellAndSettle,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000406";
const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
// The masthead renders in the pane title bar, ABOVE the card host — not
// inside the card element.
const MASTHEAD = '[data-slot="session-masthead"]';
const RUN = `${MASTHEAD} [data-slot="session-identity-arc"]`;
const IDENTITY_RUN = `${MASTHEAD} .tug-session-identity-run`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";
// Long on purpose: far past any width a stylesheet could plausibly have
// capped, so "shown whole" is a claim about available room and nothing else.
const ARC_NAME = "at0406-arc-name-shown-whole";
/** The user's own name, from a `/rename` — what puts a `:` in the grammar. */
const RENAME = "Grammar work";
let planPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0406", checkout: CHECKOUT });
  const created = createArc(projectDir(), ARC_NAME, "at0406 fixture", scratch.cli);
  // The arc drives a real plan, reviewed and stamped — so the chip's resting
  // state carries no review attribute at all, and the one that appears later
  // can only be the edit.
  planPath = recordStampedPlan(projectDir(), ARC_NAME, created.worktree, scratch.cli);
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

const mastheadHeight = (app: App): Promise<number> =>
  app.evalJS<number>(
    `Math.round(document.querySelector(${JSON.stringify(MASTHEAD)}).getBoundingClientRect().height)`,
  );

describe.skipIf(!SHOULD_RUN)("AT0406: the masthead's arc run", () => {
  test(
    "a real arc bind paints the run on the title line and unbind takes it away",
    async () => {
      const app = await launchTugApp({
        testName: "at0406-masthead-arc-run",
        env: { TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace and writes the live ledger row the bind verb
        // resolves the owning instance through.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MASTHEAD)}) !== null`,
          { timeoutMs: 10000 },
        );
        expect(await app.evalJS<number>(
          `document.querySelectorAll(${JSON.stringify(RUN)}).length`,
        )).toBe(0);
        const bareHeight = await mastheadHeight(app);

        // ── Bind, for real ────────────────────────────────────────────────
        await shellAndSettle(app, `${tugtoolPath(CHECKOUT)} arc bind ${ARC_NAME}`, 0);
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
        // ellipsized arc still says it is an arc.
        expect(run.text).toBe(`^${ARC_NAME}`);
        // One format, spelled out end to end. The custom name REMOVED the
        // callsign run — no `:`, no project, no residue ([D141]) — so the
        // whole grammar is the name and the flush `^<arc>` after it.
        expect(run.grammar).toBe(`${RENAME}^${ARC_NAME}`);
        // The glyph left the grammar when the sigil replaced it.
        expect(run.svgCount).toBe(0);
        // Inside the identity itself — the run is part of the title's grammar,
        // not a slot beside it, which is what keeps it inside the width the
        // masthead reserves against the pane's control cluster.
        expect(run.inIdentity).toBe(true);
        expect(run.overflowsLine).toBe(false);
        expect(run.title).toBe(`Working on arc ${ARC_NAME}`);
        // The sigil is decorative; the run says the sentence a reader hears.
        expect(run.label).toBe(`On arc ${ARC_NAME}`);
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
             const span = run.querySelector(".tug-session-identity-arc-name");
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
        note("at0406 arc run width", JSON.stringify(elision));
        expect(elision.hasNameSpan).toBe(true);
        expect(elision.overflows).toBe(false);
        // The ceiling is gone at the source, not merely out-measured.
        expect(elision.maxInlineSize).toBe("none");
        expect(elision.textOverflow).toBe("ellipsis");
        expect(elision.whiteSpace).toBe("nowrap");
        expect(elision.firstGlyphInside).toBe(true);

        const shot = await app.screenshot();
        note("at0406 masthead with the arc run", shot.path);

        // ── The plan drifts past its review; the run SAYS so, in words ────
        // Never in a tint: the contract is the hover sentence, and the
        // attribute that used to paint the run is pinned absent on both sides
        // of the edit so a re-tint could not slip back in unnoticed.
        const reviewAttr = async (): Promise<string | null> =>
          app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(RUN)}).getAttribute("data-review")`,
          );
        expect(await reviewAttr()).toBeNull();
        makePlanStale(planPath);
        const nudge = join(projectDir(), "at0406-nudge.txt");
        writeFileSync(nudge, "at0406 recompose nudge\n");
        try {
          await app.waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(RUN)})?.getAttribute("title") ?? "").indexOf("changed since") !== -1`,
            { timeoutMs: 30000 },
          );
        } finally {
          rmSync(nudge, { force: true });
        }
        expect(await reviewAttr(), "a stale plan tints nothing").toBeNull();
        // Saying more does not make the run a different run: no reflow of the
        // chrome tier.
        expect(await mastheadHeight(app)).toBe(bareHeight);

        // ── Unbind, for real ──────────────────────────────────────────────
        await shellAndSettle(app, `${tugtoolPath(CHECKOUT)} arc unbind`, 1);
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
