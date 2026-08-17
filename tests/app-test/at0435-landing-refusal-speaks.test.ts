/**
 * at0435-landing-refusal-speaks.test.ts — a refused land press says why, on
 * screen, in the real app ([L31]).
 *
 * The corpus had never pressed a land button. `at0417` asserts the button's
 * *word* and `at0418` asserts that the affordance opens the editor; nothing
 * walked submit → gate → refusal, which is precisely where the dash-join dead
 * press lived. The refusal was computed, discarded, and shown nowhere, so days
 * of investigation had nothing to read.
 *
 * What this drives is the mechanism, not a hypothesis about which condition
 * fires: the composer's submit path is reachable while the land button is
 * disabled — that asymmetry is the incident's whole shape — so an empty message
 * over an otherwise landable dash is the cheapest deterministic refusal there
 * is. The press produces a bulletin carrying the gate's own sentence, the mode
 * stays up, and nothing goes on the wire.
 *
 * Safe by construction: the gate refuses, so no join is ever executed against
 * any branch.
 *
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/landing-mode.ts
 * @covers tugdeck/src/lib/landing-notice.ts
 * @covers tugdeck/src/components/tugways/cards/landing-notice-controller.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
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
import { commitRound, createDash, releaseDash } from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000435";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-toolbar .tug-prompt-entry-route-group`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;

const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
const DASH = "at0435-work";

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
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
        uuid: "00000000-0000-4000-8000-000000000e01",
        timestamp: t0,
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
      {
        ...base,
        parentUuid: "00000000-0000-4000-8000-000000000e01",
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000e02",
        timestamp: t1,
        message: {
          id: "msg-435-1",
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
  `${row(dash)} [data-slot="session-changes-dash-landing"]`;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  releaseDash(PROJECT_DIR, DASH);
  const dash = createDash(PROJECT_DIR, DASH, "at0435 fixture (a round to land)");
  dashId = dash.id;
  writeFileSync(join(dash.worktree, "at0435-work.txt"), "at0435\n");
  commitRound(PROJECT_DIR, DASH, "at0435(round): something to land");

  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(PROJECT_DIR));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${SID}.jsonl`), buildFixtureJsonl(PROJECT_DIR, SID));
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  releaseDash(PROJECT_DIR, DASH);
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

/** Click `target` until `expected` matches, re-aiming between attempts (at0418). */
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
      note(`at0435 click on ${target} did not land (attempt ${i + 1})`);
    }
  }
  throw new Error(`at0435: ${expected} never appeared after clicking ${target}`);
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
    `(() => { const o = ${read}; return o !== "" && o !== "unknown" && o !== "previewing"; })()`,
    { timeoutMs: 40000 },
  );
  return app.evalJS<string>(read);
}

/** Every bulletin currently on screen, as text. */
const BULLETIN_TEXTS = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map(function(e){ return e.textContent || ""; })`;

describe.skipIf(!SHOULD_RUN)("AT0435: a refused land press speaks", () => {
  test(
    "submitting a join with no message says what is missing and sends nothing",
    async () => {
      tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0435-landing-refusal-speaks",
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

        // Into the join-message editor through the lane's own affordance.
        await clickUntil(
          app,
          `${row(DASH)} [data-slot="session-changes-dash-join"]`,
          `${ROUTE_GROUP} [data-choice-value="changes"][data-state="active"]`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          { timeoutMs: 8000 },
        );

        // The editor opens empty: a fixture dash has no maintained join draft,
        // and nothing here writes one. Nothing clears it either — `⌘A` is a
        // menu chord and menu chords die in a background window (at0043 runs
        // `foreground: true` for exactly that reason), so the fixture supplies
        // the empty document instead of a keystroke pretending to.
        await app.nativeClickAtElement(EDITOR);
        await settle();
        // Emptiness is `.cm-placeholder`, never `textContent`: CM6 renders the
        // placeholder inside `.cm-content` when the document length is 0, so
        // an empty join editor reads as "Write the join message, or use
        // Auto-Message." to anyone asking the DOM for its text (at0043).
        const opening = await app.evalJS<{ text: string; empty: boolean }>(
          `(() => {
             const el = document.querySelector(${JSON.stringify(EDITOR)});
             return {
               text: el?.textContent ?? "",
               empty: el !== null && el.querySelector(".cm-placeholder") !== null,
             };
           })()`,
        );
        note(`at0435 join editor opened with: ${JSON.stringify(opening)}`);
        expect(opening.empty, "the refusal under test is the empty message").toBe(true);
        const buttonDisabled = await app.evalJS<boolean>(
          `(() => {
             const b = document.querySelector(${JSON.stringify(JOIN_BUTTON)});
             return b !== null && (b.hasAttribute("disabled") || b.getAttribute("aria-disabled") === "true");
           })()`,
        );
        note(`at0435 land button disabled with an empty message: ${buttonDisabled}`);

        // The press. Submit reaches `land()` whatever the button looks like —
        // which is the whole reason the refusal has to speak for itself.
        await app.nativeKey("Return", ["cmd"]);

        await app.waitForCondition<boolean>(
          `${BULLETIN_TEXTS}.some(function(t){ return t.indexOf("Write a join message") !== -1; })`,
          { timeoutMs: 10000 },
        );
        const texts = await app.evalJS<string[]>(BULLETIN_TEXTS);
        note(`at0435 bulletins after the refused press: ${JSON.stringify(texts)}`);
        expect(
          texts.some((t) => t.includes("Join not sent")),
          "the bulletin names the act that was refused",
        ).toBe(true);

        // The refusal is not a dismissal: the mode is still up, so the user is
        // one keystroke from the landing they asked for.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          ),
          "join mode survives a refused press",
        ).toBe(true);

        // A second press speaks again rather than going quiet on a repeat.
        //
        // The wait for the first bulletin to fade is the test, not a delay: a
        // gate refusal is a caution and cautions auto-dismiss, so by the time
        // someone presses again the previous sentence is gone and a surface
        // that compared wording — rather than the refusal's `seq` — would sit
        // silent on exactly the press where the user is asking louder. The
        // fade is observed rather than forced; removing the node by hand would
        // leave the bulletin channel believing it was still up.
        await app.waitForCondition<boolean>(
          `${BULLETIN_TEXTS}.every(function(t){ return t.indexOf("Write a join message") === -1; })`,
          { timeoutMs: 30000 },
        );
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `${BULLETIN_TEXTS}.some(function(t){ return t.indexOf("Write a join message") !== -1; })`,
          { timeoutMs: 10000 },
        );
        note("at0435 the second press spoke again after the first bulletin faded");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
