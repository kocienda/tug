/**
 * at0418-join-outcomes.test.ts — the dash lane fronts the landing outcome and
 * the act that clears it.
 *
 * The lane used to say what a dash *is* (name · base · rounds · dirty) and
 * nothing about what landing it would do. This drives the face that answers
 * that question against real dashes and the server's own standing answer for
 * each: a dash with a round over a clean base reads clean, carries no control
 * at all, and states where landing happens; an interrupted teardown reads
 * blocked and names the resume as the act that clears it — while offering no
 * button for it, because the journal is durable and the teardown resumes
 * itself ([P08]); a dash with no rounds reads empty and asks the discard
 * question in words.
 *
 * The readiness sentence is load-bearing, not decoration. Nothing on the row
 * lands a dash, so a landable one that said only "clean" would leave the reader
 * at a dead end — the sentence naming ⌃⌘C and `/dash-join` is the whole of the
 * way forward from that state, which is why it is asserted word for word.
 *
 * ## Two fixture notes
 *
 * Every dash here lives in a scratch repository this file owns — a dash is for
 * implementing a plan, not for running a test — and the app opens it by
 * spawning a real session on it, which is what registers it as a workspace.
 *
 * The `landing` stage is faked by writing the join journal directly
 * ([#landing-fixture]) — crashing a real join mid-teardown is not reproducible
 * from a test, and the cause is not what is under test. Everything downstream
 * of the file is real: the derivation, the preflight, the feed, and the
 * affordance. The journal's state dir is keyed on the repo root `join_in`
 * resolves, which for a scratch repo outside any pinned universe is the repo
 * itself; `journalPath` mirrors that, and the preview above proves the key is
 * right by coming back with the blocker.
 *
 * The release half is the phase's one end-to-end landing: a purpose-created
 * dash is discarded from the row, and the server-formatted receipt it leaves
 * is read back after Maker ▸ Reload. A *join* is not driven here — at0436 and
 * at0441 press one on their own scratch repos — so the discard is where the
 * card → server → shell ledger → reload path is walked in this file.
 *
 * The discard is reached through the row's `⋯` menu, which is where the rare
 * verbs moved ([P08]). It confirms through the lane's `TugConfirmPopover`, and both halves
 * are driven: Cancel first — proving the arming click destroys nothing and
 * sends no release — then Confirm. The confirm's message is a fact sheet
 * naming the counts and the hand-back, not a list of round subjects: those stay
 * on the row, which is asserted here so the deletion of the block that used to
 * duplicate them is visibly a deduplication.
 *
 * `base-dirt` is deliberately **not** driven here — the blocker is already
 * pinned where it is cheap and exact: the intersection in `tugdash-core`'s
 * `preview_reports_intersecting_base_dirt_and_names_the_paths` and the act
 * text in `session-changes-dash-join.test.ts`.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-join.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/components/tugways/tug-confirm-popover.tsx
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/use-landing-receipts.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
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
  type DashScratchRepo,
} from "./dash-fixture";
import { pressDashRowMenuItem } from "./dash-row-menu-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** UUID-shaped so the release half's real `claude --resume` accepts it. */
const SID = "a7c0d1ea-0000-4000-8000-000000000418";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-toolbar .tug-prompt-entry-route-group`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
const projectDir = (): string => scratch?.repo ?? "";

const DASH_WORK = "at0418-work";
const DASH_EMPTY = "at0418-empty";
/** Its own dash: a release destroys one, so it can never be another case's. */
const DASH_RELEASE = "at0418-release";
const RELEASE_SUBJECT = "at0418(round): the subject the discard names";

const DISCARD_RECEIPT = `${CARD} [data-slot="discard-receipt-block"]`;
/** The lane's one discard confirm. It portals out of the card's subtree, so it
 *  is addressed from the document root rather than under `CARD`. */
const CONFIRM_POPOVER = '[data-slot="tug-confirm-popover"]';

let fixtureDir = "";

const row = (dash: string): string =>
  `${LANE} [data-slot="session-changes-dash-row"][data-dash="${dash}"]`;
const landing = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-dash-join"]`;
/** The block's third line — the join register, which fronts the state's word. */
const registerOf = (dash: string): string =>
  `${row(dash)} [data-slot="dash-join-register"]`;

