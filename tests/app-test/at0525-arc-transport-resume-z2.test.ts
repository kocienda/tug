/**
 * at0525-arc-transport-resume-z2.test.ts — the `ARC` placard's footer carries
 * the transport, and Resume there picks the arc back up.
 *
 * ## Why this exists
 *
 * The placard is the reading a card gives of its own arc, reached by clicking
 * the Z2 work cell. It was a reading and nothing else: its one exit was
 * `Show in Changes`, so a user looking straight at a stopped arc had to leave
 * the placard, find the shade, and read a receipt to get back into the work.
 * [D178] puts the same control the Arcs card's row wears into the footer, in
 * the word form the footer's cluster is set in, and this file is the claim
 * that the second surface really is the first one: one component, one
 * derivation, two mounts.
 *
 * Resume rather than Stop, because Resume is the face that proves the actor
 * rule. A stopped arc keeps its binding ([F10]), so the press acts as the
 * bound card — which is this card — and the placard never has to reach for a
 * followed card it does not have.
 *
 * @covers tugdeck/src/components/tugways/arc-transport-control.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx
 * @covers tugdeck/src/lib/arc-transport.ts
 * @covers tugdeck/src/lib/arc-press-store.ts
 * @covers tugrust/crates/tugcast/src/arc_api.rs
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

const SID = "a7c0d1ea-0000-4000-8000-000000000522";
const CARD = '[data-card-id="A"]';
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

/** The Z2 work cell — TASKS or ARC, one `data-priority` either way. */
const CELL = `${CARD} [data-slot="tug-status-cell"][data-priority="tasks"]`;
/** The placard's own frame, which is where its footer lives — the body slot
 *  is the scroller above it and does not contain the cluster. */
const PLACARD = ".session-arc-popover";
const TRANSPORT = `${PLACARD} [data-slot="arc-transport"]`;
const transportWith = (verb: string): string => `${TRANSPORT}[data-verb="${verb}"]`;

const ARC_NAME = "at0525-resume";
const BRIEF_BODY = "# A brief\n\nSome prose the arc opens on.\n";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0525", checkout: CHECKOUT });
  createArc(projectDir(), ARC_NAME, "at0525 resume fixture", scratch.cli);
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

/** Run a shell command on the card and wait for the transcript to carry
 *  `marker` — the acts under test add rows of their own, so a wait on a row
 *  count can never come true. */
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

/** What `tugtool arc record --json` says about the arc. */
function arcReport(): {
  stopped: [string, string] | null;
  resume: string | null;
  dispatched: string | null;
  stages: string[];
} {
  const out = JSON.parse(
    tugtool(["arc", "record", ARC_NAME, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as {
    data: {
      arc: {
        stopped: [string, string] | null;
        resume: string | null;
        dispatched: string | null;
        stages: Array<{ stage: string }>;
      } | null;
    };
  };
  const arc = out.data.arc;
  if (arc === null) {
    return { stopped: null, resume: null, dispatched: null, stages: [] };
  }
  return {
    stopped: arc.stopped,
    resume: arc.resume,
    dispatched: arc.dispatched,
    stages: arc.stages.map((line) => line.stage),
  };
}

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

describe.skipIf(!SHOULD_RUN)("AT0525: Resume in the ARC placard's footer", () => {
  test(
    "the placard offers Resume on a stopped arc, and the press picks it up",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0525-arc-transport-resume-z2",
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
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        // Both verbs on one shell line, as `at0476` runs them and for the same
        // reason: a live arc on an idle card is a rotating arc, and a tick
        // between the two would put the interruption somewhere else.
        await shellUntil(
          app,
          `${cli} arc run ${ARC_NAME} && ${cli} arc stop ${ARC_NAME}`,
          "you stopped it",
        );

        // ── The Z2 cell opens the placard ─────────────────────────────────
        //
        // The cell is TASKS or ARC under one `data-priority`, and only the
        // ARC reading opens this placard — so the wait is on the endcap's
        // word rather than on the cell's presence.
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(CELL)})?.querySelector(".session-telemetry-endcap-label")?.textContent ?? "").trim() === "ARC"`,
          { timeoutMs: 30_000 },
        );
        await app.click(CELL);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PLACARD)}) !== null`,
          { timeoutMs: 30_000 },
        );

        // ── And its footer carries the transport, wearing Resume ──────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(transportWith("resume"))}) !== null`,
          { timeoutMs: 30_000 },
        );
        const offered = await app.evalJS<string>(
          `(() => {
             const footer = document.querySelector(${JSON.stringify(
               `${PLACARD} [data-slot="tug-popup-list-footer"]`,
             )});
             const button = footer.querySelector('[data-slot="arc-transport"]');
             // The exit, which the transport leads: the act on the arc, then
             // the room where every other decision about it lives. Found by
             // its own slot rather than by position, since the transport is a
             // push button too and wears a slot of its own.
             const exit = footer.querySelector('[data-slot="tug-push-button"]');
             return JSON.stringify({
               verb: button.getAttribute("data-verb"),
               form: button.getAttribute("data-form"),
               refused: button.getAttribute("data-refused"),
               text: (button.textContent || "").trim(),
               exitText: (exit.textContent || "").trim(),
               leads:
                 (button.compareDocumentPosition(exit) &
                   Node.DOCUMENT_POSITION_FOLLOWING) !==
                 0,
             });
           })()`,
        );
        note("at0525 the placard's footer control", offered);
        const face = JSON.parse(offered) as {
          verb: string;
          form: string;
          refused: string | null;
          text: string;
          exitText: string;
          leads: boolean;
        };
        expect(face.verb).toBe("resume");
        // A word here, where the row wears an icon: the footer is a cluster of
        // words and a lone glyph in it would be the odd one out.
        expect(face.form).toBe("word");
        expect(face.text).toBe("Resume");
        expect(face.exitText).toBe("Show in Changes");
        expect(face.leads).toBe(true);
        // The arc kept its binding through the stop, so the bound card is this
        // card and there is nothing to refuse.
        expect(face.refused).toBeNull();
        note("at0525 placard with the Resume", (await app.screenshot()).path);

        await app.nativeClickAtElement(transportWith("resume"));

        // ── The record is the reading, and it is a moving target ──────────
        //
        // The press clears the stop and asks for the stopped stage again, and
        // the runner is then free to rotate it — so the claim about *which*
        // stage was asked for accepts any of the three shapes that fact wears
        // as the rotation proceeds. Pinning only the first would pin a race.
        const after = await pollUntil(
          () => arcReport(),
          (report) => report.stopped === null,
        );
        note("at0525 arc after the press", JSON.stringify(after));
        expect(after.stopped).toBeNull();
        const askedForDevise =
          after.resume === "devise" ||
          after.dispatched === "devise" ||
          after.stages.includes("devise");
        expect(askedForDevise).toBe(true);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
