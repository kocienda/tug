/**
 * at0618-release-sheet.test.ts — the Release shade, driven end to end against a
 * scratch project that declares its own release.
 *
 * `/release` is the fourth act of landing ([P12]), and the one that had no
 * surface at all: before this the only way to ship was seven typed commands in
 * a terminal. The shade is where the project's own check runs, where the
 * dispatch is gated on that check's exit code, and where the queued run is
 * watched. Nothing in it knows what a release *is* — the three strings come
 * from `[tugtool.release]` ([B09]) — so the fixture declares two shell scripts
 * and asserts the shade renders exactly what they printed.
 *
 * ## What is driven, and what is deliberately not
 *
 * The **check** runs for real, in tugcast, through the project's declared
 * command, and its rows arrive over the wire. The **gate** is asserted on both
 * sides of one edge: with the check failing, Dispatch is disabled and the
 * confirmed override is offered; with the same check rewritten to pass and
 * re-run from the header, Dispatch comes live.
 *
 * **Dispatch is never pressed.** Not the button and not the override's confirm:
 * a real dispatch runs `gh workflow run`, and a test that presses it is a test
 * that can publish. The override's popover is opened — that is the affordance
 * this file is answerable for — and dismissed with Escape. The queued-run
 * watcher is `release-store.test.ts`' and `feeds/release.rs`' to pin, where a
 * run's frames can be composed rather than waited on.
 *
 * The second case is the honest refusal: a project with no `[tugtool.release]`
 * table cannot have the verb hidden from its completion popup (the slash
 * registry is static), so `/release` answers with a pane bulletin rather than
 * with nothing at all ([L31]).
 *
 * @covers tugdeck/src/lib/release-store.ts
 * @covers tugdeck/src/components/tugways/cards/session-release/session-release-view.tsx
 * @covers tugdeck/src/components/tugways/cards/session-release/session-release-view.css
 * @covers tugdeck/src/lib/shade-view-controller.ts
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugrust/crates/tugcast/src/feeds/release.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000618";
const BARE_SID = "a7c0d1ea-0000-4000-8000-000000001618";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SHEET = `${CARD} .session-view-pane[data-view="release"] [data-slot="tug-sheet"]`;
const ROW = `${SHEET} [data-testid="session-release-row"]`;
const RECHECK = `${SHEET} [data-testid="session-release-recheck"]`;
const DISPATCH = `${SHEET} [data-testid="session-release-dispatch"]`;
const ANYWAY = `${SHEET} [data-testid="session-release-dispatch-anyway"]`;
const POPOVER = '[data-slot="tug-popover"]';
const BULLETIN = ".tug-pane-bulletin";

/** This checkout — the build under test, never the tree the fixture touches. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

/** The two scripts the project declares as its check and its dispatch. */
const CHECK_SCRIPT = ".tugtool/release-check.sh";
const DISPATCH_SCRIPT = ".tugtool/release-dispatch.sh";
/** The rows the failing check prints — one of each mark the gate reads. */
const OK_TEXT = "version 0.0.1 reads the same in all four files";
const FAIL_TEXT = "release-notes/0.0.1.md is still the seed";

/** A check that prints both rows and exits 1 — the gate's closed side. */
const FAILING_CHECK = `printf '  ok  ${OK_TEXT}\\n'
printf 'FAIL  ${FAIL_TEXT}\\n'
exit 1
`;
/** The same check, blessed — the gate's open side, written mid-test. */
const PASSING_CHECK = `printf '  ok  ${OK_TEXT}\\n'
exit 0
`;
/**
 * The dispatch this fixture declares, and never runs. It is here because the
 * table refuses to parse without all three keys (Spec S04), and it exits 1 on
 * purpose: if some future edit ever did press Dispatch, the fixture refuses to
 * be the thing that queued a run.
 */
const DISPATCH_BODY = `echo "at0618: this fixture never dispatches" >&2
exit 1
`;

const RELEASE_CONFIG = `[tugtool.arc]

[tugtool.release]
check    = "sh ${CHECK_SCRIPT}"
dispatch = "sh ${DISPATCH_SCRIPT}"
workflow = "release.yml"
`;

