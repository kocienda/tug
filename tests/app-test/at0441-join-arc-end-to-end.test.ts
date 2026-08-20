/**
 * AT0441 — the whole join arc, on one dash, in the real app.
 *
 * ## Why this exists
 *
 * The dash-join pipeline was broken for days in a way no single test could
 * see, because every test held one beat still. The face had its own coverage,
 * the gate had its own coverage, the ladder had its own coverage — and the
 * defect lived in the seams between them: the resolution store was written
 * under one spelling of a directory and read under another, so a candidate the
 * server had built and logged was invisible to the surface that had to review
 * it. Every part passed. The arc did not exist.
 *
 * So this walks the arc, beat by beat. What it asserts has changed with the
 * arc itself: the invariant used to be *every refusal points at a control on
 * screen*, because the shade carried four of them. There are none now. The
 * machine does the work a `built` dash needs, and the only act left is the
 * user's decision — so the claim this file makes is the one the arc's doctrine
 * rests on:
 *
 * **Nothing was pressed to get from `built` to landable.**
 *
 * That is not a smaller claim than the old one. A test that pressed Resolve
 * could not tell a working pilot from a pilot that never ran, because the
 * press did the pilot's job. Pressing nothing is the only way to observe it.
 *
 * ## The arc
 *
 * a conflicted dash is declared `built` → **and nothing else happens on the
 * test's side at all** → the pilot reconciles it against the base, the
 * resolver reports what it did, the project's own Tier 0 runs over that tree
 * and comes back green → **reload the deck** → still resolved, still green →
 * the shade's row mounts none of the four deleted controls → enter join mode →
 * type a message → press ⬆ → the register reports the join's beats → the dash
 * lands.
 *
 * Then the same arc's quiet twin: a second dash with nothing to reconcile,
 * judged the same way and landed the same way. A clean merge used to be the
 * one nobody examined — it landed because git found no overlapping text, which
 * is not the same claim as the result building.
 *
 * The reload is not decoration. Three candidates were built and abandoned in
 * one day because nothing durable held them; the candidate is a git ref now,
 * and this is where that claim is tested against a deck that has genuinely
 * forgotten everything it knew.
 *
 * ## Where it lands, and why that is safe
 *
 * A join that succeeds squashes its dash onto its base branch **in that
 * branch's live working tree**, and when the project is a checkout somebody
 * works in, the base is their own branch — not a thing a test may move. That
 * is why at0426 drew the line, and why at0436 can only prove the wire by
 * making the server *refuse*.
 *
 * The line moved because the fixture owns its repository now. Everything here
 * happens in a `git init`ed scratch repo under the system temp dir: the base
 * commit, the dash, the conflict, the merge driver, the landing, and the
 * squash commit that lands on its `main`. Nothing outside that directory is
 * read or written, and `afterAll` deletes it whole.
 *
 * The scratch repo sits outside any pinned `TUG_REPO_UNIVERSE`, which is
 * exactly the boundary's third case: an unrelated repository resolves by the
 * ordinary rule, whatever universe the corpus itself was run from.
 *
 * ## The fixture
 *
 * A one-file repository whose file both sides rewrite wholesale: the dash
 * forks, the base rewrites the file, the dash rewrites the same lines. So
 * `merge-tree` genuinely conflicts and the `merge-file` rung genuinely
 * declines. A stub merge driver (rung 4) then resolves it to a fixed body, so
 * the ladder reaches a candidate without the AI rung. Both dashes are declared
 * `built` at the end of the fixture, which is the one act that hands them to
 * the pilot — and the only reason the test can then press nothing.
 *
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/lib/dash-join-register.ts
 * @covers tugdeck/src/components/tugways/dash-join-register.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-join.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugrust/crates/tugdash-core/src/resolve.rs
 * @covers tugrust/crates/tugdash-core/src/ops.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_pilot.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_resolver.rs
 * @covers tugrust/crates/tugdash-core/src/workshop.rs
 * @covers tugrust/crates/tugdash-core/src/verify.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  gitRetry as git,
  makeDashScratchRepo,
  markDashBuilt,
  rmScratchSession,
  SCRATCH_NAMESPACE,
  seedScratchSession,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000441";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const TOOLBAR = `${CARD} .tug-prompt-entry-toolbar`;
const ROUTE_GROUP = `${TOOLBAR} .tug-prompt-entry-route-group`;
const LAND_BUTTON = `${CARD} .tug-prompt-entry-commit-button`;
const COMPOSER = `${CARD} [data-slot="tug-prompt-entry"]`;
/** The composer's own register — the third surface the one sentence mounts on. */
const COMPOSER_REGISTER = `${CARD} .tug-prompt-entry-status [data-slot="dash-join-register"]`;
const SHEET = '[data-slot="session-changes-view"]';
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH = "at0441-arc";
/**
 * The second dash: nothing about it conflicts with the base.
 *
 * It exists because a clean join used to be the *unexamined* one. A conflicted
 * dash was resolved, audited, and verified before it could land; a clean one
 * landed on the strength of git finding no overlapping text, which says nothing
 * about whether the result builds. Every join rides a candidate now, so this
 * dash walks the same verdict the conflicted one does — and, like it, reaches
 * that verdict with nothing pressed.
 */
