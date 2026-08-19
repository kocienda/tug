/**
 * at0418-join-outcomes.test.ts — the dash lane fronts the landing outcome and
 * the act that clears it.
 *
 * The lane used to say what a dash *is* (name · base · rounds · dirty) and
 * nothing about what landing it would do. This drives the face that answers
 * that question against real dashes and the server's own standing answer for
 * each: a dash with a round over a clean base reads clean, carries no control
 * at all, and states where landing happens; an interrupted teardown reads
 * blocked, names the resume as the act that clears it, and fronts the resume
 * itself; a dash with no rounds reads empty and asks the release question in
 * words.
 *
 * The readiness sentence is load-bearing, not decoration. Nothing on the row
 * lands a dash, so a landable one that said only "clean" would leave the reader
 * at a dead end — the sentence naming ⌃⌘C and `/dash-join` is the whole of the
 * way forward from that state, which is why it is asserted word for word.
 *
 * ## Two fixture notes
 *
 * The `landing` stage is faked by writing the join journal directly
 * ([#landing-fixture]) — crashing a real join mid-teardown is not reproducible
 * from a test, and the cause is not what is under test. Everything downstream
 * of the file is real: the derivation, the preflight, the feed, and the
 * affordance. The journal's state dir is keyed on whatever `join_in` resolves
 * as the repo root — the checkout under test when the run pins a repo universe,
 * the common dir's owner otherwise — which `universeRoot` mirrors; the preview
 * above proves the key is right by coming back with the blocker.
 *
 * The release half is the phase's one end-to-end landing: a purpose-created
 * dash is discarded from the row, and the server-formatted receipt it leaves
 * is read back after Maker ▸ Reload. A *join* cannot be driven this way — it
 * would squash a fixture onto the developer's own `main` — so the discard is
 * where the card → server → shell ledger → reload path is actually walked.
 *
 * The discard confirms through the lane's `TugConfirmPopover`, and both halves
 * are driven: Cancel first — proving the arming click destroys nothing and
 * sends no release — then Confirm. The confirm's message is a fact sheet
 * naming the counts and the hand-back, not a list of round subjects: those stay
 * on the row, which is asserted here so the deletion of the block that used to
 * duplicate them is visibly a deduplication.
 *
 * `base-dirt` is deliberately **not** driven here. Its dirt would have to land
 * in that same main checkout — the developer's live tree, mid-run — and the
 * blocker is already pinned where it is cheap and exact: the intersection in
 * `tugdash-core`'s `preview_reports_intersecting_base_dirt_and_names_the_paths`
 * and the act text in `session-changes-dash-join.test.ts`.
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
import { commitRound, createDash, discardDash, universeRoot } from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** UUID-shaped so the release half's real `claude --resume` accepts it. */
const SID = "a7c0d1ea-0000-4000-8000-000000000418";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-toolbar .tug-prompt-entry-route-group`;

const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));

const DASH_WORK = "at0418-work";
const DASH_EMPTY = "at0418-empty";
/** Its own dash: a release destroys one, so it can never be another case's. */
const DASH_RELEASE = "at0418-release";
const RELEASE_SUBJECT = "at0418(round): the subject the discard names";

const DISCARD_RECEIPT = `${CARD} [data-slot="discard-receipt-block"]`;
/** The lane's one discard confirm. It portals out of the card's subtree, so it
 *  is addressed from the document root rather than under `CARD`. */
const CONFIRM_POPOVER = '[data-slot="tug-confirm-popover"]';

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
const encodeProjectDir = (absDir: string): string =>
  absDir.replace(/[^A-Za-z0-9-]/g, "-");

let fixtureDir = "";

/** One clean Claude turn, so the reload's `claude --resume` has something to
 *  replay rather than falling back to the picker. */
function buildFixtureJsonl(cwd: string, sessionId: string): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const t0 = new Date(Date.now() - 2000).toISOString();
  const t1 = new Date(Date.now() - 1000).toISOString();
  return (
    [
      {
        ...base,
        parentUuid: null,
        type: "user",
        uuid: "00000000-0000-4000-8000-000000000d01",
        timestamp: t0,
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
      {
        ...base,
        parentUuid: "00000000-0000-4000-8000-000000000d01",
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000d02",
        timestamp: t1,
        message: {
          id: "msg-release-1",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "hi there" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 1200,
            output_tokens: 50,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 8000,
          },
        },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n"
  );
}

const row = (dash: string): string =>
  `${LANE} [data-slot="session-changes-dash-row"][data-dash="${dash}"]`;
const landing = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-dash-join"]`;

/** Owner keys, captured from `dash create` — what `bind_dash_ok` carries. */
let workId = "";
let emptyId = "";
let releaseId = "";

/**
 * The join journal's home. `join_in` resolves the repo root from the card's
 * project dir, and the state-dir slug is derived from whatever that resolution
 * returns — the pinned universe under `just app-test`, the common dir's owner
 * otherwise. `universeRoot` is the one mirror of that rule; read
 * `project_state_dir` / `join_journal_path` in `tugdash-core/src/ops.rs` and
 * `find_repo_root_from` in `tugutil-core/src/worktree.rs` before changing
 * either half of this.
 */
