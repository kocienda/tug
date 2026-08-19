/**
 * at0405-changes-dash-lane.test.ts — the Changes shade's dash lane, driven
 * against a real dash created by the real CLI.
 *
 * A dash is a different species from a claimed file, so it gets a different
 * row. This pins that grammar end to end: a real `tugutil dash create` in the
 * project under test composes into `snapshot.dashes`, the lane renders it as
 * name · base · rounds · dirty, the expanded face carries the worktree's dirty
 * files and the maintained join draft as read-only ink, and nowhere in the
 * lane is there a claim, disclaim, or hunk-election affordance — the whole
 * point of not reusing `TugChangesList`'s rows.
 *
 * Every dash in the project is a visible row, with no fold to open first. The
 * fold's absence is asserted directly, not merely relied upon.
 *
 * It also pins the fronting rule: a `bind_dash_ok` naming this card's session
 * moves the dash to the top of the lane, expanded, under the "This card's
 * dash" label. The broadcast is dispatched through `dispatchAction` — the
 * production entry point the wire's decoder hands frames to.
 *
 * ## Release's reach
 *
 * Both sides of the rule are driven. An unbound dash — one no live session is
 * mated to — offers Release from any shade, because there is nobody to take it
 * away from. A dash a *different* live session holds offers none at all: it is
 * that session's to release, and the refusal is permanent, so the control is
 * absent rather than disabled. The holding session is seeded into the ledger
 * with a `dash_id`, since `bound_sessions` is computed from those rows and a
 * client-side `bind_dash_ok` cannot fake it.
 *
 * The project must be the one tugcast registers at boot, exactly as at0332
 * records; dash entries derive from the repo's `tugdash/*` refs, which the
 * registered worktree shares with the checkout the dash was cut from.
 *
 * The lane's two binding gestures live here too, and are driven for real:
 * Leave on the fronted row sends `unbind_dash`, Adopt on a non-fronted row
 * sends `bind_dash`, and the lane's fronting moves on the broadcast that comes
 * back rather than on the click.
 *
 * What the masthead says about the binding is NOT asserted here, and that is
 * deliberate. The dash rides the title's own grammar now, derived from the
 * dash's `bound_sessions` in the account-global aggregate — so it answers to
 * server state, and the initial bind in this file is a synthesized
 * `bind_dash_ok` rather than a real one. at0406 drives that whole loop through
 * the real CLI and pins the run against it; asserting it here would have meant
 * asserting it against a fabricated frame.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/lib/changes-route-controller.ts
 * @covers tugdeck/src/components/tugways/tug-dash-name.tsx
 * @covers tugdeck/src/components/tugways/tug-meta-run.tsx
 * @covers tugdeck/src/components/tugways/tug-section-label.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  commitRound,
  createDash,
  currentBranch,
  discardDash,
  tugutil,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0405-session";
/** The reach case's own pair: the card doing the looking, and the live session
 *  that actually holds the dash. Separate ids so neither test's ledger rows can
 *  be mistaken for the other's. */
const HELD_SID = "at0405-onlooker";
const HOLDER_SID = "at0405-holder";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;
const FRONTED_LABEL = `${LANE} [data-slot="session-changes-dash-lane-fronted-label"]`;

const DASH_NAME = "at0405-lane";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH_NAME}"]`;
const ROW_FOLD = `${ROW} [data-slot="session-changes-dash-fold"]`;
const LEAVE = `${ROW} [data-slot="session-changes-dash-unbind"]`;
const ADOPT = `${ROW} [data-slot="session-changes-dash-bind"]`;
const RELEASE = `${ROW} [data-slot="session-changes-dash-discard"]`;

/** The checkout this file sits in — the project the aggregate composes, per
 *  at0332's rule. */
const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
const ROUND_FILE = "at0405-dash-round.txt";
const ROUND_SUBJECT = "at0405(round): the lane lists this subject";
const DRAFT_MESSAGE = "at0405 join draft\n\n- the lane renders this read-only";

/** The launch's private changes ledger — the same path the harness stamps into
 *  the app's `TUG_CHANGES_DB`. */
const instanceChangesDb = (instanceId: string): string =>
  join(homedir(), "Library/Application Support/Tug/instances", instanceId, "changes.db");

