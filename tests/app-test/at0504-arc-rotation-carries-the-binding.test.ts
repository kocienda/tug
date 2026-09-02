/**
 * at0504-arc-rotation-carries-the-binding.test.ts — **the postmortem, as an
 * asserted property.**
 *
 * ## What this is
 *
 * `notes/wheel-rotation-strands-the-arc.md` records one incident: a stage
 * rotated, and the arc was stranded. The card's dash face went blank, a
 * `tugtool arc` verb run from a shell born before the rotation was refused
 * because that shell still held the session id it started with, and the run
 * did not walk on. Six workstreams of hardening followed. Every one of them is
 * tested where its fact lives — the ledger's units, the predicate's table, the
 * CLI's fixtures — and until this file **nothing joined them**: no test drove a
 * real rotation and then asked whether the run survived it.
 *
 * ## The rotation is the event, not the errand
 *
 * The first draft of this file spent twenty minutes getting to a rotation the
 * hard way: a trek through a real review stage, then a real
 * implement stage, then two real step boundaries with the compaction threshold
 * on the floor so the second one rotated. It never arrived, and the reason is
 * worth keeping: **every one of those minutes was spent earning a rotation,
 * and none of them was spent on what the incident was about.** A rotation is a
 * fresh segment minted on the card's line and seated by the wheel. The
 * *opening* rotation of a dash is exactly that, and it lands about a
 * second after the door is opened.
 *
 * So the door is the gesture, and the four things the incident lost are the
 * assertions:
 *
 *   1. **The kind is recorded and obeyed.** `--kind dash` opens at
 *      implement; the same dash without it opens at devise. That is W5's
 *      recorded kind, driven end to end for the first time — the second test
 *      is the contrast, and the contrast is what makes it a *recorded* kind
 *      rather than a document sniff.
 *   2. **The binding rode the seat.** The card's masthead sigil and the Z2
 *      DASH cell still name the dash after the fresh segment lands. That is
 *      W2's broadcast ordering: the `session_updated` push carrying the
 *      `(session_id, line_id)` pair goes out before `bind_dash_ok`, so the
 *      deck's segment → line → card walk can resolve the announcement instead
 *      of silently no-opping.
 *   3. **A stale id still lands on the live segment.** `tugtool arc bind
 *      --dry-run --json`, run with the id the card was *born* with, reports
 *      `rotated: true` and resolves to the segment the card is on *now*. That
 *      is W1's chokepoint, over a real rotation, and `--dry-run` is the
 *      reading that shows its work without writing.
 *   4. **The stage was actually seated.** A `stage_label` is written only by a
 *      rotation the wheel performed, and only the bridge can write the
 *      `arc-stage` line, because it names a claude session id nobody knows
 *      until claude announces it. The card's divider is the same fact wearing
 *      a face and is observed rather than waited on — see the note at the
 *      assertion for why blocking on its wording cost the first version its
 *      whole budget.
 *
 * ## What is deliberately not here
 *
 * **Whether the seated stage finishes.** The arc's later decisions — the
 * compaction at a boundary, the continue, the hand to audit — all wait on a
 * real claude doing real work on a fixture task, which is minutes of somebody
 * else's judgement and is not what this file claims. `at0480` owns the
 * compaction end to end, behind its own `TUG_REAL_CLAUDE` gate; the
 * predicate's table owns every arm.
 *
 * A rotation does spawn a claude and hand it a prompt, so this file is not
 * free — but it is one spawn, the same cost `at0476`'s second test already
 * pays, and the arc is stopped as soon as the reading is taken.
 *
 * @covers tugrust/crates/tugcast/src/feeds/arc.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 * @covers tugrust/crates/tugtool/src/arc.rs
 * @covers tugrust/crates/tugarc-core/src/arc.rs
 * @covers tugdeck/src/lib/card-session-binding-store.ts
 * @covers tugdeck/src/lib/arc-session-index.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createDash,
  dashBriefPath,
  dashTasksPath,
  fixturePlanDocument,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  tugtoolPath,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** The card the dash runs on — and, after its rotation, the stale id. */
