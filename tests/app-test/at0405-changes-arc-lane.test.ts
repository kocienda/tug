/**
 * at0405-changes-arc-lane.test.ts — the Changes shade's arc lane, driven
 * against a real arc created by the real CLI.
 *
 * An arc is a different species from a claimed file, so it gets a different
 * row. This pins that grammar end to end: a real `tugtool arc create` in the
 * project under test composes into `snapshot.arcs`, the lane renders one
 * `ArcLifecycleBlock` at reading scale — the atom and the workers over the
 * track, the note and the divergence facts, the same block the Arcs card's
 * section renders at the rail ([D141]) — the expanded face carries the
 * worktree's dirty files and the maintained join draft as read-only ink, and
 * nowhere in the lane is there a claim, disclaim, or hunk-election affordance
 * — the whole point of not reusing `TugChangesList`'s rows.
 *
 * The draft has two grammars and the server decides which one stands: an arc
 * the join has armed shows what the join would land, under `lands as`
 * ([D152]); one it has not shows the draft plainly. This fixture's arc is
 * join-ready the moment its round lands — one round, no plan, a clean
 * worktree — so the arc arms it with nobody asking ([D147]) and `lands as` is
 * what a reader sees. The assertions below therefore wait for the draft's
 * **words** and then read whichever grammar carried them.
 *
 * The lane lists this card's arc and the unbound arcs, with no fold to open
 * first — the fold's absence is asserted directly, not merely relied upon.
 * An arc *another* live session holds is not a row here at all ([D173]): its
 * room is the card working it, reached from the Arcs card ([D153]). The
 * unbound rows stand under the `unbound` label, in the same grammar as the
 * orphaned file bucket.
 *
 * It also pins the fronting rule: a `bind_arc_ok` naming this card's session
 * moves the arc to the top of the lane, expanded, under the "This card's
 * arc" label. The broadcast is dispatched through `dispatchAction` — the
 * production entry point the wire's decoder hands frames to.
 *
 * ## A held arc, and Discard's reach
 *
 * Both sides are driven. An unbound arc — one no live session is mated to —
 * is a row that offers Discard from any shade, because there is nobody to
 * take it away from. An arc a *different* live session holds is not a row in
 * this shade at all: every act it could offer is withheld or wrong from here,
 * and the Arcs card — which lists every arc, always — is where it is seen and
 * where its room is one click away. The holding session is seeded into the
 * ledger with an `arc_id`, since `bound_session` is computed from those rows
 * and a client-side `bind_arc_ok` cannot fake it; the Arcs card row's worker
 * atom is the positive signal that the binding reached the aggregate, and the
 * lane's absence is asserted only after it.
 *
 * The project is a scratch repository this file owns, registered as a
 * workspace by spawning a real session on it — an arc is for implementing a
 * plan, not for running a test, so no fixture ever cuts one in the checkout.
 *
 * The lane's two binding gestures live here too, and are driven for real —
 * through the row's `⋯` menu, which is where they moved ([P08]): Unbind on the
 * fronted row sends `unbind_arc`, Bind on a non-fronted row sends `bind_arc`,
 * and the lane's fronting moves on the broadcast that comes back rather than on
 * the press. The menu is also where a blocked verb states its block, since a
 * disabled item takes no pointer events and a `title` on one can never be read
 * ([L31]).
 *
 * What the masthead says about the binding is NOT asserted here, and that is
 * deliberate. The arc rides the title's own grammar now, derived from the
 * arc's `bound_session` in the account-global aggregate — so it answers to
 * server state, and the initial bind in this file is a synthesized
 * `bind_arc_ok` rather than a real one. at0406 drives that whole loop through
 * the real CLI and pins the run against it; asserting it here would have meant
 * asserting it against a fabricated frame.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-lane.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-lane.css
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-documents.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/changes-section-labels.ts
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-brief.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-fold-row.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-fold.css
 * @covers tugdeck/src/components/tugways/tug-changes-list.tsx
 * @covers tugdeck/src/lib/arc-file-clusters.ts
 * @covers tugdeck/src/lib/landing-message.ts
 * @covers tugdeck/src/components/tugways/cards/session-changes/arc-row-menu.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/lib/changes-route-controller.ts
 * @covers tugdeck/src/components/tugways/arc-lifecycle-block.tsx
 * @covers tugdeck/src/components/tugways/arc-lifecycle-line.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.tsx
 * @covers tugdeck/src/lib/document-arc-entry.ts
 * @covers tugdeck/src/components/tugways/tug-section-label.tsx
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/lib/arc-join-register.ts
 * @covers tugdeck/src/components/tugways/arc-join-register.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  createArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";
import {
  arcRowMenuOpener,
  pressArcRowMenuItem,
  readArcRowMenu,
} from "./arc-row-menu-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000405";
/** The reach case's own pair: the card doing the looking, and the live session
 *  that actually holds the arc. Separate ids so neither test's ledger rows can
 *  be mistaken for the other's. */