/** Dash owner key, captured from `dash create` — the id `bind_dash_ok` carries
 *  and the lane fronts on. */
let dashOwnerId = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  const created = createDash(PROJECT_DIR, DASH_NAME, "at0405 fixture");
  dashOwnerId = created.id;
  // One committed round: it is what gives the entry a round subject, a file
  // in its range diff, the `working` stage, and a range the pop-out can open.
  //
  // The worktree's *dirt* is deliberately not part of the fixture. The feed
  // resolves a dash's worktree as `<scanned project>/.tug/worktrees/<name>`
  // while the CLI resolves it against the repository's common dir, so a run
  // whose scanned project is itself a worktree reads every dash as having no
  // worktree — `worktree_dirty` would then be false for reasons that have
  // nothing to do with the lane. Rounds read the same from either tree.
  writeFileSync(join(created.worktree, ROUND_FILE), "at0405 round\n");
  commitRound(PROJECT_DIR, DASH_NAME, ROUND_SUBJECT);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // Release discards the worktree and the branch, dirt included.
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

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

/**
 * Click `target` until `expected` reaches `want`, scrolling the target into
 * view each time. The lane sits at the bottom of an auto-sizing shade fed by an
 * aggregate that recomposes on its own schedule, so a click's coordinates can
 * go stale between the aim and the press. A missed click changes nothing, so
 * re-aiming is safe; the generous per-attempt wait is what keeps a *landed*
 * click from being re-sent and toggled back.
 *
 * Both directions take the retry, because both gestures aim at the same moving
 * lane: Adopt waits for the fronted label to appear, Leave for it to go. A bare
 * click on either is a coin flip on whether the aggregate recomposed in the
 * window between reading the coordinates and pressing them.
 */
