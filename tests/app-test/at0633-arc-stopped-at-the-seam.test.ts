/**
 * at0633-arc-stopped-at-the-seam.test.ts — a stop between the last step and
 * the audit is not an offer.
 *
 * A person pressed Stop on the Arcs card just as an arc closed its last plan
 * step and before its audit began, meaning to pick the audit up later. The
 * stop was stamped `implement` — the stage that was seated — and the server
 * read a stop outside the audit as no wheel at all, restored the pre-wheel
 * `run_complete` arm, and called the arc ready. The Changes shade raised
 * itself over the card with `Ready to join to main` and the implement stage's
 * provisional draft in the composer: exactly what a finished arc looks like,
 * over a tree nothing had audited.
 *
 * This file drives a real planned arc to that state — every step closed, a
 * round committed, the implement stage seated on the card's own session, and
 * then stopped through the real verb, `tugtool arc stop`, so the stop is a
 * person's (`stopped by user`) rather than the wheel's — and reads what the
 * surfaces make of it:
 *
 *  - the Arcs row's strip lights `implement`, the cell the stop names, and
 *    the note is the stop alone: `Stopped · stopped by user`;
 *  - the row's join register reads `unaudited`, in the caution pulse, and
 *    its sentence names the seam — `stopped before its audit` — rather than
 *    an audit that never began; `Ready to join` stands nowhere on the row;
 *  - the card never enters the Changes route on its own: no offer is minted
 *    (`join_ready` is shut on the server, so the pilot never runs), the route
 *    segment wears no offer, and the shade stays down;
 *  - and the escape the sentence promises is real: `/arc-join` opens the room
 *    in join mode on the stopped arc, the register still refuses to call it
 *    ready, and a press lands the branch on the base — the unaudited join is
 *    the user's act, possible and never called ready.
 *
 * `at0513` holds the same reading for a stop *in* the audit; this file is its
 * sibling for a stop in the stage before it, which is the half the incident
 * lived in. The pure table in `arc-join-register.test.ts` pins the sentence;
 * `log.rs` pins the gate; what this file pins is the whole chain from a real
 * press through the feed to the row, the route, and the join.
 *
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/lib/arc-join-register.ts
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-lane.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-track.tsx
 * @covers tugrust/crates/tugarc-core/src/log.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 * @covers tugrust/crates/tugcast/src/feeds/changeset.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc.rs
 * @covers tugrust/crates/tugcast/src/arc_api.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  appendArcLogLine,
  arcBriefPath,
  arcLogPath,
  bindArc,
  commitRound,
  createArc,
  makeArcScratchRepo,
  recordStampedPlan,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000633";

/** A planned arc whose walk finished and which a person stopped at the seam. */
const ARC_NAME = "at0633-seam";

const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;
const LANE_ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC_NAME}"]`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;
/** The Z4A route group — the offer rides an attribute on it, never a label. */
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-route-group`;
/** The composer's register — the shade, the composer and the Arcs row all
 *  call one derivation, so a `ready` here is a `ready` everywhere. */
const CARD_REGISTER = `${CARD} [data-slot="arc-join-register"]`;

const SECTION = ".arcs-section";
const ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${ARC_NAME}"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0633", checkout: CHECKOUT });
  const cli = scratch.cli;

  // A planned arc, as the door leaves one: a brief, a stamped two-row plan
  // with its run declared over both rows, and the kind on the record. The
  // opening lines are appended rather than driven through `arc run` — the
  // runner would seat a stage and start rotating, and the fixture wants the
  // record at the seam without the machinery. It is the route `at0513` takes.
  const arc = createArc(projectDir(), ARC_NAME, "at0633 stopped at the seam", cli);
  writeFileSync(arcBriefPath(projectDir(), ARC_NAME), "# at0633 brief\n");
  recordStampedPlan(projectDir(), ARC_NAME, arc.worktree, {
    ...cli,
    rows: 2,
    through: 2,
  });
  const log = arcLogPath(scratch.dataRoot);
  appendArcLogLine(log, ARC_NAME, "arc-start", `.tug/arcs/${ARC_NAME}/plan.md`);
  appendArcLogLine(log, ARC_NAME, "arc-kind", "planned");

  // The walk, through the real verbs, with one real round on the branch —
  // the gate refuses an arc with no rounds before it ever reads the wheel,
  // and the arc under test is one whose implement stage genuinely finished.
  writeFileSync(join(arc.worktree, "one.txt"), "first\n");
  commitRound(projectDir(), ARC_NAME, "tugarc(at0633-seam): Land the one round", cli);
  const step = (...args: string[]): void => {
    tugtool(["arc", "step", ARC_NAME, ...args], {
      cwd: projectDir(),
      binaryRoot: cli.binaryRoot,
      env: cli.env,
    });
  };
  // `recordStampedPlan` already opened step 1 and declared the selection.
  step("done", "1");
  step("start", "2", "--through", "2");
  step("done", "2");

  // The implement stage is seated — on the card's own session, which is what
  // the seat is in life, and which is what keeps the wheel from judging the
  // arc before the press: a seated, current stage that has ended no turn is
  // one the predicate waits on. The audit's `arc-stage` line has not landed,
  // so the record is exactly the seam the incident's stop fell into.
  appendArcLogLine(log, ARC_NAME, "arc-stage", `implement ${SID} opus`);

  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
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

/**
 * Run a shell command on the card and wait for the transcript to carry
 * `marker` — the stop's receipt is itself a shell row, so the wait is on the
 * text rather than on a row count (the shape `at0476` settled on).
 */
async function shellUntil(app: App, command: string, marker: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(`/shell ${command}`);
  await settle(150);
  await app.nativeKey("Enter", ["cmd"]);
  await app.waitForCondition<boolean>(
    `Array.from(document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}))
       .some((el) => (el.textContent || "").indexOf(${JSON.stringify(marker)}) !== -1)`,
    { timeoutMs: 60_000 },
  );
}

/** Whether the shade is up right now. */
function shadeUp(app: App): Promise<boolean> {
  return app.evalJS<boolean>(`document.querySelector(${JSON.stringify(SHEET)}) !== null`);
}

/** Whether the Changes segment is wearing the standing-join dot. */
function offerDot(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(ROUTE_GROUP)})?.hasAttribute("data-join-offer") ?? false`,
  );
}

