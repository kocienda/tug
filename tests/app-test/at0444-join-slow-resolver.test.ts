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
 * wrong sentence. The error face **re-mounted the Resolve control**, and a
 * second press started a second `finish_join` doing `reset --hard` on the
 * workshop the first one's resolver was live in. A false report of death was
 * an invitation to cause a real one.
 *
 * That history is why this file exists, and it survives the arc intact — but
 * both ends of it have moved, so the file is rewritten rather than patched.
 * There is no Resolve to press: the run is started by the **pilot**, on a dash
 * declared `built`, and by nothing else. And there is no control to re-mount:
 * the shade mounts none at all ([P08]). What is left is the claim that always
 * mattered, now stated where it can be seen — **a resolver held still for
 * fifteen seconds, past the old twelve-second bound, leaves the register on
 * its running pose and never fabricates a failure.**
 *
 * The deleted deadline is what this pins. A client that judged this rung's
 * liveness had no business doing so, and the register is where that judgment
 * would show: `reconciling`, steady, for as long as the run takes.
 *
 * ## The arc
 *
 * built → the pilot starts the run with nothing pressed → fifteen seconds of
 * complete silence, sampled past twelve → still `reconciling`, no error, no
 * stuck sentence, and no control anywhere → the resolver reports → the
 * candidate anchors → the register reads `ready`.
 *
 * ## The fixture
 *
 * The shared join scratch repo: one file both sides rewrite wholesale, so
 * `merge-tree` genuinely conflicts. The resolver stub reads its charter,
 * sleeps, then writes the
 * reconciled body and reports — the same two terminal shapes the real spawn
 * parses; only the transport and the pace differ.
 *
 * @covers tugdeck/src/lib/changeset-join-store.ts
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/dash-join-register.ts
 * @covers tugdeck/src/components/tugways/dash-join-register.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-join.tsx
 * @covers tugrust/crates/tugcast/src/feeds/join_resolver.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_occupancy.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_pilot.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindDash,
  silenceJoinPrompt,
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type JoinScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000444";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = '[data-slot="session-changes-view"]';
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;

const DASH = "at0444-slow";
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH}"]`;
const REGISTER = `${ROW} [data-slot="dash-join-register"]`;
const RESOLVE_ERROR = `${ROW} [data-slot="session-changes-dash-join-resolve-error"]`;
const STUCK = `${ROW} [data-slot="session-changes-dash-join-stuck"]`;
/**
 * Every control the join face used to be able to mount ([P08]).
 *
 * Kept as a selector rather than dropped with the buttons: the failure this
 * file records was a control re-mounting over a live run, and a deletion
 * nobody asserts is a deletion a later refactor can quietly undo.
 */
const ANY_CONTROL =
  `${ROW} [data-slot="session-changes-dash-resolve"], ` +
  `${ROW} [data-slot="session-changes-dash-join-verify"], ` +
  `${ROW} [data-slot="session-changes-dash-join-override"], ` +
  `${ROW} [data-slot="session-changes-dash-resume"]`;

const DASHES_CARD = '.dashes-section';
const DASH_REGISTER = `${DASHES_CARD} [data-slot="dashes-row"][data-dash="${DASH}"] [data-slot="dash-join-register"]`;

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
    resolver: RESOLVER_STUB,
    // The run this file watches is the pilot's. Nothing presses it — which is
    // also what makes "no control was mounted" a claim rather than a tautology
    // about a control the test declined to touch.
    built: true,
  });
  fixtureDir = seedScratchSession(scratch.repo, SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmJoinScratchRepo(scratch);
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

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

async function runCommand(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(line);
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

async function openOnDash(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15000 },
  );
}

/** What the row is saying about the run right now. */
async function runFace(app: App): Promise<{
  word: string;
  line: string;
  error: string;
  stuck: string;
  controls: number;
}> {
  return app.evalJS<{
    word: string;
    line: string;
    error: string;
    stuck: string;
    controls: number;
  }>(
    `(function(){
      var reg = document.querySelector(${JSON.stringify(REGISTER)});
      return {
        word: reg === null ? "" : (reg.getAttribute("data-word") || ""),
        line: reg === null ? "" : (reg.textContent || ""),
        error: (document.querySelector(${JSON.stringify(RESOLVE_ERROR)})?.textContent || ""),
        stuck: (document.querySelector(${JSON.stringify(STUCK)})?.textContent || ""),
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
        // The pilot only works a dash somebody holds ([D147]); without the
        // ledger row nothing below ever starts.
        bindDash(repo, DASH, SID, scratch?.cli ?? {});
        silenceJoinPrompt(repo, DASH);

        // The aggregate has composed the dash once the Dashes card lists it.
        await app.dispatchControlAction("toggle-dashes");
        await app.waitForCondition<boolean>(
          `document.querySelector('${DASHES_CARD} [data-slot="dashes-row"][data-dash="${DASH}"]') !== null`,
          { timeoutMs: 30000 },
        );

        // ── The run starts, and nothing started it ────────────────────────
        // Read from the Dashes card first, because the shade is not up yet: the run
        // is the pilot's, and this file must not be the thing that began it.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DASH_REGISTER)})?.getAttribute("data-word") === "reconciling"`,
          { timeoutMs: 120000 },
        );
        const startedAt = Date.now();
        note("at0444: the pilot started the run with nothing pressed");
        await app.dispatchControlAction("toggle-dashes");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DASHES_CARD)}) === null`,
          { timeoutMs: 8000 },
        );

        // The shade, for the rest of the silence — the surface that used to
        // grow a control over a live run.
        await runCommand(app, "/commit");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 40000 },
        );

        // ── The silence ───────────────────────────────────────────────────
        // Sampled across the whole quiet stretch rather than once at the end:
        // the failure this closes is a face that goes wrong *at a moment* and
        // is repaired by the answer that follows, which a single late read
        // would never see.
        let sawTwelve = false;
        while (Date.now() - startedAt < (SILENCE_S - 1) * 1000) {
          const face = await runFace(app);
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          expect(face.error, `at ${elapsed}s the run must not read as failed`).toBe("");
          expect(face.stuck, `at ${elapsed}s nothing has stuck`).toBe("");
          // The register stays on its running pose. This is the deleted
          // deadline, asserted: a client that judged this rung's liveness
          // would have flipped exactly here.
          expect(face.word, `at ${elapsed}s the register reads as work`).toBe("reconciling");
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
        // The run was never in trouble, so it lands the same ready register a
        // fast one would — which is the whole claim: the client had no business
        // judging this rung's liveness, and stopping cost it nothing.
        // Read from the register rather than the account panel: the panel
        // belongs to the join FACE, which the fronted row alone carries, and
        // fronting this dash would mean aiming the composer at it — a gesture,
        // in a file whose whole claim is that nothing was pressed.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(REGISTER)})?.getAttribute("data-word") === "ready"`,
          { timeoutMs: 180000 },
        );
        const settled = await runFace(app);
        expect(settled.error, "and no error was left behind by the wait").toBe("");
        expect(settled.stuck, "nor a stuck sentence").toBe("");
        expect(settled.word, "and the run ended where a green one ends").toBe("ready");
        note("at0444: the slow run finished green and the register reads ready");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