const HELD_SID = "a7c0d1ea-0000-4000-8000-000000001405";
const HOLDER_SID = "at0405-holder";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;
const FRONTED_LABEL = `${LANE} [data-slot="session-changes-arc-lane-fronted-label"]`;
const REST_LABEL = `${LANE} [data-slot="session-changes-arc-lane-rest-label"]`;

const ARC_NAME = "at0405-lane";
const ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC_NAME}"]`;
/** The brief's file list — the totals row and every area under it. */
const FILES = `${ROW} [data-slot="session-changes-arc-files"]`;
/** The whole fold — documents, report, brief — the one box the geometry
 *  assertions below are asked of. */
const DETAIL = `${ROW} .session-changes-arc-detail`;
const ROW_FOLD = `${ROW} [data-slot="session-changes-arc-fold"]`;
/** The same arc on the Arcs card — the every-arc surface, where a held arc
 *  is still a row. */
const ARCS_ROW = `.arcs-section [data-slot="arcs-row"][data-arc="${ARC_NAME}"]`;
/**
 * The row's three rare verbs live behind its `⋯` now ([P08]), so every
 * question about them is asked of an opened menu rather than of the row.
 */
const ROW_MENU_OPENER = arcRowMenuOpener(ROW);

/**
 * The chrome the fold hosts but does not author, excluded from the two-sizes
 * assertion because each of these carries a type scale of its own that the
 * fold has no business overriding. Without the list the assertion is false by
 * construction rather than by defect.
 */
const FOREIGN_TYPE_SCALES = [
  // `TugSectionLabel` sets `2xs` for all three section eyebrows — an eyebrow
  // is smaller than its rows by design, everywhere in the app.
  ".tug-section-label",
  // `DiffSummaryBadges` renders `TugBadge`, whose counts have their own 8–12px
  // scale — the same badges a commit receipt's rows carry.
  ".tug-badge",
  // A blocker is a `TugInlineDialog`; the frame, its title and its actions are
  // the primitive's type, not the fold's.
  ".tug-inline-dialog",
  // The escalation's surface is the shipped question wizard, mounted whole.
  ".tug-question-wizard",
];

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";
const ROUND_FILE = "at0405-arc-round.txt";
/** A directory the round touches twice — the brief's areas fold something. */
const ROUND_AREA = "at0405-area";
const ROUND_SUBJECT = "at0405(round): the lane lists this subject";
const DRAFT_MESSAGE = "at0405 join draft\n\n- the lane renders this read-only";

/** The launch's private changes ledger — the same path the harness stamps into
 *  the app's `TUG_CHANGES_DB`. */
const instanceChangesDb = (instanceId: string): string =>
  join(homedir(), "Library/Application Support/Tug/instances", instanceId, "changes.db");

/** Arc owner key, captured from `arc create` — the id `bind_arc_ok` carries
 *  and the lane fronts on. */
