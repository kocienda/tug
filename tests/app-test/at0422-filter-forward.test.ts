/**
 * at0422-filter-forward.test.ts — typing at a focused list lands in the filter
 * field attached to it ([AT0422]).
 *
 * ## What this gates
 *
 * The upward half of the attached-list contract ([P08]) — **type-select**, the
 * Finder gesture. The downward half (↑/↓ from the caret drive the list's
 * cursor) is at0265's (C). This is the other direction: with the ring on the
 * LIST, a printable character narrows the list *and the list keeps the
 * keyboard*. The field shadows what was typed; it never receives it.
 *
 * That distinction is the entire feature, and it is what the first version of
 * this contract got wrong. Granting the caret to the field narrows perfectly
 * and then strands the user: the row they were hunting is behind a Tab, and
 * `Return` presses the sheet's default with the list's selection still parked
 * wherever it was before they typed — on "New session", which silently
 * discards the pick.
 *
 *   - **Narrow without losing the keyboard (A):** typing a fragment with the
 *     ring on the list leaves the caret OUT of the field, the key view still on
 *     the list, the field showing the query, and the list narrowed to matches.
 *   - **Return opens the row you typed for (B):** the cursor re-seeds onto the
 *     first real match rather than staying on "New session", so `Return` acts
 *     on it. The regression this pins is a user typing a name and getting an
 *     empty new session.
 *   - **Escape drops the query, list keeps the keyboard (C):** the rows come
 *     back and the ring has not moved.
 *   - **Space and Backspace (D):** Space cannot OPEN a query (on a list it is
 *     the commit) but extends a non-empty one, so a multi-word title types
 *     straight through; Backspace deletes the query's last character.
 *
 * ## Deterministic rows
 *
 * Same approach as at0265: real transcript JSONL seeded into the encoded claude
 * project dir for a fresh temp path, read by the real scan. No mocks.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @foreground
 * @covers tugdeck/src/components/tugways/attached-filter.ts
 * @covers tugdeck/src/components/tugways/tug-filter-field.tsx
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** How claude names its per-project subdir under `~/.claude/projects/`. */
const encodeProjectDir = (absDir: string): string =>
  absDir.replace(/[^A-Za-z0-9-]/g, "-");

// The first row's title carries FRAGMENT as a LITERAL substring, and that is
// load-bearing: the per-keystroke assertion below reads the selected row's own
// text, so a fixture that only matches the query as a subsequence fails at the
// second character. It has been eaten once already, by a global rename that
// took "gazette provenance links" to a word with no "gaz" in it.
const SEEDED = [
  {
    id: "a7c04220-0000-4000-8000-0000000000b1",
    prompt: "gazebo provenance links",
    title: "gazebo provenance links",
  },
  {
    id: "a7c04220-0000-4000-8000-0000000000b2",
    prompt: "grapefruit harvest ledger",
    title: "grapefruit harvest ledger",
  },
  {
    id: "a7c04220-0000-4000-8000-0000000000b3",
    prompt: "gopher tunnel telemetry",
    title: "gopher tunnel telemetry",
  },
  {
    id: "a7c04220-0000-4000-8000-0000000000b4",
    prompt: "walrus reconciliation sweep",
    title: "walrus reconciliation sweep",
  },
];

/**
 * Typed one character at a time. Chosen so the query NARROWS THROUGH several
 * row sets rather than jumping straight to one match: "g" matches three seeded
 * rows, "ga" one. That is what moves a different session under the first-match
 * index between keystrokes — the case where re-seeding the cursor by index
 * alone leaves the selection naming a row the query has just hidden.
 */
const FRAGMENT = "gaz";

