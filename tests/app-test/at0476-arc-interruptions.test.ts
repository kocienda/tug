/**
 * at0476-arc-interruptions.test.ts — an interrupted arc says what happened on
 * the card the user is watching, and the work is still there to pick back up.
 *
 * ## Why this exists
 *
 * `tuglaws/arc-lifecycle.md`'s Interruptions table promises three things of
 * every interruption: the arc does something sayable, the user sees a receipt,
 * and there is a gesture that resumes. The first and third are records, and
 * the Rust tests pin them. The **second** is a claim about a card, and a claim
 * about a card is only true if the card shows it — which is what this file is
 * for. Each test drives a real `tugtool` verb through the card's own `$` shell
 * route (the route that stamps `TUG_SESSION_ID`, so the server can resolve
 * which card asked) and reads the answer off the real DOM and the real ledger.
 *
 * ## What is here, and what is deliberately not
 *
 * Two of the table's rows are drivable end to end without a claude ever
 * running, and both are here in full — receipt, `--json` state, and a working
 * resume:
 *
 *   - **`tugtool arc stop`** — the verb that means *stop the arc, keep the
 *     arc*, the receipt that says so, and the **Resume** button that receipt
 *     carries. The button is the user's resume ([B01]); the CLI verb is the
 *     machine's, and the receipt names no command at all.
 *   - **A second `/arc` naming another arc** — refused by name, with the
 *     first arc's binding untouched and its record still live.
 *
 * The rows that turn on a **seated stage** — a cancelled devise turn, and a
 * discard or join reaching the card — are not here, and the reason is not
 * scope. A stage is seated by the wheel writing `stage_label` on the
 * session row at the `session_init` that follows a real rotation; nothing
 * short of a real multi-stage claude run produces one, and a fixture that
 * wrote the column by hand would be asserting against state no code path
 * builds. Those rows are covered where their facts are real: `arc_action`'s
 * table tests for the cancel arm, and `arc_api`'s integration tests over a
 * real ledger for the ending's seated list and its receipt.
 *
 * @covers tugrust/crates/tugcast/src/feeds/arc.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 * @covers tugrust/crates/tugcast/src/arc_api.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugtool/src/arc.rs
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/tug-inline-dialog.tsx
 * @covers tugdeck/src/lib/arc-press-store.ts
 * @covers tugcode/src/session.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  arcLogPath,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  shellAndSettle,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000476";
const CARD = '[data-card-id="A"]';
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;
/**
 * The offer's own title, as the block renders it — and the reason a *stop*
 * receipt is counted by this rather than by the header words `arc stopped`.
 * The block consumes that header and draws an identity strip in its place, so
 * the words never reach the row's text; the offer is the one string a stop
 * receipt puts on screen and nothing else does.
 */
const ARC_RESUME_OFFER_TITLE = "Resume this arc";
/**
 * The Resume button inside the stop receipt's own block. Addressed through the
 * block's own class rather than the dialog primitive's slot, so a second
 * inline dialog appearing anywhere on the card cannot be pressed by accident.
 */
const RESUME_BUTTON = `${CARD} .arc-receipt-resume [data-slot="tug-push-button"]`;

const ARC_NAME = "at0476-stop";
const OTHER_ARC = "at0476-other";
const THIRD_ARC = "at0476-third";
/** Every arc's brief lives at its own address, so there is nothing to name. */
const BRIEF_BODY = "# A brief\n\nSome prose the arc opens on.\n";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0476", checkout: CHECKOUT });
  createArc(projectDir(), ARC_NAME, "at0476 stop fixture", scratch.cli);
  createArc(projectDir(), OTHER_ARC, "at0476 second arc", scratch.cli);
  createArc(projectDir(), THIRD_ARC, "at0476 third arc", scratch.cli);
  // The arc opens on the arc's own brief, so each one that runs gets one.
  for (const name of [ARC_NAME, OTHER_ARC]) {
    writeFileSync(arcBriefPath(projectDir(), name), BRIEF_BODY);
  }
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

/**
 * Run a shell command on the card and wait for the transcript to carry
 * `marker`.
 *
 * Not `shellAndSettle`: that waits for an exact row count, and the receipt
 * this file is about **is itself a shell row** ([D111]). A stop that lands its
 * receipt therefore leaves two rows where the count-based wait demanded one,
 * and the wait can never come true — the thing under test defeats the helper
 * that was supposed to observe it. Waiting on the text is indifferent to how
 * many rows the act produced.
 */
