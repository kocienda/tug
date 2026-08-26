/**
 * at0405-changes-dash-lane.test.ts — the Changes shade's dash lane, driven
 * against a real dash created by the real CLI.
 *
 * A dash is a different species from a claimed file, so it gets a different
 * row. This pins that grammar end to end: a real `tugutil dash create` in the
 * project under test composes into `snapshot.dashes`, the lane renders one
 * `DashLifecycleBlock` at reading scale — the atom and the workers over the
 * track, the note and the divergence facts, the same block the Lens's Dashes
 * section renders at the rail ([D141]) — the expanded face carries the
 * worktree's dirty files and the maintained join draft as read-only ink, and
 * nowhere in the lane is there a claim, disclaim, or hunk-election affordance
 * — the whole point of not reusing `TugChangesList`'s rows.
 *
 * The draft has two grammars and the server decides which one stands: a dash
 * the join has armed shows what the join would land, under `lands as`
 * ([D152]); one it has not shows the draft plainly. This fixture's dash is
 * join-ready the moment its round lands — one round, no plan, a clean
 * worktree — so the arc arms it with nobody asking ([D147]) and `lands as` is
 * what a reader sees. The assertions below therefore wait for the draft's
 * **words** and then read whichever grammar carried them.
 *
 * Every dash in the project is a visible row, with no fold to open first. The
 * fold's absence is asserted directly, not merely relied upon.
 *
 * It also pins the fronting rule: a `bind_dash_ok` naming this card's session
 * moves the dash to the top of the lane, expanded, under the "This card's
 * dash" label. The broadcast is dispatched through `dispatchAction` — the
 * production entry point the wire's decoder hands frames to.
 *
 * ## Discard's reach
 *
 * Both sides of the rule are driven. An unbound dash — one no live session is
 * mated to — offers Release from any shade, because there is nobody to take it
 * away from. A dash a *different* live session holds offers none at all: it is
 * that session's to release, and the refusal is permanent, so the control is
 * absent rather than disabled. The holding session is seeded into the ledger
 * with a `dash_id`, since `bound_sessions` is computed from those rows and a
 * client-side `bind_dash_ok` cannot fake it.
 *
 * The project is a scratch repository this file owns, registered as a
 * workspace by spawning a real session on it — a dash is for implementing a
 * plan, not for running a test, so no fixture ever cuts one in the checkout.
 *
 * The lane's two binding gestures live here too, and are driven for real —
 * through the row's `⋯` menu, which is where they moved ([P08]): Unbind on the
 * fronted row sends `unbind_dash`, Bind on a non-fronted row sends `bind_dash`,
 * and the lane's fronting moves on the broadcast that comes back rather than on
 * the press. The menu is also where a blocked verb states its block, since a
 * disabled item takes no pointer events and a `title` on one can never be read
 * ([L31]).
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
 * @covers tugdeck/src/components/tugways/cards/session-changes/dash-row-menu.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/lib/changes-route-controller.ts
 * @covers tugdeck/src/components/tugways/dash-lifecycle-block.tsx
 * @covers tugdeck/src/components/tugways/dash-lifecycle-line.tsx
 * @covers tugdeck/src/components/tugways/tug-dash-track.tsx
 * @covers tugdeck/src/lib/document-dash-entry.ts
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
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugutil,
  type DashScratchRepo,
} from "./dash-fixture";
import {
  dashRowMenuOpener,
  pressDashRowMenuItem,
  readDashRowMenu,
} from "./dash-row-menu-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000405";
/** The reach case's own pair: the card doing the looking, and the live session
 *  that actually holds the dash. Separate ids so neither test's ledger rows can
 *  be mistaken for the other's. */
const HELD_SID = "a7c0d1ea-0000-4000-8000-000000001405";
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
/**
 * The row's three rare verbs live behind its `⋯` now ([P08]), so every
 * question about them is asked of an opened menu rather than of the row.
 */
