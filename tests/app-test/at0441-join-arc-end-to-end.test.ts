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
 * So this walks the arc, beat by beat, and asserts the thing the incident
 * actually lacked: **at every point where the landing is refused, the control
 * that clears it is on screen.** That is [P08] — the reachability invariant —
 * and the unit half of it lives in `join-resolve-face.test.ts`. This is the
 * half that only the real app can answer, because "on screen" is a fact about
 * the DOM the deck rendered from the state the server sent.
 *
 * ## The arc
 *
 * conflicted → Resolve → progress → the resolver reconciles it in the workshop
 * and reports what it did → the project's own Tier 0 runs over that tree and
 * comes back green → **reload the deck** → still resolved, still reported,
 * still green → the row states its join route and offers no control → enter
 * join mode by that route → type a message → the composer's land control is
 * armed → **press it, and the dash joins.**
 *
 * The reload is not decoration. Three candidates were built and abandoned in
 * one day because nothing durable held them; the candidate is a git ref now,
 * and this is where that claim is tested against a deck that has genuinely
 * forgotten everything it knew.
 *
 * ## Where it lands, and why that is safe
 *
 * The press was the one beat this file could never make. A join that succeeds
 * squashes its dash onto its base branch **in that branch's live working
 * tree**, and when the project is a checkout somebody works in, the base is
 * their own branch — not a thing a test may move. That is why at0426 drew the
 * line, and why at0436 can only prove the wire by making the server *refuse*.
 *
 * The line moved because the fixture owns its repository now. Everything here
 * happens in a `git init`ed scratch repo under the system temp dir: the base
 * commit, the dash, the conflict, the merge driver, the landing, and the
 * squash commit that lands on its `main`. Nothing outside that directory is
 * read or written, and `afterAll` deletes it whole. A landed arc costs the
 * developer's checkout nothing, so the arc runs to its end.
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
 * the ladder reaches a candidate without the AI rung. The hygiene the old
 * fixture needed — a nonce against a stale `rr-cache` entry, a scrub of what
 * the run taught rerere, an unset of the driver config it borrowed from the
 * real repo — is all structural now: a fresh repo has no rr-cache to poison
 * and no config anybody else reads.
 *
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-join.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugrust/crates/tugdash-core/src/resolve.rs
 * @covers tugrust/crates/tugdash-core/src/ops.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_resolver.rs
 * @covers tugrust/crates/tugdash-core/src/workshop.rs
 * @covers tugrust/crates/tugdash-core/src/verify.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { commitRound, createDash, gitRetry as git } from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000441";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const TOOLBAR = `${CARD} .tug-prompt-entry-toolbar`;
const ROUTE_GROUP = `${TOOLBAR} .tug-prompt-entry-route-group`;
const LAND_BUTTON = `${CARD} .tug-prompt-entry-commit-button`;
const COMPOSER = `${CARD} [data-slot="tug-prompt-entry"]`;
const SHEET = '[data-slot="session-changes-view"]';
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH = "at0441-arc";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH}"]`;
const LANDING = `${ROW} [data-slot="session-changes-dash-join"]`;
const RESOLVE = `${ROW} [data-slot="session-changes-dash-resolve"]`;
const VERDICT = `${ROW} [data-slot="session-changes-dash-join-verdict"]`;
const REPORT = `${ROW} [data-slot="session-changes-dash-join-report"]`;
const READY = `${ROW} [data-slot="session-changes-dash-join-ready"]`;
const CONFLICTS = `${ROW} [data-slot="session-changes-dash-join-conflicts"]`;
const BLOCKERS = `${ROW} [data-slot="session-changes-dash-join-blockers"]`;

const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';

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
/** What the user types into the composer, and what the squash commit carries. */
const LAND_MESSAGE = "the arc lands its own dash";

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
const encodeProjectDir = (absDir: string): string => absDir.replace(/[^A-Za-z0-9-]/g, "-");

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