const CLEAN_DASH = "at0441-clean";
/** The file only the clean dash touches, so its merge has nothing to decide. */
const CLEAN_FILE = "clean.txt";
const CLEAN_BODY = "at0441 the clean dash's own file\n";
const CLEAN_MESSAGE = "the clean arc lands too";

const row = (dash: string): string =>
  `${LANE} [data-slot="session-changes-dash-row"][data-dash="${dash}"]`;
const landing = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-dash-join"]`;
const verdictOf = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-dash-join-verdict"]`;
const readyOf = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-dash-join-ready"]`;
const reportOf = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-dash-join-report"]`;
const conflictsOf = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-dash-join-conflicts"]`;

const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';
const lensRow = (dash: string): string =>
  `${LENS_SECTION} [data-slot="lens-dashes-row"][data-dash="${dash}"]`;
/** The Lens row's register — the surface that needs no shade and no gesture. */
const lensRegister = (dash: string): string =>
  `${lensRow(dash)} [data-slot="dash-join-register"]`;

/**
 * Every control the shade used to mount, as one selector ([P08]).
 *
 * Named rather than merely absent from the source: a deletion nobody asserts
 * is a deletion a later refactor can quietly undo, and each of these was a
 * press that asked the user to start work the machine now starts on its own.
 */
const DELETED_CONTROLS = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-dash-resolve"], ` +
  `${row(dash)} [data-slot="session-changes-dash-resume"], ` +
  `${row(dash)} [data-slot="session-changes-dash-join-verify"], ` +
  `${row(dash)} [data-slot="session-changes-dash-join-override"]`;

/**
 * The checkout under test. Nothing here is the *project* — it is only where
 * the built `tugutil` the fixture drives comes from.
 */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

/** The file both sides rewrite. One file is the whole repository. */
const CONFLICT_FILE = "subject.txt";
const FORK_BODY = "at0441 the body both sides will rewrite\n";
const BASE_BODY = "at0441 base side — the whole file, rewritten\n";
const DASH_BODY = "at0441 dash side — the whole file, rewritten\n";
/**
 * The body the stub resolver reconciles the conflict to, asserted verbatim.
 *
 * It carries the sentinel the fixture's Tier 0 command greps for, so the
 * project's own check passes over exactly the tree the resolver produced —
 * which is the point of running one at all.
 */
const RESOLVER_BODY = "at0441 SENTINEL reconciled by the resolver\n";
/** What the user types into the composer, and what clears the empty-message gate. */
const LAND_MESSAGE = "the arc lands its own dash";

