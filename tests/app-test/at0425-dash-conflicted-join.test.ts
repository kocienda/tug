/**
 * at0425-dash-conflicted-join.test.ts — the conflicted landing face, and
 * per-control accountability on it.
 *
 * ## Why this exists
 *
 * The first real dash landing arrived at the shade exactly here: an unbound
 * card, a join aimed by name, a preview that came back `conflicted` — and the
 * user reported every control as a dead click. The landed outcomes (clean,
 * blocked, empty) all have coverage in at0418; `conflicted` had none, because
 * a real conflict seemed to require moving the developer's `main`. It does
 * not: the fixture owns the whole repository — a scratch one, built two commits
 * deep for this — so it can rewind the dash branch to the base's parent and
 * delete a file the base's tip commit modified. The preview's `merge-tree` then
 * reports a genuine delete/modify conflict, and the developer's checkout is
 * never involved at all.
 *
 * Delete/modify is chosen deliberately a second time over: the per-file walk
 * short-circuits non-content conflicts straight to unresolved — text tools
 * never guess at structure — so driving Resolve here exercises the whole
 * click → request → ladder → terminal-frame round trip without ever reaching
 * the AI rung (no scribe run in an app-test) and settles fast.
 *
 * ## What is pinned
 *
 * - The incident's state renders as designed: the named join fronts a dash the
 *   card is not bound to, under "dash this landing is aimed at", with **Adopt**
 *   (fronting is about what is being landed; the binding is about what the card
 *   works — so the fronted header names the landing, not a binding that is not
 *   there).
 * - A conflicted outcome never reads as ready: the row states no landing
 *   route, and the conflicted paths and their archaeology are the reason, in
 *   words.
 * - **Resolve** is enabled, and a click visibly registers at once — the offer
 *   face leaves the moment the store flips to `resolving`, before any server
 *   frame. This is the dead-click assertion: if the click does nothing, the
 *   Resolve affordance is still on screen and the wait below times out.
 *   What the resolve does *after* that press belongs to the scratch-repo
 *   fixtures — at0426, at0441, at0442, at0443 — which script a resolver rather
 *   than spawning one against the developer's own checkout.
 * - **Adopt** round-trips for real: the click sends `bind_dash`, and the row
 *   flips to Leave only on the `bind_dash_ok` broadcast that comes back.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-join.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugrust/crates/tugdash-core/src/resolve.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
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
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  smallConflictSubject,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000425";
const FEED_CODE_OUTPUT = 0x40;
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const TOOLBAR = `${CARD} .tug-prompt-entry-toolbar`;
const ROUTE_GROUP = `${TOOLBAR} .tug-prompt-entry-route-group`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;
const FRONTED_LABEL = `${LANE} [data-slot="session-changes-dash-lane-fronted-label"]`;

const DASH = "at0425-conflict";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH}"]`;
const ADOPT = `${ROW} [data-slot="session-changes-dash-bind"]`;
const LEAVE = `${ROW} [data-slot="session-changes-dash-unbind"]`;
const OUTCOME = `${ROW} [data-slot="session-changes-dash-join-outcome"]`;
const RESOLVE = `${ROW} [data-slot="session-changes-dash-resolve"]`;
const READY = `${ROW} [data-slot="session-changes-dash-join-ready"]`;
const RELEASE = `${ROW} [data-slot="session-changes-dash-discard"]`;
const CONFLICTS = `${ROW} [data-slot="session-changes-dash-join-conflicts"]`;
const ARCHAEOLOGY = `${ROW} [data-slot="session-changes-dash-join-archaeology"]`;

const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/** The file the base modifies and the dash deletes. */
const SUBJECT_FILE = "at0425-subject.txt";
/** The base-tip file the dash's round deletes — the conflict's subject. */
let conflictFile = "";
/** That base commit's subject — what the archaeology must name under the path. */
let baseSubject = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({
    prefix: "at0425",
    checkout: CHECKOUT,
    files: { [SUBJECT_FILE]: "at0425 first line\nat0425 second line\n" },
  });

  // The base commit the conflict is built around: it MODIFIES a small text
  // file that the root commit already had, which is the shape
  // `smallConflictSubject` looks for — a commit with a parent, whose file is
  // text, small, clean in the working tree, and still present at the tip.
  writeFileSync(
    join(projectDir(), SUBJECT_FILE),
    "at0425 first line\nat0425 the base rewrote this line\n",
  );
  git(projectDir(), "commit", "-am", "at0425: the base modifies the subject file");

  const created = createDash(projectDir(), DASH, "at0425 conflicted fixture", scratch.cli);

  // Rewinding the dash branch to that commit's parent and deleting the file
  // diverges the two sides on it: the base modified what the dash deleted — a
  // delete/modify conflict `merge-tree` must report.
  //
  // The subject comes from the shared helper, which reads it back out of the
  // repo rather than trusting the strings above. It is *not* here for the size
  // bound: a delete/modify short-circuits to unresolved before any rung runs,
  // so no diff is ever produced and the review cap that bites at0426 cannot
  // bite this. Nobody should go looking for one here.
  const subject = smallConflictSubject(projectDir());
  conflictFile = subject.path;
  baseSubject = subject.subject;

  // The rewind and the deletion happen in the dash's own worktree — the
  // scratch repo's base branch is never touched.
  git(created.worktree, "reset", "--hard", `${subject.commit}~1`);
  rmSync(join(created.worktree, conflictFile));
  commitRound(projectDir(), DASH, `at0425(round): delete ${conflictFile}`, scratch.cli);

  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
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

