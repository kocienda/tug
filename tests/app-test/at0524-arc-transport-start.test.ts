/**
 * at0524-arc-transport-start.test.ts — Start is a button on a waiting
 * document's row, and pressing it opens the arc on the followed card.
 *
 * ## Why this exists
 *
 * The Arcs card's plan rows are the front half of an arc: a `.tug/arcs/<name>/`
 * with documents in it and no branch yet. They reported and offered nothing —
 * [D176]'s card removed a button that had composed a `/tugplug:…` line into
 * the followed card, because a label is not a control. [D178] gives the row a
 * real one, and this file is the proof that it is real: the press opens the
 * arc through the server's own `arc_run`, with the **kind the documents name**
 * rather than a kind the server sniffed off a directory, and the row it was
 * pressed on redraws with the card that is now working the arc.
 *
 * A brief and nothing else, deliberately: that is what `/arc-plan`'s door
 * leaves, and Spec S01 reads it as a `planned` arc. The recorded kind is the
 * one fact here that no other surface would notice going wrong — a plain arc
 * and a planned one differ only in how long they settle before a step is
 * walked, so a kind derived on the wrong side of the wire is silent for a
 * whole stage.
 *
 * @covers tugdeck/src/components/tugways/arc-transport-control.tsx
 * @covers tugdeck/src/lib/arc-transport.ts
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugrust/crates/tugcast/src/arc_api.rs
 * @covers tugrust/crates/tugarc-core/src/ops.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  arcBriefPath,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000521";
const SECTION = ".arcs-section";

/** A document-only arc: a brief, no plan, no branch. */
const ARC_NAME = "at0524-start";
const ROW = `${SECTION} [data-slot="arc-document-row"][data-arc="${ARC_NAME}"]`;
const TRANSPORT = `${ROW} [data-slot="arc-transport"]`;
const transportWith = (verb: string): string => `${TRANSPORT}[data-verb="${verb}"]`;
/** The bound card's mini atom in the row's eyebrow. */
const WORKER = `${ROW} [data-slot="tug-arc-lifecycle-worker"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0524", checkout: CHECKOUT });
  // Written after the repo's first commit and never through its `files` map:
  // `.tug/` is not tracked, and a committed brief would be a world that does
  // not exist.
  writeFileSync(
    arcBriefPath(projectDir(), ARC_NAME),
    "# A sketch\n\nProse the arc will open on.\n",
  );
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

/** What `tugtool arc record --json` says about the arc, read from the fixture. */
function arcReport(): { kind: string | null; document: string | null } {
  const out = JSON.parse(
    tugtool(["arc", "record", ARC_NAME, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as { data: { arc: { kind: string | null; document: string | null } | null } };
  const arc = out.data.arc;
  return arc === null ? { kind: null, document: null } : arc;
}

/** Read `probe` until `settled` accepts it — the record is on disk, and the
 *  app has no view of it to wait on. */
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

describe.skipIf(!SHOULD_RUN)("AT0524: Start on a waiting document's row", () => {
  test(
    "the press opens the arc on the followed card, with the kind the documents name",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0524-arc-transport-start",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        // Spawned rather than bound: spawning registers the scratch repo as a
        // workspace, and the card it spawns on is the one the Arcs card
        // follows — which is the card a Start acts as (Table T02).
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        await app.dispatchControlAction("toggle-arcs");
        // Raising A is the gesture that gives the Arcs card a followed card,
        // and a Start with none correctly refuses ([L31], Table T02) — the
        // card follows whatever last held the keyboard, and opening the rail
        // is itself a focus move.
        await app.evalJS<null>(`(window.__tug.activateCard("A"), null)`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SECTION)}) !== null`,
          { timeoutMs: 30_000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 30_000 },
        );

        // ── The row's one trailing thing is a Start ───────────────────────
        //
        // And no fold cue beside it: [D176] left plan rows out of the fold,
        // because the ledger a fold opens is one a waiting document does not
        // carry.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(transportWith("start"))}) !== null`,
          { timeoutMs: 30_000 },
        );
        const offered = await app.evalJS<string>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             const button = row.querySelector('[data-slot="arc-transport"]');
             return JSON.stringify({
               verb: button.getAttribute("data-verb"),
               refused: button.getAttribute("data-refused"),
               label: button.getAttribute("aria-label"),
               folds: row.querySelectorAll('[data-slot="arcs-steps-fold"]').length,
             });
           })()`,
        );
        note("at0524 the document row's control", offered);
        const face = JSON.parse(offered) as {
          verb: string;
          refused: string | null;
          label: string;
          folds: number;
        };
        expect(face.verb).toBe("start");
        // The followed card holds a session in this project and runs no arc,
        // so there is nothing to refuse.
        expect(face.refused).toBeNull();
        expect(face.label).toBe(`Start arc ${ARC_NAME}`);
        expect(face.folds).toBe(0);

        await app.nativeClickAtElement(transportWith("start"));

        // ── The server opened the arc the deck named ──────────────────────
        const opened = await pollUntil(
          () => arcReport(),
          (report) => report.kind !== null,
        );
        note("at0524 arc after the press", JSON.stringify(opened));
        // A brief and no plan is what `/arc-plan`'s door leaves, and Spec S01
        // reads it as planned — derived on the deck, sent in the frame, and
        // recorded by the server as it was sent.
        expect(opened.kind).toBe("planned");
        expect(opened.document ?? "").toEndWith("brief.md");

        // ── And the row says which card is working it ─────────────────────
        //
        // The worker atom, not `data-bound`: that attribute is `ArcCell`'s
        // alone, and this is a document row.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(WORKER)}).length === 1`,
          { timeoutMs: 30_000 },
        );
        note("at0524 row after the start", (await app.screenshot()).path);

        // ── And the same button is now the way to stop it ─────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(transportWith("stop"))}) !== null`,
          { timeoutMs: 30_000 },
        );
        const running = await app.evalJS<string>(
          `(() => {
             const buttons = document.querySelectorAll(${JSON.stringify(TRANSPORT)});
             return JSON.stringify({
               count: buttons.length,
               verb: buttons[0].getAttribute("data-verb"),
             });
           })()`,
        );
        note("at0524 the row's control after the start", running);
        const stopFace = JSON.parse(running) as { count: number; verb: string };
        expect(stopFace.count).toBe(1);
        expect(stopFace.verb).toBe("stop");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
