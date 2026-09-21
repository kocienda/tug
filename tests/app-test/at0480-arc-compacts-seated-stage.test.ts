/**
 * at0480-arc-compacts-seated-stage.test.ts — a seated implement stage that has
 * crossed the compaction threshold is compacted in place, and then walks on.
 *
 * ## Why this exists
 *
 * The predicate's decision and the runner's delivery are both pinned in Rust,
 * over synthesized facts and an in-memory supervisor. What no fixture can
 * build is the thing the whole arc is for: a **real** claude, seated by a real
 * rotation, whose window a real turn filled, told between turns to compact
 * itself and then to keep walking its plan. A `stage_label` is written only by
 * a rotation the wheel actually performed, so nothing short of a live run
 * produces the state this asserts over.
 *
 * ## What is asserted, and what deliberately is not
 *
 * The claim is about **Tug**: the arc read the boundary, decided a compaction,
 * delivered it as a `Wheel`-labelled row, recorded it on the arc log and the
 * arc record, and then continued the stage with the next step range.
 *
 * Whether claude *honors* the `/compact` — a `compact_boundary` divider and
 * the summary that follows it — is claude's call, and on a scratch plan two
 * steps long it will usually decline: the captured
 * `stream-json-catalog/v2.1.204/test-19-slash-compact.jsonl` is exactly that
 * turn, and it carries no `compact_boundary` at all. So nothing here waits on
 * one. If a divider does arrive it is `note()`d as an observation and gates
 * nothing.
 *
 * ## Running it
 *
 * On demand only. It drives a real claude through two stages and costs real
 * minutes and real tokens, so `app-test-changed` skips it:
 *
 *     TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0480-arc-compacts-seated-stage.test.ts
 *
 * @covers tugrust/crates/tugcast/src/feeds/arc.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 * @covers tugdeck/src/components/tugways/cards/session-notice-line.tsx
 * @covers tugdeck/src/components/tugways/cards/session-boundary.tsx
 * @covers tugdeck/src/lib/arc-meta-facts.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createArc,
  arcLogPath,
  arcPlanPath,
  discardArc,
  fixturePlanDocument,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

/**
 * Two gates, and they mean different things. `TUGAPP_APP_TEST` is every
 * app-test's gate; `TUG_REAL_CLAUDE` is this file's own, because a real claude
 * run is not something a derived selection should ever start on its own.
 */
const SHOULD_RUN =
  process.env.TUGAPP_APP_TEST === "1" && process.env.TUG_REAL_CLAUDE === "1";
const GATED_OFF = process.env.TUGAPP_APP_TEST === "1" && !SHOULD_RUN;

/** Two real stages and two real steps: minutes, not seconds. */
const TEST_TIMEOUT_MS = 900_000;
const STAGE_WAIT_MS = 300_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000480";
const CARD = '[data-card-id="A"]';
const NOTICE_ROWS = `${CARD} [data-slot="tug-notice"]`;
const STAGE_DIVIDERS = `${CARD} [data-boundary="stage"]`;

const ARC_NAME = "at0480-compact";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

/**
 * A threshold no real turn can stay under, so the first step boundary
 * compacts. It is raised out of reach the moment the compaction is observed —
 * see `LOOSE_CONFIG`.
 */
const SCRATCH_CONFIG = `[tugtool.arc]
implement_compact_tokens = 1
`;

/**
 * The threshold, out of reach. Written once the compaction has been seen,
 * because the arc's second answer to a context still over the line is a
 * rotation, and claude usually declines a `/compact` on a plan this small —
 * so leaving the threshold at 1 would rotate the stage away rather than
 * continue it. Raising it isolates the compaction the same way a second
 * threshold used to: what the test observes next cannot be a rotation wearing
 * the continue's clothes. The arc reads the project's config on every tick,
 * so the new line is in force by the next boundary.
 */
const LOOSE_CONFIG = `[tugtool.arc]
implement_compact_tokens = 1000000000
`;

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (GATED_OFF) {
    note(
      "at0480 skipped",
      "real-claude only — run with TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0480-arc-compacts-seated-stage.test.ts",
    );
  }
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0480", checkout: CHECKOUT });
  createArc(projectDir(), ARC_NAME, "at0480 compaction fixture", scratch.cli);
  // A plan and **no brief**: the document an arc's run opens on is its brief
  // when it has one, so writing none is what puts the plan in that seat — and
  // a document that lints as a plan skips devise entirely.
  writeFileSync(arcPlanPath(projectDir(), ARC_NAME), fixturePlanDocument(2));
  writeFileSync(resolve(projectDir(), ".tugtool", "config.toml"), SCRATCH_CONFIG);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  discardArc(projectDir(), ARC_NAME, scratch?.cli);
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 660 },
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

