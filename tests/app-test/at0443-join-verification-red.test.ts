/**
 * AT0443 — a red verdict makes the join press a decision.
 *
 * ## Why this exists
 *
 * The human diff-review gate is gone, and what replaced it is the project's own
 * checks run over the tree that would actually land. That trade is only honest
 * if the *failing* half works — and the failing half was, until the arc, a
 * refusal with a second button beside it. `JOIN ANYWAY` on the shade was a
 * control that existed only because the gate refused: the reader pressed it,
 * the gate stopped refusing, and then they pressed the *real* control
 * somewhere else. Two presses for one decision, taken in two rooms.
 *
 * So a red no longer refuses the gate at all. It arms the press the user was
 * already reaching for ([P05]): the composer's land button takes the danger
 * role, and pressing it opens a confirm naming the failing checks rather than
 * landing. Answering that confirm is the decision, and it is a decision made
 * in view of the failure, at the moment of acting, in one place.
 *
 * Three claims, in order:
 *
 * - **The red is stated, and it names what failed.** A verdict that cannot say
 *   why is the silence this whole surface exists to prevent.
 * - **The press is armed, not refused.** The button carries the danger role and
 *   opens a confirm; the confirm's question is the red, in words.
 * - **Confirming lands, and lands the refused tree.** Which is what an override
 *   means — anything else would be a confirm that quietly did something safer.
 *
 * ## The arc
 *
 * built → the pilot reconciles → the resolver produces something that does not
 * pass → Tier 0 red → the resolver is sent back and produces the same thing →
 * the budget runs out → the register states the resolver's own refusal (which
 * outranks the colour that caused it) and the shade names the failing
 * command → enter join mode → the land button is `danger` → press it → a
 * confirm, not a landing → confirm → the dash joins, carrying the tree the
 * checks refused.
 *
 * ## The fixture
 *
 * A one-file scratch repository. Its declared Tier 0 is a sentinel grep, and
 * the stub resolver writes a body **without** the sentinel — so the tier goes
 * genuinely red over the resolver's own tree, which is the only way this arc
 * can be driven without a toolchain. The iteration budget is not lowered for
 * the test: the stub simply never repairs, which is what a real unrepairable
 * red looks like. The dash is declared `built`, so the whole red is reached
 * with nothing pressed.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-join.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/landing-mode.ts
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugdeck/src/lib/dash-join-register.ts
 * @covers tugrust/crates/tugcast/src/feeds/join_resolver.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_pilot.rs
 * @covers tugrust/crates/tugdash-core/src/verify.rs
 * @covers tugrust/crates/tugdash-core/src/workshop.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  gitRetry as git,
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type JoinScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 420_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000443";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const TOOLBAR = `${CARD} .tug-prompt-entry-toolbar`;
const ROUTE_GROUP = `${TOOLBAR} .tug-prompt-entry-route-group`;
const LAND_BUTTON = `${CARD} [data-testid="tug-prompt-entry-commit-button"]`;
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CONFIRM_MESSAGE = `${CONFIRM} [data-slot="tug-confirm-message"]`;
const CONFIRM_OK = `${CONFIRM} [data-slot="tug-confirm-confirm"]`;
const CONFIRM_CANCEL = `${CONFIRM} [data-slot="tug-confirm-cancel"]`;
const SHEET = '[data-slot="session-changes-view"]';
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH = "at0443-red";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH}"]`;
const VERDICT = `${ROW} [data-slot="session-changes-dash-join-verdict"]`;
const FAILURES = `${ROW} [data-slot="session-changes-dash-join-failures"]`;
const STUCK = `${ROW} [data-slot="session-changes-dash-join-stuck"]`;
/** The control that used to stand here. It is the confirm now ([P05], [P08]). */
const OVERRIDE = `${ROW} [data-slot="session-changes-dash-join-override"]`;

const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';
const LENS_REGISTER = `${LENS_SECTION} [data-slot="lens-dashes-row"][data-dash="${DASH}"] [data-slot="dash-join-register"]`;