async function runCommand(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(line);
  await settle();
  // Dismiss the slash completion popup so Enter submits rather than accepting.
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

describe.skipIf(!SHOULD_RUN)("AT0425: the conflicted landing face answers its controls", () => {
  test(
    "a named join on an unbound card fronts conflicted; the row never reads ready, Resolve's click registers, Adopt round-trips",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0425-dash-conflicted-join",
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
        // the live ledger row the Adopt probe's `bind_dash` needs, or the
        // server has nothing to bind.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
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

        // ── The incident's state, reconstructed for real ──────────────────
        // Unbound card, join aimed by name. The mode enters, the shade rises,
        // and the dash entry already carries the answer: `conflicted`.
        await runCommand(app, `/dash-join ${DASH}`);
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(ROUTE_GROUP)} + ' [data-state="active"]');
            return el !== null && el.getAttribute("data-choice-value") === "changes";
          })()`,
          { timeoutMs: 12000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FRONTED_LABEL)}) !== null
             && document.querySelector(${JSON.stringify(ROW)})?.getAttribute("data-fronted") === "true"`,
          { timeoutMs: 12000 },
        );
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(OUTCOME)})?.textContent || "").trim() === "conflicted"`,
          { timeoutMs: 30000 },
        );
        note(`outcome: conflicted over ${conflictFile}`);

        // Fronted-but-unbound offers Adopt — fronting is about what is being
        // landed, the binding about what the card works. The incident read
        // this pairing as a contradiction; it is the designed state.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(ADOPT)}) !== null`,
          ),
        ).toBe(true);
        // The conflict names its file.
        expect(
          await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(CONFLICTS)})?.textContent || "")`,
          ),
        ).toContain(conflictFile);
        // …and what the base did to it. The fixture rewinds the dash to the
        // parent of the newest base commit that MODIFIED this file, so that
        // commit is on the base side of the merge-base by construction and its
        // subject must appear under the path.
        const archaeology = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(ARCHAEOLOGY)})?.textContent || "")`,
        );
        expect(archaeology).toContain(baseSubject);
        note(`archaeology names the base commit: ${baseSubject}`);

        // ── Landing: not offered, and the reason is on screen ─────────────
        // The incident's shape was a control that offered a press and refused
        // it somewhere the press could not reach. The row's one act here is the
        // ladder, and the conflicted paths below are the reason, in the
        // server's words.
        const claimsReady = await app.evalJS<boolean>(
          `(function(){
            var line = document.querySelector(${JSON.stringify(READY)});
            return line !== null && line.getAttribute("data-ready") === "true";
          })()`,
        );
        expect(claimsReady, "a conflicted dash must not read as ready").toBe(false);

        // ── Resolve: ungated by the turn, and the click must register ─────
        // Hold a real turn open across the whole Resolve gesture. Resolving
        // builds a candidate off to the side and touches no checkout, so the
        // agent being mid-edit is no reason to refuse it — and refusing it
        // locked a conflicted dash's only escape hatch behind the turn. The
        // turn is driven through the real store wire path (the at0099 send +
        // ingestFrame pattern), not simulated on the component.
        //
        // Release is the witness that the turn really is in flight: it keeps
        // the gate, because it destroys the dash. So mid-turn the two controls
        // must disagree — Release disabled, Resolve live — which is the whole
        // of the narrowing, read off the face.
        await app.driveSession("A", { op: "send", text: "hold the turn open" });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RELEASE)})?.disabled === true`,
          { timeoutMs: 8000 },
        );
        expect(
          await app.evalJS<boolean>(
            `(function(){
              var b = document.querySelector(${JSON.stringify(RESOLVE)});
              return b !== null && !b.disabled;
            })()`,
          ),
        ).toBe(true);
        // Scroll it into the shade's scrollport first. The dash lane renders
        // below the changed-file list, whose length is whatever the developer's
        // working tree happens to be, so on a busy tree the row starts under
        // the composer and a bare click lands on the editor instead.
        await app.evalJS<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(RESOLVE)});
            if (el === null) return false;
            el.scrollIntoView({ block: "center" });
            return true;
          })()`,
        );
        await settle(250);
        await app.nativeClickAtElement(RESOLVE);
        // The store flips to resolving synchronously on click, before any
        // server frame — the offer face leaves at once. A Resolve still on
        // screen here IS the incident's dead click.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RESOLVE)}) === null`,
          { timeoutMs: 5000 },
        );
        note("Resolve click registered mid-turn: the offer face left");

        // Close the turn — the rest of the file is an idle-state story, and
        // Adopt below would otherwise be read against a live turn.
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: FEED_CODE_OUTPUT,
          decoded: { tug_session_id: SID, type: "turn_complete", msg_id: "m1", result: "success" },
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RELEASE)})?.disabled === false`,
          { timeoutMs: 8000 },
        );

        // What happens *after* the press is no longer this file's subject. A
        // conflicted resolve now hands off to the resolver, whose refusals and
        // verdicts are pressed in at0426, at0441, at0442, and at0443 against
        // scratch repositories with scripted resolvers. Asserting the ladder's
        // old "still conflicting" dead end here would be asserting a terminal
        // state the flow no longer reaches — and driving the real one would
        // spawn a model against the developer's own checkout.
        //
        // The claim this file keeps is the one only it can make: the press
        // registered, over a real conflict in a real repository, on an unbound
        // card fronting a named join.

        // ── Adopt: the real round trip ────────────────────────────────────
        await app.nativeClickAtElement(ADOPT);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LEAVE)}) !== null`,
          { timeoutMs: 20000 },
        );
        note("Adopt round-tripped: bind_dash_ok flipped the row to Leave");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
