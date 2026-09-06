/**
 * at0523-arc-transport-stop.test.ts — Stop is a button on the Arcs card's row,
 * and pressing it stops the arc.
 *
 * ## Why this exists
 *
 * [D178] puts one transport control on every surface that shows a whole arc,
 * and the hardest of its three faces to reach any other way is Stop: an arc
 * that is running is precisely the one whose card is busy, so the row that
 * merely *routed* to that card was routing you at the moment routing helps
 * least. The claim is end to end and nothing short of the real app can make
 * it — the control derives its face from the aggregate the server sends, the
 * press goes out as an `arc_stop` CONTROL frame, the supervisor writes the
 * record and the receipt, and the row redraws itself as Resume off the next
 * beat. Every link in that chain is somebody else's unit test; this file is
 * the chain.
 *
 * The arc runs for real — `tugtool arc run` through the card's own `$` shell
 * route, so the server resolves which card asked from the `TUG_SESSION_ID` the
 * route stamps. What is deliberately absent is a claude: the stop's
 * interrupt branch needs a running turn, and that is pinned in Rust over a
 * `LedgerEntry` with a captured `input_rx` rather than guessed at here.
 *
 * `agent_supervisor.rs` is deliberately not named. The CONTROL `arc_stop` arm
 * and `stop_arc_now` both live there and both run in this test, but each is
 * pinned by a Rust test of its own — and that file is at its recorded
 * fan-out, which a claim already covered elsewhere is not worth widening.
 * `arc_api.rs` is where this press's server-side decision actually lives.
 *
 * @covers tugdeck/src/components/tugways/arc-transport-control.tsx
 * @covers tugdeck/src/components/tugways/arc-transport-control.css
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/lib/arc-transport.ts
 * @covers tugdeck/src/lib/arc-press-store.ts
 * @covers tugrust/crates/tugcast/src/arc_api.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
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
  createArc,
  arcBriefPath,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000520";
const CARD = '[data-card-id="A"]';
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;
const SECTION = ".arcs-section";

const ARC_NAME = "at0523-stop";
const ROW = `${SECTION} [data-slot="arcs-row"][data-arc="${ARC_NAME}"]`;
/** The row's transport, whatever face it is wearing. */
const TRANSPORT = `${ROW} [data-slot="arc-transport"]`;
const transportWith = (verb: string): string => `${TRANSPORT}[data-verb="${verb}"]`;

const BRIEF_BODY = "# A brief\n\nSome prose the arc opens on.\n";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0523", checkout: CHECKOUT });
  createArc(projectDir(), ARC_NAME, "at0523 stop fixture", scratch.cli);
  writeFileSync(arcBriefPath(projectDir(), ARC_NAME), BRIEF_BODY);
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

/**
 * Run a shell command on the card and wait for the transcript to carry
 * `marker` — the same shape `at0476` uses, and for the same reason: the acts
 * under test add transcript rows of their own, so a wait on an exact row count
 * can never come true.
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

/** What `tugtool arc record --json` says about the arc, read from the fixture. */
function arcReport(): { stopped: [string, string] | null; done: boolean } {
  const out = JSON.parse(
    tugtool(["arc", "record", ARC_NAME, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as { data: { arc: { stopped: [string, string] | null; done: boolean } | null } };
  const arc = out.data.arc;
  return arc === null ? { stopped: null, done: false } : arc;
}

/**
 * Read `probe` until `settled` accepts it. Not `waitForCondition`: the record
 * is a file a short-lived `tugtool` reads back, and the app has no view of it.
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

describe.skipIf(!SHOULD_RUN)("AT0523: Stop on the Arcs card's row", () => {
  test(
    "a running arc's row wears Stop, and the press stops it",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0523-arc-transport-stop",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        // A *spawned* session, not a bound one: spawning registers the scratch
        // repo as a workspace, which is what puts its arcs in the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SECTION)}) !== null`,
          { timeoutMs: 30_000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30_000 },
        );

        // ── Before the arc runs, the row offers to start it ───────────────
        //
        // Which is the face's other end, asserted here because this fixture
        // is the one that watches the same button change: an arc with a brief
        // and no run reads Start, and nothing about the arc's *documents*
        // moves for the rest of the test.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(transportWith("start"))}) !== null`,
          { timeoutMs: 30_000 },
        );

        // The arc runs for real, through the card's own shell route.
        await shellUntil(app, `${cli} arc run ${ARC_NAME} --plan`, "is bound to it");

        // ── And the row's one button is now Stop ──────────────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(transportWith("stop"))}) !== null`,
          { timeoutMs: 30_000 },
        );
        const before = await app.evalJS<string>(
          `(() => {
             const button = document.querySelector(${JSON.stringify(TRANSPORT)});
             return JSON.stringify({
               verb: button.getAttribute("data-verb"),
               form: button.getAttribute("data-form"),
               refused: button.getAttribute("data-refused"),
               label: button.getAttribute("aria-label"),
             });
           })()`,
        );
        note("at0523 the row's control while the arc runs", before);
        const stopFace = JSON.parse(before) as {
          verb: string;
          form: string;
          refused: string | null;
          label: string;
        };
        // An icon, not a word — the row's trailing column is a glyph column.
        expect(stopFace.form).toBe("icon");
        // The bound card is this card, so nothing refuses.
        expect(stopFace.refused).toBeNull();
        // And the reader with no eyes still learns which arc it is.
        expect(stopFace.label).toBe(`Stop arc ${ARC_NAME}`);

        await app.nativeClickAtElement(transportWith("stop"));

        // ── The record says it, in the closed vocabulary ──────────────────
        const stopped = await pollUntil(
          () => arcReport(),
          (report) => report.stopped !== null,
        );
        note("at0523 arc after the press", JSON.stringify(stopped));
        expect(stopped.stopped?.[1]).toBe("stopped by user");
        expect(stopped.done).toBe(false);

        // ── The card says it, on the surface the user is watching ─────────
        //
        // The press is a button on a *rail card*, and the receipt it earns
        // lands on the Session card — which is the whole of [D178]'s claim
        // that the row acts as a card rather than merely describing one.
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}))
             .some((el) => (el.textContent || "").indexOf("you stopped it") !== -1)`,
          { timeoutMs: 30_000 },
        );
        note("at0523 card with the stop receipt", (await app.screenshot()).path);

        // ── And the same button is now the way back in ────────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(transportWith("resume"))}) !== null`,
          { timeoutMs: 30_000 },
        );
        const after = await app.evalJS<string>(
          `(() => {
             const buttons = document.querySelectorAll(${JSON.stringify(TRANSPORT)});
             const button = buttons[0];
             return JSON.stringify({
               count: buttons.length,
               verb: button.getAttribute("data-verb"),
               label: button.getAttribute("aria-label"),
             });
           })()`,
        );
        note("at0523 the row's control after the stop", after);
        const resumeFace = JSON.parse(after) as {
          count: number;
          verb: string;
          label: string;
        };
        // One control, wearing a second face — never two buttons.
        expect(resumeFace.count).toBe(1);
        expect(resumeFace.verb).toBe("resume");
        expect(resumeFace.label).toBe(`Resume arc ${ARC_NAME}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