async function openCard(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
}

/** Run a shell command on the card through its own `$` route. */
async function shell(app: App, command: string): Promise<void> {
  const prompt = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
  await app.nativeClickAtElement(prompt);
  await app.nativeType(`/shell ${command}`);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
}

/** Every wheel-attributed notice row's text, in transcript order. */
async function wheelNotices(app: App): Promise<string[]> {
  const raw = await app.evalJS<string>(
    `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
      NOTICE_ROWS,
    )})).filter((el) => el.getAttribute("data-notice-origin") === "wheel")
       .map((el) => el.textContent || ""))`,
  );
  return JSON.parse(raw) as string[];
}

/** Wait until a wheel notice whose text contains `marker` is on the card. */
async function waitForWheelNotice(app: App, marker: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `Array.from(document.querySelectorAll(${JSON.stringify(NOTICE_ROWS)}))
       .filter((el) => el.getAttribute("data-notice-origin") === "wheel")
       .some((el) => (el.textContent || "").indexOf(${JSON.stringify(marker)}) !== -1)`,
    { timeoutMs: STAGE_WAIT_MS },
  );
}

/** The arc log's `compact` lines for this arc, as their notes. */
function compactNotes(): string[] {
  const log = readFileSync(arcLogPath(scratch?.dataRoot ?? ""), "utf8");
  return log
    .split("\n")
    .map((line) => line.split(/\s{2,}/).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 4 && cells[1] === ARC_NAME && cells[2] === "compact")
    .map((cells) => cells[3] ?? "");
}

describe.skipIf(!SHOULD_RUN)("AT0480: the arc compacts a seated implement stage", () => {
  test(
    "a step boundary above the threshold compacts the session, and the stage walks on",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0480-arc-compacts-seated-stage",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app);

        // Opening the arc binds this card and starts the wheel: review first,
        // because the document lints as a plan, then implement once the review
        // stage has ended a turn.
        await shell(app, `${cli} arc run ${ARC_NAME}`);
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(STAGE_DIVIDERS)}))
             .some((el) => (el.textContent || "").indexOf("implement") !== -1)`,
          { timeoutMs: STAGE_WAIT_MS },
        );
        note("at0480 implement stage seated", (await app.screenshot()).path);

        // The stage closes its first step and ends its turn. The boundary is
        // above a one-token threshold, so the arc's answer is a compaction —
        // delivered as a row the card attributes to the Wheel, not to the user.
        await waitForWheelNotice(app, "/compact");
        note("at0480 wheel rows after the compaction", JSON.stringify(await wheelNotices(app)));
        writeFileSync(resolve(projectDir(), ".tugtool", "config.toml"), LOOSE_CONFIG);

        // And it said so where a reader can find it: the arc log line, whose
        // note is the context that decided against the threshold that decided
        // it.
        const notes = compactNotes();
        note("at0480 arc log compact lines", JSON.stringify(notes));
        expect(notes.length).toBeGreaterThanOrEqual(1);
        expect(notes[0]).toMatch(/^\d+ > 1$/);

        // Then the stage keeps its session and walks on: the compact turn
        // closed no step, so the boundary it ends on is the compaction's, and
        // the arc's next word is the continue for what the ledger has left.
        await waitForWheelNotice(app, "Steps 2-2");
        note("at0480 card after the continue", (await app.screenshot()).path);

        // The placard reads the same act off the arc record.
        const arc = JSON.parse(
          tugtool(["arc", "record", ARC_NAME, "--json"], {
            cwd: projectDir(),
            binaryRoot: CHECKOUT,
            env: scratch?.cli.env,
          }),
        ) as { data: { arc: { notes: string[] } | null } };
        const arcNotes = arc.data.arc?.notes ?? [];
        note("at0480 arc notes", JSON.stringify(arcNotes));
        expect(arcNotes.some((n) => n.startsWith("compacted at "))).toBe(true);

        // Whether claude honored the compaction is claude's call, and gates
        // nothing — on a plan this small it usually declines.
        const honored = await app.evalJS<string>(
          `String(document.querySelectorAll(${JSON.stringify(
            `${CARD} [data-boundary="compaction"]`,
          )}).length)`,
        );
        note("at0480 compact_boundary dividers observed", honored);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
