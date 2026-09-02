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
 * driveable end to end from the real app against a real dash, and both are
 * here.
 *
 * **A base copy the dash already carries is not a blocker.** The fixture writes
 * onto the base, uncommitted, exactly the bytes the dash committed. The shade
 * shows no `base-dirt` refusal at all, because dropping such a copy destroys
 * nothing — those bytes are on the dash branch — so the join drops it and
 * lands the same content rather than refusing to land bytes on the grounds
 * that they are already there.
 *
 * **A divergent copy of the user's own is one Resolve.** The fixture then
 * writes different bytes to the same path. The refusal is stated once, on the
 * row's own register line; the report under it does not say it a second time,
 * and carries instead what that line cannot — the sentence saying what Resolve
 * will do, and `Resolve` itself, live because the server said it may be. The
 * remedy is in the sentence, never in the button, and the retired advice
 * ("stash") appears nowhere. What the press *does* is pinned in
 * `tugarc-core` instead; the comment at that point in the test says why the
 * harness cannot drive it.
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
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-join.tsx
 * @covers tugdeck/src/lib/changeset-join-store.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  bindDash,
  commitRound,
  createDash,
  gitRetry,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000486";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH_NAME = "at0486-resolve";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH_NAME}"]`;
const ROW_FOLD = `${ROW} [data-slot="session-changes-dash-fold"]`;
const BLOCKERS = `${SHEET} [data-slot="session-changes-arc-join-blockers"]`;
const BASE_DIRT = `${BLOCKERS} [data-blocker="base-dirt"]`;
const RESOLVE = `${BASE_DIRT} [data-slot="session-changes-arc-join-resolve-base"]`;
/** The row's own line — where the refusal is stated, once. */
const REGISTER = `${ROW} [data-slot="arc-join-register"]`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/** The path both sides touch, and the bytes the dash lands on it. */
const SHARED = "at0486-shared.txt";
const DASH_BYTES = "seed\nthe dash's own line\n";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0486", checkout: CHECKOUT });
  writeFileSync(join(projectDir(), SHARED), "seed\n");
  // Committed, so the base starts CLEAN. Case A's claim is that a blocker
  // never appears over an identical copy, and a base that begins dirty would
  // let a stale refusal stand in for one.
  gitRetry(projectDir(), "add", SHARED);
  gitRetry(projectDir(), "commit", "-m", "at0486: the shared file both sides touch");
  const created = createDash(projectDir(), DASH_NAME, "at0486 fixture", scratch.cli);
  // One round, changing the shared path — which is what makes any base-side
  // edit to it an *overlap* rather than disjoint dirt the join never touches.
  writeFileSync(join(created.worktree, SHARED), DASH_BYTES);
  commitRound(projectDir(), DASH_NAME, "at0486(round): the dash changes the shared file", scratch.cli);
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
      const app = await launchTugApp({ testName: "at0486-join-base-resolve" });
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
        // dash that carries a landing, and the fold is where the report goes
        // ([D143]). Bind, then open it.
        bindDash(projectDir(), DASH_NAME, SID, scratch?.cli ?? {});
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
        // A · the base holds the dash's own bytes. Not a refusal.
        // ---------------------------------------------------------------
        writeFileSync(join(projectDir(), SHARED), DASH_BYTES);
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

        const label = await app.evalJS<string>(
          `document.querySelector(${JSON.stringify(RESOLVE)})?.textContent ?? ""`,
        );
        expect(label).toContain("Resolve");
        const disabled = await app.evalJS<boolean>(
          `document.querySelector(${JSON.stringify(RESOLVE)}).disabled`,
        );
        expect(disabled).toBe(false);

        // The press itself is deliberately not driven here, and the reason is
        // the harness rather than the feature. A dash op that writes state —
        // and a resolve writes an op-log record, so `dash undo` can reverse
        // it — resolves its data root from `TUG_DATA_DIR`, which the fixture
        // redirects for the *CLI* it drives but cannot redirect for the app
        // process itself. `refuse_unredirected_temp_repo` then correctly
        // refuses to write a scratch repo's dash state into the live data
        // directory, in debug builds, which is every app-test build. So what
        // the press does is pinned where it is decided, over a real repo with
        // a real op log: `resolve_base_folds_the_users_own_edit_onto_the_base`
        // in `tugarc-core`, which also asserts the undo puts the work back
        // uncommitted.
        note(
          "divergent base copy: the refusal once on the register, the act and a live Resolve below it",
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
