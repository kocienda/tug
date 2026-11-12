/**
 * at0808-add-dir-grant-bulletin.test.ts — `/add-dir <path>` asks the
 * terminal's question, says "added" only once the session holds the folder,
 * and the Session Summary lists what it holds.
 *
 * ## What this gates
 *
 * `/add-dir` names its folder the way `/cd` does, then asks, pane-modal, the
 * terminal's two-scope question: "Yes, for this session" or "Yes, and remember
 * this directory". The answer it bulletins is read off two stores the frames
 * reach separately, which only the running card puts together:
 *
 *   A. **A grant is said once the session holds the folder.** tugcode sends
 *      the session's list on `system_metadata` (the metadata store's) and its
 *      answer on `add_directory_result` (the Session card's). The success
 *      bulletin waits for both, so it is never said of a folder the session
 *      does not hold.
 *
 *   B. **The Session Summary lists the folders the session holds.** Its
 *      Directories row is absent before any grant and names the granted
 *      folder once the session's list carries it.
 *
 *   C. **A refusal is a caution with tugcode's reason.** That it never puts
 *      the card in its errored state is the store's unit test
 *      (`code-session-store.directory-grant.test.ts`).
 *
 * The command runs through `run-card-command`, the menu's door and the same
 * body typing it would reach; the frames tugcode would write are injected,
 * since a harness bind has no tugcode. tugcode's half — the live
 * `apply_flag_settings`, the whole list, the refusals — is its own unit suite.
 *
 * @covers tugdeck/src/lib/directory-grant.ts
 * @covers tugdeck/src/components/tugways/tug-alert-sheet.tsx
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SESSION_ID = "a8d0d1c2-0b3e-4f5a-9c6d-7e8f9a0b1c2d";
const PROJECT_DIR = "/Users/tester/src/project";
const GRANTED = "/Users/tester/src/shared";
const REFUSED = "/Users/tester/src/missing";
const CODE_OUTPUT = 0x40;

const BULLETIN = ".tug-pane-bulletin";
const ALERT_TITLE = ".tug-alert-title";
const WIDGET = '[data-slot="session-masthead-widget"]';
const PANEL = '[data-slot="session-masthead-telemetry"]';
const DIRECTORIES_ROW = `${PANEL} .session-masthead-telemetry-row[data-row="directories"]`;

function deckShape() {
  return {
    cards: [{ id: "S", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
        cardIds: ["S"],
        activeCardId: "S",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** The bulletins on screen, as `<tone>:<text>`. */
function bulletins(app: App): Promise<string[]> {
  return app.body("S").evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(BULLETIN)})).map(
      function (b) {
        return (b.getAttribute("data-type") || "") + ":" + (b.innerText || "");
      })`,
  );
}

/** Wait for a bulletin of `tone` whose text holds `needle`. */
async function waitForBulletin(app: App, tone: string, needle: string): Promise<void> {
  await app.body("S").waitForCondition<boolean>(
    `Array.from(document.querySelectorAll(${JSON.stringify(BULLETIN)})).some(function (b) {
      return b.getAttribute("data-type") === ${JSON.stringify(tone)} &&
        (b.innerText || "").indexOf(${JSON.stringify(needle)}) !== -1;
    })`,
    { timeoutMs: 8_000 },
  );
}

/**
 * Open the Session Summary, read its Directories row — each folder's full
 * path, or null when the row is absent — and close it again.
 */
async function readDirectoriesRow(app: App): Promise<string[] | null> {
  // The pane's chrome is the Session card's own, in its page.
  await app.body("S").revealPaneControls(".body-chrome-frame");
  await app.body("S").nativeClickAtElement(WIDGET);
  await app.body("S").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
    { timeoutMs: 8_000 },
  );
  const read = await app.body("S").evalJS<string[] | null>(
    `(function () {
       var row = document.querySelector(${JSON.stringify(DIRECTORIES_ROW)});
       if (row === null) return null;
       return Array.from(row.querySelectorAll(".session-masthead-telemetry-directory")).map(
         function (d) { return d.getAttribute("title") || ""; });
     })()`,
  );
  await app.nativeKey("Escape");
  await app.body("S").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PANEL)}) === null`,
    { timeoutMs: 8_000 },
  );
  return read;
}

/** Run `/add-dir <dir>` and take "Yes, for this session" in its dialog. */
async function grantForThisSession(app: App, dir: string): Promise<string[]> {
  // card-dom: shell — `run-card-command` is the shell's action (the menu's
  // door); the shell routes it to the key card's body.
  await app.dispatchControlAction("run-card-command", { name: "add-dir", args: dir });
  await app.body("S").waitForCondition<boolean>(
    `document.querySelector('[data-testid="alert-alternate"]') !== null`,
    { timeoutMs: 8_000 },
  );
  const labels = await app.body("S").evalJS<string[]>(
    `Array.from(document.querySelectorAll('.tug-alert-actions button')).map(function (b) {
      return (b.textContent || "").trim();
    })`,
  );
  await app.body("S").click('[data-testid="alert-confirm"]');
  await app.body("S").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(ALERT_TITLE)}) === null`,
    { timeoutMs: 8_000 },
  );
  return labels;
}

describe.skipIf(!SHOULD_RUN)("at0808 — /add-dir <path>", () => {
  test(
    "the dialog asks the terminal's question; a grant is said once held and listed, a refusal with its reason",
    async () => {
      const app = await launchTugApp({ testName: "at0808-add-dir-grant-bulletin" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "S" });
        await waitForBodyReady(app, "S");
        await app.bindSession("S", { tugSessionId: SESSION_ID, projectDir: PROJECT_DIR });

        expect(await readDirectoriesRow(app), "no Directories row before a grant").toBeNull();

        // ---- A. Granted: the answer alone is not enough to say "added". ----
        const labels = await grantForThisSession(app, GRANTED);
        expect(labels).toEqual(["Cancel", "Yes, and remember this directory", "Yes, for this session"]);

        await app.body("S").driveSession({
          op: "ingestFrame",
          feedId: CODE_OUTPUT,
          decoded: {
            type: "add_directory_result",
            tug_session_id: SESSION_ID,
            directory: GRANTED,
            ok: true,
            additional_directories: [GRANTED],
            ipc_version: 2,
          },
        });
        expect(
          (await bulletins(app)).some((b) => b.startsWith("success:")),
          "no success before the folder is in the session's list",
        ).toBe(false);

        await app.ingestSessionMetadata("S", {
          type: "system_metadata",
          tug_session_id: SESSION_ID,
          cwd: PROJECT_DIR,
          additional_directories: [GRANTED],
          ipc_version: 2,
        });
        await waitForBulletin(app, "success", "shared");

        // ---- B. The Session Summary lists the held folder. -----------------
        expect(await readDirectoriesRow(app)).toEqual([GRANTED]);

        // ---- C. Refused: a caution naming tugcode's reason. ----------------
        await grantForThisSession(app, REFUSED);
        await app.body("S").driveSession({
          op: "ingestFrame",
          feedId: CODE_OUTPUT,
          decoded: {
            type: "add_directory_result",
            tug_session_id: SESSION_ID,
            directory: REFUSED,
            ok: false,
            reason: `${REFUSED} does not exist`,
            additional_directories: [GRANTED],
            ipc_version: 2,
          },
        });
        await waitForBulletin(app, "warning", "does not exist");
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0808] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