/** One clean Claude turn, so the reload's `claude --resume` has something to replay. */
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
        uuid: "00000000-0000-4000-8000-000000000f01",
        timestamp: t0,
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
      {
        ...base,
        parentUuid: "00000000-0000-4000-8000-000000000f01",
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000f02",
        timestamp: t1,
        message: {
          id: "msg-441-1",
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

beforeAll(() => {
  if (!SHOULD_RUN) return;

  // `-b main` is explicit: the machine's `init.defaultBranch` may be anything,
  // and the dash's base has to be a branch this repo actually has out.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "at0441-")));
  dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "at0441-data-")));
  git(scratch, "init", "-b", "main");
  git(scratch, "config", "user.email", "app-test@tugtool.dev");
  git(scratch, "config", "user.name", "at0441");
  writeFileSync(join(scratch, CONFLICT_FILE), FORK_BODY);
  // The project declares its own verification ([P11]). Tier 0 is a sentinel
  // grep — seconds cheap, no toolchain, and it can genuinely go red — and
  // there is deliberately **no** Tier 1: a fixture join runs inside an
  // app-test that already holds the machine-wide apptest gate, so a real
  // tier-1 command would queue on the gate its own run is holding.
  mkdirSync(join(scratch, ".tugtool"), { recursive: true });
  writeFileSync(
    join(scratch, ".tugtool", "config.toml"),
    `[tugtool.dash]\nverify_tier0 = ["grep -q SENTINEL ${CONFLICT_FILE}"]\n`,
  );
  git(scratch, "add", "-A");
  git(scratch, "commit", "-m", "at0441: the file both sides rewrite");

  // The dash forks here — `createDash` derives `--base` from the branch the
  // project has out, which is this repo's `main`. The CLI is the checkout
  // under test's; the repo it acts upon is the scratch one.
  const created = createDash(scratch, DASH, "at0441 full-arc fixture", {
    binaryRoot: CHECKOUT,
    env: { TUG_DATA_DIR: dataRoot },
  });

  // Both sides move the same lines, after the fork: a genuine conflict.
  writeFileSync(join(scratch, CONFLICT_FILE), BASE_BODY);
  git(scratch, "commit", "-am", "at0441: the base rewrites it");
  writeFileSync(join(created.worktree, CONFLICT_FILE), DASH_BODY);
  commitRound(scratch, DASH, `at0441(round): rewrite ${CONFLICT_FILE}`, {
    binaryRoot: CHECKOUT,
    env: { TUG_DATA_DIR: dataRoot },
  });

  // The resolver, configured in the scratch repo only. It speaks the two
  // terminal shapes over stdio — one JSON line per user message in, one per
  // terminal turn out — which is the identical parse-and-wait path the real
  // spawn takes; only the transport differs.
  stubDir = mkdtempSync(join(tmpdir(), "at0441-resolver-"));
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

  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(scratch));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${SID}.jsonl`), buildFixtureJsonl(scratch, SID));
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // The repository IS the teardown: branch, worktree, config, rr-cache and
  // dash all go with the directory.
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  if (dataRoot !== "") rmSync(dataRoot, { recursive: true, force: true });
  if (stubDir !== "") rmSync(stubDir, { recursive: true, force: true });
  if (fixtureDir !== "") rmSync(fixtureDir, { recursive: true, force: true });
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

/** Press a control on the dash row, scrolling it into the shade first (at0426). */
async function revealAndClick(app: App, selector: string): Promise<void> {
  await app.evalJS<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return false;
      el.scrollIntoView({ block: "center" });
      return true;
    })()`,
  );
  await settle(250);
  await app.nativeClickAtElement(selector);
}

/**
 * The reachability assertion, in the form the invariant actually claims: the
 * landing is refused, the face says so, and the slot that clears it is in the
 * DOM. A sentence pointing at a control nobody can see is the failure this
 * whole file is about, so it is checked as one fact, not two.
 */
async function refusalIsReachable(
  app: App,
  beat: string,
  expectedSlot: string,
): Promise<void> {
  const state = await app.evalJS<{ ready: boolean; line: string; slotPresent: boolean }>(
    `(function(){
      var line = document.querySelector(${JSON.stringify(READY)});
      return {
        ready: line !== null && line.getAttribute("data-ready") === "true",
        line: line === null ? "" : (line.textContent || ""),
        slotPresent: document.querySelector(${JSON.stringify(expectedSlot)}) !== null,
      };
    })()`,
  );
  expect(state.ready, `${beat}: the row must not read as landable`).toBe(false);
  expect(state.slotPresent, `${beat}: the control that clears this must be on screen`).toBe(
    true,
  );
  note(`at0441 ${beat}: refused, ${expectedSlot} mounted — line ${JSON.stringify(state.line)}`);
}

