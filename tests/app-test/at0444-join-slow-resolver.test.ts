/**
 * AT0444 — a resolver that takes its time is working, not dead.
 *
 * ## Why this exists
 *
 * The client used to declare a resolve lost after twelve seconds of silence.
 * That premise came from the scribe rung, which streams a token at a time and
 * genuinely cannot be quiet for long. The resolver rung is nothing like it: it
 * reports four discrete beats — working, asking, verifying, iterating — and the
 * stretches between them are a model composing a reconciliation, a build, a
 * test selection. Minutes, routinely.
 *
 * So the deadline fired on healthy runs, and what it produced was not merely a
 * wrong sentence. The error face **re-mounts the Resolve control**, and a
 * second press started a second `finish_join` doing `reset --hard` on the
 * workshop the first one's resolver was live in. A false report of death was
 * an invitation to cause a real one.
 *
 * This file holds a resolver still for fifteen seconds — past the old deadline,
 * with room — and asserts the face never says it died.
 *
 * ## The two halves of "one dash, one run"
 *
 * The server half is admission: a second resolve, a verify, or a non-preview
 * join is refused by name while a run holds the dash. That is pinned where it
 * lives, in `agent_supervisor.rs`
 * (`a_live_resolve_refuses_every_other_run_on_that_dash`), because it is a
 * statement about the registry rather than about the DOM.
 *
 * The client half is what this file can answer and that one cannot: **while a
 * run is live, the row mounts no control at all.** There is nothing to press,
 * which is why the admission refusal is a backstop rather than a daily event —
 * and it is the exact thing the false error face used to undo, by mounting
 * Resolve again over a run that was still going.
 *
 * ## The arc
 *
 * conflicted → Resolve → the offer leaves on the press → fifteen seconds of
 * complete silence, checked past twelve → still progress, no error, no control
 * → the resolver reports → Tier 0 green → the row states its join route.
 *
 * ## The fixture
 *
 * The shared join scratch repo: one file both sides rewrite wholesale, so
 * `merge-tree` genuinely conflicts, and a declared Tier 0 that greps for a
 * sentinel. The resolver stub reads its charter, sleeps, then writes the
 * reconciled body and reports — the same two terminal shapes the real spawn
 * parses; only the transport and the pace differ.
 *
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-join.tsx
 * @covers tugrust/crates/tugcast/src/feeds/join_resolver.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_occupancy.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
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
import { makeJoinScratchRepo, rmJoinScratchRepo, type JoinScratchRepo } from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000444";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = '[data-slot="session-changes-view"]';
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH = "at0444-slow";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH}"]`;
const JOIN_FACE = `${ROW} [data-slot="session-changes-dash-join"]`;
const RESOLVE = `${ROW} [data-slot="session-changes-dash-resolve"]`;
const PROGRESS = `${ROW} [data-slot="session-changes-dash-join-progress"]`;
const RESOLVE_ERROR = `${ROW} [data-slot="session-changes-dash-join-resolve-error"]`;
const STUCK = `${ROW} [data-slot="session-changes-dash-join-stuck"]`;
const VERDICT = `${ROW} [data-slot="session-changes-dash-join-verdict"]`;
const READY = `${ROW} [data-slot="session-changes-dash-join-ready"]`;
/** Every control the join face can mount — none of them may be up mid-run. */
const ANY_CONTROL =
  `${ROW} [data-slot="session-changes-dash-resolve"], ` +
  `${ROW} [data-slot="session-changes-dash-join-verify"], ` +
  `${ROW} [data-slot="session-changes-dash-join-override"], ` +
  `${ROW} [data-slot="session-changes-dash-resume"]`;

const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';

/** The checkout whose built binaries the fixture drives. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

const FILE = "subject.txt";
const RESOLVED_BODY = "at0444 SENTINEL reconciled, eventually\n";

/**
 * How long the resolver says nothing, in seconds.
 *
 * Comfortably past the twelve-second deadline this test exists to disprove,
 * and short enough that the file is not itself a slow test.
 */
const SILENCE_S = 15;

