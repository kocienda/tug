/**
 * at0486-join-base-resolve.test.ts — a join blocked by uncommitted work on the
 * base, and the one control that clears it.
 *
 * ## What this pins
 *
 * A `base-dirt` blocker used to be one bit standing for three different
 * situations, reported as a sentence naming acts no control in the app can
 * perform. It is now read: the overlap says what the base's uncommitted bytes
 * ARE, and each case gets the reading its facts earn. Two of the three are
 * driveable end to end from the real app against a real arc, and both are
 * here.
 *
 * **A base copy the arc already carries is not a blocker.** The fixture writes
 * onto the base, uncommitted, exactly the bytes the arc committed. The shade
 * shows no `base-dirt` refusal at all, because dropping such a copy destroys
 * nothing — those bytes are on the arc branch — so the join drops it and
 * lands the same content rather than refusing to land bytes on the grounds
 * that they are already there.
 *
 * **A divergent copy of the user's own is one Resolve, and the press is
 * driven.** The fixture then
 * writes different bytes to the same path. The refusal is stated once, on the
 * row's own register line; the report under it does not say it a second time,
 * and carries instead what that line cannot — the sentence saying what Resolve
 * will do, and `Resolve` itself, live because the server said it may be. The
 * remedy is in the sentence, never in the button, and the retired advice
 * ("stash") appears nowhere. The sentence is a **fact sheet**: the count, the
 * base, and that the way back is on this surface — checkable, because the
 * blocker's files are named right above it.
 *
 * Then the test presses it, and holds the app to the whole of the outcome:
 * the `base-dirt` refusal goes away, the running line under the row goes with
 * it, the fold's commit is on the base with the subject the server writes,
 * and the shared path is no longer dirty. That is the seam this file exists
 * for — the fold has always worked, and what it could not do was say so on
 * screen.
 *
 * **And a press's outcome outlives the press.** The receipt naming the fold's
 * commit is read off the arc's entry, out of the op log — so the test reloads
 * the whole app and finds it still there, which is the difference between a
 * report and something you had to be watching for. Its `Undo` is then pressed
 * and the base goes back to the exact tip recorded before the fold, with the
 * edit uncommitted again and the blocker returned. A control that commits
 * somebody's work in progress has to carry the way back, or the report is a
 * notification rather than a remedy.
 *
 * The third case — an edit another *live* session holds, where the same frame
 * renders with the same live Resolve and a sentence naming whose work the
 * fold takes — is not driven here. Seeding a second live session that owns a
 * base path is a fixture about attribution rather than about this control,
 * and both halves are already pinned in `tugarc-core`:
 * `a_foreign_hand_on_the_overlap_names_its_holder` for the sentence and the
 * remedy, and `resolve_base_folds_another_sessions_edit_and_names_it` for
 * what the press does with it.
 *
 * ## Why the shade rather than the CLI
 *
 * The CLI path has its own tests. What only the real app can show is that the
 * blocker the server composes reaches the surface as one statement of what is
 * wrong and one act that clears it — said once each — that the control is live
 * when the server says it may be, and that pressing it clears the reading the
 * user was looking at.
 *
 * @covers tugrust/crates/tugarc-core/src/ops.rs
 * @covers tugrust/crates/tugarc-core/src/oplog.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-join.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-fold-row.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-fold.css
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugdeck/src/lib/arc-join-register.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindArc,
  commitRound,
  createArc,
  gitRetry,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000486";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;

const ARC_NAME = "at0486-resolve";
const ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC_NAME}"]`;
const ROW_FOLD = `${ROW} [data-slot="session-changes-arc-fold"]`;
const BLOCKERS = `${SHEET} [data-slot="session-changes-arc-join-blockers"]`;
const BASE_DIRT = `${BLOCKERS} [data-blocker="base-dirt"]`;
const RESOLVE = `${BASE_DIRT} [data-slot="session-changes-arc-join-resolve-base"]`;
/** The row's own line — where the refusal is stated, once. */
const REGISTER = `${ROW} [data-slot="arc-join-register"]`;
/** The overlay a press raises, and the thing that must not outlive the act. */
const RUNNING = `${ROW} [data-slot="session-changes-arc-join-running"]`;
/** The blocker's own files, named above the sentence that counts them. */
const PATHS = `${BASE_DIRT} [data-slot="session-changes-arc-join-paths"]`;
/** The fold's durable receipt, read off the arc's entry rather than a frame. */
const RECEIPT = `${ROW} [data-slot="session-changes-arc-join-resolve-receipt"]`;
/** The one act on the report — the way back from a fold. */
const UNDO = `${RECEIPT} [data-slot="session-changes-arc-join-undo-resolve-base"]`;
/** The per-path lane a fold in flight shows while it runs. */
const FOLDING = `${ROW} [data-slot="session-changes-arc-join-folding"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/** The path both sides touch, and the bytes the arc lands on it. */
const SHARED = "at0486-shared.txt";
const ARC_BYTES = "seed\nthe arc's own line\n";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0486", checkout: CHECKOUT });
  writeFileSync(join(projectDir(), SHARED), "seed\n");
  // Committed, so the base starts CLEAN. Case A's claim is that a blocker
  // never appears over an identical copy, and a base that begins dirty would
  // let a stale refusal stand in for one.
  gitRetry(projectDir(), "add", SHARED);
  gitRetry(projectDir(), "commit", "-m", "at0486: the shared file both sides touch");
  const created = createArc(projectDir(), ARC_NAME, "at0486 fixture", scratch.cli);
  // One round, changing the shared path — which is what makes any base-side
  // edit to it an *overlap* rather than disjoint dirt the join never touches.
  writeFileSync(join(created.worktree, SHARED), ARC_BYTES);
  commitRound(projectDir(), ARC_NAME, "at0486(round): the arc changes the shared file", scratch.cli);
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
        size: { width: 900, height: 700 },
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

describe.skipIf(!SHOULD_RUN)("at0486: a blocked join reads what is wrong and offers one Resolve", () => {
  test(
    "an identical base copy never blocks; a divergent one clears with Resolve",
    async () => {
      // The app's own data dir, redirected to the fixture's — the same launch
      // `at0405` makes. A resolve writes an op-log record so `arc undo` can
      // reverse it, and `refuse_unredirected_temp_repo` correctly refuses to
      // write a scratch repo's arc state into the live data directory in a
      // debug build, which is every app-test build. That refusal was on the
      // app's path and this test simply never set the variable; the harness
      // forwards every `TUG*` through `open --env` and tugcast inherits the
      // app's full environment, so one line here is the whole of it.
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0486-join-base-resolve",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.spawnSessionResume("A", {
          tugSessionId: SID,
          projectDir: projectDir(),
        });
        // The toggle is chain-routed, so something inside the card has to be
        // first responder before it can reach the card's own handler.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROMPT_INPUT)}) !== null`,
          { timeoutMs: 40_000 },
        );
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.dispatchControlAction("toggle-changes-view");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 40_000 },
        );
        // The join face lives in the fronted row's fold: it is the card's own
        // arc that carries a landing, and the fold is where the report goes
        // ([D143]). Bind, then open it.
        bindArc(projectDir(), ARC_NAME, SID, scratch?.cli ?? {});
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 20_000 },
        );
        for (let i = 0; i < 6; i++) {
          const open = await app.evalJS<boolean>(
            `document.querySelector('${ROW}[data-expanded="true"]') !== null`,
          );
          if (open) break;
          await app.nativeClickAtElement(ROW_FOLD);
          await new Promise((r) => setTimeout(r, 400));
        }
        await app.waitForCondition<boolean>(
          `document.querySelector('${ROW}[data-expanded="true"]') !== null`,
          { timeoutMs: 20_000 },
        );

        // ---------------------------------------------------------------
        // A · the base holds the arc's own bytes. Not a refusal.
        // ---------------------------------------------------------------
        writeFileSync(join(projectDir(), SHARED), ARC_BYTES);
        // The overlap is recomputed on the changeset feed's own schedule, and
        // the blockers are never cached — so the reading settles on its own.
        // Asserted by holding: a refusal that never appears is the claim.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
        );
        for (let i = 0; i < 12; i++) {
          const blocked = await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(BASE_DIRT)}) !== null`,
          );
          expect(blocked).toBe(false);
          await new Promise((r) => setTimeout(r, 250));
        }
        note("identical base copy: no base-dirt refusal over 3s of recomputes");

        // ---------------------------------------------------------------
        // B · the user's own divergent edit. One Resolve, and it is live.
        // ---------------------------------------------------------------
        writeFileSync(join(projectDir(), SHARED), "seed\nmy own separate edit\n");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BASE_DIRT)}) !== null`,
          { timeoutMs: 40_000 },
        );

        // The refusal is the register's line, and the register's alone.
        const line = await app.evalJS<string>(
          `document.querySelector(${JSON.stringify(REGISTER)})?.textContent ?? ""`,
        );
        expect(line).toContain(SHARED);
        // The sentence states the fact and names no act no control performs.
        expect(line).not.toContain("stash");
        // The report below it does not repeat that sentence.
        const echoed = await app.evalJS<number>(
          `document.querySelectorAll('${BASE_DIRT} .session-changes-arc-join-detail').length`,
        );
        expect(echoed).toBe(0);

        // The report is the app's dialog vocabulary, not a shape of its own.
        const dialogTitle = await app.evalJS<string>(
          `document.querySelector('${BASE_DIRT} [data-slot="tug-inline-dialog"] .tug-inline-dialog-title')?.textContent ?? ""`,
        );
        expect(dialogTitle).toBe("Base work in the way");

        const explain = await app.evalJS<string>(
          `document.querySelector('${BASE_DIRT} .session-changes-arc-join-act')?.textContent ?? ""`,
        );
        // The remedy is in the sentence, not in the button.
        expect(explain).toContain("Resolve");
        // And the sentence is a FACT SHEET ([P10]): how many files, which
        // base, and that the way back is on this surface rather than in a
        // command the reader would have to leave for.
        expect(explain).toContain("1 file");
        expect(explain).toContain("main");
        expect(explain).toContain("Undo here");
        expect(explain).not.toContain("tugtool");
        // The count is checkable because the files are named right above it.
        const paths = await app.evalJS<string>(
          `document.querySelector(${JSON.stringify(PATHS)})?.textContent ?? ""`,
        );
        expect(paths).toContain(SHARED);

        const label = await app.evalJS<string>(
          `document.querySelector(${JSON.stringify(RESOLVE)})?.textContent ?? ""`,
        );
        expect(label).toContain("Resolve");
        const disabled = await app.evalJS<boolean>(
          `document.querySelector(${JSON.stringify(RESOLVE)}).disabled`,
        );
        expect(disabled).toBe(false);

        note(
          "divergent base copy: the refusal once on the register, the act and a live Resolve below it",
        );

        // ---------------------------------------------------------------
        // C · press it. The fold ran; what this pins is that the app says so.
        // ---------------------------------------------------------------
        // Where the base stands before the act, so the undo below has
        // something to be checked against rather than merely "it moved".
        const preFoldHead = gitRetry(projectDir(), "rev-parse", "HEAD").trim();
        await app.nativeClickAtElement(RESOLVE);

        // While the fold runs, the register says what is running — and says it
        // once ([P07]). The window is small and a fast machine may never paint
        // it, so this polls briefly and moves on; what it does NOT tolerate is
        // the register reading `Reconciling` while the fold's own per-path
        // lane is on screen, which was the 2026-09-03 face exactly.
        let sawFolding = false;
        for (let i = 0; i < 20; i++) {
          const during = await app.evalJS<{ line: string; folding: boolean }>(
            `(() => ({
               line: document.querySelector(${JSON.stringify(REGISTER)})?.textContent ?? "",
               folding: document.querySelector(${JSON.stringify(FOLDING)}) !== null,
             }))()`,
          );
          if (during.folding) {
            sawFolding = true;
            expect(during.line).not.toContain("Reconciling");
          }
          if (during.line.includes("Committing base work")) {
            note(`register during the fold: ${during.line}`);
            sawFolding = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!sawFolding) {
          note("the fold finished before a paint — no folding face observed");
        }

        // The blocker going away IS the outcome — it is recomputed from the
        // base's bytes and never cached, so its absence is the fold having
        // happened rather than a client's opinion about it.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BASE_DIRT)}) === null`,
          { timeoutMs: 40_000 },
        );
        // And the overlay comes down with it. A spinner that outlives its own
        // act is the defect this round is named for: the outcome frame carried
        // no `arc`, so the deck dropped it, and nothing else could end the run.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RUNNING)}) === null`,
          { timeoutMs: 40_000 },
        );
        note("Resolve pressed: the base-dirt refusal and the running line both gone");

        // What it did in git, read from the repo rather than from the screen.
        const subject = gitRetry(projectDir(), "log", "-1", "--format=%s").trim();
        expect(subject).toBe(
          `Commit base work in progress to unblock the join of ${ARC_NAME}`,
        );
        const porcelain = gitRetry(projectDir(), "status", "--porcelain");
        expect(porcelain).not.toContain(SHARED);
        note(`fold commit on the base: ${subject}`);

        // ---------------------------------------------------------------
        // D · the receipt, and that it survives a reload.
        // ---------------------------------------------------------------
        // The receipt is read off the arc's entry, out of the op log ([P05]),
        // rather than out of the overlay that pressed — which is what makes
        // it survive a reload and reach a second deck. A commit made from
        // somebody's uncommitted work is not something to learn by having
        // been watching.
        const foldHead = gitRetry(projectDir(), "rev-parse", "HEAD").trim();
        const shortSha = foldHead.slice(0, 7);
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(RECEIPT)})?.textContent ?? "").includes(${JSON.stringify(shortSha)})`,
          { timeoutMs: 40_000 },
        );
        const receipt = await app.evalJS<string>(
          `document.querySelector(${JSON.stringify(RECEIPT)})?.textContent ?? ""`,
        );
        expect(receipt).toContain("1 file");
        note(`receipt: ${receipt}`);

        await app.appReload();
        // Test mode skips the boot-time tugbank read, so a reloaded WebView
        // comes up with no deck and no session — the same re-seed every
        // `appReload` test does. What is being tested across the reload is
        // the RECEIPT, which lives in the op log rather than in any of this.
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.spawnSessionResume("A", {
          tugSessionId: SID,
          projectDir: projectDir(),
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROMPT_INPUT)}) !== null`,
          { timeoutMs: 40_000 },
        );
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.dispatchControlAction("toggle-changes-view");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 40_000 },
        );
        for (let i = 0; i < 6; i++) {
          const open = await app.evalJS<boolean>(
            `document.querySelector('${ROW}[data-expanded="true"]') !== null`,
          );
          if (open) break;
          await app.nativeClickAtElement(ROW_FOLD);
          await new Promise((r) => setTimeout(r, 400));
        }
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(RECEIPT)})?.textContent ?? "").includes(${JSON.stringify(shortSha)})`,
          { timeoutMs: 40_000 },
        );
        note("receipt survives a reload — it is read from the op log, not the press");

        // ---------------------------------------------------------------
        // E · Undo. The work goes back exactly where it was.
        // ---------------------------------------------------------------
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(UNDO)}) !== null`,
          { timeoutMs: 20_000 },
        );
        // Live, and the assertion is the point rather than the setup. A
        // successful fold puts the base and the arc on divergent history,
        // which is exactly the collision the resolution ladder exists for —
        // so the pilot starts a ladder right after a fold, and the row reads
        // `Reconciling` with a run in flight. That run is not the fold's, and
        // an Undo greyed out through it is greyed out precisely when a reader
        // has just been told their work was committed and wants it back.
        const beforeUndo = await app.evalJS<{
          register: string;
          disabled: boolean;
        }>(
          `(() => ({
             register: document.querySelector(${JSON.stringify(REGISTER)})?.textContent ?? "(none)",
             disabled: document.querySelector(${JSON.stringify(UNDO)}).disabled,
           }))()`,
        );
        note(`before Undo: ${JSON.stringify(beforeUndo)}`);
        expect(beforeUndo.disabled).toBe(false);
        await app.nativeClickAtElement(UNDO);

        // The blocker coming BACK is the outcome, by the same argument its
        // going away was: it is recomputed from the base's bytes.
        // Report what the app and the repo say if it does not, so a failure
        // here names the refusal instead of only the timeout.
        for (let i = 0; i < 24; i++) {
          const back = await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(BASE_DIRT)}) !== null`,
          );
          if (back) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const afterUndo = await app.evalJS<{
          blocked: boolean;
          receipt: string;
          errors: string[];
        }>(
          `(() => ({
             blocked: document.querySelector(${JSON.stringify(BASE_DIRT)}) !== null,
             receipt: document.querySelector(${JSON.stringify(RECEIPT)})?.textContent ?? "(none)",
             errors: Array.from(document.querySelectorAll('${ROW} .session-changes-arc-join-detail')).map((n) => n.textContent ?? ""),
           }))()`,
        );
        note(
          `after Undo — blocked=${afterUndo.blocked} head=${gitRetry(projectDir(), "rev-parse", "--short", "HEAD").trim()} receipt=${afterUndo.receipt} errors=${JSON.stringify(afterUndo.errors)}`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BASE_DIRT)}) !== null`,
          { timeoutMs: 40_000 },
        );
        const undonePorcelain = gitRetry(projectDir(), "status", "--porcelain");
        expect(undonePorcelain).toContain(SHARED);
        expect(gitRetry(projectDir(), "rev-parse", "HEAD").trim()).toBe(preFoldHead);
        note("Undo pressed: the base is back at its pre-fold tip and the edit is uncommitted again");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