const SID_DASH = "a7c0d1ea-0000-4000-8000-000000000504";
/** The card the trek runs on. Its own card, so its own spawn id. */
const SID_TREK = "a7c0d1ea-0000-4000-8000-000000000505";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const STAGE_DIVIDERS = `${CARD} [data-slot="stage-divider"]`;
const MASTHEAD_DASH =
  '[data-slot="session-masthead"] [data-slot="session-identity-dash"]';
/** The Z2 DASH cell — the placard the incident blanked. */
const Z2_DASH_VALUE = `${CARD} [data-slot="tug-status-cell"][data-priority="tasks"] [data-slot="session-telemetry-dash-value"]`;

/**
 * **Whether the deck moves the card's seat onto the segment a rotation
 * created — which since W7 it does.**
 *
 * This is the postmortem's own symptom, still standing after W1-W5, and this
 * file is what found it. The server side is entirely correct and is asserted
 * unconditionally above: the wheel mints the segment, `seat_line_binding`
 * moves the dash onto it, and `dash bind --dry-run` run with the card's
 * spawn-time id reports `rotated: true` and resolves to it. What does not
 * happen was the *deck* reading any of it. The row push that announces the
 * fresh segment carries its `(session_id, line_id)` pair and the deck has
 * always seated its line store on it — but the card's *seat* was never asked
 * for: `cardLineFacts` answered the card's binding `tugSessionId`, which is
 * the card's **address** and must not move (its `CardServices` bag is built
 * around it, and every frame it sends is stamped with it). So the seat is
 * derived — card → line → the line's current segment — and the dash lookup
 * every identity surface makes walks the same way on a miss. The masthead's
 * `^<dash>` sigil and the Z2 DASH cell were one lookup failing twice.
 *
 * The constant stays rather than being deleted with the defect: it is what
 * says the assertions below it are the postmortem's own screen, and flipping
 * it back is the one-line way to re-pin this file if the seat is ever lost
 * again. It was `false` for exactly one workstream — W6 found the defect here
 * and W7 closed it — and a run still says which reading it took.
 */
const DECK_SEAT_FOLLOWS_A_ROTATION = true;

/** Said either way, so a green run states the claim as loudly as a red one. */
const DECK_SEAT_NOTE =
  "the deck moves the card onto the segment the wheel seated";

const DASH_ARC = "at0504-dash";
const TREK_ARC = "at0504-trek";

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: DashScratchRepo | null = null;
const fixtureDirs: string[] = [];
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0504", checkout: CHECKOUT });

  // Two dashes with **identical documents** — a brief and a task list, which
  // is the shape `/dash` leaves. Identical on purpose: the only thing that
  // differs between the two tests is the `--kind` flag, so a difference in
  // where the arc opens can only be the recorded kind talking.
  for (const dash of [DASH_ARC, TREK_ARC]) {
    createDash(projectDir(), dash, `at0504 ${dash}`, scratch.cli);
    writeFileSync(dashBriefPath(projectDir(), dash), "# A brief\n\nOne small thing.\n");
    writeFileSync(dashTasksPath(projectDir(), dash), fixturePlanDocument(1));
  }

  for (const id of [SID_DASH, SID_TREK]) {
    fixtureDirs.push(seedScratchSession(projectDir(), id));
  }
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmDashScratchRepo(scratch);
  for (const dir of fixtureDirs) rmScratchSession(dir);
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

async function openCard(app: App, sid: string): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: sid, projectDir: projectDir() });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
}

/** Run a shell command on the card through its own `$` route. */
async function shell(app: App, command: string): Promise<void> {
  await app.nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType(`/shell ${command}`);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
}

interface ArcStageLine {
  stage: string;
  session_id: string;
}

interface ArcReading {
  stages: ArcStageLine[];
  kind: string | null;
  stopped: [string, string] | null;
}

