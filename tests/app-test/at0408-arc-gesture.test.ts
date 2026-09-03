/**
 * at0408-arc-gesture.test.ts — `/arc-bind`, all four ways it can go.
 *
 * The command means "work on this arc, making it if needed", and it takes
 * each of its two paths for what that path is. A name the card's snapshot
 * already knows is a pure UI-concept write: a `bind_arc` CONTROL frame,
 * silent, no transcript ink — so this asserts the chip arrives with **no**
 * shell row behind it. A name it does not know is a git mutation, so it goes
 * through the shell route and leaves a receipt saying what was made, and
 * `arc create`'s own auto-bind is what ends the card bound.
 *
 * The other two ways are the ones that must not mutate anything: bare
 * `/arc-bind` opens the picker sheet (the full picking behavior is at0421's;
 * what this file pins is that the bare form no longer shows the shade), and a
 * name that could not be passed through a shell unquoted is refused with a
 * caution naming the constraint rather than turned into a quoting adventure.
 *
 * The run waits for the aggregate to answer before typing anything. That is
 * not politeness: before the first compose every name misses the snapshot
 * match, and `/arc-bind <known-name>` would fall through to the create path and
 * cut a second branch for an arc that already exists.
 *
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugdeck/src/lib/arc-name.ts
 * @covers tugdeck/src/lib/arc-bind-error-store.ts
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000408";
const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const PICKER = '[data-slot="arc-picker-sheet"]';
// The arc marker on the masthead's title line — the identity's own run
// since the masthead badge was retired. Scoped to the masthead, because a
// line-tier identity anywhere else (a Cards row, a picker row) wears it too.
const CHIP =
  '[data-slot="session-masthead"] [data-slot="session-identity-arc"]';
/** What that run reads: the identity's arc grammar, sigil included. */
const chipText = (arc: string): string => `^${arc}`;
const BULLETIN = ".tug-pane-bulletin";

const ARCS_CARD = '.arcs-section';

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";
/** Already there when the gesture runs — the bind path. */
const KNOWN_ARC = "at0408-known";
/** Does not exist until `/arc-bind` makes it — the create path. */
const MADE_ARC = "at0408-made";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0408", checkout: CHECKOUT });
  createArc(projectDir(), KNOWN_ARC, "at0408 fixture", scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

// The whole repository goes — MADE_ARC included, however far the run got.
afterAll(() => {
  if (!SHOULD_RUN) return;
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

/** Type a command into the card's prompt and submit it. */
async function runCommand(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(PROMPT);
  await app.nativeType(line);
  await settle();
  // Dismiss the slash completion popup so Enter submits rather than accepting.
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

const count = (selector: string): string =>
  `document.querySelectorAll(${JSON.stringify(selector)}).length`;

describe.skipIf(!SHOULD_RUN)("AT0408: the /arc-bind gesture", () => {
  test(
    "a known name binds silently, an unknown one is created through the shell, bare opens the picker, and a shell-unsafe name is refused",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0408-arc-gesture",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace, so its arcs reach the aggregate — and the
        // create path's shell child runs with its cwd there.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // ── Wait for the aggregate to answer ──────────────────────────────
        // The Arcs card reads the same `ChangesetAllStore` the
        // card's controller does, so a row for the fixture arc there is proof
        // the snapshot has composed this project's arcs. Typing before that
        // would send `/arc-bind <known>` down the CREATE path.
        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector('${ARCS_CARD} [data-slot="arcs-row"][data-arc="${KNOWN_ARC}"]') !== null`,
          { timeoutMs: 30000 },
        );
        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ARCS_CARD)}) === null`,
          { timeoutMs: 8000 },
        );

        // ── A known name binds, with no shell row behind it ───────────────
        await runCommand(app, `/arc-bind ${KNOWN_ARC}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)})?.textContent.trim() === ${JSON.stringify(chipText(KNOWN_ARC))}`,
          { timeoutMs: 15000 },
        );
        // The bind is a CONTROL frame: silent, no transcript ink.
        expect(await app.evalJS<number>(count(SHELL_ROWS))).toBe(0);

        // ── An unknown name is created, with a receipt ────────────────────
        await runCommand(app, `/arc-bind ${MADE_ARC}`);
        await app.waitForCondition<boolean>(
          `(function(){
             var rows = document.querySelectorAll(${JSON.stringify(SHELL_ROWS)});
             if (rows.length !== 1) return false;
             var foot = rows[0].querySelector('[data-slot="session-z1b-end-state"]');
             return foot !== null && foot.textContent.indexOf("exit") !== -1;
           })()`,
          { timeoutMs: 40000 },
        );
        const receipt = await app.evalJS<string>(
          `(document.querySelectorAll(${JSON.stringify(SHELL_ROWS)})[0]?.textContent ?? "").trim()`,
        );
        expect(receipt).toContain(`tugtool arc create ${MADE_ARC}`);
        // `arc create`'s unconditional auto-bind is what ends the card bound —
        // this handler never sends a second bind of its own.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)})?.textContent.trim() === ${JSON.stringify(chipText(MADE_ARC))}`,
          { timeoutMs: 20000 },
        );

        // ── A shell-unsafe name is refused, and nothing is made ───────────
        await runCommand(app, "/arc-bind two words");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BULLETIN)}) !== null`,
          { timeoutMs: 8000 },
        );
        const caution = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(BULLETIN)})?.textContent ?? "").trim()`,
        );
        expect(caution).toContain("arc name");
        // Still exactly the one create; the refusal ran no command.
        expect(await app.evalJS<number>(count(SHELL_ROWS))).toBe(1);

        // ── Bare `/arc-bind` picks, and does not open the shade ──────────
        // Showing every arc and offering no way to choose one was the old
        // answer; with more than one arc in the project the bare form is a
        // picker now, and the shade stays where it was.
        expect(await app.evalJS<number>(count(PICKER))).toBe(0);
        await runCommand(app, "/arc-bind");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
          { timeoutMs: 8000 },
        );
        expect(await app.evalJS<number>(count(SHEET))).toBe(0);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