/** The scratch repository — the project the app opens, and the only tree
 *  anything in this file touches. */
let scratch = "";
/**
 * Where Tug's own state for that repository lives.
 *
 * A dash writes project state — its dash-log, its join journal — under the
 * data root, keyed by the repo's path. For a repo that exists only for this
 * run, that state is garbage the moment the run ends, and a debug build
 * refuses outright to write it into the developer's live data directory
 * (`refuse_unredirected_temp_repo`). Redirecting the root is what the refusal
 * asks for, and it must reach **both** halves: the fixture's CLI calls and the
 * app, or the dash one of them writes is a dash the other cannot see.
 */
let dataRoot = "";
let stubDir = "";
let fixtureDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;

  // The scratch repository, from the one shared implementation. The project
  // declares its own verification ([P11]): Tier 0 is a sentinel grep —
  // seconds cheap, no toolchain, and it can genuinely go red — and there is
  // deliberately **no** Tier 1, which no longer runs at join time at all.
  const base = makeDashScratchRepo({
    prefix: "at0441",
    checkout: CHECKOUT,
    files: {
      [CONFLICT_FILE]: FORK_BODY,
      ".tugtool/config.toml": `[tugtool.dash]\nverify_tier0 = ["grep -q SENTINEL ${CONFLICT_FILE}"]\n`,
    },
  });
  scratch = base.repo;
  dataRoot = base.dataRoot;

  // The dash forks here — `createDash` derives `--base` from the branch the
  // project has out, which is this repo's `main`. The CLI is the checkout
  // under test's; the repo it acts upon is the scratch one.
  const created = createDash(scratch, DASH, "at0441 full-arc fixture", base.cli);

  // Both sides move the same lines, after the fork: a genuine conflict.
  writeFileSync(join(scratch, CONFLICT_FILE), BASE_BODY);
  git(scratch, "commit", "-am", "at0441: the base rewrites it");
  writeFileSync(join(created.worktree, CONFLICT_FILE), DASH_BODY);
  commitRound(scratch, DASH, `at0441(round): rewrite ${CONFLICT_FILE}`, base.cli);

  // The second dash forks from the same point and touches a file nobody else
  // does, so its squash has nothing to reconcile — the clean arc.
  const clean = createDash(scratch, CLEAN_DASH, "at0441 clean-arc fixture", base.cli);
  writeFileSync(join(clean.worktree, CLEAN_FILE), CLEAN_BODY);
  commitRound(scratch, CLEAN_DASH, `at0441(round): add ${CLEAN_FILE}`, base.cli);

  // The resolver, configured in the scratch repo only. It speaks the two
  // terminal shapes over stdio — one JSON line per user message in, one per
  // terminal turn out — which is the identical parse-and-wait path the real
  // spawn takes; only the transport differs.
  stubDir = mkdtempSync(join(tmpdir(), `${SCRATCH_NAMESPACE}-at0441-resolver-`));
  const stub = join(stubDir, "stub-resolver.sh");
  writeFileSync(
    stub,
    `#!/bin/sh\nws="$1"\nread -r _charter\nprintf '%s' '${RESOLVER_BODY}' > "$ws/${CONFLICT_FILE}"\n` +
      `printf '%s\\n' '{"files":[{"path":"${CONFLICT_FILE}","resolved_by":"resolver",` +
      `"what_each_side_did":"both sides rewrote the whole file",` +
      `"reconciliation":"kept the dash intent and the base sentinel"}],"notes":"at0441"}'\n`,
  );
  chmodSync(stub, 0o755);
  git(scratch, "config", "tugdash.joinresolver", stub);

  // Last, and the whole reason this file presses nothing: `built` is what
  // hands a dash to the pilot. Both dashes are declared here, before the app
  // ever launches, so the arc is already the machine's when the deck arrives.
  markDashBuilt(scratch, DASH, base.cli);
  markDashBuilt(scratch, CLEAN_DASH, base.cli);

  fixtureDir = seedScratchSession(scratch, SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // The repository IS the teardown: branch, worktree, config, rr-cache and
  // dash all go with the directory.
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  if (dataRoot !== "") rmSync(dataRoot, { recursive: true, force: true });
  if (stubDir !== "") rmSync(stubDir, { recursive: true, force: true });
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

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

async function runCommand(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(line);
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

/** Whether the composer is on the changes route — join mode, live. */
function inJoinMode(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="changes"][data-state="active"]`)}) !== null`,
  );
}