/** Owner keys, captured from `dash create` — what `bind_dash_ok` carries. */
let workId = "";
let emptyId = "";
let releaseId = "";

/**
 * The join journal's home, mirrored from the Rust.
 *
 * Two halves, and both matter. The *root* is the scratch repo's own data root
 * — `base_data_dir()` is `$TUG_DATA_DIR/Tug`, and this fixture redirects
 * `TUG_DATA_DIR` — so the journal is written where the app under test looks
 * and nowhere near the developer's live state. The *slug* is the repo path
 * with every separator turned to `-`, which is `project_slug` in
 * `tugutil-core/src/paths.rs`; the scratch repo is realpath'd at creation, so
 * it is already the canonical spelling that function would compute. Read
 * `project_state_dir` / `join_journal_path` in `tugdash-core/src/ops.rs`
 * before changing either half.
 */
function journalPath(dash: string): string {
  const slug = projectDir().replaceAll("/", "-");
  return join(
    scratch?.dataRoot ?? "",
    "Tug",
    "projects",
    slug,
    `join-journal-${dash}.json`,
  );
}

function writeJournal(dash: string): void {
  const path = journalPath(dash);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        name: dash,
        base_branch: "main",
        strategy: "squash",
        commit_hash: "abc1234",
        phase: "WorktreeRemoved",
      },
      null,
      2,
    ),
  );
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0418", checkout: CHECKOUT });
  const work = createDash(projectDir(), DASH_WORK, "at0418 fixture (a round)", scratch.cli);
  workId = work.id;
  writeFileSync(join(work.worktree, "at0418-work.txt"), "at0418\n");
  commitRound(projectDir(), DASH_WORK, "at0418(round): something to land", scratch.cli);
  // No round at all — the empty outcome is the absence of one.
  emptyId = createDash(projectDir(), DASH_EMPTY, "at0418 fixture (no rounds)", scratch.cli).id;

  const doomed = createDash(
    projectDir(),
    DASH_RELEASE,
    "at0418 fixture (to discard)",
    scratch.cli,
  );
  releaseId = doomed.id;
  writeFileSync(join(doomed.worktree, "at0418-release.txt"), "at0418\n");
  commitRound(projectDir(), DASH_RELEASE, RELEASE_SUBJECT, scratch.cli);

  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // One directory removal takes all three dashes, their worktrees, and the
  // journal with them — there is nothing to discard one at a time, and nothing
  // left behind when this file dies before its teardown runs.
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
 * Click `target` until `expected` matches, re-aiming between attempts. The
 * lane sits at the bottom of an auto-sizing shade fed by an aggregate that
 * recomposes on its own schedule, so a click's coordinates can go stale
 * between the aim and the press. A missed click changes nothing, so a retry is
 * a retry and never a double toggle.
 */
async function clickUntil(
  app: App,
  target: string,
  expected: string,
  attempts = 5,
): Promise<void> {
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
      await app.waitForCondition<boolean>(
        `document.querySelector(${JSON.stringify(expected)}) !== null`,
        { timeoutMs: 3000 },
      );
      return;
    } catch {
      note(`at0418 click on ${target} did not land (attempt ${i + 1})`);
    }
  }
  throw new Error(`at0418: ${expected} never appeared after clicking ${target}`);
}

/**
 * Raise the Changes shade and wait for the dash lane under it. `/commit` is
 * the gesture that puts it up; leaving a landing mode takes it back down,
 * which is why this is a helper rather than a preamble.
 */
