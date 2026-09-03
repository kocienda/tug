/**
 * at0496-join-press-clears-the-room.test.ts — pressing Join leaves the Changes
 * shade, and lands the reader in front of the join.
 *
 * ## What this gates
 *
 * A join is submitted from inside the Changes shade, and the moment it is
 * submitted the shade has nothing left to say: the arc is being joined, and
 * every act the room offered for it is spent. So the press must do three
 * things at once, and all three are one gesture's worth of the same idea —
 * *hand the user back to the conversation*:
 *
 *   1. The shade **closes**.
 *   2. The `Joining…` register is **in view** in the transcript.
 *
 * The third — the joined arc is **gone from the room**, so a room re-opened
 * mid-join is not still offering the join that is running — is pinned at the
 * store, in `lib/__tests__/changeset-join-store.test.ts`, where the clock is
 * the test's. Over this fixture's two-file repository the join is finished
 * before the room can be re-opened, so an assertion made here would be reading
 * an arc the feed had already dropped and would hold whether or not the room
 * filtered anything.
 *
 * On 2026-08-29 none of the three happened on a real join. The shade stayed up
 * over the transcript for the whole fifteen seconds the join took, so the
 * register — which lives at the transcript's live edge, and was there the whole
 * time — was behind the panel; the arc kept being offered; and the user,
 * seeing nothing, pressed again and got `Joining…` as a *refusal*. The instance
 * log carries the shape of it: two accepted presses, then
 * `sheetDidHide never fired — the watchdog landed the staged callback`.
 *
 * ## Why these assertions and not weaker ones
 *
 * "The shade closed" is asserted as the sheet being **gone from the DOM**,
 * because `TugSheet` unmounts on hide — a sheet that is merely transparent or
 * mid-animation is a shade the user is still looking at.
 *
 * "In view" is asserted **geometrically**, against the transcript scroller's
 * own rect, not by the element existing. The register existing proves nothing:
 * it existed throughout the incident. What was asked for is to *see* it — so
 * the fixture seeds a transcript taller than its pane and parks the reader at
 * the top before the press. On a transcript that fits, the live edge is always
 * in view and the assertion would be free.
 *
 * The fixture is at0436's — a scratch repository with one landable arc — for
 * the reason at0436 has one: entering join mode resolves the arc, and a
 * resolution aimed at this checkout would run the corpus's own checks over the
 * candidate. Here it is a sentinel grep over a two-file repo.
 *
 * `session-card.tsx` is deliberately NOT named here. It sits at the selection
 * budget's ceiling, a 21st claim would make every edit to it a refused
 * selection, and its half of this gesture — the press's own dismissal of the
 * room — is already named by at0436, which drives the same staged press. What
 * this file discriminates on is the composer's: an accepted landing jumping
 * the reader to the live edge.
 *
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/cards/session-landing-progress-row.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-lane.tsx
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/shade-view-controller.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindArc,
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  rmScratchSession,
  seedScratchSession,
  silenceJoinPrompt,
  type JoinScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/**
 * Minted per run, not fixed.
 *
 * The fixture's JSONL lands in the machine-global `~/.claude/projects`, where
 * every *other* live Tug instance's external scan can see it and record a
 * session row of its own — pointed at a scratch repository that is deleted
 * when the test ends. `arc bind` asks every instance on the machine, so a
 * fixed id lets one of those stale rows answer for this run and refuse the
 * bind against a directory this run has never heard of. A fresh id per run is
 * an id nothing else can be holding.
 */
const SID = randomUUID();
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;
const TRANSCRIPT = `${CARD} .session-view-pane[data-view="transcript"] [data-slot="tug-list-view"]`;
/** The live-edge narration row — where a landing accounts for itself. */
const PROGRESS_ROW = `${CARD} [data-slot="session-landing-progress-row"]`;

const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const ARC = "at0496-work";
const FILE = "subject.txt";

let scratch: JoinScratchRepo | null = null;
const projectDir = (): string => scratch?.repo ?? "";

let fixtureDir = "";
let tugbankPath = "";
let arcId = "";

const row = (arc: string): string =>
  `${LANE} [data-slot="session-changes-arc-row"][data-arc="${arc}"]`;
const landsAs = (arc: string): string =>
  `${row(arc)} [data-slot="session-changes-arc-lands-as"]`;
const CANDIDATE = `${CARD} [data-slot="arc-join-register"][data-word="ready"]`;