/** Bring the card up on the fixture repo, with the deck mounted. */
async function openOnDash(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15000 },
  );
}

/** Show the Lens, do something with it, and put it away. */
async function withLens(app: App, body: () => Promise<void>): Promise<void> {
  await app.dispatchControlAction("toggle-lens");
  try {
    await body();
  } finally {
    await app.dispatchControlAction("toggle-lens");
    await app.waitForCondition<boolean>(
      `document.querySelector(${JSON.stringify(LENS_SECTION)}) === null`,
      { timeoutMs: 8000 },
    );
  }
}

/**
 * Wait for a dash's Lens register to settle on a word, with nothing pressed.
 *
 * The Lens is the surface this can be read from without touching the dash at
 * all: raising the shade is a gesture about the card, but aiming the join mode
 * at a row is a gesture about *this dash*, and a test asserting the machine
 * worked unprompted must not be the thing that prompted it.
 */
async function lensRegisterReaches(
  app: App,
  dash: string,
  word: string,
  timeoutMs: number,
): Promise<string> {
  let line = "";
  await withLens(app, async () => {
    await app.waitForCondition<boolean>(
      `document.querySelector(${JSON.stringify(lensRegister(dash))})?.getAttribute("data-word") === ${JSON.stringify(word)}`,
      { timeoutMs },
    );
    line = await app.evalJS<string>(
      `(document.querySelector(${JSON.stringify(lensRegister(dash))})?.textContent || "")`,
    );
  });
  return line;
}

/**
 * Aim the composer at a dash, which fronts its row and raises the lane.
 *
 * The join FACE belongs to the fronted row alone — joining is a gesture on the
 * card's own dash — so reading what the shade says about a dash means fronting
 * it first. This starts nothing: on a conflicted dash the mode entry asks the
 * server for nothing at all, and on a clean one it only ensures the candidate
 * the pilot has already built.
 */
async function frontTheRow(app: App, dash: string): Promise<void> {
  // Always back to the prompt route first, then in by name. `/dash-join`
  // toggles, so a conditional entry would leave the mode aimed at whichever
  // dash it was already on — which is the wrong row for every beat after the
  // first landing.
  await returnToPrompt(app);
  await runCommand(app, `/dash-join ${dash}`);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(LANE)}) !== null`,
    { timeoutMs: 40000 },
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(`${LANE} [data-slot="session-changes-dash-row"][data-dash="${dash}"]`)})?.getAttribute("data-fronted") === "true"`,
    { timeoutMs: 30000 },
  );
}

/**
 * Put the composer back on the prompt route.
 *
 * Load-bearing before any typed command: `/commit` leaves the composer in
 * commit mode, where the editor *is* the message — so a `/dash-join` typed
 * there is message text rather than a command.
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

/**
 * Press ⬆ and watch for the join's own beats.
 *
 * The beats are the claim ([P03]): a join that reports nothing until it is
 * over is the silence the old twelve-second deadline was invented to paper
 * over. Sampled in a tight poll from the press onward, because each beat is
 * one frame of a run that takes seconds — and read from **both** registers,
 * since the whole point of one derivation is that the composer and the row
 * say the same thing.
 */
