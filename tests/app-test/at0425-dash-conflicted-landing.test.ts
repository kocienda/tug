/**
 * at0425-dash-conflicted-landing.test.ts — the conflicted landing face, and
 * per-control accountability on it.
 *
 * ## Why this exists
 *
 * The first real dash landing arrived at the shade exactly here: an unbound
 * card, a join aimed by name, a preview that came back `conflicted` — and the
 * user reported every control as a dead click. The landed outcomes (clean,
 * blocked, empty) all have coverage in at0418; `conflicted` had none, because
 * a real conflict seemed to require moving the developer's `main`. It does
 * not: the fixture owns the dash's worktree, so it can rewind the dash branch
 * to the base's parent and delete a file the base's tip commit modified. The
 * preview's `merge-tree` then reports a genuine delete/modify conflict with no
 * commit on the base and no dirt in the developer's checkout.
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
 *   card is not bound to, under "the dash on this card", with **Adopt** (fronting
 *   is about what is being landed; the binding is about what the card works).
 * - **Join** on a conflicted outcome is disabled and carries its reason.
 * - **Resolve** is enabled, and a click visibly registers at once — the offer
 *   face leaves the moment the store flips to `resolving`, before any server
 *   frame. This is the dead-click assertion: if the click does nothing, the
 *   Resolve affordance is still on screen and the wait below times out.
 * - The ladder's terminal frame lands: the face settles `partial`, naming the
 *   file that is still conflicting.
 * - **Adopt** round-trips for real: the click sends `bind_dash`, and the row
 *   flips to Leave only on the `bind_dash_ok` broadcast that comes back.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-landing.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-lane.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugrust/crates/tugdash-core/src/resolve.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync } from "node:fs";
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
  discardDash,
  smallConflictSubject,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "at0425-session";
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
const OUTCOME = `${ROW} [data-slot="session-changes-dash-landing-outcome"]`;
const RESOLVE = `${ROW} [data-slot="session-changes-dash-resolve"]`;
const JOIN = `${ROW} [data-slot="session-changes-dash-join"]`;
const RELEASE = `${ROW} [data-slot="session-changes-dash-discard"]`;
const REFUSALS = `${ROW} [data-slot="session-changes-dash-landing-refusals"]`;
const CONFLICTS = `${ROW} [data-slot="session-changes-dash-landing-conflicts"]`;
const ARCHAEOLOGY = `${ROW} [data-slot="session-changes-dash-landing-archaeology"]`;
const PARTIAL = `${ROW} [data-slot="session-changes-dash-landing-partial"]`;

const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';

const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));

/** The base-tip file the dash's round deletes — the conflict's subject. */
let conflictFile = "";
/** That base commit's subject — what the archaeology must name under the path. */
let baseSubject = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  discardDash(PROJECT_DIR, DASH);
  const created = createDash(PROJECT_DIR, DASH, "at0425 conflicted fixture");

  // A base commit that modified a small text file, and that file. Rewinding
  // the dash branch to that commit's parent and deleting the file diverges the
  // two sides on it: the base modified what the dash deleted — a delete/modify
  // conflict `merge-tree` must report.
  //
  // The subject comes from the shared helper for determinism, so this file's
  // outcome stops depending on what `main` last touched. It is *not* here for
  // the size bound: a delete/modify short-circuits to unresolved before any
  // rung runs, so no diff is ever produced and the review cap that bites
  // at0426 cannot bite this. Nobody should go looking for one here.
  const subject = smallConflictSubject(PROJECT_DIR);
  conflictFile = subject.path;
  baseSubject = subject.subject;

  // The rewind and the deletion happen in the dash's own worktree — the
  // developer's checkout and the base branch are never touched.
  git(created.worktree, "reset", "--hard", `${subject.commit}~1`);
  rmSync(join(created.worktree, conflictFile));
  commitRound(PROJECT_DIR, DASH, `at0425(round): delete ${conflictFile}`);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  discardDash(PROJECT_DIR, DASH);
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
    "a named join on an unbound card fronts conflicted; Join refuses with its reason, Resolve's click registers and settles partial, Adopt round-trips",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0425-dash-conflicted-landing",
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
        // The Adopt probe's `bind_dash` needs the session in this instance's
        // ledger, or the server has nothing to bind.
        app.seedLedger({
          sessions: [
            {
              session_id: SID,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              card_id: "A",
              name: "at0425 work",
            },
          ],
        });

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
        // the preview fires on its own, and the answer is `conflicted`.
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

        // ── Join: refused, and the refusal has words ──────────────────────
        const joinState = await app.evalJS<{
          disabled: boolean;
          title: string;
          pointerEvents: string;
        }>(
          `(function(){
            var b = document.querySelector(${JSON.stringify(JOIN)});
            return {
              disabled: b ? b.disabled : false,
              title: b ? (b.getAttribute("title") || "") : "",
              pointerEvents: b ? getComputedStyle(b).pointerEvents : "",
            };
          })()`,
        );
        expect(joinState.disabled).toBe(true);
        // The reason arrives as face text, and ONLY as face text. A disabled
        // button takes no pointer events (recorded below), so the `title` this
        // file used to assert could never be read by anyone — carrying one was
        // the defect, not the fix.
        expect(joinState.title).toBe("");
        note(`disabled Join pointer-events: ${joinState.pointerEvents}`);
        expect(
          await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(REFUSALS)})?.textContent || "")`,
          ),
        ).toContain("Resolve the conflicts first");

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

        // The ladder's terminal frame must land, and for a delete/modify it must
        // be `partial` naming the file. No rung may claim a non-content conflict:
        // the per-file walk short-circuits it to unresolved, and rung 2 (rerere)
        // skips it rather than harvesting the surviving side's content as a
        // resolution — the false positive `resolve.rs` used to have here, which
        // reported `resolved` over a candidate equal to the base tree.
        const terminal = await app.waitForCondition<string>(
          `(function(){
            var row = document.querySelector(${JSON.stringify(ROW)});
            if (row === null) return null;
            if (row.querySelector('[data-slot="session-changes-dash-landing-partial"]') !== null) return "partial";
            if (row.querySelector('[data-slot="session-changes-dash-landing-resolved"]') !== null) return "resolved";
            if (row.querySelector('.session-changes-dash-landing-error') !== null) return "error";
            return null;
          })()`,
          { timeoutMs: 60000 },
        );
        // A delete/modify must settle `partial` — no rung may claim a
        // non-content conflict.
        expect(terminal).toBe("partial");
        const partialText = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PARTIAL)})?.textContent || "").trim()`,
        );
        // The face names the file it could not resolve.
        expect(partialText).toContain(conflictFile);
        note(`ladder settled partial: ${partialText}`);

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