/**
 * A transcript with more turns than the pane can show.
 *
 * Load-bearing, not scenery. The narration this file is about lives at the
 * transcript's live edge, so on a transcript that fits there is nowhere for it
 * to hide and the assertion would hold whether or not the press moves the
 * reader. The incident's transcript was ninety thousand pixels tall; this one
 * only has to overflow a 340px pane.
 */
function tallTranscript(cwd: string, sessionId: string): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const uuid = (n: number): string =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const lines: unknown[] = [];
  for (let i = 0; i < 40; i += 1) {
    const u = uuid(i * 2 + 1);
    lines.push({
      ...base,
      parentUuid: i === 0 ? null : uuid(i * 2),
      type: "user",
      uuid: u,
      timestamp: new Date(Date.now() - (80 - i * 2) * 1000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: `turn ${i} — the question` }] },
    });
    lines.push({
      ...base,
      parentUuid: u,
      type: "assistant",
      uuid: uuid(i * 2 + 2),
      timestamp: new Date(Date.now() - (79 - i * 2) * 1000).toISOString(),
      message: {
        id: `msg-at0496-${i}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: `turn ${i} — the answer` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1200,
          output_tokens: 50,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 8000,
        },
      },
    });
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeJoinScratchRepo({
    prefix: "at0496",
    arc: ARC,
    description: "at0496 fixture (a round to land)",
    checkout: CHECKOUT,
    file: FILE,
    fork: "at0496 the arc's file\n",
    base: "at0496 SENTINEL the base's own file\n",
    arcBody: "at0496 SENTINEL the arc rewrote it\n",
    cleanMerge: true,
    resolver: "#!/bin/sh\nexit 0\n",
  });
  arcId = scratch.arcId;
  fixtureDir = seedScratchSession(projectDir(), SID);
  writeFileSync(join(fixtureDir, `${SID}.jsonl`), tallTranscript(projectDir(), SID));
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmJoinScratchRepo(scratch);
  rmScratchSession(fixtureDir);
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

/**
 * Open the room in JOIN mode, the way a user does: `/arc-join`.
 *
 * Retried, because the command needs the arc to have reached the changeset
 * feed — before that it answers with a bulletin and nothing opens. The feed
 * arrives on its own schedule and the lane, which is the only visible sign of
 * it, lives inside the room this is trying to open.
 */
async function openTheRoomOnTheJoin(app: App): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    await app.nativeClickAtElement(EDITOR);
    await settle();
    await app.nativeKey("a", ["cmd"]);
    await app.nativeKey("Delete");
    await app.nativeType("/arc-join");
    await settle();
    // Dismiss the completion popup. Join mode is not up yet, so this reaches
    // the popup and not the mode.
    await app.nativeKey("Escape");
    await settle();
    await app.nativeKey("Return", ["cmd"]);
    try {
      await app.waitForCondition<boolean>(
        `document.querySelector(${JSON.stringify(SHEET)}) !== null &&
         document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
        { timeoutMs: 6000 },
      );
      await app.waitForCondition<boolean>(
        `document.querySelector(${JSON.stringify(LANE)}) !== null`,
        { timeoutMs: 40000 },
      );
      return;
    } catch {
      note(`at0496 /arc-join did not open the room in join mode (attempt ${attempt})`);
    }
  }
  throw new Error("at0496: /arc-join never opened the room in join mode");
}

/**
 * Whether `selector` is inside the transcript scroller's visible rect — the
 * geometric reading of "in view", which is what the user asked for and what
 * the element merely existing does not answer.
 */