async function pressAndWatchBeats(app: App, dash: string): Promise<string[]> {
  const before = git(scratch, "rev-parse", "main").trim();
  // The sampler runs IN THE PAGE, at 10ms, started before the press.
  //
  // Sampling from the test process cannot work here: a join on a one-file
  // repository is a fast-forward that takes milliseconds, and every sample
  // costs an evalJS round trip. The register would be up and down again
  // between two reads, and the test would report "the join said nothing" about
  // a join that said four things. An interval inside the page has no round
  // trip — and it is `setInterval` rather than `requestAnimationFrame` because
  // a background app-test window runs no rAF at all.
  await app.evalJS<null>(
    `(function(){
      window.__at0441Beats = [];
      // Every register on screen, wherever it is mounted. The claim is that
      // the join narrates itself somewhere a reader is looking, and scoping
      // the sampler to one surface would turn a question about the arc into a
      // question about which surface survives the press.
      window.__at0441Timer = setInterval(function(){
        var els = document.querySelectorAll(${JSON.stringify(`[data-slot="dash-join-register"]`)});
        for (var i = 0; i < els.length; i += 1) {
          var word = els[i].getAttribute("data-word") || "";
          if (word !== "" && window.__at0441Beats.indexOf(word) === -1) {
            window.__at0441Beats.push(word);
          }
        }
      }, 10);
      return null;
    })()`,
  );
  await app.nativeClickAtElement(LAND_BUTTON);
  // The base moves at the INTEGRATE, which is the first of the four beats —
  // teardown, release and record all follow it — so the sampler keeps running
  // for a moment past the tip move.
  const deadline = Date.now() + 90_000;
  let landed = false;
  while (Date.now() < deadline && !landed) {
    landed = git(scratch, "rev-parse", "main").trim() !== before;
    if (!landed) await settle(100);
  }
  if (landed) await settle(3000);
  const words = await app.evalJS<string[]>(
    `(function(){
      clearInterval(window.__at0441Timer);
      var out = window.__at0441Beats || [];
      window.__at0441Beats = [];
      return out;
    })()`,
  );
  if (!landed) {
    throw new Error(
      `at0441: the press never landed — main's tip is still ${before}; register said ${words.join(", ")}`,
    );
  }
  return words;
}

