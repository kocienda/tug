/**
 * at0570-topline-currency.test.ts — the line under a session's name is a
 * currency line while a turn is in flight and an identity line at rest.
 *
 * ## What this gates
 *
 * The reported defect was a topline that kept saying what the *previous* work
 * was for, for a minute or more after a new ask. Two sentences answer it, and
 * they want opposite cadences: the **synopsis** is what the session is FOR,
 * held steady on purpose so a wall of sessions can be scanned, and the
 * **current line** is what this turn is on. The description ladder takes the
 * second on top of the first while a turn is in flight, and the pure ladder's
 * order is pinned in `session-description-ladder.test.ts`. What can only be
 * pinned against the real app is that the wire reaches the line: two shapes
 * share the `OVERVIEW` feed, the store holds the current one per session, and
 * the turn decides whether it is still true.
 *
 * Three readings on one mounted masthead, in the order a real turn produces
 * them:
 *
 *  1. **A turn in flight with no line written yet reads the turn's ask**, and
 *     is marked as the stand-in it is. This is the floor: a written line has a
 *     latency tail, and for the seconds before it lands the ask is the one
 *     thing that cannot be wrong. It is explicitly not the solve — showing a
 *     person their own prompt back says nothing they did not just type.
 *  2. **A current line takes the top the moment one is written**, and is NOT
 *     marked, because it is a sentence written about the session rather than a
 *     fact standing in for one.
 *  3. **At turn end the through-line answers again.** The synopsis was never
 *     touched by any of it, which is the property the split exists to protect:
 *     the identity line a list of sessions is read by must not move because a
 *     turn started.
 *
 * The current line arrives through `publishOverviewPost`, which is the door to
 * the `OVERVIEW` frame handler rather than to a post in particular — the bytes
 * go through the production parse and the production fold, and the handler
 * tells the two shapes apart by their tag exactly as it does on the wire.
 *
 * The Cards rail renders the same `SessionIdentityRow` with the same
 * `currency` default, so the rule holds there by construction and is not
 * re-pinned here. The session picker's opt-out is a prop it passes and is
 * covered by the ladder's own test.
 *
 * @covers tugdeck/src/lib/overview-store.ts
 * @covers tugdeck/src/protocol.ts
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// UUID-shaped so the bound session reads as a real one.
const SID = "a7c0d1ea-0000-4000-8000-000000000570";

const PANE = '.tug-pane[data-pane-id="p1"]';
const MASTHEAD = `${PANE} [data-slot="session-masthead"]`;
const DESCRIPTION = `${MASTHEAD} .tug-session-row-description`;

const SYNOPSIS = "Rework how a session names itself";
const ASK = "why does the download resume path wedge";
const CURRENT = "Chase the wedge in the download resume path";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0570-proj-")));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
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

/** A `session_updated` frame body — exactly what the supervisor pushes. */
function sessionUpdated(fields: Record<string, unknown>): string {
  return JSON.stringify({ session_id: SID, fields });
}

/** One DIGEST frame body, scoped to this session, as the emitter writes it. */
function digestFrame(text: string, beat: number, kind: string): string {
  return JSON.stringify({
    type: "digest",
    text,
    scopes: [SID],
    beat,
    at: Date.now(),
    kind,
  });
}

/** A current-line frame, tagged as tugcast's `SessionCurrentLine` tags it. */
function currentLineFrame(current: string): string {
  return JSON.stringify({
    kind: "session_current",
    session_id: SID,
    at_ms: Date.now(),
    current,
  });
}

/** The description line's text and whether it wears the stand-in treatment. */
const describedJS = `JSON.stringify((function(){
  var el = document.querySelector(${JSON.stringify(DESCRIPTION)});
  if (el === null) return { text: null, standIn: null };
  return {
    text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
    standIn: el.getAttribute("data-stamp") === "true",
  };
})())`;

describe.skipIf(!SHOULD_RUN)("AT0570: the topline answers a new ask at once", () => {
  test(
    "the ask stands in, the current line takes the top, and the through-line returns at turn end",
    async () => {
      const app = await launchTugApp({ testName: "at0570-topline-currency" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID, projectDir });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DESCRIPTION)}) !== null`,
          { timeoutMs: 20_000 },
        );

        // The through-line arrives the way it always does — on the ledger row,
        // written by the Observer's own wake — so the line under the name is
        // an identity line before any turn starts.
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishSessionUpdated(${JSON.stringify(
              sessionUpdated({ synopsis: SYNOPSIS }),
            )})`,
          ),
        ).toBe(true);
        await app.waitForCondition<boolean>(
          `JSON.parse(${describedJS}).text === ${JSON.stringify(SYNOPSIS)}`,
          { timeoutMs: 20_000 },
        );
        const atRest = JSON.parse(await app.evalJS<string>(describedJS));
        note("at0570 at rest", JSON.stringify(atRest));
        expect(atRest.standIn, "a written sentence is not a stand-in").toBe(false);

        // 1. The ask opens the turn, and with no line written for it yet the
        //    topline reads the ask — marked, because it is a fact standing in
        //    for a sentence nobody has written.
        await app.evalJS<boolean>(
          `window.__tug.publishDigestFrame(${JSON.stringify(digestFrame(`asked: ${ASK}`, 1, "ask"))})`,
        );
        await app.waitForCondition<boolean>(
          `JSON.parse(${describedJS}).text.indexOf(${JSON.stringify(ASK)}) !== -1`,
          { timeoutMs: 20_000 },
        );
        const onAsk = JSON.parse(await app.evalJS<string>(describedJS));
        note("at0570 ask standing in", JSON.stringify(onAsk));
        expect(onAsk.text, "the previous turn's sentence is gone from the line").not.toContain(
          SYNOPSIS,
        );
        expect(onAsk.standIn, "the ask is marked as the stand-in it is").toBe(true);

        // 2. The Observer's line lands and takes the top, unmarked. Same feed
        //    as a post, told apart by its tag.
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(currentLineFrame(CURRENT))})`,
          ),
        ).toBe(true);
        await app.waitForCondition<boolean>(
          `JSON.parse(${describedJS}).text === ${JSON.stringify(CURRENT)}`,
          { timeoutMs: 20_000 },
        );
        const onCurrent = JSON.parse(await app.evalJS<string>(describedJS));
        note("at0570 current line", JSON.stringify(onCurrent));
        expect(onCurrent.standIn, "a written sentence is not a stand-in").toBe(false);

        // 3. The turn ends and the identity line returns, untouched by any of
        //    it. This is what the split protects: a list of sessions reads the
        //    same sentence before and after a turn.
        await app.evalJS<boolean>(
          `window.__tug.publishDigestFrame(${JSON.stringify(digestFrame("Done", 2, "turn"))})`,
        );
        await app.waitForCondition<boolean>(
          `JSON.parse(${describedJS}).text === ${JSON.stringify(SYNOPSIS)}`,
          { timeoutMs: 20_000 },
        );
        const afterTurn = JSON.parse(await app.evalJS<string>(describedJS));
        note("at0570 at turn end", JSON.stringify(afterTurn));
        expect(afterTurn, "the line at turn end is the line before the turn").toEqual(atRest);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0570] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