function inViewProbe(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const scroller = document.querySelector(${JSON.stringify(TRANSCRIPT)});
    if (el === null || scroller === null) return JSON.stringify({ found: false });
    const a = el.getBoundingClientRect();
    const b = scroller.getBoundingClientRect();
    return JSON.stringify({
      found: true,
      inView: a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && a.height > 0,
      word: el.querySelector("[data-slot=\\"arc-join-register\\"]")?.getAttribute("data-word") ?? null,
      el: { top: Math.round(a.top), bottom: Math.round(a.bottom) },
      scroller: { top: Math.round(b.top), bottom: Math.round(b.bottom) },
    });
  })()`;
}

describe.skipIf(!SHOULD_RUN)("AT0496: a Join press hands the room back", () => {
  test(
    "the shade closes, the arc leaves it, and the Joining register is in view",
    async () => {
      tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0496-join-press-clears-the-room",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        bindArc(projectDir(), ARC, SID, scratch?.cli ?? {});
        silenceJoinPrompt(projectDir(), ARC);

        await app.dispatchControlAction("bind_arc_ok", {
          tug_session_id: SID,
          arc_id: arcId,
          arc_name: ARC,
        });
        await openTheRoomOnTheJoin(app);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(landsAs(ARC))}) !== null`,
          { timeoutMs: 20000 },
        );

        // Entering join mode resolves the arc; the candidate standing is that
        // resolution anchoring, and it is what the gate reads.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CANDIDATE)}) !== null`,
          { timeoutMs: 180000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          ),
          "precondition: the Changes shade is up",
        ).toBe(true);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(row(ARC))}) !== null`,
          ),
          "precondition: the shade is offering this arc",
        ).toBe(true);

        // Scroll the transcript away from its live edge, and leave it there.
        //
        // This is the reader who has been looking back through the session —
        // and it is what makes the narration assertion mean anything: with the
        // transcript resting at the bottom, the narration is in view whether
        // or not the press moves anybody. An upward scroll outside the
        // at-bottom band disengages follow-bottom ([D93]), so nothing pulls
        // the view back on its own.
        await app.evalJS<null>(
          `(() => {
             const s = document.querySelector(${JSON.stringify(TRANSCRIPT)});
             if (s !== null) s.scrollTop = 0;
             return null;
           })()`,
        );
        await settle(500);
        const parked = JSON.parse(
          await app.evalJS<string>(
            `(() => {
               const s = document.querySelector(${JSON.stringify(TRANSCRIPT)});
               if (s === null) return JSON.stringify({ found: false });
               return JSON.stringify({
                 found: true,
                 scrollTop: Math.round(s.scrollTop),
                 room: Math.round(s.scrollHeight - s.clientHeight),
               });
             })()`,
          ),
        ) as { found: boolean; scrollTop?: number; room?: number };
        note(`at0496 transcript parked before the press: ${JSON.stringify(parked)}`);
        expect(parked.found, "the transcript scroller is there to park").toBe(true);
        expect(
          (parked.room ?? 0) > 200,
          "precondition: the transcript overflows its pane, so the live edge can be off screen",
        ).toBe(true);
        expect(
          (parked.scrollTop ?? 0) < (parked.room ?? 0) - 100,
          "precondition: the reader is parked away from the live edge",
        ).toBe(true);

        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("Delete");
        await app.nativeType("at0496: land this arc");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent ?? "").indexOf("land this arc") !== -1`,
          { timeoutMs: 5000 },
        );

        await app.nativeKey("Return", ["cmd"]);

        // ── 1. The shade closes. ──
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          { timeoutMs: 8000 },
        );

        // ── 2. The Joining register is in view in the transcript. ──
        //
        // Read here, on the press's own beat, because a join over a two-file
        // repository settles in well under a second: waited for later, the
        // register would already have moved from `joining` to `joined` and a
        // word-pinned selector would miss a row that was never absent. What is
        // asserted is the ROW — the narration standing where the reader was
        // handed to — and its word is noted rather than pinned.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROGRESS_ROW)}) !== null`,
          { timeoutMs: 20000 },
        );
        const seen = JSON.parse(await app.evalJS<string>(inViewProbe(PROGRESS_ROW))) as {
          found: boolean;
          inView?: boolean;
          word?: string | null;
          el?: { top: number; bottom: number };
          scroller?: { top: number; bottom: number };
        };
        note(`at0496 landing narration: ${JSON.stringify(seen)}`);
        expect(seen.found, "the landing narrates itself in the transcript").toBe(true);
        expect(
          seen.inView,
          "and it is on screen, not below the transcript's visible edge",
        ).toBe(true);
        expect(
          seen.word,
          "and what it says is about this join, not a leftover state",
        ).toBeOneOf(["joining", "joined", "join-failed"]);

        // The third guarantee — an arc whose join is running is no longer on
        // offer — is pinned at the store instead, in
        // `lib/__tests__/changeset-join-store.test.ts`. It cannot be read
        // honestly from here: a join over a two-file repository is finished
        // before the room can be re-opened, so what this file would be reading
        // is an arc the feed has already dropped — which passes whether or not
        // the room ever filtered anything. The store test holds the clock.
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0496] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
