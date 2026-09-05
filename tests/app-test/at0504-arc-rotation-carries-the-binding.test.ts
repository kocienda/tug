/**
 * at0504-arc-rotation-carries-the-binding.test.ts — **the postmortem, as an
 * asserted property.**
 *
 * ## What this is
 *
 * One incident sits behind this file: a stage rotated, and the arc was
 * stranded ([D167]). The card's arc face went blank, a
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
 * hard way: a planned arc through a real review stage, then a real
 * implement stage, then two real step boundaries with the compaction threshold
 * on the floor so the second one rotated. It never arrived, and the reason is
 * worth keeping: **every one of those minutes was spent earning a rotation,
 * and none of them was spent on what the incident was about.** A rotation is a
 * fresh segment minted on the card's line and seated by the wheel. The
 * *opening* rotation of an arc is exactly that, and it lands about a
 * second after the door is opened.
 *
 * So the door is the gesture, and the four things the incident lost are the
 * assertions:
 *
 *   1. **The kind is recorded and obeyed.** A bare `arc run` opens at
 *      implement; the same arc run with `--plan` opens at devise. That is
 *      W5's recorded kind, driven end to end for the first time — the second
 *      test is the contrast, and the contrast is what makes it a *recorded*
 *      kind rather than a document sniff.
 *   2. **The binding rode the seat.** The card's masthead sigil and the Z2
 *      ARC cell still name the arc after the fresh segment lands. That is
 *      W2's broadcast ordering: the `session_updated` push carrying the
 *      `(session_id, line_id)` pair goes out before `bind_arc_ok`, so the
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
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createArc,
  arcBriefPath,
  arcTasksPath,
  arcWorktreePath,
  disarmAutoreplay,
  fixturePlanDocument,
  gitRetry,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** The card the plain arc runs on — and, after its rotation, the stale id. */
const SID_PLAIN = "a7c0d1ea-0000-4000-8000-000000000504";
/** The card the planned arc runs on. Its own card, so its own spawn id. */
const SID_PLANNED = "a7c0d1ea-0000-4000-8000-000000000505";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const STAGE_DIVIDERS = `${CARD} [data-boundary="stage"]`;
const MASTHEAD_ARC =
  '[data-slot="session-masthead"] [data-slot="session-identity-arc"]';
/** The Z2 ARC cell — the placard the incident blanked. */
const Z2_ARC_VALUE = `${CARD} [data-slot="tug-status-cell"][data-priority="tasks"] [data-slot="session-telemetry-arc-value"]`;