const ROW_MENU_OPENER = dashRowMenuOpener(ROW);

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";
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
  scratch = makeDashScratchRepo({ prefix: "at0405", checkout: CHECKOUT });
  const created = createDash(projectDir(), DASH_NAME, "at0405 fixture", scratch.cli);
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
  commitRound(projectDir(), DASH_NAME, ROUND_SUBJECT, scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
  seedScratchSession(projectDir(), HELD_SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // The whole repository goes — branch, worktree, and dash with it.
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
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0405-changes-dash-lane-held",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace, so its dash reaches the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: HELD_SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        // The resumed transcript's one committed turn, on screen — typing into
        // the composer before the card reaches its resting state races the
        // resume's own repaint.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8000 },
        );

        // A second live session in this instance's ledger, and the dash is
        // mated to IT rather than to this card's. `bound_sessions` is computed
        // from these rows, so this is the real condition rather than a
        // client-side pretence — a `bind_dash_ok` broadcast could not produce
        // it. After launch, not before: tugcast demotes every `live` row to
        // `closed` at startup.
        app.seedLedger({
          sessions: [
            {
              session_id: HOLDER_SID,
              workspace_key: projectDir(),
              project_dir: projectDir(),
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
        const held = await readDashRowMenu(app, ROW);
        expect(
          held.discard.present,
          "a dash another live session holds offers no Discard",
        ).toBe(false);
        expect(
          held.bind.present,
          "Bind is unaffected — taking a dash on is not destroying it",
        ).toBe(true);
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
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0405-changes-dash-lane",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace (so its dash reaches the aggregate) and writes
        // the live ledger row Adopt's and Leave's CONTROL frames resolve the
        // calling session through. The resumed transcript already carries one
        // committed turn, which is the card's resting state.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
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

        // The rare verbs are behind the `⋯` and nowhere else: standing on the
        // row they read as peers of the acts a reader performs constantly.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(ROW_MENU_OPENER)}).length`,
          ),
          "the row carries one opener for its rare verbs",
        ).toBe(1);
        // Discard reaches an unbound dash. No live session is mated to this one,
        // so it is nobody's to protect and this shade may clean it up — the
        // whole point of widening the gesture past the fronted row.
        const unbound = await readDashRowMenu(app, ROW);
        expect(unbound.discard.present, "an unbound dash offers Discard").toBe(true);
        expect(unbound.discard.disabled, "and nothing is blocking it").toBe(false);
        // The reason rides the label when there is one, so an available verb
        // is the bare word ([L31]).
        expect(unbound.discard.label.trim(), "an available verb is the bare word").toBe(
          "Discard",
        );

        // ── The row reads in dash grammar ─────────────────────────────────
        const row = await app.evalJS<{
          badge: string;
          phase: string | null;
          note: string;
          popOuts: number;
          claimish: number;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             const lane = document.querySelector(${JSON.stringify(LANE)});
             const track = row.querySelector('[data-slot="tug-dash-track"]');
             const noteEl = row.querySelector('[data-slot="tug-dash-lifecycle-note"]');
             return {
               badge: (row.querySelector('[data-slot="tug-dash-lifecycle-name"]')?.textContent ?? "").trim(),
               phase: track?.getAttribute("data-phase") ?? null,
               note: (noteEl?.textContent ?? "").trim(),
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
        // Where the dash stands in its life, as the strip's own last cell.
        // One committed round, no plan and a clean worktree derives `ready`:
        // with no declared selection to finish, a landed round is the whole of
        // the intent, and the server arms the join from it ([D147]) — so the
        // track stands at `join`, the phase every arming stage reads as. With
        // no step open the note is that phase word and nothing more.
        expect(row.phase).toBe("join");
        expect(row.note).toBe(row.phase);
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
            cwd: projectDir(),
            binaryRoot: CHECKOUT,
            env: { TUG_CHANGES_DB: instanceChangesDb(app.instanceId) },
          },
        );
        const nudge = join(projectDir(), "at0405-nudge.txt");
        writeFileSync(nudge, "at0405 recompose nudge\n");
        try {
          // Waited for by its **words**, not by its slot. The fold has two
          // grammars for the same maintained draft and which one stands is the
          // server's call, not the fixture's: a dash the join has armed
          // shows what the join would land (`lands as`), and one it has not
          // shows the draft plainly. This dash is join-ready — one round, no
          // plan, a clean worktree — so the arc arms it unbidden ([D147]) and
          // `lands as` is what a reader sees. Waiting on the plain slot waited
          // for a grammar that could not appear.
          await app.waitForCondition<boolean>(
            `(() => {
               const row = document.querySelector(${JSON.stringify(ROW)});
               const body = row?.querySelector(".session-changes-dash-draft-message");
               return (body?.textContent ?? "").includes("at0405 join draft");
             })()`,
            { timeoutMs: 25000 },
          );
        } catch (err) {
          const shape = await app.evalJS<Record<string, unknown>>(
            `(() => {
               const row = document.querySelector(${JSON.stringify(ROW)});
               if (row === null) return { row: "absent" };
               const slots = [...row.querySelectorAll("[data-slot]")].map((el) => el.getAttribute("data-slot"));
               return {
                 expanded: row.getAttribute("data-expanded"),
                 phase: row.querySelector('[data-slot="tug-dash-track"]')?.getAttribute("data-phase") ?? null,
                 slots: [...new Set(slots)].join(","),
               };
             })()`,
          );
          note(`at0405 draft never reached the fold: ${JSON.stringify(shape)}`);
          throw err;
        } finally {
          rmSync(nudge, { force: true });
        }

        const detail = await app.evalJS<{
          landsAs: string | null;
          plainDraft: string | null;
          provenance: number;
          files: string;
          subjects: string;
          editors: number;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             const text = (sel) => {
               const el = row.querySelector(sel);
               return el === null ? null : el.textContent.trim();
             };
             return {
               landsAs: text('[data-slot="session-changes-dash-lands-as"]'),
               plainDraft: text('[data-slot="session-changes-dash-draft"]'),
               provenance: row.querySelectorAll('[data-slot="session-changes-dash-lands-as-note"]').length,
               files: (row.querySelector('[data-slot="session-changes-dash-files"]')?.textContent ?? "").trim(),
               subjects: (row.querySelector('[data-slot="session-changes-dash-subjects"]')?.textContent ?? "").trim(),
               editors: row.querySelectorAll('[data-slot="tug-text-editor"], textarea, input').length,
             };
           })()`,
        );
        // One grammar at a time, under its own `TugSectionLabel` eyebrow —
        // the fold's third section, after report and rounds.
        const standing = detail.landsAs ?? detail.plainDraft;
        expect(detail.landsAs === null || detail.plainDraft === null).toBe(true);
        expect(standing).not.toBe(null);
        expect((standing ?? "").toLowerCase()).toContain(
          detail.landsAs === null ? "draft" : "lands as",
        );
        expect(standing).toContain("at0405 join draft");
        // The offer's provenance note names the *substitutes* — a branch
        // description, or the generic stand-in. Its absence is how the offer
        // says these are the draft's own words.
        if (detail.landsAs !== null) expect(detail.provenance).toBe(0);
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

        // ── The stack is one left margin ──────────────────────────────────
        // Line 1 is who, line 2 is what the dash is doing, line 3 is what its
        // join is doing — and all three start on the dash NAME's margin.
        //
        // Getting there is arithmetic this lane cannot avoid: the metadata
        // line and the register are siblings of the row, so they begin at its
        // border box while the atom above them begins at its content box and
        // is then optically outdented on top of that. Three offsets, and the
        // lane once took a space token instead and landed nine pixels left of
        // the name. Measured against the rendered name so the row's density,
        // the atom's padding and the outdent can all move without this
        // becoming a lie.
        const stack = await app.evalJS<{ name: number; mark: number }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             const L = (el) => Math.round(el.getBoundingClientRect().left * 10) / 10;
             return {
               name: L(row.querySelector('[data-slot="tug-dash-lifecycle-name"]')),
               mark: L(row.querySelector('[data-slot="tug-dash-lifecycle-line"] > *')),
             };
           })()`,
        );
        note("at0405 stack", JSON.stringify(stack));
        expect(stack.mark, "line 2 starts on the dash name's own margin").toBe(
          stack.name,
        );

        // ── The complement rule ───────────────────────────────────────────
        // Unbind on the fronted row, Bind on none of it — a menu carrying both
        // at once would say the card can take on and put down the same dash.
        const affordances = await readDashRowMenu(app, ROW);
        expect(affordances.unbind.present).toBe(true);
        expect(affordances.bind.present).toBe(false);

        // ── Unbind: the real `unbind_dash` round trip ─────────────────────
        // The fronting moves on the `unbind_dash_ok` broadcast, never on the
        // press — nothing here writes the binding store optimistically, so
        // this assertion is about the round trip.
        await pressDashRowMenuItem(app, ROW, "unbind-dash");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FRONTED_LABEL)}) === null`,
          { timeoutMs: 15000 },
        );

        // ── Bind: and back again, the same way ────────────────────────────
        // The row stays on screen when it stops being fronted — it moves into
        // the rest group, which hides nothing — so its menu is reachable
        // without a fold click first.
        await pressDashRowMenuItem(app, ROW, "bind-dash");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FRONTED_LABEL)}) !== null`,
          { timeoutMs: 15000 },
        );
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