/** What `tugtool arc record --json` says about a dash right now. */
function arcReport(name: string): ArcReading {
  const out = JSON.parse(
    tugtool(["arc", "record", name, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as { data: { arc: ArcReading | null } };
  return out.data.arc ?? { stages: [], kind: null, stopped: null };
}

/**
 * Wait until the arc record holds a rotation, and return the reading.
 *
 * A rotation is what the wheel writes an `arc-stage` line for, and the bridge
 * writes it when the fresh claude announces its session id — so this is the
 * moment the rotation is *complete*, not the moment it was asked for. A stop
 * ends the wait early and loudly: an arc that refused to rotate has a sentence
 * about why, and reporting it beats timing out with none.
 */
async function waitForRotation(name: string): Promise<ArcReading> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const arc = arcReport(name);
    if (arc.stages.length >= 1) return arc;
    if (arc.stopped !== null) {
      throw new Error(
        `at0504: ${name}'s arc stopped before it rotated — ${arc.stopped.join(": ")}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`at0504: ${name}'s arc never rotated`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/**
 * `dash bind --dry-run --json`, run with `stale` in the environment.
 *
 * From **node**, not from the card's `$` route, and that is the whole point:
 * the `$` route stamps the session id the card holds *now*, and the id the
 * incident was about is the one a process born before the rotation is still
 * carrying. `--dry-run` is the reading that shows the resolution and writes
 * nothing, so the assertion costs the binding nothing.
 */
function bindDryRun(
  name: string,
  stale: string,
): {
  posted_session_id: string;
  tug_session_id: string;
  state: string | null;
  line_id: string | null;
  rotated: boolean;
  resolved: boolean;
} {
  const out = JSON.parse(
    tugtool(["arc", "bind", name, "--dry-run", "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: { ...scratch?.cli.env, TUG_SESSION_ID: stale },
    }),
  ) as {
    data: {
      posted_session_id: string;
      tug_session_id: string;
      state: string | null;
      line_id: string | null;
      rotated: boolean;
      resolved: boolean;
    };
  };
  return out.data;
}

describe.skipIf(!SHOULD_RUN)("AT0504: a rotation the work does not notice", () => {
  test(
    "a dash opens at implement, and its rotation carries the binding and the id",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0504-arc-rotation-carries-the-binding",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app, SID_DASH);

        // The door. Opening the arc binds this card and starts the wheel,
        // whose first act is the rotation this whole file is about.
        await shell(app, `${cli} arc run ${DASH_ARC} --kind dash`);
        const arc = await waitForRotation(DASH_ARC);
        note(`at0504 dash arc: ${JSON.stringify(arc)}`);

        // ── 1. The recorded kind decided where to open ───────────────────
        //
        // A brief with no plan opens at *devise* under the default kind —
        // which the second test drives, over identical documents. So this is
        // the kind talking, not the documents.
        expect(arc.kind, "the kind is recorded, not derived later").toBe("dash");
        expect(arc.stages[0]?.stage, "no devise, no review").toBe("implement");
        const seatedSegment = arc.stages[0]!.session_id;
        expect(seatedSegment, "a rotation seated a fresh segment").not.toBe(SID_DASH);

        // ── 2. The stage was really seated ───────────────────────────────
        //
        // The `arc-stage` line above is that fact and is the one asserted: it
        // names a claude session id nobody knows until claude announces it,
        // so only a rotation the wheel actually performed can produce it.
        //
        // The card's divider is the same fact wearing a face, and it is
        // deliberately **observed rather than waited on**. Its text is
        // composed from the announcement's own field, which W5 left spelled
        // `arc` and sourced from the resolved kind — so what it reads is a
        // question about presentation, and a test that blocked on a guess at
        // its wording would spend its whole budget being wrong about
        // something it is not claiming. (It did: the first version of this
        // waited for the word "implement" and timed out at four minutes with
        // every assertion around it already true.)
        const dividers = await app.evalJS<string>(
          `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
            STAGE_DIVIDERS,
          )})).map((el) => (el.textContent || "").trim()))`,
        );
        note(`at0504 stage dividers on the card: ${dividers}`);
        note("at0504 the stage is seated", (await app.screenshot()).path);

        // ── 3. A stale id lands on the live segment ──────────────────────
        //
        // `SID_DASH` is the id the card was born on, and the rotation has
        // moved the line's tip past it. Every process started before the
        // rotation — the card's own `$` shell above all — is still holding it,
        // and the incident is what happened when one of them was believed.
        //
        // Read **before** the surface below, on purpose: this is the server's
        // own answer, so a run that fails at the card can still say whether
        // the ledger was right and only the deck was wrong. That is the
        // difference between "the binding was lost" and "the binding was not
        // announced", and they are different bugs.
        const dry = bindDryRun(DASH_ARC, SID_DASH);
        note(`at0504 stale-id resolution: ${JSON.stringify(dry)}`);
        expect(dry.posted_session_id, "the stale id is what went out").toBe(SID_DASH);
        expect(dry.resolved, "an instance answered").toBe(true);
        expect(dry.rotated, "and said the posted id had rotated").toBe(true);
        expect(dry.state, "the segment it resolved to is live").toBe("live");
        expect(dry.tug_session_id, "and is the one the rotation seated").toBe(
          seatedSegment,
        );

        // ── 4. The binding rode the seat, on the card ────────────────────
        //
        // The masthead's sigil reads the account-global aggregate's
        // `bound_sessions`, which only a live row actually carrying the
        // binding reaches; the Z2 cell reads the same dash through the card's
        // own binding store, which is what `bind_dash_ok` writes. The
        // incident blanked both.
        //
        // What the deck thinks the card is seated on is noted first, because
        // it is the fact that tells the two failure modes apart: a card still
        // reading the pre-rotation segment never learned about the new one.
        let facts = await app.evalJS<{ tugSessionId: string; lineId: string }>(
          `window.__tug.cardLineFacts("A")`,
        );
        const seatDeadline = Date.now() + 60_000;
        while (facts.tugSessionId === SID_DASH && Date.now() < seatDeadline) {
          await new Promise((r) => setTimeout(r, 1_000));
          facts = await app.evalJS<{ tugSessionId: string; lineId: string }>(
            `window.__tug.cardLineFacts("A")`,
          );
        }
        note(`at0504 the deck's seat after the rotation: ${JSON.stringify(facts)}`);
        const seatMoved = facts.tugSessionId === seatedSegment;
        note(
          seatMoved
            ? "at0504 the deck's seat followed the rotation"
            : "at0504 KNOWN DEFECT — the deck's seat did not follow the rotation; " +
              "see this file's `DECK_SEAT_FOLLOWS_A_ROTATION`",
        );
        expect(seatMoved, DECK_SEAT_NOTE).toBe(DECK_SEAT_FOLLOWS_A_ROTATION);
        if (!DECK_SEAT_FOLLOWS_A_ROTATION) return;

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MASTHEAD_DASH)}) !== null`,
          { timeoutMs: 20_000 },
        );
        const sigil = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(MASTHEAD_DASH)})?.textContent ?? "").trim()`,
        );
        note(`at0504 masthead after the rotation: ${JSON.stringify(sigil)}`);
        expect(sigil, "the card still names its dash").toContain(DASH_ARC);

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(Z2_DASH_VALUE)}) !== null`,
          { timeoutMs: 20_000 },
        );
        const placard = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(Z2_DASH_VALUE)})?.textContent ?? "").trim()`,
        );
        note(`at0504 Z2 placard after the rotation: ${JSON.stringify(placard)}`);
        expect(placard.length, "the Z2 placard did not blank").toBeGreaterThan(0);

        // Stop the arc rather than leaving a stage running past the reading.
        await shell(app, `${cli} arc stop ${DASH_ARC}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the same documents without --kind open at devise, which is what makes the kind a kind",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0504-arc-trek-default",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app, SID_TREK);

        // No `--kind`, so the default. [B08]'s default is `trek`, and the two
        // errors are not symmetric: opening a dash at devise costs two
        // rotations it did not need, while opening a trek at implement skips a
        // cold read it did. The cheaper mistake is the default.
        await shell(app, `${cli} arc run ${TREK_ARC}`);
        const arc = await waitForRotation(TREK_ARC);
        note(`at0504 trek arc: ${JSON.stringify(arc)}`);

        expect(arc.kind, "the default is recorded like any other kind").toBe("trek");
        expect(arc.stages[0]?.stage, "a brief with no plan settles first").toBe(
          "devise",
        );

        await shell(app, `${cli} arc stop ${TREK_ARC}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
