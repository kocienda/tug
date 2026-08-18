/**
 * at0332-changes-claim-disclaim.test.ts — the Changes shade's unattributed
 * rows, driven against the real aggregate over a really-dirty checkout.
 *
 * A file written with no tool call behind it composes into the unattributed
 * bucket. This pins what that row looks like: a Claim affordance carrying the
 * corner-down-left icon, and — because the row carries no badge, no
 * provenance, and no hint — no metadata divider at all. The divider rides a
 * wrapper span rather than the provenance span, so "which metadata kinds
 * render" and "how many dividers show" are independent; the empty end of that
 * rule is what a metadata-free row proves.
 *
 * The project must be the one tugcast registers at boot (its bootstrap
 * `--source-tree`) and the card's binding must carry the registry's canonical
 * key — a synthetic temp repo never composes into the aggregate and the shade
 * sits at "Waiting for project scan…" forever.
 *
 * **Not driven here:** the claim/disclaim round trip's *destination*. Clicking
 * Claim really does write rows, but the file only surfaces under a session
 * entry when the ledger holds a live session of that id, and `bindSession` is
 * a synthetic client-side binding the ledger knows nothing about. Those verbs
 * are covered at the Rust layer (`session_ledger.rs`: batch claim atomicity,
 * disclaim scoping, journal replay).
 *
 * That gap is no longer a wall, only a scope choice: `app.seedLedger()` writes
 * a live session and its proof rows through the real ledger, which is how
 * at0334 drives a session-entry row. A test that wants the attributed row —
 * its Disclaim affordance, its corner-up-right icon, its single divider — can
 * seed one rather than accept the gap.
 *
 * @covers tugdeck/src/components/tugways/tug-changes-list.tsx
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugdeck/src/lib/changes-route-controller.ts
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/components/tugways/tug-section-label.tsx
 * @covers tugdeck/src/components/tugways/tug-meta-run.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0332-session";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

// The registry keys a workspace by the canonical (realpath) project dir, and
// the binding must carry that same key or the shade never resolves the
// composed project. The scratch file lives in this checkout because that is
// the only project the aggregate composes; it is removed afterwards.
const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
const DIRTY_FILE = "at0332-scratch.txt";
const scratchPath = join(PROJECT_DIR, DIRTY_FILE);

/** The scratch file's block inside the unattributed section of the list. */
const UNATTRIBUTED_ROW =
  `${SHEET} .tug-changes-list-file-list[data-entry-kind="unattributed"] ` +
  `[data-testid="tug-changes-list-file-block"][data-path="${DIRTY_FILE}"]`;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // No tool call stands behind this write, so nothing attributes it.
  writeFileSync(scratchPath, "at0332 scratch\n");
});

afterAll(() => {
  if (existsSync(scratchPath)) rmSync(scratchPath, { force: true });
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

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0332: unattributed row chrome in the Changes shade", () => {
  test(
    "a dirty unclaimed file renders a corner-down-left Claim and no metadata divider",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0332-changes-claim-disclaim",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          projectDir: PROJECT_DIR,
          workspaceKey: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // One committed turn so the card is a live, non-empty session.
        await app.driveSession("A", { op: "send", text: "hello" });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: 0x40,
          decoded: { tug_session_id: SID, type: "prompt_anchor", promptUuid: "uuid-1" },
        });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: 0x40,
          decoded: { tug_session_id: SID, type: "turn_complete", msg_id: "m1", result: "success" },
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8000 },
        );

        // ── Raise the changes sheet ────────────────────────────────────────
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape"); // dismiss the completion popup
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 8000 },
        );

        // ── The scratch file arrives unattributed ──────────────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(UNATTRIBUTED_ROW)}) !== null`,
          { timeoutMs: 20000 },
        );

        const row = await app.evalJS<{ claimIcon: string | null; meta: number }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(UNATTRIBUTED_ROW)});
             const svg = row.querySelector('[data-testid="tug-changes-list-claim"] svg');
             return {
               claimIcon: svg === null ? null : svg.getAttribute("class"),
               meta: row.querySelectorAll(".tug-changes-list-file-meta").length,
             };
           })()`,
        );
        expect(row.claimIcon).toContain("lucide-corner-down-left");
        expect(row.meta).toBe(0);

        // The section's bulk affordance carries the same icon vocabulary.
        const claimAllIcon = await app.evalJS<string | null>(
          `(() => {
             const svg = document.querySelector(
               ${JSON.stringify(`${SHEET} [data-testid="tug-changes-list-claim-all-unattributed"] svg`)},
             );
             return svg === null ? null : svg.getAttribute("class");
           })()`,
        );
        expect(claimAllIcon).toContain("lucide-corner-down-left");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