function journalPath(dash: string): string {
  const slug = universeRoot(PROJECT_DIR).replaceAll("/", "-");
  return join(
    homedir(),
    "Library/Application Support/Tug/projects",
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
  discardDash(PROJECT_DIR, DASH_WORK);
  discardDash(PROJECT_DIR, DASH_EMPTY);
  rmSync(journalPath(DASH_WORK), { force: true });
  const work = createDash(PROJECT_DIR, DASH_WORK, "at0418 fixture (a round)");
  workId = work.id;
  writeFileSync(join(work.worktree, "at0418-work.txt"), "at0418\n");
  commitRound(PROJECT_DIR, DASH_WORK, "at0418(round): something to land");
  // No round at all — the empty outcome is the absence of one.
  emptyId = createDash(PROJECT_DIR, DASH_EMPTY, "at0418 fixture (no rounds)").id;

  discardDash(PROJECT_DIR, DASH_RELEASE);
  const doomed = createDash(PROJECT_DIR, DASH_RELEASE, "at0418 fixture (to discard)");
  releaseId = doomed.id;
  writeFileSync(join(doomed.worktree, "at0418-release.txt"), "at0418\n");
  commitRound(PROJECT_DIR, DASH_RELEASE, RELEASE_SUBJECT);

  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(PROJECT_DIR));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${SID}.jsonl`), buildFixtureJsonl(PROJECT_DIR, SID));
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // The journal first: a dash with one left over is a dash the release verb
  // has to argue with.
  rmSync(journalPath(DASH_WORK), { force: true });
  discardDash(PROJECT_DIR, DASH_WORK);
  discardDash(PROJECT_DIR, DASH_EMPTY);
  // Already gone if the discard did its job; this is the path where it did not.
  discardDash(PROJECT_DIR, DASH_RELEASE);
  if (fixtureDir !== "") rmSync(join(fixtureDir, `${SID}.jsonl`), { force: true });
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
 * What the row says about landing.
 *
 * Landing is the composer's, so what the face owes the reader is a sentence:
 * `ready` is the state that names the route, and `line` is whatever the face
 * states about landing in any state.
 */
async function landingFace(
  app: App,
  dash: string,
): Promise<{ ready: boolean; line: string; refusals: string }> {
  return app.evalJS<{ ready: boolean; line: string; refusals: string }>(
    `(() => {
       const line = document.querySelector(${JSON.stringify(`${row(dash)} [data-slot="session-changes-dash-join-ready"]`)});
       const reasons = document.querySelector(${JSON.stringify(`${row(dash)} [data-slot="session-changes-dash-join-refusals"]`)});
       return {
         ready: line !== null && line.getAttribute("data-ready") === "true",
         line: line === null ? "" : (line.textContent ?? ""),
         refusals: reasons === null ? "" : (reasons.textContent ?? ""),
       };
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
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0418-join-outcomes",
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

        await raiseShade(app);

        // ── Clean: the fronted row reads the feed and offers the join ─────
        await app.dispatchControlAction("bind_dash_ok", {
          tug_session_id: SID,
          dash_id: workId,
          dash_name: DASH_WORK,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(landing(DASH_WORK))}) !== null`,
          { timeoutMs: 20000 },
        );
        expect(await settledOutcome(app, DASH_WORK)).toBe("clean");
        const clean = await landingFace(app, DASH_WORK);
        // A landable dash states that it is ready and names where landing
        // happens — the composer's ⬆ is what fires one.
        expect(clean.ready).toBe(true);
        expect(clean.line).toContain("Ready to join");
        expect(clean.line).toContain("/dash-join");
        // No blockers on a clean bill, and no release question either.
        const cleanFace = await app.evalJS<{ blockers: number; empty: number }>(
          `(() => {
             const face = document.querySelector(${JSON.stringify(landing(DASH_WORK))});
             return {
               blockers: face.querySelectorAll('[data-slot="session-changes-dash-join-blockers"] li').length,
               empty: face.querySelectorAll('[data-slot="session-changes-dash-join-empty"]').length,
             };
           })()`,
        );
        expect(cleanFace.blockers).toBe(0);
        expect(cleanFace.empty).toBe(0);

        // The route the readiness line named opens the join-message editor.
        // The route group is invariant, so the Changes segment is what goes
        // active; the Z5 button is what names the landing as a join.
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
        const nudge = join(PROJECT_DIR, "at0418-nudge.txt");
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
        const stuck = await landingFace(app, DASH_WORK);
        // Nothing claims this dash is ready, and the blocker's own detail and
        // act are the sentence — the face does not repeat a generic refusal
        // over the specific one already on screen.
        expect(stuck.ready).toBe(false);

        // The stage the journal derives fronts the act itself. The button is
        // asserted, never pressed: a resume would tear the fixture's branch
        // down against a commit that never happened.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${row(DASH_WORK)} [data-slot="session-changes-dash-resume"]`)}) !== null`,
          { timeoutMs: 40000 },
        );
        note(`at0418 resume affordance rendered for ${DASH_WORK}`);
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
        const noJoin = await landingFace(app, DASH_EMPTY);
        expect(noJoin.ready).toBe(false);

        // ── Release: confirm, then the receipt, then a reload ──────────────
        // Its own dash, because this case destroys the one it runs on.
        await app.dispatchControlAction("bind_dash_ok", {
          tug_session_id: SID,
          dash_id: releaseId,
          dash_name: DASH_RELEASE,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(landing(DASH_RELEASE))}) !== null`,
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
        await clickUntil(
          app,
          `${row(DASH_RELEASE)} [data-slot="session-changes-dash-discard"]`,
          CONFIRM_POPOVER,
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
        await clickUntil(
          app,
          `${row(DASH_RELEASE)} [data-slot="session-changes-dash-discard"]`,
          CONFIRM_POPOVER,
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
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: PROJECT_DIR });
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