/** The checkout whose built binaries the fixture drives. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

const FILE = "subject.txt";
/** What the resolver writes — deliberately missing the sentinel Tier 0 wants. */
const UNVERIFIABLE = "at0443 reconciled, and it does not pass\n";
const JOIN_MESSAGE = "joined past a red verdict, deliberately";

/**
 * Never repairs. Every turn — the charter and each Tier 0 failure that follows
 * it — gets the same body back, which is what an unrepairable red looks like
 * from the orchestrator's side.
 */
const RESOLVER_STUB = `#!/bin/sh
ws="$1"
while read -r _line; do
  printf '%s' '${UNVERIFIABLE}' > "$ws/${FILE}"
  printf '%s\\n' '{"files":[{"path":"${FILE}","resolved_by":"resolver","what_each_side_did":"both rewrote it","reconciliation":"took the dash side"}],"notes":"at0443"}'
done
`;

let scratch: JoinScratchRepo | null = null;
let fixtureDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeJoinScratchRepo({
    prefix: "at0443",
    dash: DASH,
    description: "at0443 red-verdict fixture",
    checkout: CHECKOUT,
    file: FILE,
    fork: "at0443 the body both sides will rewrite\n",
    base: "at0443 base side — the whole file, rewritten\n",
    dashBody: "at0443 dash side — the whole file, rewritten\n",
    verifyTier0: `grep -q SENTINEL ${FILE}`,
    resolver: RESOLVER_STUB,
    // The pilot's, not the test's: the whole red is reached with nothing
    // pressed, which is the only way to observe that the pilot reached it.
    built: true,
  });
  fixtureDir = seedScratchSession(scratch.repo, SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmJoinScratchRepo(scratch);
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

async function openOnDash(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15000 },
  );
}