async function raiseShade(app: App): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType("/commit");
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
    { timeoutMs: 8000 },
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(LANE)}) !== null`,
    { timeoutMs: 40000 },
  );
}

/**
 * The fronted row's outcome once the feed has answered. Waits for any word
 * rather than for one expected one, so a wrong answer reports itself instead of
 * timing out on a selector.
 */
async function settledOutcome(app: App, dash: string): Promise<string> {
  const read = `(document.querySelector(${JSON.stringify(landing(dash))})?.getAttribute("data-outcome") ?? "")`;
  await app.waitForCondition<boolean>(
    `(() => { const o = ${read}; return o !== ""; })()`,
    { timeoutMs: 40000 },
  );
  const outcome = await app.evalJS<string>(read);
  const face = await app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(landing(dash))})?.textContent ?? "").trim()`,
  );
  note(`at0418 ${dash} outcome: ${outcome} — face: ${JSON.stringify(face)}`);
  return outcome;
}

/**
 * Whether the row claims a landable dash.
 *
 * The one place the row says so is its third line — the join register, whose
 * word is the state ([D142]). The face's standing readiness line is gone: a
 * refusal rides the control that refuses (the composer's ⬆, the ⋯ menu
 * item's label), so nothing on the row states a refusal about a press nobody
 * made — and nothing here must read as ready when the state is anything else.
 */
async function claimsReady(app: App, dash: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `(() => {
       const reg = document.querySelector(${JSON.stringify(registerOf(dash))});
       return reg !== null && reg.getAttribute("data-word") === "ready";
     })()`,
  );
}

/**
 * Return the composer to the prompt route.
 *
 * `/commit` raised the shade in **commit** mode, and in that mode the editor
 * is the commit message — a `/dash-join` typed into it is message text, not a
 * command, and ⌘Return submits the commit rather than switching modes. So a
 * slash command has to be typed from the prompt route, which is where every
 * one of them is read.
 */
async function returnToPrompt(app: App): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await settle();
  await app.nativeKey("Escape");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="prompt"][data-state="active"]`)}) !== null`,
    { timeoutMs: 8000 },
  );
}