/**
 * Read the charter, say nothing at all for {@link SILENCE_S}, then reconcile.
 *
 * The silence is the fixture. Nothing is emitted during it — no delta, no
 * heartbeat, no keepalive — because the point is that a run which cannot speak
 * is still a run, and that only the server is in a position to know otherwise.
 */
const RESOLVER_STUB = `#!/bin/sh
ws="$1"
read -r _charter
sleep ${SILENCE_S}
printf '%s' '${RESOLVED_BODY}' > "$ws/${FILE}"
printf '%s\\n' '{"files":[{"path":"${FILE}","resolved_by":"resolver","what_each_side_did":"both sides rewrote the whole file","reconciliation":"kept the dash intent and the base sentinel"}],"notes":"at0444"}'
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
          id: "msg-444-1",
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
    prefix: "at0444",
    dash: DASH,
    description: "at0444 slow-resolver fixture",
    checkout: CHECKOUT,
    file: FILE,
    fork: "at0444 the body both sides will rewrite\n",
    base: "at0444 base side — the whole file, rewritten\n",
    dashBody: "at0444 dash side — the whole file, rewritten\n",
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

/** What the face is saying about the run right now. */
async function runFace(app: App): Promise<{
  error: string;
  stuck: string;
  progress: boolean;
  controls: number;
}> {
  return app.evalJS<{ error: string; stuck: string; progress: boolean; controls: number }>(
    `(function(){
      return {
        error: (document.querySelector(${JSON.stringify(RESOLVE_ERROR)})?.textContent || ""),
        stuck: (document.querySelector(${JSON.stringify(STUCK)})?.textContent || ""),
        progress: document.querySelector(${JSON.stringify(PROGRESS)}) !== null,
        controls: document.querySelectorAll(${JSON.stringify(ANY_CONTROL)}).length,
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0444: a slow resolver is not a dead one", () => {
  test(
    "fifteen seconds of silence renders as work, offers nothing to press, and finishes green",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const repo = scratch?.repo ?? "";
      const app = await launchTugApp({
        testName: "at0444-join-slow-resolver",
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

        // ── The press ─────────────────────────────────────────────────────
        await settle(400);
        const pressedAt = Date.now();
        await revealAndClick(app, RESOLVE);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RESOLVE)}) === null`,
          { timeoutMs: 5000 },
        );

        // ── The silence ───────────────────────────────────────────────────
        // Sampled across the whole quiet stretch rather than once at the end:
        // the failure this closes is a face that goes wrong *at a moment* and
        // is repaired by the answer that follows, which a single late read
        // would never see.
        let sawTwelve = false;
        while (Date.now() - pressedAt < (SILENCE_S - 1) * 1000) {
          const face = await runFace(app);
          const elapsed = Math.round((Date.now() - pressedAt) / 1000);
          expect(face.error, `at ${elapsed}s the run must not read as failed`).toBe("");
          expect(face.stuck, `at ${elapsed}s nothing has stuck`).toBe("");
          // Nothing to press is the client half of one dash, one run: the
          // second `finish_join` that used to `reset --hard` a live workshop
          // began with a control this face should never have been mounting.
          expect(face.controls, `at ${elapsed}s the row offers no act`).toBe(0);
          if (elapsed >= 12) sawTwelve = true;
          await settle(1000);
        }
        expect(sawTwelve, "the silence was sampled past the old twelve-second deadline").toBe(
          true,
        );
        note(`at0444: ${SILENCE_S}s of resolver silence read as work throughout`);

        // ── The finish ────────────────────────────────────────────────────
        // The run was never in trouble, so it lands the same green verdict a
        // fast one would — which is the whole claim: the client had no business
        // judging this rung's liveness, and stopping cost it nothing.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(VERDICT)})?.getAttribute("data-verdict") === "green"`,
          { timeoutMs: 180000 },
        );
        const settled = await runFace(app);
        expect(settled.error, "and no error was left behind by the wait").toBe("");
        expect(settled.stuck, "nor a stuck sentence").toBe("");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(READY)})?.getAttribute("data-ready") === "true"`,
          { timeoutMs: 30000 },
        );
        note("at0444: the slow run finished green and the row reads joinable");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