async function shellUntil(app: App, command: string, marker: string): Promise<void> {
  const prompt = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
  await app.nativeClickAtElement(prompt);
  await app.nativeType(`/shell ${command}`);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
  await app.waitForCondition<boolean>(
    `Array.from(document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}))
       .some((el) => (el.textContent || "").indexOf(${JSON.stringify(marker)}) !== -1)`,
    { timeoutMs: 60_000 },
  );
}

/** Every shell row's text, in transcript order. */
async function shellRowText(app: App): Promise<string[]> {
  const raw = await app.evalJS<string>(
    `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
      SHELL_ROWS,
    )})).map((el) => el.textContent || ""))`,
  );
  return JSON.parse(raw) as string[];
}

/** What `tugtool arc record --json` says about an arc, read from the fixture. */
function arcReport(name: string): {
  stopped: [string, string] | null;
  resume: string | null;
  done: boolean;
  dispatched: string | null;
  stages: string[];
} {
  const out = JSON.parse(
    tugtool(["arc", "record", name, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as {
    data: {
      arc: {
        stopped: [string, string] | null;
        resume: string | null;
        done: boolean;
        dispatched: string | null;
        stages: Array<{ stage: string }>;
      } | null;
    };
  };
  const arc = out.data.arc;
  if (arc === null) {
    return { stopped: null, resume: null, done: false, dispatched: null, stages: [] };
  }
  return {
    stopped: arc.stopped,
    resume: arc.resume,
    done: arc.done,
    dispatched: arc.dispatched,
    stages: arc.stages.map((line) => line.stage),
  };
}

/**
 * Read `probe` until `settled` accepts what it returns, or give up.
 *
 * Not `waitForCondition`: that evaluates JavaScript inside the app, and what
 * is being waited on here is a record on disk that a short-lived `tugtool`
 * process reads back. The app has no view of it.
 */
async function pollUntil<T>(
  probe: () => T,
  settled: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = probe();
  while (!settled(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    last = probe();
  }
  return last;
}

async function openCard(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
}

describe.skipIf(!SHOULD_RUN)("AT0476: an interrupted arc says so on the card", () => {
  test(
    "arc stop stops the arc, says so on the card, and arc run picks it back up",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0476-arc-interruptions",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app);

        // Opening the arc and stopping it are **one** shell line, and that is
        // not a convenience. A live arc on an idle card is a rotating arc:
        // the runner's next tick seats the first stage. Chaining the two verbs
        // in one process is what puts the interruption where the test means
        // it, rather than wherever the sweep happened to be.
        //
        // The wait is on the receipt itself, which is the claim: the card was
        // told, in words, on the surface the user is watching.
        await shellUntil(
          app,
          `${cli} arc run ${ARC_NAME} && ${cli} arc stop ${ARC_NAME}`,
          "you stopped it",
        );

        // The record says it, in the closed vocabulary. Stable to re-read: a
        // stopped arc is not advanced by a tick.
        const stopped = arcReport(ARC_NAME);
        note("at0476 arc after stop", JSON.stringify(stopped));
        expect(stopped.stopped?.[1]).toBe("stopped by user");
        expect(stopped.done).toBe(false);

        // And the card says it, as a shell-exchange row ([D111]) under
        // `/arc-run` — which is what a restore replays too.
        const rows = await shellRowText(app);
        const receipt = rows.find((t) => t.indexOf("you stopped it") !== -1) ?? "";
        note("at0476 stop receipt", receipt);
        // **The header is a parse key, not display text.** The receipt's
        // first line — `arc stopped · <arc> · in <stage> — <reason>` — is
        // what `parseArcReceipt` matches on, and the block's whole purpose is
        // to spend it: it renders the arc as an atom and the reason as the
        // lifecycle strip's note.
        // Asserting the raw prefix would pin the row to *not* having been
        // recognized, which is the opposite of the claim. So the claim is
        // that it was recognized — the wheel-attributed identifier is the one
        // word only the arc-receipt block puts on a row.
        expect(receipt).toContain("Wheel");
        expect(receipt).toContain(ARC_NAME);
        // And it names no command. The resume is a button in this row's own
        // block; a CLI verb in the transcript is the implementation leaking
        // into something the user reads.
        expect(receipt).not.toContain("tugtool arc run");
        note("at0476 card with the stop receipt", (await app.screenshot()).path);

        // ── And the way back into the work is a button ────────────────────
        //
        // The whole of the claim: the row the user is looking at carries the
        // resume itself, and pressing it is the only gesture required. No CLI
        // verb is typed here, because the point of the change is that the
        // user never has to.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RESUME_BUTTON)}) !== null`,
          { timeoutMs: 30_000 },
        );
        note("at0476 card with the Resume button", (await app.screenshot()).path);
        await app.nativeClickAtElement(RESUME_BUTTON);

        // The record is the reading, and it is a **moving target**: the press
        // clears the stop and asks for the stopped stage again, and the runner
        // is then free to rotate it. So the poll takes the first snapshot in
        // which the stop is gone, and the claim about *which* stage was asked
        // for accepts any of the three shapes that fact wears as the rotation
        // proceeds — the standing request, the dispatch, or the stage line the
        // dispatch produced. Pinning only the first would be pinning a race.
        const after = await pollUntil(
          () => arcReport(ARC_NAME),
          (report) => report.stopped === null,
        );
        note("at0476 resume", JSON.stringify(after));
        expect(after.stopped).toBeNull();
        const askedForDevise =
          after.resume === "devise" ||
          after.dispatched === "devise" ||
          after.stages.includes("devise");
        expect(askedForDevise).toBe(true);

        // ── One press, one stop, and no second one behind it ──────────────
        //
        // The guard for the whole arc's worth of work: an arc stopped for
        // silence used to be re-stopped within 160 ms of the press, because
        // the stall clock outranked the resume and the runner's memory
        // outlived the stop. Nothing about that was visible in the record's
        // *final* state — it settled back to stopped — so what is asserted is
        // the count of lines, after the receipt stream has been quiet long
        // enough for a second stop to have landed if one were coming.
        //
        // Six seconds: the settle plus one. A re-stop is decided at a settled
        // idle edge, so a window that has stayed quiet for longer than one has
        // already outlived the decision.
        //
        // The wait is written as a wait for the row the re-stop *would* add,
        // so the timeout is the pass and the resolution is the failure. Waiting
        // for the count to stay put would be a condition already true, which
        // resolves at once and waits for nothing at all.
        const receiptCount = async () => (await shellRowText(app)).length;
        const before = await receiptCount();
        let grew = true;
        await app
          .waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}).length > ${before}`,
            { timeoutMs: 6_000 },
          )
          .catch(() => {
            grew = false;
          });
        expect(grew).toBe(false);

        const rowsAfterResume = await shellRowText(app);
        note("at0476 rows after the resume", JSON.stringify(rowsAfterResume));
        expect(
          rowsAfterResume.filter((row) => row.includes(ARC_RESUME_OFFER_TITLE))
            .length,
        ).toBe(1);

        const logLines = readFileSync(arcLogPath(scratch?.dataRoot ?? ""), "utf8")
          .split("\n")
          .filter((line) => line.includes(`\t${ARC_NAME}\t`) || line.includes(ARC_NAME));
        const resumeAt = logLines.findIndex((line) => line.includes("arc-resume"));
        expect(resumeAt).toBeGreaterThanOrEqual(0);
        expect(
          logLines.filter((line) => line.includes("arc-resume")).length,
        ).toBe(1);
        expect(
          logLines.slice(resumeAt + 1).some((line) => line.includes("arc-stop")),
        ).toBe(false);

        // ── And the frame the offer sits in pads evenly ───────────────────
        //
        // A header-only dialog — a title and an action, no description and no
        // options — used to inherit the padding of the shape that has rows
        // under it, so the offer sat high in its own frame. The layout the
        // primitive derives is what says which shape this is.
        const framing = await app.evalJS<string>(
          `(() => {
            const root = document.querySelector(${JSON.stringify(
              `${CARD} .arc-receipt-resume`,
            )});
            if (root === null) return JSON.stringify({ layout: null });
            const style = getComputedStyle(root);
            return JSON.stringify({
              layout: root.getAttribute("data-layout"),
              top: style.paddingTop,
              bottom: style.paddingBottom,
            });
          })()`,
        );
        const frame = JSON.parse(framing) as {
          layout: string | null;
          top?: string;
          bottom?: string;
        };
        note("at0476 resume frame", framing);
        expect(frame.layout).toBe("header");
        expect(frame.bottom).toBe(frame.top);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a second arc on a card already running one is refused by name",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0476-arc-interruptions-bind",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app);

        // One line again, and for the same reason: the refusal is about a
        // card running a **live** arc, and a tick between the two verbs
        // would seat a stage or stop the arc, either of which changes the
        // question being asked.
        await shellAndSettle(
          app,
          `${cli} arc run ${OTHER_ARC} && ${cli} arc bind ${THIRD_ARC}`,
        );

        // ── The interruption that is refused rather than described ────────
        //
        // The message is the whole proof of the binding it protects: the
        // server names what the card is running back to the person who asked
        // to displace it.
        const rows = await shellRowText(app);
        const refusal = rows[0] ?? "";
        note("at0476 bind refusal", refusal);
        expect(refusal).toContain(`card runs ${OTHER_ARC}`);
        expect(refusal).toContain(THIRD_ARC);
        note("at0476 card with the refusal", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