function buildFixtureJsonl(
  cwd: string,
  sessionId: string,
  prompt: string,
  title: string,
): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const suffix = sessionId.slice(-2);
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: `00000000-0000-4000-8000-0000000${suffix}e01`,
      timestamp: "2026-07-20T10:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    },
    {
      ...base,
      parentUuid: `00000000-0000-4000-8000-0000000${suffix}e01`,
      type: "assistant",
      uuid: `00000000-0000-4000-8000-0000000${suffix}e02`,
      timestamp: "2026-07-20T10:00:01.000Z",
      message: {
        id: `msg-forward-${suffix}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    { type: "ai-title", aiTitle: title, sessionId },
  ];
  return lines.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

let projectDir = "";
let fixtureDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0422-proj-")));
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(projectDir));
  mkdirSync(fixtureDir, { recursive: true });
  for (const session of SEEDED) {
    writeFileSync(
      join(fixtureDir, `${session.id}.jsonl`),
      buildFixtureJsonl(projectDir, session.id, session.prompt, session.title),
    );
  }
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
  if (fixtureDir !== "" && existsSync(fixtureDir)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

const PICKER_FORM = ".session-card-picker-form";
const PICKER_OPEN = `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`;
const PATH_FIELD = '[data-tug-focus-key="session-picker-cycle:0"]';
const SESSIONS_STOP = '[data-tug-focus-key="session-picker-cycle:2"]';
const FILTER_INPUT = '[data-testid="session-card-picker-filter"] input';
const RESUME_ROW = '[data-testid="session-card-picker-session-resume"]';

const RESUME_COUNT = `document.querySelectorAll(${JSON.stringify(RESUME_ROW)}).length`;

/** The row the list has SELECTED — what the sheet's default button will act on. */
const SELECTED_ROW = `${RESUME_ROW}[data-selected="true"], ${RESUME_ROW} [data-selected="true"]`;

/** The filter field's current value — `null` when the field is not mounted. */
const FILTER_VALUE = `(function(){
  var el = document.querySelector(${JSON.stringify(FILTER_INPUT)});
  return el === null ? null : el.value;
})()`;

/** Whether the caret is really in the filter field (not merely ringed there). */
const CARET_IN_FILTER = `(function(){
  var el = document.querySelector(${JSON.stringify(FILTER_INPUT)});
  return el !== null && document.activeElement === el;
})()`;

/** The focus key of whatever wears the keyboard ring — for diagnosing a stall. */
const KEY_VIEW_STOP = `(function(){
  var el = document.querySelector("[data-key-view-kbd]");
  return el === null ? null : (el.getAttribute("data-tug-focus-key") || el.tagName);
})()`;

/** Whether the engine's keyboard key view is the sessions list right now. */
const KEY_VIEW_IS_LIST = `(function(){
  var el = document.querySelector(${JSON.stringify(SESSIONS_STOP)});
  return el !== null && el.hasAttribute("data-key-view-kbd");
})()`;

/**
 * Wait for the filter field to hold exactly `expected`.
 *
 * Returns a BOOLEAN rather than the value: `waitForCondition` polls until its
 * script returns something truthy, and `""` — the expected value whenever a
 * query has just been cleared — is falsy, so a value-returning predicate can
 * never resolve for the one case most worth asserting.
 */
function waitForFilterValue(app: App, expected: string): Promise<boolean> {
  return app.waitForCondition<boolean>(
    `${FILTER_VALUE} === ${JSON.stringify(expected)}`,
    { timeoutMs: 6000 },
  );
}

/**
 * Walk the picker's Tab cycle until the sessions list holds the key view —
 * the same real gesture the user makes, rather than a placement the test
 * authors. Bounded: the cycle's membership is host-dependent.
 */
async function focusSessionsList(app: App): Promise<void> {
  for (let i = 0; i < 12; i++) {
    if (await app.evalJS<boolean>(KEY_VIEW_IS_LIST)) return;
    await app.nativeKey("Tab");
    try {
      await app.waitForCondition<boolean>(KEY_VIEW_IS_LIST, { timeoutMs: 1_500 });
      return;
    } catch {
      // Not this stop — keep walking.
    }
  }
  note(`tab walk stalled; key view is ${await app.evalJS<string | null>(KEY_VIEW_STOP)}`);
  throw new Error("tab walk never reached the sessions list");
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 860, height: 640 },
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

/** Open the picker on the seeded project and wait for all three rows. */
async function openPickerOnSeededProject(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.waitForCondition<boolean>(PICKER_OPEN, { timeoutMs: 8000 });
  await app.evalJS<null>(`(function(){
    var el = document.querySelector(${JSON.stringify(PATH_FIELD)});
    if (!el) throw new Error("path field not found");
    el.focus();
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(projectDir)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return null;
  })()`);
  await app.waitForCondition<boolean>(`${RESUME_COUNT} >= ${SEEDED.length}`, {
    timeoutMs: 20_000,
  });
  // Typing the path opens the recents dropdown, and an OPEN dropdown consumes
  // Tab (the combo box owns it while its list is up), so a walk from here
  // would never leave the path field.
  await app.nativeKey("Escape");
}

describe.skipIf(!SHOULD_RUN)(
  "AT0422: type-select narrows a focused list without taking its keyboard",
  () => {
    test(
      "typing narrows while the list keeps the keyboard, and Return opens the row that was typed for",
      async () => {
        // Real keystrokes, not synthesized KeyboardEvents: a dispatched event
        // has no default action, and half of what this asserts is about which
        // surface the real key reaches.
        const app = await launchTugApp({
          testName: "at0422-type-select",
          foreground: true,
        });
        try {
          await openPickerOnSeededProject(app);
          const baselineCount = await app.evalJS<number>(RESUME_COUNT);

          await focusSessionsList(app);
          expect(await app.evalJS<boolean>(CARET_IN_FILTER)).toBe(false);

          // (A)+(B) Type ONE CHARACTER AT A TIME, and after each one require
          // that the selection names a row matching everything typed so far.
          //
          // Per-keystroke is the point, not thoroughness theatre. The selection
          // is tracked by re-seeding the cursor to the first match, and the
          // first match is an INDEX — so the interesting failure is the query
          // narrowing while that index stays the same number and a different
          // session slides under it ("g" matches three seeded rows, "ga" one).
          // A selection left naming the previous occupant points at a row the
          // query has now hidden, the picker invalidates it back to "New
          // session", and `Return` opens an empty session with the cursor bar
          // still sitting on the match. Asserting only the final state misses
          // it whenever the last keystroke happens to move the index.
          const typed: string[] = [];
          for (const ch of FRAGMENT) {
            await app.nativeType(ch);
            const query = FRAGMENT.slice(0, typed.length + 1);
            typed.push(ch);
            expect(await waitForFilterValue(app, query)).toBe(true);
            const selected = await app.waitForCondition<string>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(SELECTED_ROW)});
                return el === null ? null : (el.textContent || "");
              })()`,
              { timeoutMs: 6000 },
            );
            note(`selection at "${query}": ${JSON.stringify(selected)}`);
            expect(selected.toLowerCase()).toContain(query);
            expect(selected).not.toContain("New session");
          }

          // The caret never went to the field and the key view never left the
          // list — the whole gesture ran with the list as first responder.
          expect(await app.evalJS<boolean>(CARET_IN_FILTER)).toBe(false);
          expect(await app.evalJS<boolean>(KEY_VIEW_IS_LIST)).toBe(true);
          await app.waitForCondition<boolean>(
            `${RESUME_COUNT} < ${baselineCount}`,
            { timeoutMs: 6000 },
          );

          // Return presses the sheet's default with that selection live, which
          // opens the seeded session — the picker gives way to the card.
          await app.nativeKey("Return");
          await app.waitForCondition<boolean>(`!(${PICKER_OPEN})`, {
            timeoutMs: 15_000,
          });
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0422-type-select] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "Escape drops the query and the list still holds the keyboard",
      async () => {
        const app = await launchTugApp({
          testName: "at0422-type-select-escape",
          foreground: true,
        });
        try {
          await openPickerOnSeededProject(app);
          const baselineCount = await app.evalJS<number>(RESUME_COUNT);
          await focusSessionsList(app);

          await app.nativeType(FRAGMENT);
          await app.waitForCondition<boolean>(
            `${RESUME_COUNT} < ${baselineCount}`,
            { timeoutMs: 6000 },
          );

          // (C) Escape is the list's while there is a query to drop, so the
          // sheet survives it and the ring does not move.
          await app.nativeKey("Escape");
          expect(await waitForFilterValue(app, "")).toBe(true);
          await app.waitForCondition<boolean>(
            `${RESUME_COUNT} === ${baselineCount}`,
            { timeoutMs: 6000 },
          );
          expect(await app.evalJS<boolean>(PICKER_OPEN)).toBe(true);
          expect(await app.evalJS<boolean>(KEY_VIEW_IS_LIST)).toBe(true);
          expect(await app.evalJS<boolean>(CARET_IN_FILTER)).toBe(false);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0422-escape] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "Space cannot open a query but extends one, and Backspace deletes",
      async () => {
        const app = await launchTugApp({
          testName: "at0422-type-select-keys",
          foreground: true,
        });
        try {
          await openPickerOnSeededProject(app);
          await focusSessionsList(app);

          // (D) On a list Space is the commit, and a query cannot usefully open
          // with one — so it must leave the field empty.
          await app.nativeKey(" ");
          await new Promise((r) => setTimeout(r, 500));
          expect(await app.evalJS<string | null>(FILTER_VALUE)).toBe("");

          // Inside a query it is an ordinary character, which is what lets a
          // multi-word title be typed straight through.
          await focusSessionsList(app);
          await app.nativeType("zebra ha");
          expect(await waitForFilterValue(app, "zebra ha")).toBe(true);

          // Backspace edits the query rather than doing nothing. (The harness
          // name is `Backspace`; its `Delete` is the forward-delete key.)
          await app.nativeKey("Backspace");
          expect(await waitForFilterValue(app, "zebra h")).toBe(true);
          expect(await app.evalJS<boolean>(CARET_IN_FILTER)).toBe(false);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0422-keys] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
