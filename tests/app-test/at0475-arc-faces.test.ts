/**
 * at0475-arc-faces.test.ts — where the arc shows on a card's faces, and where
 * it deliberately does not ([AT0475]).
 *
 * ## Why this exists
 *
 * A dash arc rotates on a server tick. Nobody pressed anything, so there is no
 * spinner somebody is watching and no reply somebody is waiting for — which
 * makes a **stopped** arc the one state in the whole system that can go
 * silently dark. Every other stalled thing on these surfaces is explained by a
 * gesture nobody made. An arc that stopped is explained by nothing.
 *
 * So the arc gets two faces, both of them existing surfaces:
 *
 *   1. the **Z2 DASH cell**, where it costs no height at all — the arc's stage
 *      and its stopped-ness are attributes the CSS paints ([L06]), because the
 *      cell's box is already spoken for by the fraction and the stage glyph;
 *   2. the **placard's metadata line**, one press away, where there is room for
 *      the words: which stage it stopped in and why.
 *
 * And it gets **no third face**. `derive_stage` still answers what the dash is
 * doing in git, untouched — the arc is reported beside it and never folded in,
 * which is what lets a card say `implementing` and `arc stopped in review` at
 * once. That is not a nicety: a stopped arc has usually walked several steps,
 * so a face that let the arc overwrite the git stage would erase the progress
 * at the exact moment somebody needs to see it.
 *
 * Driven against the real feed, on a real dash in a scratch repository, with
 * the arc's own dash-log lines written in the grammar `tugdash_core::arc`
 * writes them — the runner's writers are not reachable from a test process, but
 * the record is a file, and reading it back through the whole stack (dash-log →
 * `read_arc` → `DashDetail` → `CHANGESET_ALL` → the session index → the cell)
 * is the point.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugrust/crates/tugdash-core/src/ops.rs
 * @covers tugrust/crates/tugcast/src/feeds/changeset.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/lib/dash-session-index.ts
 * @covers tugdeck/src/components/tugways/dash-meta-line.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";

import { launchTugApp, note } from "./_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";
import {
  bindDash,
  createDash,
  discardDash,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000475";
const DASH_NAME = "at0475-arc";
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

/** The Z2 work cell's DASH reading — the value span, where the arc rides. */
const DASH_VALUE =
  '[data-card-id="A"] [data-slot="tug-status-cell"][data-priority="tasks"] [data-slot="session-telemetry-dash-value"]';
const DASH_CELL =
  '[data-card-id="A"] [data-slot="tug-status-cell"][data-priority="tasks"]';
const PLACARD = '[data-slot="session-dash-popover-body"]';
const ARC_FACT = `${PLACARD} [data-slot="tug-dash-meta-fact"][data-fact="arc-stopped"]`;

let project: DashScratchRepo | null = null;
let fixture = "";
let logPath = "";
const dir = (): string => project?.repo ?? "";

/**
 * The dash-log this project's state lives in, found rather than composed.
 *
 * Its directory is keyed by a slug of the repository path that this test has
 * no business re-deriving — a second speller of one key is exactly the drift
 * [L29] exists to forbid. `dash create` has already written the file, so the
 * honest way to find it is to look for the one the tool made.
 */
function findDashLog(dataRoot: string): string {
  // `TUG_DATA_DIR` names the *parent* of the data root; the root itself is
  // `<TUG_DATA_DIR>/Tug`, which is what `base_data_dir` composes.
  const projects = join(dataRoot, "Tug", "projects");
  for (const entry of readdirSync(projects)) {
    const candidate = join(projects, entry, "dash-log.md");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this one.
    }
  }
  throw new Error(`no dash-log.md under ${projects}`);
}

/** One dash-log line, in the grammar `append_dash_log` writes. */
function appendArcLine(marker: string, arcNote: string): void {
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  appendFileSync(logPath, `${at}  ${DASH_NAME}  ${marker}  ${arcNote}\n`);
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
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

beforeAll(() => {
  if (!SHOULD_RUN) return;
  project = makeDashScratchRepo({ prefix: "at0475", checkout: CHECKOUT });
  createDash(dir(), DASH_NAME, "at0475 arc faces", project.cli);
  logPath = findDashLog(project.dataRoot);
  fixture = seedScratchSession(dir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  if (project !== null) {
    discardDash(dir(), DASH_NAME, { binaryRoot: CHECKOUT, env: project.cli.env });
  }
  rmDashScratchRepo(project);
  rmScratchSession(fixture);
});

describe.skipIf(!SHOULD_RUN)("AT0475: the arc's faces", () => {
  test(
    "a running arc tints the cell, a stopped one says why on the placard, and neither touches the git stage",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0475-arc-faces",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: project?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: dir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });
        bindDash(dir(), DASH_NAME, SID, {
          binaryRoot: CHECKOUT,
          env: project!.cli.env,
        });

        // The cell reads DASH once the binding reaches the aggregate. Until
        // then it is TASKS, and asserting the arc on it would be asserting
        // against the wrong reading entirely.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DASH_VALUE)}) !== null`,
          { timeoutMs: 40_000 },
        );
        note("at0475 dash-log", logPath);

        // A dash with no arc says nothing about one — the absence has to be
        // silence rather than an empty reading.
        expect(
          await app.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(DASH_VALUE)})||{}).getAttribute?.("data-arc") ?? null`,
          ),
        ).toBeNull();

        // ── A rotation in flight ──────────────────────────────────────────
        appendArcLine("arc-start", "paperwork/at0475-brief.md");
        appendArcLine("arc-stage", "devise claude-at0475-a opus");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DASH_VALUE)})?.getAttribute("data-arc") === "devise"`,
          { timeoutMs: 40_000 },
        );
        // …and quietly: a stage in flight is the ordinary case, so nothing is
        // tinted for it.
        expect(
          await app.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(DASH_VALUE)})||{}).getAttribute?.("data-arc-stopped") ?? null`,
          ),
        ).toBeNull();

        // ── The stop ──────────────────────────────────────────────────────
        appendArcLine("arc-stop", "review the plan did not lint");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DASH_VALUE)})?.getAttribute("data-arc-stopped") === "true"`,
          { timeoutMs: 40_000 },
        );

        // The words are on the placard, which is where there is room for them.
        await app.click(DASH_CELL);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ARC_FACT)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const fact = JSON.parse(
          await app.evalJS<string>(
            `(() => { const el = document.querySelector(${JSON.stringify(ARC_FACT)});
              return JSON.stringify({ text: (el.textContent||"").trim(), tone: el.getAttribute("data-tone") }); })()`,
          ),
        ) as { text: string; tone: string | null };
        expect(fact.text).toBe("arc stopped · review");
        expect(fact.tone).toBe("danger");

        // And the reading the arc must never overwrite: the placard's footer
        // carries the *git* stage, derived exactly as it always was. A dash
        // with no rounds reads `created`, and it still does — the arc stopping
        // is a fact about the arc, not a rewrite of what git holds.
        expect(
          await app.evalJS<string>(
            `(document.querySelector('[data-slot="tug-popup-list-footer"]')?.textContent ?? "").trim()`,
          ),
        ).toContain("created");

        // The arc's own stage survives the stop: it says where it got to, which
        // is what a resume needs and what a cleared field would have thrown away.
        expect(
          await app.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(DASH_VALUE)})||{}).getAttribute?.("data-arc") ?? null`,
          ),
        ).toBe("devise");

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0475] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