/**
 * Watch for the shade or the offer across a window, and say whether either
 * ever appeared. Sampled rather than read once: the failure this guards is a
 * reveal that fires and is superseded, which a single late read would report
 * as silence.
 */
async function offerAppearsWithin(app: App, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await shadeUp(app)) || (await offerDot(app))) return true;
    await settle(500);
  }
  return false;
}

interface RowReading {
  phase: string | null;
  stopped: string | null;
  litCell: string | null;
  note: string;
  joinWord: string | null;
  registerWord: string | null;
  registerLine: string;
  text: string;
}

/** The Arcs row, read whole from one beat: strip, note, register. */
const readRow = (app: App): Promise<RowReading> =>
  app.evalJS<RowReading>(
    `(() => {
       const row = document.querySelector(${JSON.stringify(ROW)});
       const track = row.querySelector('[data-slot="tug-arc-track"]');
       const lit = track.querySelector('[data-slot="tug-arc-track-cell"][data-state="stopped"]');
       const register = row.querySelector('[data-slot="arc-join-register"]');
       return {
         phase: track.getAttribute("data-phase"),
         stopped: track.getAttribute("data-stopped"),
         litCell: lit?.getAttribute("data-phase") ?? null,
         note: (row.querySelector('[data-slot="tug-arc-lifecycle-note"]')?.textContent ?? "").trim(),
         joinWord: row.getAttribute("data-join-word"),
         registerWord: register?.getAttribute("data-word") ?? null,
         registerLine: (register?.textContent ?? "").trim(),
         text: (row.textContent ?? "").trim(),
       };
     })()`,
  );

/**
 * Open the room in JOIN mode the way a user does: `/arc-join <name>`.
 * Retried, because the command needs the arc to have reached the changeset
 * feed — before that it answers with a bulletin and nothing opens.
 */
async function openTheRoomOnTheJoin(app: App): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    await app.nativeClickAtElement(EDITOR);
    await settle();
    await app.nativeKey("a", ["cmd"]);
    await app.nativeKey("Delete");
    await app.nativeType(`/arc-join ${ARC_NAME}`);
    await settle();
    // Dismiss the completion popup; join mode is not up yet, so this reaches
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
        `document.querySelector(${JSON.stringify(LANE_ROW)}) !== null`,
        { timeoutMs: 40000 },
      );
      return;
    } catch {
      note(`at0633 /arc-join did not open the room in join mode (attempt ${attempt})`);
    }
  }
  throw new Error("at0633: /arc-join never opened the room in join mode");
}

/** The base branch's tip subject — the only place a join writes itself down. */
function baseTip(): string {
  return Bun.spawnSync(["git", "-C", projectDir(), "log", "-1", "--format=%s", "main"], {})
    .stdout.toString()
    .trim();
}

