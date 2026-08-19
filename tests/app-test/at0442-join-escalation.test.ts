/**
 * AT0442 — the resolver asks, the user answers, and the join finishes.
 *
 * ## Why this exists
 *
 * The resolver reconciles a merge from what each side was *trying to do*, and
 * most conflicts have an answer that serves both. Some do not: two sides can
 * want genuinely incompatible things, and a resolver that guesses past that is
 * worse than one that stops. So the charter gives it exactly one escape —
 * ask, once, phrased as intent, with two to four concrete resolutions — and
 * this file is the proof that the escape reaches a human and comes back.
 *
 * It is the one arc where the join is *blocked on a person*, and every part of
 * it is a seam that has failed before in this pipeline:
 *
 * - The question must reach the card. It rides a CONTROL frame, which is
 *   droppable by design, **and** a durable fact on the dash — this asserts the
 *   surface, which is downstream of both.
 * - The surface must be the shipped question component, not a hand-rolled
 *   dialog. What renders here is `QuestionWizard` through its host seam: the
 *   join supplies the transport, the wizard supplies the surface, and the
 *   transcript path that also mounts it is untouched.
 * - The answer must reach the *waiting* resolver. It is addressed by
 *   `request_id` through a rendezvous, not by dash, so an answer cannot
 *   resolve a question it was not written for.
 *
 * ## The arc
 *
 * conflicted → Resolve → the resolver asks → the question renders on the join
 * face → press an option → the resolver takes the answer verbatim and finishes
 * → Tier 0 green → the row states its join route.
 *
 * ## The fixture
 *
 * A one-file scratch repository whose file both sides rewrite wholesale, so
 * `merge-tree` genuinely conflicts. The stub resolver prints the ask shape,
 * blocks on stdin for the answer, writes the answer into the file, and reports
 * — the same two terminal shapes and the same parse-and-wait path the real
 * spawn takes; only the transport differs. Writing the answer into the file is
 * what makes "verbatim" checkable: the assertion reads the joined tree.
 *
 * @covers tugdeck/src/components/tugways/chrome/session-question-dialog.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-join.tsx
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugrust/crates/tugcast/src/feeds/join_resolver.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 * @covers tugrust/crates/tugdash-core/src/resolve.rs
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
const TEST_TIMEOUT_MS = 300_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000442";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = '[data-slot="session-changes-view"]';
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH = "at0442-ask";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH}"]`;
const JOIN_FACE = `${ROW} [data-slot="session-changes-dash-join"]`;
const RESOLVE = `${ROW} [data-slot="session-changes-dash-resolve"]`;
const QUESTION = `${ROW} [data-slot="session-changes-dash-join-question"]`;
const WIZARD = `${QUESTION} [data-slot="session-question-dialog"]`;
const VERDICT = `${ROW} [data-slot="session-changes-dash-join-verdict"]`;
const READY = `${ROW} [data-slot="session-changes-dash-join-ready"]`;

const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';

/** The checkout whose built binaries the fixture drives. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

const FILE = "subject.txt";
const QUESTION_TEXT = "Which naming should the merged file keep?";
/** The option the test presses — and, verbatim, what lands in the file. */
const CHOSEN = "SENTINEL keep the dash naming";
const OTHER = "SENTINEL keep the base naming";

/**
 * Ask, wait, then resolve to the answer itself.
 *
 * The answer arrives wrapped in the charter's re-entry sentence, so the stub
 * strips to the option text with `sed`. Writing it into the file is what makes
 * "handed to the resolver verbatim" an assertion about bytes rather than about
 * a log line.
 */
const RESOLVER_STUB = `#!/bin/sh
ws="$1"
read -r _charter
printf '%s\\n' '{"ask":{"question":"${QUESTION_TEXT}","options":[{"label":"${CHOSEN}","description":"the dash renamed it deliberately"},{"label":"${OTHER}","description":"the base renamed it deliberately"}]}}'
read -r answer
printf '%s\\n' "$answer" | sed -e 's/.*SENTINEL/SENTINEL/' -e 's/\\\\n.*//' > "$ws/${FILE}"
printf '%s\\n' '{"files":[{"path":"${FILE}","resolved_by":"resolver","what_each_side_did":"both renamed it","reconciliation":"took the answer"}],"notes":"at0442"}'
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
        uuid: "00000000-0000-4000-8000-000000000e01",
        timestamp: new Date(Date.now() - 2000).toISOString(),
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
      {
        ...base,
        parentUuid: "00000000-0000-4000-8000-000000000e01",
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000e02",
        timestamp: new Date(Date.now() - 1000).toISOString(),
        message: {
          id: "msg-442-1",
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
    prefix: "at0442",
    dash: DASH,
    description: "at0442 escalation fixture",
    checkout: CHECKOUT,
    file: FILE,
    fork: "at0442 the body both sides will rewrite\n",
    base: "at0442 base side — the whole file, rewritten\n",
    dashBody: "at0442 dash side — the whole file, rewritten\n",
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

async function openOnDash(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0442: the resolver's escalation", () => {
  test(
    "the resolver asks on the join face, the answer returns verbatim, and the join finishes",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const repo = scratch?.repo ?? "";
      const app = await launchTugApp({
        testName: "at0442-join-escalation",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await openOnDash(app);
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: repo });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // The aggregate has composed the dash once the Lens roster lists it.
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

        // ── The ask reaches the face ──────────────────────────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(WIZARD)}) !== null`,
          { timeoutMs: 120000 },
        );
        const asked = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(QUESTION)})?.textContent || "")`,
        );
        // Phrased as intent, with concrete resolutions — never a diff. That is
        // the charter's requirement and the reason the escalation exists at
        // all, so the surface is asserted to carry both halves.
        expect(asked, "the question is the resolver's own").toContain(QUESTION_TEXT);
        expect(asked, "and both resolutions are offered").toContain(CHOSEN);
        expect(asked, "including the one not taken").toContain(OTHER);
        note(`at0442 asked: ${JSON.stringify(QUESTION_TEXT)}`);

        // ── The answer goes back ──────────────────────────────────────────
        // Pressed through the same DOM a person would: the option row, then
        // the wizard's own Submit in its action bar (at0146's selectors).
        await revealAndClick(
          app,
          `${WIZARD} .session-question-dialog-options-list [data-option-label="${CHOSEN}"]`,
        );
        await settle(300);
        await revealAndClick(
          app,
          `${WIZARD} .session-question-dialog-actionbar-buttons .tug-button-primary-action`,
        );

        // ── The resolver finishes on the answer ───────────────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(VERDICT)})?.getAttribute("data-verdict") === "green"`,
          { timeoutMs: 180000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(WIZARD)}) === null`,
          ),
          "an answered question stops standing",
        ).toBe(true);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(READY)})?.getAttribute("data-ready") === "true"`,
          { timeoutMs: 30000 },
        );
        note("at0442 resolved: the answered resolver reached a verified candidate");

        // The answer reached the resolver as the user's own words. Read the
        // candidate's own blob rather than a frame or a log line: the claim is
        // about what would actually join, and only the tree can settle it.
        const merged = git(repo, "show", `refs/tug/join/${DASH}:${FILE}`);
        expect(merged.trim(), "the option's label reached the resolver verbatim").toBe(
          CHOSEN,
        );
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