describe.skipIf(!SHOULD_RUN)("AT0441: the join arc, end to end", () => {
  test(
    "a built dash reconciles and passes its checks with nothing pressed, survives a reload, offers no control, and joins on the composer's press",
    async () => {
      const tugbankPath = mkTempTugbank();
      // The source tree is where the app finds `tugdeck/dist` to serve, so it
      // stays the checkout under test. The *project* is the scratch repo, and
      // it reaches the server the only way a project ever does: a real session
      // spawn, which registers its workspace and puts it in the open-project
      // set the changeset aggregate enumerates.
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0441-join-arc-end-to-end",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: dataRoot },
      });
      try {
        await app.enableDeckTrace(true);
        await openOnDash(app);
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: scratch });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // ── Beat 1: the machine's whole job, with nothing pressed ─────────
        // From here to the reload, this test issues no gesture aimed at the
        // dash. The conflict is real, the resolver runs, and the project's own
        // Tier 0 judges what it produced — because the dash is `built` and the
        // pilot acts on a built dash.
        const readyLine = await lensRegisterReaches(app, DASH, "ready", 240000);
        expect(readyLine, "the register states the arc, not a control").toContain(
          "Ready to join",
        );
        note(`at0441 unprompted: the conflicted dash reached ${JSON.stringify(readyLine)}`);

        // ── Beat 2: the reload ────────────────────────────────────────────
        // The candidate is a git ref, the report is a blob the config points
        // at, and the verdict is branch config anchored to the two heads — so
        // a deck that has forgotten everything must come back to the same
        // state. This is the beat three abandoned candidates paid for.
        await app.appReload();
        await openOnDash(app);
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: scratch });
        await app.awaitEngineReady("A", { timeoutMs: 20000 });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
          { timeoutMs: 20000 },
        );
        expect(
          await lensRegisterReaches(app, DASH, "ready", 90000),
          "the verdict came back from git, not from a store the reload emptied",
        ).toContain("Ready to join");
        note("at0441 reload beat: the candidate and its verdict both came back from git");

        // ── Beat 3: the shade states, and offers nothing ──────────────────
        // The face belongs to the fronted row, and fronting is what
        // `/dash-join` does — so this is the first gesture in the file, and it
        // comes after every claim about the machine working alone. It aims the
        // composer; it starts nothing.
        await frontTheRow(app, DASH);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(verdictOf(DASH))})?.getAttribute("data-verdict") === "green"`,
          { timeoutMs: 60000 },
        );
        const shade = await app.evalJS<{
          controls: number;
          report: string;
          ready: boolean;
          line: string;
          conflicts: string;
        }>(
          `(function(){
            var line = document.querySelector(${JSON.stringify(readyOf(DASH))});
            return {
              controls: document.querySelectorAll(${JSON.stringify(DELETED_CONTROLS(DASH))}).length,
              report: (document.querySelector(${JSON.stringify(reportOf(DASH))})?.textContent || ""),
              ready: line !== null && line.getAttribute("data-ready") === "true",
              line: line === null ? "" : (line.textContent || ""),
              conflicts: (document.querySelector(${JSON.stringify(conflictsOf(DASH))})?.textContent || ""),
            };
          })()`,
        );
        // Four deletions, asserted rather than assumed. Each was a press that
        // asked the user to start machine work — the arc inverted.
        expect(shade.controls, "the shade mounts none of the four deleted controls").toBe(0);
        // What remains is information, and it is all still here: the resolver's
        // own account of what it reconciled and how.
        expect(shade.report, "the report names the file it reconciled").toContain(
          CONFLICT_FILE,
        );
        expect(shade.report, "and says how it reconciled it").toContain("kept the dash intent");
        expect(shade.ready, "and the row reads landable").toBe(true);
        expect(shade.line, "naming the route, since there is nothing to press here").toContain(
          "/dash-join",
        );
        note(`at0441 shade: ${JSON.stringify(shade.line)} — no controls, full report`);

        // ── Beat 4: the one act, in the one place it lives ────────────────
        // Already in join mode — fronting the row is how the shade was read —
        // so what is left is the message and the press.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="changes"][data-state="active"]`)}) !== null`,
          { timeoutMs: 12000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${LAND_BUTTON}[aria-label="Join"]`)}) !== null`,
          { timeoutMs: 12000 },
        );
        // An empty message is the last refusal in the gate's order, and its
        // control is the composer's own editor — which is mounted, because the
        // route that got here is the one that opens it ([P09]).
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          ),
          "empty-message points at the composer, which is on screen",
        ).toBe(true);

        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeType(LAND_MESSAGE);
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent ?? "").indexOf(${JSON.stringify(LAND_MESSAGE)}) !== -1`,
          { timeoutMs: 5000 },
        );
        const armed = await app.evalJS<{ disabled: boolean; classes: string }>(
          `(function(){
            var b = document.querySelector(${JSON.stringify(`${LAND_BUTTON}[aria-label="Join"]`)});
            return {
              disabled: b === null ? true : b.disabled === true,
              classes: b === null ? "" : (b.className || ""),
            };
          })()`,
        );
        expect(armed.disabled, "with a message and a green verdict, nothing refuses").toBe(false);
        // Green, so the press is an action rather than a decision. The role
        // rides the button's class — `.tug-button-{emphasis}-{role}` is where
        // [D02]'s matrix lands — and the danger half of it is at0443's ([P05]).
        expect(armed.classes, "a green join is an ordinary act").not.toContain("danger");

        // ── Beat 5: the press, its beats, and the landing ─────────────────
        const beats = await pressAndWatchBeats(app, DASH);
        note(`at0441 land beats: ${JSON.stringify(beats)}`);
        // The settled state is the assertion, and deliberately so. A join on a
        // one-file repository is a fast-forward measured in milliseconds, and
        // its beat frames and its terminal reply arrive in one batch — so
        // demanding an in-flight `joining` frame would be demanding that the
        // renderer interleave with the wire, which no test can hold still and
        // no reader would see anyway. What the arc owes the presser is that
        // the surface they are looking at says what happened, and `joined` is
        // that sentence. Any in-flight beats the sampler did catch are noted
        // above rather than asserted.
        expect(
          beats.includes("joined"),
          "the join settled on its own result rather than going quiet",
        ).toBe(true);

        const subject = git(scratch, "log", "-1", "--format=%s", "main").trim();
        note(`at0441 landed: ${JSON.stringify(subject)}`);
        // The subject wears the dash's scope. It is *not* the message typed
        // above, and that is designed rather than a slip: landing a resolved
        // candidate fast-forwards onto the commit the ladder already built,
        // which carries the message composed when it was built. The typed
        // message's job was to clear the gate's empty-message refusal.
        expect(subject.startsWith(`tugdash(${DASH}): `), subject).toBe(true);
        // And it carries the resolution the checks passed — not either side of
        // the conflict. A landing that quietly took one side would pass every
        // assertion above and still be the wrong tree.
        expect(readFileSync(join(scratch, CONFLICT_FILE), "utf8")).toBe(RESOLVER_BODY);

        // The journaled teardown ran: nothing of the dash is left to land
        // twice. Polled, because the teardown is a phase *after* the integrate.
        const teardownBy = Date.now() + 60_000;
        while (Date.now() < teardownBy && branchExists(`tugdash/${DASH}`)) {
          await settle(500);
        }
        expect(branchExists(`tugdash/${DASH}`), "the dash branch is gone").toBe(false);
        expect(worktreePaths().some((p) => p.includes(DASH)), "its worktree is gone").toBe(false);

        // ── Beat 6: the clean arc, judged the same way ────────────────────
        // The dash above earned its verdict by conflicting. This one has
        // nothing to reconcile, and until the arc existed that meant nothing
        // examined it: it joined because git found no overlapping text, which
        // is not the same claim as the result building.
        expect(
          await lensRegisterReaches(app, CLEAN_DASH, "ready", 240000),
          "a dash with nothing to reconcile still faced the checks, unprompted",
        ).toContain("Ready to join");
        note("at0441 clean beat: the quiet dash was judged without being asked");

        await frontTheRow(app, CLEAN_DASH);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${LAND_BUTTON}[aria-label="Join"]`)}) !== null`,
          { timeoutMs: 12000 },
        );
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeType(CLEAN_MESSAGE);
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent ?? "").indexOf(${JSON.stringify(CLEAN_MESSAGE)}) !== -1`,
          { timeoutMs: 5000 },
        );
        const cleanBeats = await pressAndWatchBeats(app, CLEAN_DASH);
        note(`at0441 clean land beats: ${JSON.stringify(cleanBeats)}`);
        expect(readFileSync(join(scratch, CLEAN_FILE), "utf8")).toBe(CLEAN_BODY);
        const cleanTeardownBy = Date.now() + 60_000;
        while (Date.now() < cleanTeardownBy && branchExists(`tugdash/${CLEAN_DASH}`)) {
          await settle(500);
        }
        expect(branchExists(`tugdash/${CLEAN_DASH}`), "the clean dash is gone too").toBe(false);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/** Whether the scratch repo still carries `ref`. */
function branchExists(ref: string): boolean {
  return (
    Bun.spawnSync(
      ["git", "-C", scratch, "rev-parse", "--verify", "--quiet", `refs/heads/${ref}`],
      {},
    ).exitCode === 0
  );
}

/** Every worktree the scratch repo still registers. */
function worktreePaths(): string[] {
  return git(scratch, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}
