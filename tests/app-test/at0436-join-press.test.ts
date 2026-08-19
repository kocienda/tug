/**
 * at0436-join-press.test.ts — the Join press reaches the wire, and a
 * server refusal reaches the user ([L31]).
 *
 * This is the gesture the corpus never made. On 2026-08-17 a Join press
 * produced three previews and no land request at all: the staged callback
 * re-read the dash off a controller the staging itself had just cleared, found
 * nothing, and returned. Nothing was sent, nothing was said, and the backend
 * was never asked — so the only honest pin is one that walks submit → gate →
 * stage → shade dismissal → wire and then proves the server *answered*.
 *
 * ## Why the join is made to fail, and why that is the strongest safe test
 *
 * A join that succeeds squashes its dash onto its base branch. This fixture's
 * dash lives in the checkout the corpus is running from, so that base is a
 * branch somebody works on — not a thing this file may move (`at0418` declines
 * the same landing for the same reason). So the fixture is made *unlandable
 * after its preview settles*: an interrupted-teardown journal is written into
 * the gap between the clean preview and the press. The gate still passes — it
 * judges the settled preview — the request goes out for real, and the server
 * refuses it with its own sentence.
 *
 * The landed half is not untestable, only untestable *here*: at0441 owns a
 * scratch repository outright and presses the same control through to a squash
 * commit on its own `main`. This file stays the press → wire → **refusal** pin;
 * that one is the press → wire → **landed** pin.
 *
 * That refusal is the proof. `changeset_join_err` can only exist if the land
 * request reached the wire, which is exactly what did not happen in the
 * incident. And it lands on the second thing this campaign built: join had no
 * error surface at all, so the server's reason used to settle into a snapshot
 * field nothing in the app ever read.
 *
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/components/tugways/cards/staged-landing.ts
 * @covers tugdeck/src/components/tugways/cards/landing-notice-controller.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
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
import { commitRound, createDash, discardDash, universeRoot } from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000436";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-toolbar .tug-prompt-entry-route-group`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;

const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
const DASH = "at0436-work";

const encodeProjectDir = (absDir: string): string => absDir.replace(/[^A-Za-z0-9-]/g, "-");

let fixtureDir = "";
let tugbankPath = "";
let dashId = "";

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
          id: "msg-436-1",
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

const row = (dash: string): string =>
  `${LANE} [data-slot="session-changes-dash-row"][data-dash="${dash}"]`;
const landing = (dash: string): string =>
  `${row(dash)} [data-slot="session-changes-dash-join"]`;

/**
 * The join journal's home. `join_in` resolves the repo root from the card's
 * project dir, and the state-dir slug is derived from whatever that resolution
 * returns — the pinned universe under `just app-test`, the common dir's owner
 * otherwise (see at0418, `universeRoot` in `dash-fixture.ts`, and
 * `project_state_dir` / `join_journal_path` in `tugdash-core/src/ops.rs`).
 */
function journalPath(dash: string): string {
  const slug = universeRoot(PROJECT_DIR).replaceAll("/", "-");
  return join(
    homedir(),
    "Library/Application Support/Tug/projects",
    slug,
    `join-journal-${dash}.json`,
  );
}