/** Enter join mode on a dash by its named route, the way a user would. */
async function enterJoinMode(app: App, dash: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(`/dash-join ${dash}`);
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

describe.skipIf(!SHOULD_RUN)("AT0418: the dash lane's landing outcomes", () => {
  test(
    "clean states its route and offers no button, an interrupted teardown names its resume, and an empty dash asks to be released",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0418-join-outcomes",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace, so its dashes reach the aggregate — and the
        // discard's CONTROL frame resolves the calling session through the
        // live ledger row it writes.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await raiseShade(app);

        // ── Clean: a dash whose arc has not begun is two lines, and quiet ──
        await app.dispatchControlAction("bind_dash_ok", {
          tug_session_id: SID,
          dash_id: workId,
          dash_name: DASH_WORK,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${row(DASH_WORK)} [data-slot="tug-dash-meta-line"]`)}) !== null`,
          { timeoutMs: 20000 },
        );
        // Clean, and not yet joinable: every join rides a candidate the
        // project's own checks have judged ([P03]), and this dash was never
        // marked built — the arc has not begun. The design's answer is
        // REMOVAL, not a refusal ([D142]): no register line 3 (the arc has
        // nothing to say), no report in the fold (there is no evidence), and
        // no standing sentence about a press nobody made. The block is the
        // eyebrow and the metadata line, and nothing else stands.
        //
        // The joinable end of this arc is at0441's, which resolves a clean
        // dash and reaches a green verdict with no press.
        expect(await claimsReady(app, DASH_WORK)).toBe(false);
        const clean = await app.evalJS<{ register: number; face: number }>(
          `(() => ({
             register: document.querySelectorAll(${JSON.stringify(registerOf(DASH_WORK))}).length,
             face: document.querySelectorAll(${JSON.stringify(landing(DASH_WORK))}).length,
           }))()`,
        );
        expect(clean.register, "no join arc yet, so no register line").toBe(0);
        expect(clean.face, "no evidence yet, so no report section").toBe(0);

        // Joining still routes through the composer — the quiet block takes
        // nothing from the gesture. The route group is invariant, so the
        // Changes segment is what goes active; the Z5 button is what names
        // the landing as a join.
        await returnToPrompt(app);
        await enterJoinMode(app, DASH_WORK);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="changes"][data-state="active"]`)}) !== null`,
          { timeoutMs: 12000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="prompt"][data-state="active"]`)}) !== null`,
          { timeoutMs: 8000 },
        );

        // ── Interrupted teardown: blocked, named, and resumable ────────────
        // Leaving join mode took the shade down with it, so the journal is
        // written into the gap and the shade comes back up on state the server
        // recomputed while it was down.
        writeJournal(DASH_WORK);
        // The blocker and the `landing` stage both ride the aggregate — and
        // nothing about a file in the state dir wakes it.
        // Touching a project file is what asks for the recompose that carries
        // the new stage onto the entry.
        const nudge = join(projectDir(), "at0418-nudge.txt");
        writeFileSync(nudge, "at0418 recompose nudge\n");
        await raiseShade(app);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(landing(DASH_WORK))}) !== null`,
          { timeoutMs: 20000 },
        );
        expect(await settledOutcome(app, DASH_WORK)).toBe("blocked");
        const blocked = await app.evalJS<{ detail: string; act: string }>(
          `(() => {
             const li = document.querySelector(${JSON.stringify(`${landing(DASH_WORK)} li[data-blocker="stale-journal"]`)});
             return {
               detail: (li?.querySelector(".session-changes-dash-join-detail")?.textContent ?? "").trim(),
               act: (li?.querySelector(".session-changes-dash-join-act")?.textContent ?? "").trim(),
             };
           })()`,
        );
        // The server's own sentence, verbatim — the same bytes the execute
        // path would refuse with.
        expect(blocked.detail).toContain("is incomplete");
        expect(blocked.detail).toContain("tugutil dash join");
        expect(blocked.act).toBe("Resume the interrupted teardown");
        // Nothing claims this dash is ready, and the blocker's own detail and
        // act are the sentence — the face does not repeat a generic refusal
        // over the specific one already on screen.
        expect(await claimsReady(app, DASH_WORK)).toBe(false);

        // And it fronts no button to resume with. The journal is durable and an
        // interrupted teardown resumes itself, so a control for it was a press
        // that existed only because nothing did ([P08]) — the blocker's own act
        // sentence above is what the reader gets, and it is enough.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(`${row(DASH_WORK)} [data-slot="session-changes-dash-resume"]`)}).length`,
          ),
          "an interrupted teardown offers no resume button",
        ).toBe(0);
        note(`at0418 blocked ${DASH_WORK}: the act is stated, and nothing is offered`);
        rmSync(journalPath(DASH_WORK), { force: true });
        rmSync(nudge, { force: true });

        // ── Empty: the release question, in words, with no join ────────────
        await app.dispatchControlAction("bind_dash_ok", {
          tug_session_id: SID,
          dash_id: emptyId,
          dash_name: DASH_EMPTY,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(landing(DASH_EMPTY))}) !== null`,
          { timeoutMs: 20000 },
        );
        expect(await settledOutcome(app, DASH_EMPTY)).toBe("empty");
        const emptyFace = await app.evalJS<{ note: string; buttons: number }>(
          `(() => {
             const face = document.querySelector(${JSON.stringify(landing(DASH_EMPTY))});
             const note = face.querySelector('[data-slot="session-changes-dash-join-empty"]');
             return {
               note: (note?.textContent ?? "").trim(),
               buttons: note === null ? -1 : note.querySelectorAll("button").length,
             };
           })()`,
        );
        expect(emptyFace.note).toBe("Nothing to join — discard this dash.");
        // The line is prose; the act it names is the row's own affordance, not
        // a second button inside the sentence.
        expect(emptyFace.buttons).toBe(0);
        expect(await claimsReady(app, DASH_EMPTY)).toBe(false);

        // ── Release: confirm, then the receipt, then a reload ──────────────
        // Its own dash, because this case destroys the one it runs on.
        await app.dispatchControlAction("bind_dash_ok", {
          tug_session_id: SID,
          dash_id: releaseId,
          dash_name: DASH_RELEASE,
        });
        // The fronted row, expanded: its fold carries the rounds section even
        // while the report has nothing to say (clean, arc unbegun → no face).
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${row(DASH_RELEASE)} [data-slot="session-changes-dash-subjects"]`)}) !== null`,
          { timeoutMs: 20000 },
        );

        // The round subject lives on the row itself, not in the confirm. The
        // popover's message is one flat string and cannot carry a list — and it
        // does not need to, because the expanded row already lists them. This
        // assertion is here to prove the fact survived the block that used to
        // duplicate it.
        expect(
          await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(`${row(DASH_RELEASE)} [data-slot="session-changes-dash-subjects"]`)})?.textContent ?? "").trim()`,
          ),
          "the row still lists the round subject",
        ).toContain(RELEASE_SUBJECT);

        // Cancel first: the arming beat must not itself be destructive.
        await pressDashRowMenuItem(app, row(DASH_RELEASE), "request-discard-dash");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM_POPOVER)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.nativeClickAtElement(`${CONFIRM_POPOVER} [data-slot="tug-confirm-cancel"]`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM_POPOVER)}) === null`,
          { timeoutMs: 8000 },
        );
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(row(DASH_RELEASE))}).length`,
          ),
          "cancel destroys nothing",
        ).toBe(1);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(DISCARD_RECEIPT)}).length`,
          ),
          "cancel sends no release",
        ).toBe(0);

        // Arm it again and read the fact sheet: counts, and where the
        // worktree's uncommitted files go. The hand-back is the sentence that
        // makes this consent rather than a click.
        await pressDashRowMenuItem(app, row(DASH_RELEASE), "request-discard-dash");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM_POPOVER)}) !== null`,
          { timeoutMs: 8000 },
        );
        const preflight = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(`${CONFIRM_POPOVER} [data-slot="tug-confirm-message"]`)})?.textContent ?? "").trim()`,
        );
        note(`at0418 discard confirm: ${JSON.stringify(preflight)}`);
        expect(preflight).toContain(DASH_RELEASE);
        expect(preflight).toContain("Discards 1 round · 1 file");

        // Confirming destroys it: the row goes on the next recompose, and the
        // discard leaves the only record of what it took.
        await app.nativeClickAtElement(`${CONFIRM_POPOVER} [data-slot="tug-confirm-confirm"]`);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(DISCARD_RECEIPT)}).length === 1`,
          { timeoutMs: 40000 },
        );
        const receipt = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(DISCARD_RECEIPT)})?.textContent ?? "").trim()`,
        );
        note(`at0418 release receipt: ${JSON.stringify(receipt)}`);
        expect(receipt).toContain(DASH_RELEASE);
        expect(receipt).toContain(RELEASE_SUBJECT);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(row(DASH_RELEASE))}) === null`,
          { timeoutMs: 40000 },
        );

        // Maker ▸ Reload: the row comes back out of the shell ledger, through
        // the same parser, and must render the same bytes ([P06]).
        await app.appReload();
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(DISCARD_RECEIPT)}).length === 1`,
          { timeoutMs: 60000 },
        );
        expect(
          await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(DISCARD_RECEIPT)})?.textContent ?? "").trim()`,
          ),
          "the restored discard receipt renders the same bytes as the live one",
        ).toBe(receipt);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
