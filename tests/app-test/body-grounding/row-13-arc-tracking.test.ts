/**
 * row-13-arc-tracking.test.ts — an arc run in a body's session shows in
 * that body's Z2 and in the shell's Arcs card.
 *
 * The bar's thirteenth row ([B02] row 13). Read live on the user's deck: the
 * shell's Arcs card had the arc's row and the body's Z2 had no arc at all,
 * because the body page attached none of the connection-scoped stores the
 * shell boots, and Z2's ARC cell reads its arc from the aggregate changeset
 * the body never had. So one body session card is bound to a real arc in a
 * scratch repository — a stamped ten-row plan with a run declared over its
 * first three steps, the shape where the run's numerals and the plan's own
 * pair disagree — and the row reads both sides of the same beat:
 *
 * - **The body's Z2** — the ARC cell stands in the body's own document and
 *   reads the declared run, `1/3`, not the plan's `1/10`.
 * - **The shell** — the card's masthead, which the shell draws for a body
 *   card, carries the lifecycle mark with the same fraction.
 * - **The Arcs body** — the Arcs card is a body of its own, and has the
 *   arc's row with the bound session's worker on it.
 *
 * Then the unbind takes the arc off the body's Z2 again, and the Arcs body,
 * which follows the Session card focused before it, offers Bind unrefused:
 * its Bind target is that card's session, read off the card context the
 * shell sends it. Which stores a body attaches at all is enumerated by
 * `body/__tests__/body-stores.test.ts`.
 *
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/lib/arc-session-index.ts
 * @covers tugdeck/src/components/arcs/arcs-card-registration.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "../_harness/tugbank-helpers";
import {
  bindArc,
  createArc,
  makeArcScratchRepo,
  recordStampedPlan,
  rmArcScratchRepo,
  tugtool,
  type ArcScratchRepo,
} from "../arc-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "../streaming-stub-fixture";
import { bodyOfKind } from "../_harness/card-reach";
import { pollFor, waitForBody } from "./_bodies";

const TEST_NAME = "body-grounding-row-13-arc-tracking";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const A = "row13-a";
const SID = "a7c0d1ea-0000-4000-8000-000000000713";
const ARC = "row13-run";
const READ_MS = 30_000;

/** In the body: Z2's ARC reading, in the TASKS cell that wears it once bound. */
const ARC_VALUE = '[data-slot="tug-status-cell"][data-priority="tasks"] [data-slot="session-telemetry-arc-value"]';
/** In the shell: the masthead's lifecycle mark, and its step fraction. */
const MASTHEAD_MARK = '[data-slot="session-masthead"] [data-slot="session-identity-row-progress"] [data-slot="tug-arc-lifecycle-mark"]';
const MASTHEAD_FRACTION = `${MASTHEAD_MARK} [data-slot="tug-step-fraction"]`;
/** In the Arcs body: the arc's row, the bound session's worker on it, and its Bind verb. */
const ARCS_ROW = `.arcs-section [data-slot="arcs-row"][data-arc="${ARC}"]`;
const ARCS_WORKER = `${ARCS_ROW} [data-slot="tug-arc-lifecycle-worker"]`;
const ARCS_BIND = `${ARCS_ROW} [data-slot="arc-verb"][data-verb="bind"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", "..", ".."));

let scratch: ArcScratchRepo | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "row13", checkout: CHECKOUT });
  const run = createArc(scratch.repo, ARC, "row13 declared run", scratch.cli);
  recordStampedPlan(scratch.repo, ARC, run.worktree, { ...scratch.cli, rows: 10, through: 3 });
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
});

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [
      {
        id: `${A}-pane`,
        position: { x: 40, y: 40 },
        // Wide enough that no `@container` rung in `tug-status-cell.css` hides
        // the TASKS cell the ARC reading rides.
        size: { width: 900, height: 720 },
        cardIds: [A],
        activeCardId: A,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${A}-pane`,
    hasFocus: true,
  };
}