async function clickUntil(
  app: Awaited<ReturnType<typeof launchTugApp>>,
  target: string,
  expected: string,
  want: "present" | "absent" = "present",
  attempts = 4,
): Promise<void> {
  const predicate =
    want === "present"
      ? `document.querySelector(${JSON.stringify(expected)}) !== null`
      : `document.querySelector(${JSON.stringify(expected)}) === null`;
  for (let i = 0; i < attempts; i += 1) {
    await app.evalJS<null>(
      `(() => {
         const el = document.querySelector(${JSON.stringify(target)});
         if (el !== null) el.scrollIntoView({ block: "center" });
         return null;
       })()`,
    );
    await settle();
    await app.nativeClickAtElement(target);
    try {
      await app.waitForCondition<boolean>(predicate, { timeoutMs: 2500 });
      return;
    } catch {
      note(`at0405 click on ${target} did not land (attempt ${i + 1})`);
    }
  }
  throw new Error(
    `at0405: ${expected} never went ${want} after clicking ${target}`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0405: the Changes shade's dash lane", () => {
  test(
    "a dash another live session holds offers this shade no Release at all",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0405-changes-dash-lane-held",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", {
          tugSessionId: HELD_SID,
          projectDir: PROJECT_DIR,
          workspaceKey: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // Two live sessions in this instance's ledger, and the dash is mated
        // to the OTHER one. `bound_sessions` is computed from these rows, so
        // this is the real condition rather than a client-side pretence — a
        // `bind_dash_ok` broadcast could not produce it.
        app.seedLedger({
          sessions: [
            {
              session_id: HELD_SID,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              card_id: "A",
              name: "at0405 onlooker",
            },
            {
              session_id: HOLDER_SID,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              card_id: "elsewhere",
              name: "at0405 holder",
              dash_id: dashOwnerId,
              dash_name: DASH_NAME,
            },
          ],
        });

        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape");
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30000 },
        );

        // The row is here — a dash somebody else is working is still a
        // situation worth seeing. What is absent is the gesture that would
        // destroy it: that dash is its own session's to release.
        //
        // Absent, not disabled. Nothing the reader does *here* will ever make
        // it available, and a disabled control with a reason is the idiom for
        // "not yet", not for "not yours".
        await settle(1500);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(RELEASE)}).length`,
          ),
          "a dash another live session holds renders no Release",
        ).toBe(0);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(ADOPT)}).length`,
          ),
          "Adopt is unaffected — taking a dash on is not destroying it",
        ).toBe(1);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a real dash renders in dash grammar, folds when unbound, and fronts on bind",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0405-changes-dash-lane",
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
        // Adopt and Leave send real CONTROL frames, and the server resolves
        // the calling session out of this instance's ledger — a client-side
        // binding alone is invisible to it. After launch, not before: tugcast
        // demotes every `live` row to `closed` at startup.
        app.seedLedger({
          sessions: [
            {
              session_id: SID,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              card_id: "A",
              name: "at0405 work",
            },
          ],
        });

        await app.driveSession("A", { op: "send", text: "hello" });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: 0x40,
          decoded: { tug_session_id: SID, type: "prompt_anchor", promptUuid: "uuid-1" },
        });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: 0x40,
          decoded: {
            tug_session_id: SID,
            type: "turn_complete",
            msg_id: "m1",
            result: "success",
          },
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8000 },
        );

        // ── Raise the changes shade ────────────────────────────────────────
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape");
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 8000 },
        );

        // ── Unbound: the lane exists, and the dash is a visible row ────────
        // Nothing is fronted yet — the card is bound to no dash — but the row
        // is on screen with no gesture at all. A dash somebody else is working
        // is a situation to look at, not a count to expand.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30000 },
        );
        // The count is of THIS fixture's row, not of the lane. A dash's refs
        // are repo-global, so any dash the developer has open is a row here
        // too — a total is a fact about whoever is running the suite.
        const unfrontedState = await app.evalJS<{ fronted: number; rows: number }>(
          `(() => ({
             fronted: document.querySelectorAll(${JSON.stringify(FRONTED_LABEL)}).length,
             rows: document.querySelectorAll(${JSON.stringify(ROW)}).length,
           }))()`,
        );
        expect(unfrontedState.fronted).toBe(0);
        expect(unfrontedState.rows).toBe(1);

        // The fold is gone, not merely unused — nothing anywhere renders it.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('[data-slot="session-changes-dash-lane-fold"]').length`,
          ),
          "the other-dashes fold no longer exists",
        ).toBe(0);

        // Discard reaches an unbound dash. No live session is mated to this one,
        // so it is nobody's to protect and this shade may clean it up — the
        // whole point of widening the gesture past the fronted row.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(RELEASE)}).length`,
          ),
          "an unbound dash offers Discard",
        ).toBe(1);

        // ── The row reads in dash grammar ─────────────────────────────────
        const row = await app.evalJS<{
          badge: string;
          facts: string;
          popOuts: number;
          claimish: number;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             const lane = document.querySelector(${JSON.stringify(LANE)});
             return {
               badge: (row.querySelector('[data-slot="session-changes-dash-name"]')?.textContent ?? "").trim(),
               facts: (row.querySelector(".session-changes-dash-facts")?.textContent ?? "").trim(),
               popOuts: row.querySelectorAll('[data-testid="tug-changes-list-diff-popout"]').length,
               claimish: lane.querySelectorAll(
                 '[data-testid^="tug-changes-list-claim"], [data-testid^="tug-changes-list-disclaim"], .tug-changes-list-claim, .tug-changes-list-disclaim',
               ).length,
             };
           })()`,
        );
        // The name wears its caret and no chip: `DashSigil`, the same component
        // a bound session's identity atom composes. `textContent`, not
        // `innerText` — the run is an inline-flex of two spans, which
        // blockifies them and would put a line break between the sigil and
        // the name it belongs to.
        expect(row.badge).toBe(`^${DASH_NAME}`);
        // The base is the branch this checkout has out — what the fixture
        // forked from — not the repo's default. Run from a dash worktree, the
        // two differ.
        expect(row.facts).toContain(currentBranch(PROJECT_DIR));
        expect(row.facts).toContain("1 round");
        // The derived stage, rendered as the word the server sent.
        expect(row.facts).toContain("working");
        expect(row.popOuts).toBe(1);
        // The lane is read-only by construction: no claim grammar reaches it.
        expect(row.claimish).toBe(0);

        // ── Expanded face: the rounds, the files, and the join draft ───────
        await clickUntil(app, ROW_FOLD, `${ROW}[data-expanded="true"]`);

        // The draft is a ledger row, and the harness points this instance's
        // changes ledger at its own private copy so a run never writes into
        // the developer's real one — so the draft has to be written there,
        // with the same CLI verb and the same env the app itself runs under.
        // Touching a tracked-project file is what wakes the aggregate for the
        // recompose that carries the draft onto the entry.
        tugutil(
          ["draft", "set", "--owner", `dash:${DASH_NAME}`, "--message", DRAFT_MESSAGE, "--json"],
          {
            cwd: PROJECT_DIR,
            env: { TUG_CHANGES_DB: instanceChangesDb(app.instanceId) },
          },
        );
        const nudge = join(PROJECT_DIR, "at0405-nudge.txt");
        writeFileSync(nudge, "at0405 recompose nudge\n");
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(`${ROW} [data-slot="session-changes-dash-draft"]`)}) !== null`,
            { timeoutMs: 25000 },
          );
        } finally {
          rmSync(nudge, { force: true });
        }

        const detail = await app.evalJS<{
          draft: string;
          files: string;
          subjects: string;
          editors: number;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             return {
               draft: (row.querySelector('[data-slot="session-changes-dash-draft"]')?.textContent ?? "").trim(),
               files: (row.querySelector('[data-slot="session-changes-dash-files"]')?.textContent ?? "").trim(),
               subjects: (row.querySelector('[data-slot="session-changes-dash-subjects"]')?.textContent ?? "").trim(),
               editors: row.querySelectorAll('[data-slot="tug-text-editor"], textarea, input').length,
             };
           })()`,
        );
        expect(detail.draft).toContain("Join draft");
        expect(detail.draft).toContain("at0405 join draft");
        expect(detail.subjects).toContain(ROUND_SUBJECT);
        expect(detail.files).toContain(ROUND_FILE);
        // Read-only means read-only: no editor, anywhere in the row.
        expect(detail.editors).toBe(0);

        // ── Bind: the dash fronts, expanded, under its own label ───────────
        await app.dispatchControlAction("bind_dash_ok", {
          tug_session_id: SID,
          dash_id: dashOwnerId,
          dash_name: DASH_NAME,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FRONTED_LABEL)}) !== null`,
          { timeoutMs: 8000 },
        );
        const fronted = await app.evalJS<{ first: string | null; expanded: string | null }>(
          `(() => {
             const rows = document.querySelectorAll(${JSON.stringify(`${LANE} [data-slot="session-changes-dash-row"]`)});
             const first = rows[0] ?? null;
             return {
               first: first === null ? null : first.getAttribute("data-dash"),
               expanded: first === null ? null : first.getAttribute("data-expanded"),
             };
           })()`,
        );
        expect(fronted.first).toBe(DASH_NAME);
        expect(fronted.expanded).toBe("true");

        // ── The complement rule ───────────────────────────────────────────
        // Leave on the fronted row, Adopt on none of it — a refactor that
        // broke this into two buttons on one row would say the card can both
        // take on and put down the same dash.
        const affordances = await app.evalJS<{ leave: number; adopt: number }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             return {
               leave: row.querySelectorAll('[data-slot="session-changes-dash-unbind"]').length,
               adopt: row.querySelectorAll('[data-slot="session-changes-dash-bind"]').length,
             };
           })()`,
        );
        expect(affordances.leave).toBe(1);
        expect(affordances.adopt).toBe(0);

        // ── Leave: the real `unbind_dash` round trip ──────────────────────
        // The fronting moves on the `unbind_dash_ok` broadcast, never on the
        // click — nothing here writes the binding store optimistically, so
        // this assertion is about the round trip.
        await clickUntil(app, LEAVE, FRONTED_LABEL, "absent");

        // ── Adopt: and back again, the same way ───────────────────────────
        // The row stays on screen when it stops being fronted — it moves into
        // the rest group, which no longer hides anything — so Adopt is reachable
        // without a fold click first.
        //
        // Through a scroll-in-and-retry, because the lane is the shade's last
        // block over an aggregate that recomposes on its own schedule, so a
        // coordinate read can go stale between aiming and clicking. A missed
        // click leaves the state untouched, which is what makes the retry a
        // retry and not a double-bind.
        await clickUntil(app, ADOPT, FRONTED_LABEL);
        expect(
          await app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(`${LANE} [data-slot="session-changes-dash-row"]`)})?.getAttribute("data-dash") ?? null`,
          ),
        ).toBe(DASH_NAME);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