/** Whether the composer is on the changes route — join mode, live. */
function inJoinMode(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="changes"][data-state="active"]`)}) !== null`,
  );
}

/** Bring the card up on the fixture dash, with the lane composed. */
async function openOnDash(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0441: the join arc, end to end", () => {
  test(
    "conflicted resolves, is audited and verified, survives a reload, and joins — every refusal pointing at a mounted control",
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

        // The aggregate has composed the dash once the Lens roster lists it.
        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector('${LENS_SECTION} [data-slot="lens-dashes-row"][data-dash="${DASH}"]') !== null`,
          { timeoutMs: 30000 },
        );
        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LENS_SECTION)}) === null`,
          { timeoutMs: 8000 },
        );

        // ── Beat 1: conflicted, with the ladder as the way out ────────────
        // Nothing is asked of the server here. The dash's entry already
        // carries what a landing would do, so the face is up as soon as the
        // row is.
        await runCommand(app, `/dash-join ${DASH}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)})?.getAttribute("data-fronted") === "true"`,
          { timeoutMs: 20000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LANDING)})?.getAttribute("data-outcome") === "conflicted"`,
          { timeoutMs: 40000 },
        );
        expect(
          await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(CONFLICTS)})?.textContent || "")`,
          ),
          "the conflicted face names the path it conflicts on",
        ).toContain(CONFLICT_FILE);
        // A blocked dash would point somewhere else entirely; this one points
        // at the ladder, and the ladder is on screen.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(BLOCKERS)}) === null`,
          ),
          "a conflicted dash is not a blocked one",
        ).toBe(true);
        await refusalIsReachable(app, "conflicted", RESOLVE);

        // ── Beat 2: the run, visible while it runs ────────────────────────
        await settle(400);
        await revealAndClick(app, RESOLVE);
        // The overlay flips synchronously, so the offer leaves on the click
        // itself — which is what tells a dead press apart from a slow ladder.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RESOLVE)}) === null`,
          { timeoutMs: 5000 },
        );
        note("at0441 Resolve registered: the offer face left on the press");

        // ── Beat 3: resolved, audited, and verified ───────────────────────
        // What stands where the review panel used to is the resolver's own
        // account plus the project's verdict. The human is no longer the
        // auditor of machine text decisions: the resolver read every
        // resolution against the dash's intent and had to account for each
        // one, and the checks ran over the tree that would actually land.
        // The verdict is the beat, not the candidate. The ladder anchors a
        // candidate of its own before the resolver has even opened the
        // workshop, so waiting on the panel alone would read the arc one stage
        // early — which is precisely the seam this file exists to hold still.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(VERDICT)})?.getAttribute("data-verdict") === "green"`,
          { timeoutMs: 180000 },
        );
        const stuck = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(`${ROW} [data-slot="session-changes-dash-join-stuck"]`)})?.textContent || "")`,
        );
        expect(stuck, "the resolve did not stick").toBe("");
        const reportText = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(REPORT)})?.textContent || "")`,
        );
        expect(reportText, "the report names the file it reconciled").toContain(CONFLICT_FILE);
        expect(reportText, "and says how it reconciled it").toContain("kept the dash intent");
        note("at0441 verified: the project's own Tier 0 ran over the resolver's tree and passed");

        // ── Beat 4: the reload ────────────────────────────────────────────
        // The candidate is a git ref, the report is a blob the config points
        // at, and the verdict is branch config anchored to the two heads — so
        // a deck that has forgotten everything must come back to the same
        // state. This is the beat three abandoned candidates paid for: before
        // it, the resolution lived only in a client store, and a reload — or a
        // dropped socket, or a relaunch — threw it away silently.
        await app.appReload();
        await openOnDash(app);
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: scratch });
        await app.awaitEngineReady("A", { timeoutMs: 20000 });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
          { timeoutMs: 20000 },
        );
        await runCommand(app, `/dash-join ${DASH}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(VERDICT)})?.getAttribute("data-verdict") === "green"`,
          { timeoutMs: 60000 },
        );
        expect(
          await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(REPORT)})?.textContent || "")`,
          ),
          "with the same account it had before",
        ).toContain(CONFLICT_FILE);
        note("at0441 reload beat: the candidate, its report, and its verdict all came back from git");

        // ── Beat 5: landable — a sentence, and no control ─────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(READY)})?.getAttribute("data-ready") === "true"`,
          { timeoutMs: 30000 },
        );
        const readyLine = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(READY)})?.textContent || "")`,
        );
        // With nothing to press on the row, this sentence is the entire way
        // forward — so it has to name the route, not merely assert readiness.
        expect(readyLine).toContain("Ready to join");
        expect(readyLine).toContain("/dash-join");
        note(`at0441 landable: ${JSON.stringify(readyLine)}`);

        // ── Beat 6: the route the sentence named ──────────────────────────
        // `/dash-join` toggles: the beat-4 command that raised the lane left
        // the card in join mode, and sending it again would leave it. So the
        // route is entered only when it is not already the live one.
        if (!(await inJoinMode(app))) await runCommand(app, `/dash-join ${DASH}`);
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
        // route that got here is the one that opens it.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          ),
          "empty-message points at the composer, which is on screen",
        ).toBe(true);

        // ── Beat 7: a message, and a landing with nothing left refusing ───
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("Delete");
        await app.nativeType(LAND_MESSAGE);
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent ?? "").indexOf(${JSON.stringify(LAND_MESSAGE)}) !== -1`,
          { timeoutMs: 5000 },
        );
        const armed = await app.evalJS<{ disabled: boolean; label: string }>(
          `(function(){
            var b = document.querySelector(${JSON.stringify(`${LAND_BUTTON}[aria-label="Join"]`)});
            return {
              disabled: b === null ? true : b.disabled === true,
              label: b === null ? "" : (b.getAttribute("aria-label") || ""),
            };
          })()`,
        );
        expect(armed.label).toBe("Join");
        expect(armed.disabled, "with a message and a reviewed candidate, nothing refuses").toBe(
          false,
        );

        // ── Beat 8: the press, and the landing it produces ────────────────
        // The repository is the fixture's own, so this may finally run. What
        // it proves is the half at0436 cannot reach: a join that is not
        // refused actually integrates. Waiting on the repository rather than
        // on an animation — background windows run no rAF, so the staged
        // landing may be the watchdog's to fire.
        const before = git(scratch, "rev-parse", "main").trim();
        await app.nativeKey("Return", ["cmd"]);
        const landed = await waitForLanding(before);
        note(`at0441 landed: ${JSON.stringify(landed.subject)}`);

        // The subject wears the dash's scope. It is *not* the message typed
        // above, and that is the designed behavior rather than a slip: landing
        // a resolved candidate fast-forwards onto the commit the ladder
        // already built, which carries the message composed when it was built.
        // The typed message's job here was to clear the gate's empty-message
        // refusal, which it did.
        expect(landed.subject.startsWith(`tugdash(${DASH}): `), landed.subject).toBe(true);
        // And it carries the resolution that was reviewed — not either side of
        // the conflict. A landing that quietly took one side would pass every
        // assertion above and still be the wrong tree.
        expect(readFileSync(join(scratch, CONFLICT_FILE), "utf8")).toBe(RESOLVER_BODY);
        // The journaled teardown ran: nothing of the dash is left to land twice.
        expect(branchExists(`tugdash/${DASH}`), "the dash branch is gone").toBe(false);
        expect(worktreePaths().some((p) => p.includes(DASH)), "its worktree is gone").toBe(
          false,
        );

        // And the lane agrees. A landed dash that keeps being offered is the
        // same class of lie the whole campaign is about.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) === null`,
          { timeoutMs: 60000 },
        );
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

/**
 * Poll `main`'s tip until it moves off `before`, and return what landed.
 *
 * The repository is the signal rather than a bulletin: a successful join posts
 * nothing (the notice controller speaks only failures), so the tip moving is
 * the only place the outcome is written down.
 */
async function waitForLanding(before: string): Promise<{ subject: string }> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (git(scratch, "rev-parse", "main").trim() !== before) {
      return { subject: git(scratch, "log", "-1", "--format=%s", "main").trim() };
    }
    await settle(500);
  }
  throw new Error(`at0441: the press never landed — main's tip is still ${before}`);
}