function writeJournal(dash: string): void {
  const path = journalPath(dash);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        name: dash,
        base_branch: "main",
        strategy: "squash",
        commit_hash: "abc1234",
        phase: "WorktreeRemoved",
      },
      null,
      2,
    ),
  );
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  rmSync(journalPath(DASH), { force: true });
  discardDash(PROJECT_DIR, DASH);
  const dash = createDash(PROJECT_DIR, DASH, "at0436 fixture (a round to land)");
  dashId = dash.id;
  writeFileSync(join(dash.worktree, "at0436-work.txt"), "at0436\n");
  commitRound(PROJECT_DIR, DASH, "at0436(round): something to land");

  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(PROJECT_DIR));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${SID}.jsonl`), buildFixtureJsonl(PROJECT_DIR, SID));
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // The journal first: a dash carrying one is a dash the release verb argues
  // with rather than tears down.
  rmSync(journalPath(DASH), { force: true });
  discardDash(PROJECT_DIR, DASH);
  if (fixtureDir !== "") rmSync(join(fixtureDir, `${SID}.jsonl`), { force: true });
  if (tugbankPath !== "") rmTempTugbank(tugbankPath);
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

async function clickUntil(app: App, target: string, expected: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await app.evalJS<null>(
      `(() => {
         const el = document.querySelector(${JSON.stringify(target)});
         if (el !== null) el.scrollIntoView({ block: "center" });
         return null;
       })()`,
    );
    await settle();
    await app.nativeClickAtElement(target);
    try {
      await app.waitForCondition<boolean>(
        `document.querySelector(${JSON.stringify(expected)}) !== null`,
        { timeoutMs: 3000 },
      );
      return;
    } catch {
      note(`at0436 click on ${target} did not land (attempt ${i + 1})`);
    }
  }
  throw new Error(`at0436: ${expected} never appeared after clicking ${target}`);
}

/**
 * Return the composer to the prompt route.
 *
 * `/commit` raised the shade in **commit** mode, and in that mode the editor
 * is the commit message — a `/dash-join` typed into it is message text, not a
 * command, and ⌘Return submits the commit rather than switching modes. So a
 * slash command has to be typed from the prompt route, which is where every
 * one of them is read.
 */
async function returnToPrompt(app: App): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await settle();
  await app.nativeKey("Escape");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="prompt"][data-state="active"]`)}) !== null`,
    { timeoutMs: 8000 },
  );
}

/** Enter join mode on a dash by its named route — the row offers no control. */
async function enterJoinMode(app: App, dash: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(`/dash-join ${dash}`);
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

async function raiseShade(app: App): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType("/commit");
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
    { timeoutMs: 8000 },
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(LANE)}) !== null`,
    { timeoutMs: 40000 },
  );
}

async function settledOutcome(app: App, dash: string): Promise<string> {
  const read = `(document.querySelector(${JSON.stringify(landing(dash))})?.getAttribute("data-outcome") ?? "")`;
  await app.waitForCondition<boolean>(
    `(() => { const o = ${read}; return o !== ""; })()`,
    { timeoutMs: 40000 },
  );
  return app.evalJS<string>(read);
}

const BULLETIN_TEXTS = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map(function(e){ return e.textContent || ""; })`;

describe.skipIf(!SHOULD_RUN)("AT0436: the Join press reaches the wire", () => {
  test(
    "a pressed join is sent for real, and the server's refusal is shown",
    async () => {
      tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0436-join-press",
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

        await raiseShade(app);
        await app.dispatchControlAction("bind_dash_ok", {
          tug_session_id: SID,
          dash_id: dashId,
          dash_name: DASH,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(landing(DASH))}) !== null`,
          { timeoutMs: 20000 },
        );
        expect(await settledOutcome(app, DASH), "the fixture must be landable").toBe("clean");

        // The landable row offers no control — the composer's ⬆ is the only
        // thing that lands — so the route the readiness line names is how the
        // editor opens.
        await returnToPrompt(app);
        await enterJoinMode(app, DASH);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ROUTE_GROUP} [data-choice-value="changes"][data-state="active"]`)}) !== null`,
          { timeoutMs: 12000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          { timeoutMs: 8000 },
        );

        // A message of the user's own, so the press clears the gate on its
        // merits rather than on whatever the dash's draft happens to hold.
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("Delete");
        await app.nativeType("at0436: land this dash");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent ?? "").indexOf("land this dash") !== -1`,
          { timeoutMs: 5000 },
        );

        // Make the dash unlandable *after* the preview settled. The gate reads
        // the settled preview and still passes; the server refuses on execute.
        writeJournal(DASH);

        await app.nativeKey("Return", ["cmd"]);

        // The refusal can only exist if the request reached the wire — which
        // is precisely the beat that produced nothing at all before. Waiting
        // on outcomes, never on the shade's exit animation: background windows
        // run no rAF, so the watchdog may be what runs the staged landing.
        await app.waitForCondition<boolean>(
          `${BULLETIN_TEXTS}.some(function(t){ return t.indexOf("Join failed") !== -1; })`,
          { timeoutMs: 60000 },
        );
        const texts = await app.evalJS<string[]>(BULLETIN_TEXTS);
        note(`at0436 bulletins after the press: ${JSON.stringify(texts)}`);
        expect(
          texts.some((t) => t.includes("is incomplete")),
          "the server's own sentence reaches the user, not a generic failure",
        ).toBe(true);

        // The dash is still there: a refused execute lands nothing.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(row(DASH))}) !== null`,
          ),
          "a refused join leaves the dash standing",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
