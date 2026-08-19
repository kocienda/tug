/**
 * AT0443 — verification goes red, the face says why, and the override joins.
 *
 * ## Why this exists
 *
 * The human diff-review gate is gone, and what replaced it is the project's own
 * checks run over the tree that would actually land. That trade is only honest
 * if the *failing* half works, and the failing half has three parts that have
 * to hold together:
 *
 * - **The resolver gets to try again.** A red a machine can repair should cost
 *   a machine iteration, not the user's attention — so the failure text goes
 *   back to the resolver as another turn, up to a bounded budget.
 * - **The budget ends, and it ends in a sentence.** A resolver that cannot fix
 *   what it broke must leave a join that says why rather than one that sits
 *   there refusing. This asserts the sentence, on screen.
 * - **Red is a refusal with a door.** The face names the failing command and
 *   mounts **Join anyway** — an override taken in view of the failure, never a
 *   default, never a trap, and never a state with no way forward.
 *
 * ## The arc
 *
 * conflicted → Resolve → the resolver reconciles to something that does not
 * pass → Tier 0 red → the resolver is sent back and produces the same thing →
 * the budget runs out → the face names the failing command and offers **Join
 * anyway** → press it → the composer's join control arms → the dash joins.
 *
 * ## The fixture
 *
 * A one-file scratch repository, as at0441 and at0442. Its declared Tier 0 is a
 * sentinel grep, and the stub resolver writes a body **without** the sentinel —
 * so the tier goes genuinely red over the resolver's own tree, which is the
 * only way this arc can be driven without a toolchain. The iteration budget is
 * not lowered for the test: the stub simply never repairs, which is what a real
 * unrepairable red looks like.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-join.tsx
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugrust/crates/tugcast/src/feeds/join_resolver.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugrust/crates/tugdash-core/src/verify.rs
 * @covers tugrust/crates/tugdash-core/src/workshop.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
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
  gitRetry as git,
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  type JoinScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 420_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000443";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const TOOLBAR = `${CARD} .tug-prompt-entry-toolbar`;
const ROUTE_GROUP = `${TOOLBAR} .tug-prompt-entry-route-group`;
const LAND_BUTTON = `${CARD} .tug-prompt-entry-commit-button`;
const SHEET = '[data-slot="session-changes-view"]';
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH = "at0443-red";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH}"]`;
const JOIN_FACE = `${ROW} [data-slot="session-changes-dash-join"]`;
const RESOLVE = `${ROW} [data-slot="session-changes-dash-resolve"]`;
const VERDICT = `${ROW} [data-slot="session-changes-dash-join-verdict"]`;
const FAILURES = `${ROW} [data-slot="session-changes-dash-join-failures"]`;
const OVERRIDE = `${ROW} [data-slot="session-changes-dash-join-override"]`;
const STUCK = `${ROW} [data-slot="session-changes-dash-join-stuck"]`;
const READY = `${ROW} [data-slot="session-changes-dash-join-ready"]`;

const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';

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

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
const encodeProjectDir = (absDir: string): string => absDir.replace(/[^A-Za-z0-9-]/g, "-");

/** One clean Claude turn, so the session has something to resume onto. */
function buildFixtureJsonl(cwd: string, sessionId: string): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  return (
    [
      {
        ...base,
        parentUuid: null,
        type: "user",
        uuid: "00000000-0000-4000-8000-000000000d01",
        timestamp: new Date(Date.now() - 2000).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
      {
        ...base,
        parentUuid: "00000000-0000-4000-8000-000000000d01",
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000d02",
        timestamp: new Date(Date.now() - 1000).toISOString(),
        message: {
          id: "msg-443-1",
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
  });
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(scratch.repo));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${SID}.jsonl`), buildFixtureJsonl(scratch.repo, SID));
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmJoinScratchRepo(scratch);
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

/** Press a control on the dash row, scrolling it into the shade first. */
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

describe.skipIf(!SHOULD_RUN)("AT0443: a red verdict, and the override past it", () => {
  test(
    "the exam goes red, the face names the failing command, and Join anyway joins",
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

        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector('${LENS_SECTION} [data-slot="lens-dashes-row"][data-dash="${DASH}"]') !== null`,
          { timeoutMs: 30000 },
        );
        await app.dispatchControlAction("toggle-lens");

        await runCommand(app, `/dash-join ${DASH}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN_FACE)})?.getAttribute("data-outcome") === "conflicted"`,
          { timeoutMs: 40000 },
        );
        await settle(400);
        await revealAndClick(app, RESOLVE);

        // ── The red, and what it says ─────────────────────────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(VERDICT)})?.getAttribute("data-verdict") === "red"`,
          { timeoutMs: 240000 },
        );
        const failures = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(FAILURES)})?.textContent || "")`,
        );
        // A red that cannot say why is the silence this whole surface exists
        // to prevent, so the failing command is asserted by name.
        expect(failures, "the red names the command that failed").toContain("grep");
        note(`at0443 red: ${JSON.stringify(failures)}`);

        // The resolver spent its budget before the face ever went red, and the
        // sentence that says so is durable — it comes back on the feed rather
        // than living in the overlay that started the run.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(STUCK)}) !== null`,
          { timeoutMs: 60000 },
        );
        const stuck = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(STUCK)})?.textContent || "")`,
        );
        expect(stuck, "the exhausted budget is stated, not implied").toContain("passes");
        note(`at0443 stuck: ${JSON.stringify(stuck)}`);

        // ── The door ──────────────────────────────────────────────────────
        // Refused, and the control that carries it forward is on screen — the
        // reachability invariant, over the one state whose answer is an
        // override rather than a fix.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(READY)})?.getAttribute("data-ready") === "true"`,
          ),
          "a red join is not landable",
        ).toBe(false);
        await revealAndClick(app, OVERRIDE);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(READY)})?.getAttribute("data-ready") === "true"`,
          { timeoutMs: 30000 },
        );
        note("at0443 override: the red join reads landable once the user says so");

        // ── The join it opens ─────────────────────────────────────────────
        // `/dash-join` toggles, and the command that raised the lane left the
        // card in join mode — so the route is re-entered only if it left.
        if (!(await inJoinMode(app))) await runCommand(app, `/dash-join ${DASH}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="changes"][data-state="active"]`)}) !== null`,
          { timeoutMs: 20000 },
        );
        await app.nativeClickAtElement(EDITOR);
        await app.nativeType(JOIN_MESSAGE);
        await settle(400);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LAND_BUTTON)})?.hasAttribute("disabled") === false`,
          { timeoutMs: 20000 },
        );
        await app.nativeClickAtElement(LAND_BUTTON);

        // The dash's work is on the base branch. Polled on git rather than on
        // the row leaving, because the row can leave for reasons that are not
        // a join — and what this beat claims is about the base branch.
        const deadline = Date.now() + 90_000;
        let subject = "";
        while (Date.now() < deadline) {
          subject = git(repo, "log", "-1", "--format=%s", "main").trim();
          if (subject.includes(DASH)) break;
          await settle(500);
        }
        if (!subject.includes(DASH)) {
          note(
            `at0443 join did not land; face reads ${JSON.stringify(
              await app.evalJS<string>(
                `(document.querySelector(${JSON.stringify(JOIN_FACE)})?.textContent || "<no face>")`,
              ),
            )} composer reads ${JSON.stringify(
              await app.evalJS<string>(
                `(document.querySelector(${JSON.stringify(TOOLBAR)})?.textContent || "<no toolbar>")`,
              ),
            )}`,
          );
        }
        expect(subject, "the override's join landed a squash on the base").toContain(DASH);
        expect(
          git(repo, "show", `main:${FILE}`),
          "and it landed the tree the checks refused, which is what an override means",
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