const textOf = (selector: string): string =>
  `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "").trim()`;

describe.skipIf(!SHOULD_RUN)("body-grounding row 13: arc tracking from a body", () => {
  test(
    "an arc bound to a body's session reads its declared run in the body's Z2, its mark on the shell's masthead and its row in the Arcs card, and leaves the Z2 on unbind",
    async () => {
      const projectDir = scratch?.repo ?? "";
      const stubDir = stubDirectory();
      writeFileSync(join(stubDir, `${SID}.json`), JSON.stringify(streamingTranscript(2, 1)));
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: {
          [STUB_TRANSCRIPT_DIR_ENV]: stubDir,
          TUGBANK_PATH: tugbankPath,
          TUG_DATA_DIR: scratch?.dataRoot ?? "",
        },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        // A spawned session, so the scratch repo is a workspace and its arcs
        // reach the aggregate the body's Z2 reads.
        await app.spawnSessionNew(A, { tugSessionId: SID, projectDir });
        await waitForBody(app, A);
        const body = app.body(A);

        // ── Before the bind, no arc reading anywhere ─────────────────────
        expect(await body.evalJS<string>(textOf(ARC_VALUE)), "the body's Z2 reads no arc before the bind").toBe("");
        expect(await app.body("row13-a").evalJS<number>(`document.querySelectorAll(${JSON.stringify(MASTHEAD_MARK)}).length`), "no mark on the masthead before the bind").toBe(0);

        // ── Bound: the body's Z2 and the shell's surfaces read one arc ────
        bindArc(projectDir, ARC, SID, { binaryRoot: CHECKOUT, env: scratch?.cli.env });
        const z2 = await pollFor(() => body.evalJS<string>(textOf(ARC_VALUE)), (t) => t === "1/3", READ_MS);
        const masthead = await pollFor(() => app.body("row13-a").evalJS<string>(textOf(MASTHEAD_FRACTION)), (t) => t === "1/3", READ_MS);
        note(`bound: body Z2 ARC ${JSON.stringify(z2)}, shell masthead fraction ${JSON.stringify(masthead)}`);
        expect(z2, "the body's Z2 reads the declared run").toBe("1/3");
        expect(masthead, "the shell's masthead for the body card reads the same run").toBe("1/3");

        await app.dispatchControlAction("toggle-arcs");
        const arcs = await bodyOfKind(app, "dashes");
        const worker = await pollFor(
          () => arcs.evalJS<boolean>(`document.querySelector(${JSON.stringify(ARCS_WORKER)}) !== null`),
          (v) => v,
          READ_MS,
        );
        expect(worker, "the Arcs body has the arc's row with the bound session on it").toBe(true);
        note("row 13 bound", (await app.captureWindow()).path);

        // ── Unbound: the body's Z2 lets the arc go ────────────────────────
        tugtool(["arc", "unbind", "--json"], {
          cwd: projectDir,
          binaryRoot: CHECKOUT,
          env: { ...scratch?.cli.env, TUG_SESSION_ID: SID },
        });
        const cleared = await pollFor(() => body.evalJS<string>(textOf(ARC_VALUE)), (t) => t === "", READ_MS);
        expect(cleared, "the body's Z2 reads no arc after the unbind").toBe("");

        // ── The Arcs body follows A: Bind would send the arc to A's session ──
        const bindState = `(function () {
          var b = document.querySelector(${JSON.stringify(ARCS_BIND)});
          return b === null ? "absent" : b.getAttribute("data-refused") === "true" ? "refused: " + b.getAttribute("aria-label") : "offered";
        })()`;
        const bind = await pollFor(() => arcs.evalJS<string>(bindState), (s) => s === "offered", READ_MS);
        note(`Arcs body Bind after the unbind: ${bind}`);
        expect(bind, "the Arcs body offers Bind to the followed Session card's session").toBe("offered");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