/** Put the composer back on the prompt route, where slash commands are read. */
async function returnToPrompt(app: App): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await settle();
  await app.nativeKey("Escape");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="prompt"][data-state="active"]`)}) !== null`,
    { timeoutMs: 8000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0443: a red verdict, and the decision past it", () => {
  test(
    "the checks go red unprompted, the shade names the failing command, and the armed press asks before it lands",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const repo = scratch?.repo ?? "";
      const app = await launchTugApp({
        testName: "at0443-join-verification-red",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await openOnDash(app);
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: repo });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // ── The red, reached by the machine ───────────────────────────────
        // Nothing is pressed to get here. The dash is `built`, the pilot
        // reconciles it, the resolver spends its budget failing to make the
        // checks pass, and the register settles red.
        // The word is `stuck`, not `checks-red`, and the ordering is the point:
        // a refusal the resolver has already STATED outranks the verdict that
        // caused it. The resolver spent its whole budget failing to make the
        // checks pass, and what the register owes the reader is the sentence
        // about that rather than a colour.
        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LENS_REGISTER)})?.getAttribute("data-word") === "stuck"`,
          { timeoutMs: 300000 },
        );
        note(
          `at0443 unprompted red: ${JSON.stringify(
            await app.evalJS<string>(
              `(document.querySelector(${JSON.stringify(LENS_REGISTER)})?.textContent || "")`,
            ),
          )}`,
        );
        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LENS_SECTION)}) === null`,
          { timeoutMs: 8000 },
        );

        // ── What the shade says about it ──────────────────────────────────
        // The join face belongs to the fronted row, so the dash is aimed at
        // first. That is a gesture about which row the composer is pointed at,
        // and it comes after every claim above about the machine working alone.
        await runCommand(app, `/dash-join ${DASH}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(VERDICT)})?.getAttribute("data-verdict") === "red"`,
          { timeoutMs: 60000 },
        );
        const red = await app.evalJS<{ failures: string; stuck: string; override: number }>(
          `(function(){
            return {
              failures: (document.querySelector(${JSON.stringify(FAILURES)})?.textContent || ""),
              stuck: (document.querySelector(${JSON.stringify(STUCK)})?.textContent || ""),
              override: document.querySelectorAll(${JSON.stringify(OVERRIDE)}).length,
            };
          })()`,
        );
        // A red that cannot say why is the silence this surface exists to
        // prevent, so the failing command is asserted by name.
        expect(red.failures, "the red names the command that failed").toContain("grep");
        // The resolver spent its budget before the verdict settled, and the
        // sentence that says so is durable — it comes back on the feed rather
        // than living in an overlay.
        expect(red.stuck, "the exhausted budget is stated, not implied").toContain("passes");
        // And the door out is NOT here. The shade states; the composer acts.
        expect(red.override, "the shade offers no way past the red").toBe(0);
        note(`at0443 shade: failures ${JSON.stringify(red.failures)} stuck ${JSON.stringify(red.stuck)}`);

        // ── The armed press ───────────────────────────────────────────────
        await returnToPrompt(app);
        if (!(await inJoinMode(app))) await runCommand(app, `/dash-join ${DASH}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="changes"][data-state="active"]`)}) !== null`,
          { timeoutMs: 20000 },
        );
        await app.nativeClickAtElement(EDITOR);
        await app.nativeType(JOIN_MESSAGE);
        await settle(400);
        // The role rides the button's class — `.tug-button-{emphasis}-{role}`
        // is where [D02]'s matrix lands. A red join is a decision, and the
        // button says so before it is pressed.
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(LAND_BUTTON)})?.className || "").indexOf("danger") !== -1`,
          { timeoutMs: 20000 },
        );
        const armed = await app.evalJS<boolean>(
          `document.querySelector(${JSON.stringify(LAND_BUTTON)})?.hasAttribute("disabled") === false`,
        );
        // Armed, not refused. The gate passes a red now; what stands between
        // the press and the landing is a question, not a wall.
        expect(armed, "a red join is armed rather than blocked").toBe(true);

        // ── The press asks ────────────────────────────────────────────────
        const beforePress = git(repo, "rev-parse", "main").trim();
        await app.nativeClickAtElement(LAND_BUTTON);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
          { timeoutMs: 10000 },
        );
        const question = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(CONFIRM_MESSAGE)})?.textContent || "").trim()`,
        );
        note(`at0443 confirm: ${JSON.stringify(question)}`);
        // The question is the red, in words — not "are you sure".
        expect(question, "the confirm names what it is asking about").toContain("red");
        expect(question, "and how much of it there is").toContain("1 failing check");
        expect(
          git(repo, "rev-parse", "main").trim(),
          "and the press that opened it landed nothing",
        ).toBe(beforePress);

        // Cancelling is not a landing either — the arming beat must be
        // answerable both ways or it is a trap rather than a question.
        await app.nativeClickAtElement(CONFIRM_CANCEL);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) === null`,
          { timeoutMs: 8000 },
        );
        await settle(1000);
        expect(git(repo, "rev-parse", "main").trim(), "cancel lands nothing").toBe(beforePress);

        // ── And confirming lands ──────────────────────────────────────────
        await app.nativeClickAtElement(LAND_BUTTON);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
          { timeoutMs: 10000 },
        );
        await app.nativeClickAtElement(CONFIRM_OK);

        const deadline = Date.now() + 90_000;
        let subject = "";
        while (Date.now() < deadline) {
          subject = git(repo, "log", "-1", "--format=%s", "main").trim();
          if (subject.includes(DASH)) break;
          await settle(500);
        }
        if (!subject.includes(DASH)) {
          note(
            `at0443 join did not land; composer reads ${JSON.stringify(
              await app.evalJS<string>(
                `(document.querySelector(${JSON.stringify(TOOLBAR)})?.textContent || "<no toolbar>")`,
              ),
            )}`,
          );
        }
        expect(subject, "the confirmed press landed a squash on the base").toContain(DASH);
        expect(
          git(repo, "show", `main:${FILE}`),
          "and it landed the tree the checks refused, which is what the decision meant",
        ).toBe(UNVERIFIABLE);
        note(`at0443 joined past the red: ${JSON.stringify(subject)}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