/**
 * **Whether the deck moves the card's seat onto the segment a rotation
 * created — which since W7 it does.**
 *
 * This is the postmortem's own symptom, still standing after W1-W5, and this
 * file is what found it. The server side is entirely correct and is asserted
 * unconditionally above: the wheel mints the segment, `seat_line_binding`
 * moves the arc onto it, and `arc bind --dry-run` run with the card's
 * spawn-time id reports `rotated: true` and resolves to it. What does not
 * happen was the *deck* reading any of it. The row push that announces the
 * fresh segment carries its `(session_id, line_id)` pair and the deck has
 * always seated its line store on it — but the card's *seat* was never asked
 * for: `cardLineFacts` answered the card's binding `tugSessionId`, which is
 * the card's **address** and must not move (its `CardServices` bag is built
 * around it, and every frame it sends is stamped with it). So the seat is
 * derived — card → line → the line's current segment — and the arc lookup
 * every identity surface makes walks the same way on a miss. The masthead's
 * `^<arc>` sigil and the Z2 ARC cell were one lookup failing twice.
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

const PLAIN_ARC = "at0504-plain";
const PLANNED_ARC = "at0504-planned";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
const fixtureDirs: string[] = [];
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0504", checkout: CHECKOUT });

  // Two arcs with **identical documents** — a brief and a task list, which
  // is the shape the bare door leaves. Identical on purpose: the only thing
  // that differs between the two tests is the `--plan` flag, so a difference in
  // where the arc opens can only be the recorded kind talking.
  //
  // The plain arc has **no seat** before the wheel runs — no `arc create`, no
  // branch, no worktree — which is exactly what a door leaves: the documents
  // and the name. The dispatch makes the worktree before it composes the
  // `where` line that names it, and the first test asserts that it did. The
  // planned arc keeps the fixture's `arc create`: it opens at devise, which
  // makes nothing, so a seat for it is not this file's question.
  for (const arc of [PLAIN_ARC, PLANNED_ARC]) {
    if (arc === PLANNED_ARC) {
      createArc(projectDir(), arc, `at0504 ${arc}`, scratch.cli);
    } else {
      disarmAutoreplay(projectDir(), arc);
    }
    writeFileSync(arcBriefPath(projectDir(), arc), "# A brief\n\nOne small thing.\n");
    writeFileSync(arcTasksPath(projectDir(), arc), fixturePlanDocument(1));
  }

  for (const id of [SID_PLAIN, SID_PLANNED]) {
    fixtureDirs.push(seedScratchSession(projectDir(), id));
  }
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
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

/** What `tugtool arc record --json` says about an arc right now. */
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
 * `arc bind --dry-run --json`, run with `stale` in the environment.
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
    "a plain arc opens at implement, and its rotation carries the binding and the id",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0504-arc-rotation-carries-the-binding",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app, SID_PLAIN);

        const worktree = arcWorktreePath(projectDir(), PLAIN_ARC);
        expect(existsSync(worktree), "no seat exists before the wheel runs").toBe(false);

        // The door. Opening the arc binds this card and starts the wheel,
        // whose first act is the rotation this whole file is about.
        await shell(app, `${cli} arc run ${PLAIN_ARC}`);
        const arc = await waitForRotation(PLAIN_ARC);
        note(`at0504 plain arc: ${JSON.stringify(arc)}`);

        // ── 0. The dispatch made the seat it named ───────────────────────
        //
        // Nothing in this fixture created a branch or a worktree for the
        // plain arc. The implement dispatch makes both before it composes the
        // `where` line, so by the time the rotation is recorded the worktree
        // stands and is checked out on the arc's branch — a line naming a
        // path that was only computed is the promise this asserts against.
        expect(existsSync(worktree), "the dispatch made the worktree").toBe(true);
        expect(
          gitRetry(worktree, "rev-parse", "--abbrev-ref", "HEAD").trim(),
          "and it is on the arc's branch",
        ).toBe(`tugarc/${PLAIN_ARC}`);

        // ── 1. The recorded kind decided where to open ───────────────────
        //
        // A brief with no plan opens at *devise* under `--plan` — which the
        // second test drives, over identical documents. So this is the kind
        // talking, not the documents.
        expect(arc.kind, "the kind is recorded, not derived later").toBe("plain");
        expect(arc.stages[0]?.stage, "no devise, no review").toBe("implement");
        const seatedSegment = arc.stages[0]!.session_id;
        expect(seatedSegment, "a rotation seated a fresh segment").not.toBe(SID_PLAIN);

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
        // `SID_PLAIN` is the id the card was born on, and the rotation has
        // moved the line's tip past it. Every process started before the
        // rotation — the card's own `$` shell above all — is still holding it,
        // and the incident is what happened when one of them was believed.
        //
        // Read **before** the surface below, on purpose: this is the server's
        // own answer, so a run that fails at the card can still say whether
        // the ledger was right and only the deck was wrong. That is the
        // difference between "the binding was lost" and "the binding was not
        // announced", and they are different bugs.
        const dry = bindDryRun(PLAIN_ARC, SID_PLAIN);
        note(`at0504 stale-id resolution: ${JSON.stringify(dry)}`);
        expect(dry.posted_session_id, "the stale id is what went out").toBe(SID_PLAIN);
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
        // binding reaches; the Z2 cell reads the same arc through the card's
        // own binding store, which is what `bind_arc_ok` writes. The
        // incident blanked both.
        //
        // What the deck thinks the card is seated on is noted first, because
        // it is the fact that tells the two failure modes apart: a card still
        // reading the pre-rotation segment never learned about the new one.
        let facts = await app.evalJS<{ tugSessionId: string; lineId: string }>(
          `window.__tug.cardLineFacts("A")`,
        );
        const seatDeadline = Date.now() + 60_000;
        while (facts.tugSessionId === SID_PLAIN && Date.now() < seatDeadline) {
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
          `document.querySelector(${JSON.stringify(MASTHEAD_ARC)}) !== null`,
          { timeoutMs: 20_000 },
        );
        const sigil = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(MASTHEAD_ARC)})?.textContent ?? "").trim()`,
        );
        note(`at0504 masthead after the rotation: ${JSON.stringify(sigil)}`);
        expect(sigil, "the card still names its arc").toContain(PLAIN_ARC);

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(Z2_ARC_VALUE)}) !== null`,
          { timeoutMs: 20_000 },
        );
        const placard = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(Z2_ARC_VALUE)})?.textContent ?? "").trim()`,
        );
        note(`at0504 Z2 placard after the rotation: ${JSON.stringify(placard)}`);
        expect(placard.length, "the Z2 placard did not blank").toBeGreaterThan(0);

        // Stop the arc rather than leaving a stage running past the reading.
        await shell(app, `${cli} arc stop ${PLAIN_ARC}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the same documents with --plan open at devise, which is what makes the kind a kind",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0504-arc-planned",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app, SID_PLANNED);

        // `--plan`, which is the only thing the settled progression is asked
        // for: the default is plain, matching the bare door, and the flag is
        // what buys the devise and the review before any step is walked.
        await shell(app, `${cli} arc run ${PLANNED_ARC} --plan`);
        const arc = await waitForRotation(PLANNED_ARC);
        note(`at0504 planned arc: ${JSON.stringify(arc)}`);

        expect(arc.kind, "the flag is recorded like any other kind").toBe("planned");
        expect(arc.stages[0]?.stage, "a brief with no plan settles first").toBe(
          "devise",
        );

        await shell(app, `${cli} arc stop ${PLANNED_ARC}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
