/**
 * at0764-join-run-line-silence.test.ts — the shade's run line says when a
 * run has gone quiet.
 *
 * While a run is live the arc row in the Changes shade carries a run line
 * directly under the register: what the server last reported on the left, the
 * clock on the right. Past twenty seconds with no report the left side turns
 * to "no report for N s" in the caution tone. The shared register keeps its
 * one word; the line is the shade's alone.
 *
 * The run is real, held the way at0763 holds it: a scratch repository with one
 * genuine conflict and a resolver stub that reads its charter and then sleeps,
 * so after the workshop opens nothing more is reported. Rather than wait out
 * twenty real seconds, the page's clock is moved a minute ahead — the band's
 * facts are the server's own times, so the line then reads a report that is a
 * minute old, which is exactly the stale run under test.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-lane.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-resolve-ledger.tsx
 * @covers tugdeck/src/lib/resolve-ledger.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
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

/** Minted per run, for the reason at0683 gives. */
const SID = randomUUID();
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;

const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const ARC = "at0764-work";
const ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC}"]`;
const LINE = `${ROW} [data-slot="session-changes-arc-run-line"]`;
const WORDS = `${LINE} [data-slot="session-changes-arc-run-line-words"]`;
const CLOCK = `${LINE} [data-slot="session-changes-arc-run-line-clock"]`;

/** Holds the run: the charter is read, and the resolver then simply waits. */
const RESOLVER_STUB = "#!/bin/sh\nread -r _charter\nsleep 120\n";

let scratch: JoinScratchRepo | null = null;
const projectDir = (): string => scratch?.repo ?? "";
let fixtureDir = "";
let tugbankPath = "";
let arcId = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeJoinScratchRepo({
    prefix: "at0764",
    arc: ARC,
    description: "at0764 fixture (a run that goes quiet)",
    checkout: CHECKOUT,
    file: "subject.txt",
    fork: "at0764 the body both sides will rewrite\n",
    base: "at0764 base side — the whole file, rewritten\n",
    arcBody: "at0764 arc side — the whole file, rewritten\n",
    resolver: RESOLVER_STUB,
    // `built` hands the arc to the pilot, whose run is the one under test.
    built: true,
  });
  arcId = scratch.arcId;
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmJoinScratchRepo(scratch);
  rmScratchSession(fixtureDir);
  if (tugbankPath !== "") rmTempTugbank(tugbankPath);
});

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** Open the Changes shade, retried until the lane shows the arc (at0683). */
async function openTheShade(app: App): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    await app.body("A").nativeClickAtElement(EDITOR);
    await settle();
    await app.nativeKey("a", ["cmd"]);
    await app.nativeKey("Delete");
    await app.nativeType("/commit");
    await settle();
    await app.nativeKey("Escape");
    await settle();
    await app.nativeKey("Return", ["cmd"]);
    const attemptBy = Date.now() + 5_000;
    while (Date.now() < attemptBy) {
      if (await app.body("A").evalJS<boolean>(`document.querySelector(${JSON.stringify(ROW)}) !== null`)) return;
      await settle(100);
    }
    note(`at0764 the shade did not show the arc (attempt ${attempt})`);
  }
  throw new Error("at0764: the Changes shade never showed the arc");
}

/** The run line's facts, or null while there is none. */
const LINE_FACTS = `(() => {
  const line = document.querySelector(${JSON.stringify(LINE)});
  const words = document.querySelector(${JSON.stringify(WORDS)});
  const clock = document.querySelector(${JSON.stringify(CLOCK)});
  if (line === null || words === null || clock === null) return null;
  return {
    tone: line.getAttribute("data-tone"),
    quiet: words.getAttribute("data-quiet"),
    words: words.textContent ?? "",
    clock: clock.textContent ?? "",
    wordsColor: getComputedStyle(words).color,
    clockColor: getComputedStyle(clock).color,
  };
})()`;

interface LineFacts {
  tone: string | null;
  quiet: string | null;
  words: string;
  clock: string;
  wordsColor: string;
  clockColor: string;
}

describe.skipIf(!SHOULD_RUN)("AT0764: the run line says when a run goes quiet", () => {
  test(
    "a live run draws the run line under the register, and a stale report reads as silence",
    async () => {
      tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0764-join-run-line-silence",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        // The pilot works only an arc somebody holds ([D147]).
        bindArc(projectDir(), ARC, SID, scratch?.cli ?? {});
        silenceJoinPrompt(projectDir(), ARC);
        await app.dispatchControlAction("bind_arc_ok", {
          tug_session_id: SID,
          arc_id: arcId,
          arc_name: ARC,
        });
        await openTheShade(app);

        // ── The run is live: the line stands under the register, talking. ──
        await app.body("A").waitForCondition<boolean>(
          `(${LINE_FACTS}) !== null`,
          { timeoutMs: 60000 },
        );
        const live = await app.body("A").evalJS<LineFacts>(LINE_FACTS);
        note(`at0764 the run line, live: ${JSON.stringify(live)}`);
        const order = await app.body("A").evalJS<boolean>(`(() => {
          const register = document.querySelector(${JSON.stringify(`${ROW} .session-changes-arc-register`)});
          const line = document.querySelector(${JSON.stringify(LINE)});
          return register !== null && register.nextElementSibling === line;
        })()`);
        expect(order, "the run line sits directly under the register").toBe(true);
        expect(live.words, "the line says something the server reported").not.toBe("");
        expect(live.clock, "the line carries the clock").toMatch(/^\d+:\d\d/);

        // ── A minute on the page's clock: the last report is a minute old. ──
        await app.body("A").evalJS<boolean>(`(() => {
          const real = Date.now.bind(Date);
          window.__at0764RealNow = real;
          Date.now = () => real() + 60000;
          return true;
        })()`);
        await app.body("A").waitForCondition<boolean>(
          `(${LINE_FACTS})?.quiet === "true"`,
          { timeoutMs: 5000 },
        );
        const quiet = await app.body("A").evalJS<LineFacts>(LINE_FACTS);
        await app.body("A").evalJS<boolean>(`(() => {
          if (window.__at0764RealNow !== undefined) Date.now = window.__at0764RealNow;
          return true;
        })()`);
        note(`at0764 the run line, quiet: ${JSON.stringify(quiet)}`);
        expect(quiet.words, "the silence sentence").toMatch(/^no report for \d+ s$/);
        expect(quiet.tone, "the line turns to the warning tone").toBe("warning");
        expect(quiet.wordsColor, "the silence sentence is not the clock's muted ink").not.toBe(
          quiet.clockColor,
        );
        expect(quiet.wordsColor, "the silence sentence is a caution, not the talking ink").not.toBe(
          live.wordsColor,
        );
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0764] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