let scratch: ArcScratchRepo | null = null;
let bare: ArcScratchRepo | null = null;
let fixtureDir = "";
let bareFixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";
const bareDir = (): string => bare?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // The configured project: the table and both scripts are part of its first
  // commit, so the check tugcast runs is the one `git ls-files` would show.
  scratch = makeArcScratchRepo({
    prefix: "at0618",
    checkout: CHECKOUT,
    files: {
      ".tugtool/config.toml": RELEASE_CONFIG,
      [CHECK_SCRIPT]: FAILING_CHECK,
      [DISPATCH_SCRIPT]: DISPATCH_BODY,
    },
  });
  fixtureDir = seedScratchSession(projectDir(), SID);
  // And one with nothing declared — `makeArcScratchRepo`'s default config is
  // the arc table alone, which is exactly the unconfigured case.
  bare = makeArcScratchRepo({ prefix: "at0618-bare", checkout: CHECKOUT });
  bareFixtureDir = seedScratchSession(bareDir(), BARE_SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmArcScratchRepo(bare);
  rmScratchSession(fixtureDir);
  rmScratchSession(bareFixtureDir);
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

/** Type a local slash command and submit it, at0405's gesture exactly. */
async function runSlash(
  app: Awaited<ReturnType<typeof launchTugApp>>,
  command: string,
): Promise<void> {
  await app.nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType(command);
  await settle();
  // The completion popup is up over a typed `/`; Escape dismisses it without
  // touching the line, which is what leaves Cmd-Return free to submit.
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

describe.skipIf(!SHOULD_RUN)("AT0618: the Release shade", () => {
  test(
    "the check's rows gate Dispatch, and a passing re-check opens it",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0618-release-sheet",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A spawned session registers the scratch repo as a workspace, which is
        // what makes the aggregate compose it — and the aggregate is where the
        // `release` surface rides ([P09]), so `/release` cannot pass its own
        // guard until the project has been composed once.
        await app.spawnSessionResume("A", {
          tugSessionId: SID,
          projectDir: projectDir(),
        });
        await app.awaitEngineReady("A", { timeoutMs: 15_000 });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8_000 },
        );
        // The Changes shade's all-clear is the cheapest POSITIVE signal that the
        // aggregate has emitted this workspace — a clean-and-composed project,
        // which a freshly committed scratch repo is. The frame that carries it
        // is the frame that carries `release`, and `/release`'s own guard reads
        // that field, so opening the shade before this would race the compose.
        // (Absence of the scanning placeholder would not do: it is also absent
        // before the shade mounts at all.)
        await runSlash(app, "/commit");
        await app.waitForCondition<boolean>(
          `document.querySelector('${CARD} .session-view-pane[data-view="changes"] .session-changes-clean') !== null`,
          { timeoutMs: 30_000 },
        );
        await app.nativeKey("Escape");
        await settle(400);

        // ---- The shade opens, and the check runs itself on open. -----------
        await runSlash(app, "/release");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 8_000 },
        );
        // Two rows, one of each mark the failing script printed. The wait is
        // generous because the command is a real `sh` in a real subprocess.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(ROW)}).length === 2`,
          { timeoutMs: 30_000 },
        );
        const rows = await app.evalJS<Array<{ mark: string; text: string }>>(
          `Array.from(document.querySelectorAll(${JSON.stringify(ROW)})).map(
             function (el) {
               return {
                 mark: el.getAttribute("data-mark") || "",
                 text: (el.innerText || "").trim(),
               };
             },
           )`,
        );
        note(`at0618 rows: ${JSON.stringify(rows)}`);
        expect(rows.map((row) => row.mark)).toEqual(["ok", "fail"]);
        expect(rows[0]?.text).toContain(OK_TEXT);
        expect(rows[1]?.text).toContain(FAIL_TEXT);

        // ---- The gate, closed. --------------------------------------------
        const closed = await app.evalJS<{
          dispatchDisabled: boolean | null;
          anyway: number;
        }>(
          `(function () {
             var d = document.querySelector(${JSON.stringify(DISPATCH)});
             return {
               dispatchDisabled: d === null ? null : d.disabled === true,
               anyway: document.querySelectorAll(${JSON.stringify(ANYWAY)}).length,
             };
           })()`,
        );
        expect(
          closed.dispatchDisabled,
          "a FAIL row means Dispatch cannot be pressed",
        ).toBe(true);
        expect(
          closed.anyway,
          "and the confirmed override is offered instead",
        ).toBe(1);

        // ---- The override is a confirmation, not a second button. ----------
        //
        // Opened and dismissed. Confirming it would queue a real release, so
        // this file goes exactly as far as the affordance and no further.
        await app.nativeClickAtElement(ANYWAY);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(POPOVER)}) !== null`,
          { timeoutMs: 8_000 },
        );
        const confirmText = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(POPOVER)})?.innerText || "")`,
        );
        expect(confirmText).toContain("Dispatch anyway");
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(POPOVER)}) === null`,
          { timeoutMs: 8_000 },
        );
        // Escape closed the popover and not the shade beneath it.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          ),
        ).toBe(true);

        // ---- The gate, opened, by the project's own check changing. --------
        writeFileSync(join(projectDir(), CHECK_SCRIPT), PASSING_CHECK);
        await app.nativeClickAtElement(RECHECK);
        await app.waitForCondition<boolean>(
          `(function () {
             var d = document.querySelector(${JSON.stringify(DISPATCH)});
             return d !== null && d.disabled !== true;
           })()`,
          { timeoutMs: 30_000 },
        );
        const opened = await app.evalJS<{ rows: number; anyway: number }>(
          `(function () {
             return {
               rows: document.querySelectorAll(${JSON.stringify(ROW)}).length,
               anyway: document.querySelectorAll(${JSON.stringify(ANYWAY)}).length,
             };
           })()`,
        );
        expect(opened.rows, "the passing check prints one row").toBe(1);
        expect(
          opened.anyway,
          "and a passing check withdraws the override — there is nothing to override",
        ).toBe(0);
        // Dispatch is live and stays unpressed. The next gesture would publish.
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a project that declares no release table answers the verb with a bulletin",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0618-release-sheet-bare",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: bare?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", {
          tugSessionId: BARE_SID,
          projectDir: bareDir(),
        });
        await app.awaitEngineReady("A", { timeoutMs: 15_000 });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8_000 },
        );

        await app.dispatchControlAction("run-card-command", { name: "release" });
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(BULLETIN)}))
             .some(function (b) {
               return (b.innerText || "").indexOf("[tugtool.release]") !== -1;
             })`,
          { timeoutMs: 15_000 },
        );
        const text = await app.evalJS<string>(
          `Array.from(document.querySelectorAll(${JSON.stringify(BULLETIN)}))
             .map(function (b) { return b.innerText || ""; })
             .join(" | ")`,
        );
        note(`at0618 bare bulletin: ${text}`);
        expect(text).toContain("declares no [tugtool.release]");
        // And the shade did not open on a project with nothing to release.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          ),
        ).toBe(true);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
