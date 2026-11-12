/**
 * at0797-workspaces-done-spent-by-attention.test.ts — a turn that finished on
 * a card the user was not looking at reads Done on its Workspaces row until
 * they look, and the reading survives a reload.
 *
 * The turn's end is the ledger's own: the seed writes it through the same
 * `record_turn_end` a successful `turn_complete` calls, because an app-test
 * has no live `claude` to finish a turn. Everything after it is real — the
 * deck lists the row from tugcast, a reload lists it again, and activating
 * the card sends `attend_session` to tugcast, whose stamp comes back on the
 * row's push. Three readings on the Workspaces card:
 *
 *  1. Card B's session finished a turn while card A was active: B's row wears
 *     the filled, still green dot and its line closes `Done.`;
 *     A's row, the one being attended, reads the ring and `Ready.`.
 *  2. A deck reload leaves B's mark standing — it is the ledger's fact, and
 *     nothing about the page holds it.
 *  3. Activating card B spends it: the ring and `Ready.` come back.
 *
 * A turn that completes on the active card is seen in the very write that
 * ends it (tugcast stamps attention there for the session the deck last
 * named), so no push ever carries that mark. Producing one needs a real turn,
 * which is the one thing this harness cannot drive; the ledger and supervisor
 * unit tests hold that guarantee, and the reporter's rule for naming the
 * attended session is a deck unit test.
 *
 * @covers tugdeck/src/lib/session-attention.ts
 * @covers tugdeck/src/lib/code-session-store/use-session-phase.ts
 * @covers tugdeck/src/lib/code-session-store/session-phase-visual.ts
 * @covers tugdeck/src/lib/session-activity-line.ts
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 * @covers tugdeck/src/components/cards/cards-session-cell.tsx
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/control/rows.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";
import { kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// UUID-shaped so both read as real sessions.
const SID_A = "a7c0d1ea-0000-4000-8000-00000000a797";
const SID_B = "a7c0d1ea-0000-4000-8000-00000000b797";

const rowOf = (sid: string): string => `.cards-card [data-session-id="${sid}"]`;

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0797-proj-")));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

/** Two Session cards side by side, A active. */
function twoCardDeck() {
  const { width, height } = SESSION_CARD_SIZE_SHORT;
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session A", closable: true },
      { id: "B", componentId: "session", title: "Session B", closable: true },
    ],
    panes: [
      {
        id: "pA",
        position: { x: 40, y: 40 },
        size: { width: width / 2, height },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "pB",
        position: { x: 60 + width / 2, y: 40 },
        size: { width: width / 2, height },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pA",
    hasFocus: true,
  };
}

/** A row's dot and line, as the Workspaces card draws them. */
interface RowReading {
  role: string;
  state: string;
  text: string;
}

const NO_ROW: RowReading = { role: "", state: "", text: "" };

const readRow = (app: App, sid: string): Promise<RowReading> =>
  kindBody(app, "cards").evalJS<RowReading>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(rowOf(sid))});
       if (el === null) return ${JSON.stringify(NO_ROW)};
       var dot = el.querySelector('[data-slot="tug-progress-indicator"]');
       return {
         role: dot === null ? "" : (dot.getAttribute("data-tone") || ""),
         state: dot === null ? "" : (dot.getAttribute("data-state") || ""),
         text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
       };
     })()`,
  );

/** Wait until `sid`'s row wears `state` and its text carries `closer`. */
async function waitForRow(app: App, sid: string, state: string, closer: string): Promise<RowReading> {
  await kindBody(app, "cards").waitForCondition<boolean>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(rowOf(sid))});
       if (el === null) return false;
       var dot = el.querySelector('[data-slot="tug-progress-indicator"]');
       if (dot === null || dot.getAttribute("data-state") !== ${JSON.stringify(state)}) return false;
       return (el.textContent || "").indexOf(${JSON.stringify(closer)}) !== -1;
     })()`,
    { timeoutMs: 20_000 },
  );
  return readRow(app, sid);
}

/** Seed the deck, bind both cards, and open the Workspaces card. */
async function standUp(app: App): Promise<void> {
  await app.seedDeckState({ state: twoCardDeck(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
    { timeoutMs: 30_000 },
  );
  await app.bindSession("A", { tugSessionId: SID_A, projectDir, workspaceKey: projectDir });
  await app.bindSession("B", { tugSessionId: SID_B, projectDir, workspaceKey: projectDir });
  await app.dispatchControlAction("toggle-cards");
  await kindBody(app, "cards").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(rowOf(SID_B))}) !== null`,
    { timeoutMs: 20_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0797: Done on the Workspaces row is spent by attention", () => {
  test(
    "an unseen turn end reads Done, survives a reload, and activating the card spends it",
    async () => {
      const app = await launchTugApp({ testName: "at0797-workspaces-done-spent-by-attention" });
      try {
        app.seedLedger({
          sessions: [
            { session_id: SID_A, workspace_key: projectDir, project_dir: projectDir, card_id: "A", name: "Session A" },
            {
              session_id: SID_B,
              workspace_key: projectDir,
              project_dir: projectDir,
              card_id: "B",
              name: "Session B",
              turn_end_unseen: true,
            },
          ],
        });
        // Attention is only reported while the app is active.
        await app.waitForCondition<boolean>("window.__tug.getHasFocus() === true", { timeoutMs: 10_000 });
        await standUp(app);

        // 1. B finished while A was attended: filled and still, `Done.`.
        const unseen = await waitForRow(app, SID_B, "completed", "Done.");
        note("at0797 B before attention", JSON.stringify(unseen));
        expect(unseen.role, "green: the finished tone").toBe("success");
        expect(unseen.text).not.toContain("Ready.");
        const attended = await waitForRow(app, SID_A, "stopped", "Ready.");
        note("at0797 A, attended", JSON.stringify(attended));
        expect(attended.text).not.toContain("Done.");

        // 2. A reload lists the row again from tugcast, mark and all.
        await app.appReload();
        await standUp(app);
        const reloaded = await waitForRow(app, SID_B, "completed", "Done.");
        note("at0797 B after reload", JSON.stringify(reloaded));
        expect(reloaded.role).toBe("success");

        // 3. Activating B is attention: tugcast stamps it and the push spends
        //    the mark on the row.
        await app.evalJS<null>(`(window.__tug.activateCard("B"), null)`);
        const spent = await waitForRow(app, SID_B, "stopped", "Ready.");
        note("at0797 B after attention", JSON.stringify(spent));
        expect(spent.role).toBe("inherit");
        expect(spent.text).not.toContain("Done.");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