describe.skipIf(!SHOULD_RUN)("AT0633: a stop at the seam is not an offer", () => {
  test(
    "the row reads `Stopped · stopped by user` in implement with the word `unaudited`, the shade never raises itself, and /arc-join still lands the branch unaudited",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0633-arc-stopped-at-the-seam",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bind: spawning registers the scratch
        // repo as a workspace, so its arcs reach the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // The card holds the arc, through the real ledger verb: `arc stop`
        // stops the arc the calling card is bound to, and the pilot — were
        // the gate ever to open — works only a bound arc ([D147]). Binding
        // is also what makes this the incident's shape: a bound, finished
        // implement stage sitting at the seam.
        bindArc(projectDir(), ARC_NAME, SID, scratch?.cli ?? {});

        // The press. A person's stop, through the verb the Arcs card's
        // button runs, from the card's own shell so the calling session is
        // the bound one. The receipt is the wait: the card was told, in
        // words, on the surface the user is watching.
        await shellUntil(app, `${tugtoolPath(CHECKOUT)} arc stop ${ARC_NAME}`, "you stopped it");

        await app.dispatchControlAction("toggle-arcs");
        // The row, with the stop folded into it: `data-stopped` on the strip
        // is the last fact the feed derives from the record, so a row that
        // has it has everything else this file reads.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ROW} [data-slot="tug-arc-track"][data-stopped="true"]`)}) !== null`,
          { timeoutMs: 30000 },
        );
        const row = await readRow(app);
        note("at0633 row", JSON.stringify(row));
        note("at0633 screenshot", (await app.screenshot()).path);

        // ── The stop landed where it landed: implement ────────────────────
        // The strip lights the cell the stop names, and the note is the
        // stop alone, in the record's own vocabulary. This is the fact the
        // brief keeps: the strip records where the stop happened, and the
        // register is where "the audit is what is owed" gets said.
        expect(row.phase).toBe("implement");
        expect(row.stopped).toBe("true");
        expect(row.litCell).toBe("implement");
        expect(row.note).toBe("Stopped · stopped by user");

        // ── The offer is not made, and the register says why ─────────────
        // `join_ready` is shut over every stop on a wheel-driven arc now, so
        // the derived stage is not a joinable word — and the register speaks
        // anyway, because a stop with the walk over is the one wait it has a
        // sentence for. The sentence names the seam, not an audit that never
        // began.
        expect(row.joinWord).toBe("unaudited");
        expect(row.registerWord).toBe("unaudited");
        expect(row.registerLine).toContain("stopped before its audit");
        expect(row.registerLine).not.toContain("audit stopped");
        expect(row.text).not.toContain("Ready to join");

        // ── The card never enters Changes on its own ──────────────────────
        // The incident's face: the shade raised itself over the card with
        // the provisional draft in the composer. No offer is minted over a
        // shut gate, so nothing summons the shade and the segment wears no
        // dot. Sampled across a window, because the reveal this guards
        // against is one that fires on a recompute.
        expect(
          await offerAppearsWithin(app, 6000),
          "no offer is minted over a stopped, unaudited arc, so the shade stays down",
        ).toBe(false);

        // ── The escape is real: /arc-join lands it, unaudited ─────────────
        // The sentence promises "resume it, or land it unaudited", and the
        // brief's open question was whether the second half works from the
        // deck on a stopped arc. Open the room by name, as a user would.
        await openTheRoomOnTheJoin(app);
        // Entering join mode resolves the arc ([P03]) and a candidate comes
        // to stand — and the register still refuses to call it ready: the
        // stop outranks the candidate, on the composer as on the row.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD_REGISTER)})?.getAttribute("data-word") === "unaudited"`,
          { timeoutMs: 30000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(`${CARD} [data-slot="arc-join-register"][data-word="ready"]`)}) === null`,
          ),
          "nothing on the card calls a stopped, unaudited arc ready",
        ).toBe(true);

        // A message of the user's own, so the press clears the gate on its
        // merits rather than on whatever draft the arc happens to hold.
        await app.nativeClickAtElement(EDITOR);
        await settle();
        await app.nativeKey("a", ["cmd"]);
        await app.nativeKey("Delete");
        await app.nativeType("at0633: land this arc unaudited");
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR)})?.textContent ?? "").indexOf("land this arc") !== -1`,
          { timeoutMs: 5000 },
        );
        const before = baseTip();
        await app.nativeKey("Return", ["cmd"]);

        // The base branch moving is the proof: the unaudited join is possible,
        // and it is the user's act. Waiting on the outcome, never on the
        // shade's exit — background windows run no rAF.
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline && baseTip() === before) await settle(500);
        expect(baseTip(), "the press reached the wire and the unaudited join landed").not.toBe(
          before,
        );
        note(`at0633 landed: ${JSON.stringify(baseTip())}`);
        // And the arc is gone from the lane: a landed arc that keeps being
        // offered would be the same lie the stop was.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LANE_ROW)}) === null`,
          { timeoutMs: 60000 },
        );
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