let arcOwnerId = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0405", checkout: CHECKOUT });
  const created = createArc(projectDir(), ARC_NAME, "at0405 fixture", scratch.cli);
  arcOwnerId = created.id;
  // One committed round: it is what gives the entry a round subject, a file
  // in its range diff, the `working` stage, and a range the pop-out can open.
  //
  // The worktree's *dirt* is deliberately not part of the fixture. The feed
  // resolves an arc's worktree as `<scanned project>/.tug/worktrees/<name>`
  // while the CLI resolves it against the repository's common dir, so a run
  // whose scanned project is itself a worktree reads every arc as having no
  // worktree — `worktree_dirty` would then be false for reasons that have
  // nothing to do with the lane. Rounds read the same from either tree.
  writeFileSync(join(created.worktree, ROUND_FILE), "at0405 round\n");
  // Two files under one directory, so the brief's areas have a CLUSTER to
  // fold. A round of a single root file clusters to that file and renders no
  // toggle at all, which left the fold's own affordances uncovered.
  mkdirSync(join(created.worktree, ROUND_AREA), { recursive: true });
  writeFileSync(join(created.worktree, ROUND_AREA, "first.txt"), "at0405 area one\n");
  writeFileSync(join(created.worktree, ROUND_AREA, "second.txt"), "at0405 area two\n");
  commitRound(projectDir(), ARC_NAME, ROUND_SUBJECT, scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
  seedScratchSession(projectDir(), HELD_SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // The whole repository goes — branch, worktree, and arc with it.
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

describe.skipIf(!SHOULD_RUN)("AT0405: the Changes shade's arc lane", () => {
  test(
    "an arc another live session holds is no row in this shade, and still one on the Arcs card",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0405-changes-arc-lane-held",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace, so its arc reaches the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: HELD_SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        // The resumed transcript's one committed turn, on screen — typing into
        // the composer before the card reaches its resting state races the
        // resume's own repaint.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8000 },
        );

        // A second live session in this instance's ledger, and the arc is
        // mated to IT rather than to this card's. `bound_session` is computed
        // from these rows, so this is the real condition rather than a
        // client-side pretence — a `bind_arc_ok` broadcast could not produce
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
              arc_id: arcOwnerId,
              arc_name: ARC_NAME,
            },
          ],
        });

        // The Arcs card is the every-arc surface, and its row's worker atom is
        // the positive signal that the seeded binding reached the aggregate.
        // Asserting the lane's absence before this would pass on a snapshot
        // that simply has not recomposed yet.
        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector('${ARCS_ROW} [data-slot="tug-arc-lifecycle-worker"]') !== null`,
          { timeoutMs: 30000 },
        );

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
        await settle(1500);

        // No row, and no `unbound` label over an empty group ([D173]). An arc
        // somebody else is working has nothing this card can do to it — the
        // one destructive gesture is withheld, a join lands work this card
        // never touched, a bind would co-bind onto a session mid-run — and its
        // room is the card working it, one click away on the Arcs card. A row
        // here was a weaker face for that room.
        const held = await app.evalJS<{
          lanes: number;
          rows: number;
          restLabels: number;
          arcsRows: number;
        }>(
          `(() => ({
             lanes: document.querySelectorAll(${JSON.stringify(LANE)}).length,
             rows: document.querySelectorAll(${JSON.stringify(ROW)}).length,
             restLabels: document.querySelectorAll(${JSON.stringify(REST_LABEL)}).length,
             arcsRows: document.querySelectorAll(${JSON.stringify(ARCS_ROW)}).length,
           }))()`,
        );
        // This scratch project's only arc is the held one, so the lane has
        // nothing left to draw — and a lane with nothing in it renders
        // nothing at all, not an empty element spending the shade body's gap
        // on air (at0340 pins the same contract for a project with no arcs).
        expect(held.lanes, "an emptied lane renders no element at all").toBe(0);
        expect(held.rows, "a held arc is not a row in this shade").toBe(0);
        expect(held.restLabels, "and no label stands over an empty group").toBe(0);
        expect(held.arcsRows, "while the Arcs card still lists it").toBe(1);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a real arc renders in arc grammar, folds when unbound, and fronts on bind",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0405-changes-arc-lane",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace (so its arc reaches the aggregate) and writes
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

        // ── Unbound: the lane exists, and the arc is a visible row ────────
        // Nothing is fronted yet — the card is bound to no arc — but the row
        // is on screen with no gesture at all. An arc nobody is working is a
        // situation to look at, not a count to expand.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30000 },
        );
        // The count is of THIS fixture's row, not of the lane. An arc's refs
        // are repo-global, so any arc the developer has open is a row here
        // too — a total is a fact about whoever is running the suite.
        const unfrontedState = await app.evalJS<{ fronted: number; rows: number; restLabel: string }>(
          `(() => ({
             fronted: document.querySelectorAll(${JSON.stringify(FRONTED_LABEL)}).length,
             rows: document.querySelectorAll(${JSON.stringify(ROW)}).length,
             restLabel: (document.querySelector(${JSON.stringify(REST_LABEL)})?.textContent ?? "").trim(),
           }))()`,
        );
        expect(unfrontedState.fronted).toBe(0);
        expect(unfrontedState.rows).toBe(1);
        // The group is named for what its rows are, in the grammar of the
        // orphaned file bucket: a name and the reason the row is here, and no
        // count — the rows are the count ([D173]).
        expect(unfrontedState.restLabel, "the rest group is the unbound arcs").toContain("unbound");
        expect(unfrontedState.restLabel).toContain("no session is working these");

        // The fold is gone, not merely unused — nothing anywhere renders it.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('[data-slot="session-changes-arc-lane-fold"]').length`,
          ),
          "the other-arcs fold no longer exists",
        ).toBe(0);

        // The rare verbs are behind the `⋯` and nowhere else: standing on the
        // row they read as peers of the acts a reader performs constantly.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(ROW_MENU_OPENER)}).length`,
          ),
          "the row carries one opener for its rare verbs",
        ).toBe(1);
        // Discard reaches an unbound arc. No live session is mated to this one,
        // so it is nobody's to protect and this shade may clean it up — the
        // whole point of widening the gesture past the fronted row.
        const unbound = await readArcRowMenu(app, ROW);
        expect(unbound.discard.present, "an unbound arc offers Discard").toBe(true);
        expect(unbound.discard.disabled, "and nothing is blocking it").toBe(false);
        // The reason rides the label when there is one, so an available verb
        // is the bare word ([L31]).
        expect(unbound.discard.label.trim(), "an available verb is the bare word").toBe(
          "Discard",
        );

        // ── The row reads in arc grammar ─────────────────────────────────
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
             const track = row.querySelector('[data-slot="tug-arc-track"]');
             const noteEl = row.querySelector('[data-slot="tug-arc-lifecycle-note"]');
             return {
               badge: (row.querySelector('[data-slot="tug-arc-lifecycle-name"]')?.textContent ?? "").trim(),
               phase: track?.getAttribute("data-phase") ?? null,
               note: (noteEl?.textContent ?? "").trim(),
               popOuts: row.querySelectorAll('[data-testid="tug-changes-list-diff-popout"]').length,
               claimish: lane.querySelectorAll(
                 '[data-testid^="tug-changes-list-claim"], [data-testid^="tug-changes-list-disclaim"], .tug-changes-list-claim, .tug-changes-list-disclaim',
               ).length,
             };
           })()`,
        );
        // The name wears its caret and no chip: `ArcSigil`, the same component
        // a bound session's identity atom composes. `textContent`, not
        // `innerText` — the run is an inline-flex of two spans, which
        // blockifies them and would put a line break between the sigil and
        // the name it belongs to.
        expect(row.badge).toBe(`^${ARC_NAME}`);
        // Where the arc stands in its life, as the strip's own last cell.
        // One committed round, no plan and a clean worktree derives `ready`:
        // with no declared selection to finish, a landed round is the whole of
        // the intent, and the server arms the join from it ([D147]) — so the
        // track stands at `join`, the phase every arming stage reads as. With
        // no step open the line is that phase's clause and nothing more.
        expect(row.phase).toBe("join");
        // The join phase reads `Finished`: the work is over and the join is
        // what is left, which the register one line below is what says ([B01]).
        expect(row.note).toBe("Finished");
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
        tugtool(
          ["draft", "set", "--owner", `arc:${ARC_NAME}`, "--message", DRAFT_MESSAGE, "--json"],
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
          // server's call, not the fixture's: an arc the join has armed
          // shows what the join would land (`lands as`), and one it has not
          // shows the draft plainly. This arc is join-ready — one round, no
          // plan, a clean worktree — so the arc arms it unbidden ([D147]) and
          // `lands as` is what a reader sees. Waiting on the plain slot waited
          // for a grammar that could not appear. The words are the subject's:
          // the brief fronts the message's first line as its heading and
          // folds the rest, so the heading is where a draft's words surface.
          await app.waitForCondition<boolean>(
            `(() => {
               const row = document.querySelector(${JSON.stringify(ROW)});
               const subject = row?.querySelector('[data-slot="session-changes-arc-brief-subject"]');
               return (subject?.textContent ?? "").includes("at0405 join draft");
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
                 phase: row.querySelector('[data-slot="tug-arc-track"]')?.getAttribute("data-phase") ?? null,
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
               landsAs: text('[data-slot="session-changes-arc-lands-as"]'),
               plainDraft: text('[data-slot="session-changes-arc-draft"]'),
               provenance: row.querySelectorAll('[data-slot="session-changes-arc-lands-as-note"]').length,
               files: (row.querySelector('[data-slot="session-changes-arc-files"]')?.textContent ?? "").trim(),
               subjects: (row.querySelector('[data-slot="session-changes-arc-subjects"]')?.textContent ?? "").trim(),
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

        // ── A changed file is the receipt's own row ───────────────────────
        // Not a lookalike: `ChangesFileRow` itself, mounted through
        // `ArcRangeFileRow`, so the fold's rows and a commit receipt's rows
        // cannot drift apart. A root-level file is a cluster of one and
        // renders directly.
        const shape = await app.evalJS<{
          blocks: number;
          roundFile: boolean;
          area: string | null;
          areaIsRow: boolean;
        }>(
          `(() => {
             const files = document.querySelector(${JSON.stringify(FILES)});
             const area = files.querySelector('[data-slot="session-changes-arc-cluster"][data-dir$="${ROUND_AREA}"]');
             return {
               blocks: files.querySelectorAll(".tug-changes-list-file-block").length,
               roundFile: files.querySelector('.tug-changes-list-file-block[data-path="${ROUND_FILE}"]') !== null,
               area: area === null ? null : area.getAttribute("data-expanded"),
               areaIsRow: area !== null && area.querySelector(".arc-fold-row") !== null,
             };
           })()`,
        );
        note(`at0405 file shape: ${JSON.stringify(shape)}`);
        expect(shape.roundFile, "a changed file is a receipt file block").toBe(true);
        expect(shape.area, "an area starts folded").toBe("false");
        expect(shape.areaIsRow, "and its head is the fold's own row").toBe(true);

        // And the head's own fold cue turns it — the directory row is a fold,
        // not a label with a chevron drawn beside it.
        const AREA = `${FILES} [data-slot="session-changes-arc-cluster"][data-dir$="${ROUND_AREA}"]`;
        await app.nativeClickAtElement(`${AREA} .arc-fold-row`);
        await app.waitForCondition<boolean>(
          `document.querySelector('${AREA}')?.getAttribute("data-expanded") === "true"`,
          { timeoutMs: 8000 },
        );
        await app.nativeClickAtElement(`${AREA} .arc-fold-row`);
        await app.waitForCondition<boolean>(
          `document.querySelector('${AREA}')?.getAttribute("data-expanded") === "false"`,
          { timeoutMs: 8000 },
        );

        // Expanding one mounts THAT file's diff and no other — the pathspec
        // this fold's pop-outs rest on, proven at the row that uses it.
        await app.nativeClickAtElement(
          `${FILES} .tug-changes-list-file-block[data-path="${ROUND_FILE}"] .tug-changes-list-row-hit`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('${FILES} .tug-changes-list-file-block[data-path="${ROUND_FILE}"] [data-slot="diff-body"]') !== null`,
          { timeoutMs: 20000 },
        );
        const scoped = await app.evalJS<{ headers: string[] }>(
          `(() => {
             const block = document.querySelector('${FILES} .tug-changes-list-file-block[data-path="${ROUND_FILE}"]');
             return {
               headers: Array.from(block.querySelectorAll("[data-slot=\\"diff-body\\"]")).map(
                 (body) => (body.textContent ?? "").slice(0, 400),
               ),
             };
           })()`,
        );
        note(`at0405 scoped diff: ${JSON.stringify(scoped).slice(0, 300)}`);
        expect(scoped.headers.length, "the expand mounted one diff body").toBe(1);
        expect(
          scoped.headers[0],
          "and it is this file's, not the whole range's",
        ).not.toContain(ROUND_AREA);

        // ── The totals row folds the whole list, and stays ────────────────
        await app.nativeClickAtElement(
          `${FILES} [data-slot="session-changes-arc-totals"]`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${FILES} .tug-changes-list-file-block').length === 0`,
          { timeoutMs: 8000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('${FILES} [data-slot="session-changes-arc-totals"]') !== null`,
          ),
          "the totals row survives its own fold",
        ).toBe(true);
        // And back, so the rest of the file reads the list it expects.
        await app.nativeClickAtElement(
          `${FILES} [data-slot="session-changes-arc-totals"]`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${FILES} .tug-changes-list-file-block').length > 0`,
          { timeoutMs: 8000 },
        );

        // ── The air: rows and eyebrows, and nothing else ──────────────────
        // One row height for every row the fold draws, two type sizes for
        // everything the fold itself authors, and no gap between the sections
        // — the three facts that make the fold read as one list rather than
        // as three strips that happen to be stacked.
        const air = await app.evalJS<{
          gap: string;
          heights: number[];
          sizes: number[];
          xs: number;
          sm: number;
        }>(
          `(() => {
             const detail = document.querySelector(${JSON.stringify(DETAIL)});
             // The two sizes are read from the theme rather than written down:
             // a probe resolving each token is what the assertion compares
             // against, so retuning a token retunes the test with it.
             const probe = document.createElement("span");
             probe.style.position = "absolute";
             probe.style.visibility = "hidden";
             detail.appendChild(probe);
             probe.style.fontSize = "var(--tug-font-size-xs)";
             const xs = parseFloat(getComputedStyle(probe).fontSize);
             probe.style.fontSize = "var(--tug-font-size-sm)";
             const sm = parseFloat(getComputedStyle(probe).fontSize);
             probe.remove();

             const foreign = ${JSON.stringify(FOREIGN_TYPE_SCALES)}.join(",");
             const sizes = new Set();
             for (const el of detail.querySelectorAll("*")) {
               if (el.closest(foreign) !== null) continue;
               // Only elements that actually SET type on their own text: an
               // ancestor's size is asserted at the descendant that shows it.
               let own = false;
               for (const node of el.childNodes) {
                 if (node.nodeType === 3 && node.textContent.trim() !== "") own = true;
               }
               if (!own) continue;
               sizes.add(parseFloat(getComputedStyle(el).fontSize));
             }

             const style = getComputedStyle(detail);
             return {
               gap: style.rowGap,
               heights: [...new Set(
                 // A row inside a closed fold is display:none and has no
                 // height to be equal to; the question is about the rows a
                 // reader can see.
                 [...detail.querySelectorAll(".tug-list-row")]
                   .filter((r) => r.offsetParent !== null)
                   .map((r) => Math.round(r.getBoundingClientRect().height)),
               )],
               sizes: [...sizes].sort((a, b) => a - b),
               xs,
               sm,
             };
           })()`,
        );
        note(`at0405 air: ${JSON.stringify(air)}`);
        // A `gap` the stylesheet does not set computes as `normal` on a flex
        // box; either reading is the same fact — the sections are flush and
        // their eyebrows are what separates them.
        expect(
          air.gap === "normal" || parseFloat(air.gap) === 0,
          "the fold has no inter-section gap",
        ).toBe(true);
        expect(air.heights, "every fold row reports one height").toHaveLength(1);
        expect(air.sizes, "and the fold's own text has two sizes").toEqual([
          air.xs,
          air.sm,
        ]);

        // ── Bind: the arc fronts, expanded, under its own label ───────────
        await app.dispatchControlAction("bind_arc_ok", {
          tug_session_id: SID,
          arc_id: arcOwnerId,
          arc_name: ARC_NAME,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FRONTED_LABEL)}) !== null`,
          { timeoutMs: 8000 },
        );
        const fronted = await app.evalJS<{ first: string | null; expanded: string | null }>(
          `(() => {
             const rows = document.querySelectorAll(${JSON.stringify(`${LANE} [data-slot="session-changes-arc-row"]`)});
             const first = rows[0] ?? null;
             return {
               first: first === null ? null : first.getAttribute("data-arc"),
               expanded: first === null ? null : first.getAttribute("data-expanded"),
             };
           })()`,
        );
        expect(fronted.first).toBe(ARC_NAME);
        expect(fronted.expanded).toBe("true");

        // ── The line centres its whole run ────────────────────────────────
        // Line 1 anchors an identity to each edge — the arc atom left, the
        // worker right, a hairline between. Line 2 answers it from the middle:
        // the track and the reading it explains — glyph, fraction, word,
        // facts — are one unit, centred together, so the strip travels along
        // the row as the words beside it change width.
        //
        // Measured as the air on either side of the run rather than against
        // constants, so the shade's width, the row's density and the atom's
        // padding can all move without this becoming a lie. A pixel of
        // tolerance: an odd width has to round somewhere.
        const stack = await app.evalJS<{
          lead: number;
          tail: number;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             const line = row.querySelector('[data-slot="tug-arc-lifecycle-line"]');
             const box = line.getBoundingClientRect();
             const track = line.querySelector('[data-slot="tug-arc-track"]').getBoundingClientRect();
             const read = line.querySelector('[data-slot="tug-arc-lifecycle-reading"]').getBoundingClientRect();
             const R = (n) => Math.round(n * 10) / 10;
             return {
               lead: R(track.left - box.left),
               tail: R(box.right - read.right),
             };
           })()`,
        );
        note("at0405 stack", JSON.stringify(stack));
        expect(
          Math.abs(stack.lead - stack.tail),
          "the run — track then reading — is centred in the line",
        ).toBeLessThanOrEqual(1);
        expect(
          stack.lead,
          "and it is a centred run, not a line filled edge to edge",
        ).toBeGreaterThan(1);

        // ── The complement rule ───────────────────────────────────────────
        // Unbind on the fronted row, Bind on none of it — a menu carrying both
        // at once would say the card can take on and put down the same arc.
        const affordances = await readArcRowMenu(app, ROW);
        expect(affordances.unbind.present).toBe(true);
        expect(affordances.bind.present).toBe(false);

        // ── Unbind: the real `unbind_arc` round trip ─────────────────────
        // The fronting moves on the `unbind_arc_ok` broadcast, never on the
        // press — nothing here writes the binding store optimistically, so
        // this assertion is about the round trip.
        await pressArcRowMenuItem(app, ROW, "unbind-arc");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FRONTED_LABEL)}) === null`,
          { timeoutMs: 15000 },
        );

        // ── Bind: and back again, the same way ────────────────────────────
        // The row stays on screen when it stops being fronted — it moves into
        // the rest group, which hides nothing — so its menu is reachable
        // without a fold click first.
        await pressArcRowMenuItem(app, ROW, "bind-arc");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FRONTED_LABEL)}) !== null`,
          { timeoutMs: 15000 },
        );
        expect(
          await app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(`${LANE} [data-slot="session-changes-arc-row"]`)})?.getAttribute("data-arc") ?? null`,
          ),
        ).toBe(ARC_NAME);

        // ── A ready arc says so in the Arcs card's own line ────────────────
        // This arc's join is armed — the `lands as` grammar above is what says
        // so — and on the Arcs card that reading is two lines rather than
        // three: the lifecycle line carries the whole sentence, naming the
        // base, with a settled dot where the phase glyph stands, and the
        // register band under it is not drawn at all ([P08]). The band's job
        // was to say a thing the line above it could say itself.
        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ARCS_ROW)}) !== null`,
          { timeoutMs: 30000 },
        );
        await app.waitForCondition<boolean>(
          `(document.querySelector('${ARCS_ROW} [data-slot="tug-arc-lifecycle-note"]')?.textContent ?? "").trim() === "Ready to join to main"`,
          { timeoutMs: 30000 },
        );
        const readyRow = await app.evalJS<{
          note: string;
          registers: number;
          phaseMarks: number;
          overrides: number;
          dots: number;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ARCS_ROW)});
             const slot = row.querySelector(".tug-arc-lifecycle-mark-slot");
             return {
               note: (row.querySelector('[data-slot="tug-arc-lifecycle-note"]')?.textContent ?? "").trim(),
               registers: row.querySelectorAll('[data-slot="arc-join-register"]').length,
               phaseMarks: row.querySelectorAll('[data-slot="tug-arc-phase-mark"]').length,
               overrides: slot === null ? 0 : 1,
               dots: slot === null ? 0 : slot.querySelectorAll('[data-slot="tug-progress-indicator"]').length,
             };
           })()`,
        );
        note(`at0405 ready row: ${JSON.stringify(readyRow)}`);
        expect(readyRow.note, "the line carries the whole sentence, base and all").toBe(
          "Ready to join to main",
        );
        expect(readyRow.registers, "and no register band stands under it").toBe(0);
        expect(readyRow.overrides, "the host's own mark is seated").toBe(1);
        expect(readyRow.phaseMarks, "and the phase glyph yields to it").toBe(0);
        expect(readyRow.dots, "the mark is the settled indicator").toBe(1);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
