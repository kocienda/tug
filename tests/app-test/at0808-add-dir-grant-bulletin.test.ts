/**
 * at0808-add-dir-grant-bulletin.test.ts — `/add-dir <path>` asks whether to
 * add the folder, says "added" only once the session holds it, and the
 * Session Summary lists what it holds.
 *
 * ## What this gates
 *
 * `/add-dir` names its folder the way `/cd` does, then asks, pane-modal, "Add
 * this directory?" with two plain buttons, Cancel and Add, and an unchecked
 * checkbox to include the folder in the project's future sessions. The answer
 * it bulletins is read off two stores the frames reach separately, which only
 * the running card puts together:
 *
 *   A. **A grant is said once the session holds the folder.** tugcode sends
 *      the session's list on `system_metadata` (the metadata store's) and its
 *      answer on `directory_result` (the Session card's). The success
 *      bulletin waits for both, so it is never said of a folder the session
 *      does not hold.
 *
 *   B. **The Session Summary lists the folders the session holds.** Its
 *      Directories row is absent before any grant and names the granted
 *      folder once the session's list carries it; the Project row names the
 *      project folder throughout. Every key ends before its value starts,
 *      and a click on a folder asks the host to open it as a folder.
 *
 *   C. **A refusal is a caution with tugcode's reason.** That it never puts
 *      the card in its errored state is the store's unit test
 *      (`code-session-store.directory-grant.test.ts`).
 *
 *   D. **The folder is the server's canonical spelling ([L29]).** Named
 *      through a symlink, the dialog shows, and the grant sends, the
 *      gateway's spelling, never the alias: the bulletin only lands when the
 *      answer for the canonical folder matches what the card sent.
 *
 *   E. **The Summary's `x` removes a folder, and says so once it is gone.**
 *      Each removable folder carries an `x`; pressing it opens a confirm
 *      inside the Summary — which stays open under it — asking "Remove this
 *      directory?" with Cancel and Remove. Confirming sends the removal, and
 *      the success bulletin waits for tugcode's answer AND the folder leaving
 *      the session's list; the row then no longer names it.
 *
 *   F. **`/remove-dir` asks the same question as a pane-modal sheet.** Named
 *      a held folder, it asks "Remove this directory?" with Cancel and
 *      Remove and removes it the way the `x` does; named a folder the
 *      session doesn't hold, it is a caution saying so; bare, it opens the
 *      Session Summary.
 *
 * The command runs through `run-card-command`, the menu's door and the same
 * body typing it would reach; the frames tugcode would write are injected,
 * since a harness bind has no tugcode. tugcode's half — the live
 * `apply_flag_settings`, the whole list, the refusals — is its own unit suite.
 *
 * @covers tugdeck/src/lib/directory-grant.ts
 * @covers tugdeck/src/components/tugways/tug-alert-sheet.tsx
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 * @covers tugdeck/src/lib/permission-rules-store.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const PROJECT_ROW = `${PANEL} .session-masthead-telemetry-row[data-row="project"]`;

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
 *
 * It also reads the Project row's folder, and asserts on the way that no key
 * in the panel runs into its value: the key track is a fixed width, and
 * DIRECTORIES at its letter-spacing once overflowed it.
 */
async function readDirectoriesRow(app: App): Promise<string[] | null> {
  return (await readSummary(app)).directories;
}

interface SummaryReading {
  project: string | null;
  directories: string[] | null;
}

async function readSummary(app: App, click?: string): Promise<SummaryReading> {
  // The pane's chrome is the Session card's own, in its page.
  await app.body("S").revealPaneControls(".body-chrome-frame");
  await app.body("S").nativeClickAtElement(WIDGET);
  await app.body("S").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
    { timeoutMs: 8_000 },
  );
  const read = await app.body("S").evalJS<SummaryReading & { collisions: string[] }>(
    `(function () {
       var folders = function (selector) {
         var row = document.querySelector(selector);
         if (row === null) return null;
         return Array.from(row.querySelectorAll(".session-masthead-telemetry-directory")).map(
           function (d) { return d.getAttribute("data-path") || ""; });
       };
       var collisions = Array.from(document.querySelectorAll(${JSON.stringify(`${PANEL} .session-masthead-telemetry-row`)}))
         .filter(function (row) {
           var key = row.querySelector(".session-masthead-telemetry-label");
           var value = row.querySelector(".session-masthead-telemetry-value");
           if (key === null || value === null) return false;
           var range = document.createRange();
           range.selectNodeContents(key);
           return range.getBoundingClientRect().right > value.getBoundingClientRect().left;
         })
         .map(function (row) { return (row.querySelector(".session-masthead-telemetry-label").textContent || "").trim(); });
       var project = folders(${JSON.stringify(PROJECT_ROW)});
       return { project: project === null ? null : project[0], directories: folders(${JSON.stringify(DIRECTORIES_ROW)}), collisions: collisions };
     })()`,
  );
  expect(read.collisions, "no key runs into its value").toEqual([]);
  if (click !== undefined) {
    await app.body("S").evalJS(
      `Array.from(document.querySelectorAll(${JSON.stringify(`${PANEL} .session-masthead-telemetry-directory`)}))
        .find(function (d) { return d.getAttribute("data-path") === ${JSON.stringify(click)}; }).click()`,
    );
  }
  await app.nativeKey("Escape");
  await app.body("S").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PANEL)}) === null`,
    { timeoutMs: 8_000 },
  );
  return { project: read.project, directories: read.directories };
}

/** What the removal's confirm showed, and whether the Summary stayed open under it. */
interface ConfirmReading {
  message: string;
  buttons: string[];
  summaryOpen: boolean;
}

/**
 * Open the Session Summary, press the `x` on `dir`'s line, read the confirm,
 * press Remove, and close the Summary again.
 */
async function removeThroughSummary(app: App, dir: string): Promise<ConfirmReading> {
  const remove = `${PANEL} [data-slot="session-masthead-telemetry-remove"][data-path=${JSON.stringify(dir)}]`;
  const confirm = '[data-slot="tug-confirm-popover"]';
  await app.body("S").revealPaneControls(".body-chrome-frame");
  await app.body("S").nativeClickAtElement(WIDGET);
  // The `x` appears once the project's settings have been read.
  await app.body("S").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(remove)}) !== null`,
    { timeoutMs: 8_000 },
  );
  await app.body("S").click(remove);
  await app.body("S").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(confirm)}) !== null`,
    { timeoutMs: 8_000 },
  );
  const reading = await app.body("S").evalJS<ConfirmReading>(
    `({
      message: (document.querySelector('[data-slot="tug-confirm-message"]').textContent || "").trim(),
      buttons: Array.from(document.querySelectorAll(${JSON.stringify(`${confirm} button`)})).map(function (b) {
        return (b.textContent || "").trim();
      }),
      summaryOpen: document.querySelector(${JSON.stringify(PANEL)}) !== null,
    })`,
  );
  await app.body("S").click('[data-slot="tug-confirm-confirm"]');
  await app.body("S").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(confirm)}) === null`,
    { timeoutMs: 8_000 },
  );
  await app.nativeKey("Escape");
  await app.body("S").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PANEL)}) === null`,
    { timeoutMs: 8_000 },
  );
  return reading;
}

/**
 * Record what the Session card's page posts to the host's `openPath` bridge,
 * WITHOUT calling through: a real Finder window would steal the focus the
 * harness depends on, and what the deck asks for is the whole contract. The
 * install is `at0410`'s, for the reasons it gives — every wrapper is pinned,
 * and the install is read back before it is trusted.
 */
async function captureOpenPath(app: App): Promise<void> {
  const installed = await app.body("S").evalJS<boolean>(
    `(function(){
      window.__at0808OpenPath = [];
      var recorder = function(payload){ window.__at0808OpenPath.push(typeof payload === "string" ? JSON.parse(payload) : payload); };
      var ns = window.webkit;
      var real = ns.messageHandlers;
      var handler = real.openPath;
      window.__at0808Pins = { ns: ns, real: real, handler: handler };
      try {
        var handlers = new Proxy({}, { get: function(_t, name){ return name === "openPath" ? { postMessage: recorder } : real[name]; } });
        Object.defineProperty(ns, "messageHandlers", { configurable: true, value: handlers });
      } catch (e) {}
      try { handler.postMessage = recorder; } catch (e) {}
      try { return window.webkit.messageHandlers.openPath.postMessage === recorder; } catch (e) { return false; }
    })()`,
  );
  if (!installed) throw new Error("[at0808] the openPath capture did not take in the Session card's page");
}

/** What the dialog showed: its buttons, its checkbox's label and whether it opened checked. */
interface DialogReading {
  buttons: string[];
  message: string;
  checkbox: string;
  checked: boolean;
}

/** Run `/add-dir <dir>` and press Add in its dialog, leaving the checkbox alone. */
async function grantForThisSession(app: App, dir: string): Promise<DialogReading> {
  // card-dom: shell — `run-card-command` is the shell's action (the menu's
  // door); the shell routes it to the key card's body.
  await app.dispatchControlAction("run-card-command", { name: "add-dir", args: dir });
  await app.body("S").waitForCondition<boolean>(
    `document.querySelector('[data-testid="alert-checkbox"]') !== null`,
    { timeoutMs: 8_000 },
  );
  const reading = await app.body("S").evalJS<DialogReading>(
    `({
      buttons: Array.from(document.querySelectorAll('.tug-alert-actions button')).map(function (b) {
        return (b.textContent || "").trim();
      }),
      message: (document.querySelector('.tug-alert-message').textContent || "").trim(),
      checkbox: (document.querySelector('.tug-alert-checkbox').textContent || "").trim(),
      checked: document.querySelector('[data-testid="alert-checkbox"]').getAttribute("data-state") === "checked",
    })`,
  );
  await app.body("S").click('[data-testid="alert-confirm"]');
  await app.body("S").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(ALERT_TITLE)}) === null`,
    { timeoutMs: 8_000 },
  );
  return reading;
}

/** The server's canonical spelling of `path`, from the gateway the card asks. */
async function serverCanonical(app: App, path: string): Promise<string> {
  await app.body("S").evalJS(`(() => {
    window.__at0808_canonical = undefined;
    fetch("/api/fs/stat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [${JSON.stringify(path)}], kind: "dir" }),
    })
      .then((r) => r.json())
      .then((j) => { window.__at0808_canonical = (j.canonical || {})[${JSON.stringify(path)}] || ""; })
      .catch(() => { window.__at0808_canonical = ""; });
  })()`);
  await app.body("S").waitForCondition<boolean>(`window.__at0808_canonical !== undefined`, {
    timeoutMs: 8_000,
  });
  return app.body("S").evalJS<string>(`window.__at0808_canonical`);
}

describe.skipIf(!SHOULD_RUN)("at0808 — /add-dir <path>", () => {
  test(
    "the dialog asks with Cancel and Add and an unchecked project checkbox; a grant is said once held and listed, a refusal with its reason",
    async () => {
      const app = await launchTugApp({ testName: "at0808-add-dir-grant-bulletin" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "S" });
        await waitForBodyReady(app, "S");
        await app.bindSession("S", { tugSessionId: SESSION_ID, projectDir: PROJECT_DIR });

        expect(await readDirectoriesRow(app), "no Directories row before a grant").toBeNull();

        // ---- A. Granted: the answer alone is not enough to say "added". ----
        const dialog = await grantForThisSession(app, GRANTED);
        expect(dialog).toEqual({
          buttons: ["Cancel", "Add"],
          message: `${GRANTED} becomes readable and writable by this session.`,
          checkbox: `Include this directory in all ${PROJECT_DIR} sessions in the future`,
          checked: false,
        });

        await app.body("S").driveSession({
          op: "ingestFrame",
          feedId: CODE_OUTPUT,
          decoded: {
            type: "directory_result",
            op: "add",
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
        await captureOpenPath(app);
        expect(await readSummary(app, GRANTED)).toEqual({ project: PROJECT_DIR, directories: [GRANTED] });
        expect(
          await app.body("S").evalJS<Array<{ path: string; kind: string }>>(`window.__at0808OpenPath`),
          "a click on a folder opens it as a folder",
        ).toEqual([{ path: GRANTED, kind: "folder" }]);

        // ---- C. Refused: a caution naming tugcode's reason. ----------------
        await grantForThisSession(app, REFUSED);
        await app.body("S").driveSession({
          op: "ingestFrame",
          feedId: CODE_OUTPUT,
          decoded: {
            type: "directory_result",
            op: "add",
            tug_session_id: SESSION_ID,
            directory: REFUSED,
            ok: false,
            reason: `${REFUSED} does not exist`,
            additional_directories: [GRANTED],
            ipc_version: 2,
          },
        });
        await waitForBulletin(app, "warning", "does not exist");

        // ---- D. Named through a symlink, the folder is the canonical one. --
        const scratch = mkdtempSync(join(tmpdir(), "at0808-"));
        try {
          const real = join(scratch, "real");
          const alias = join(scratch, "alias");
          await Bun.write(join(real, ".keep"), "");
          symlinkSync(real, alias);
          const canonical = await serverCanonical(app, alias);
          expect(canonical, "the gateway answers for the alias").not.toBe("");
          expect(canonical, "the gateway resolves the alias").not.toBe(alias);

          const aliased = await grantForThisSession(app, alias);
          expect(aliased.message).toBe(`${canonical} becomes readable and writable by this session.`);
          await app.body("S").driveSession({
            op: "ingestFrame",
            feedId: CODE_OUTPUT,
            decoded: {
              type: "directory_result",
              op: "add",
              tug_session_id: SESSION_ID,
              directory: canonical,
              ok: true,
              additional_directories: [GRANTED, canonical],
              ipc_version: 2,
            },
          });
          await app.ingestSessionMetadata("S", {
            type: "system_metadata",
            tug_session_id: SESSION_ID,
            cwd: PROJECT_DIR,
            additional_directories: [GRANTED, canonical],
            ipc_version: 2,
          });
          await waitForBulletin(app, "success", "real");
          expect(await readDirectoriesRow(app)).toEqual([GRANTED, canonical]);

          // ---- E. The Summary's `x` removes a folder. -----------------------
          const asked = await removeThroughSummary(app, GRANTED);
          expect(asked).toEqual({
            message: "Remove this directory?",
            buttons: ["Cancel", "Remove"],
            summaryOpen: true,
          });
          await app.body("S").driveSession({
            op: "ingestFrame",
            feedId: CODE_OUTPUT,
            decoded: {
              type: "directory_result",
              op: "remove",
              tug_session_id: SESSION_ID,
              directory: GRANTED,
              ok: true,
              additional_directories: [canonical],
              ipc_version: 2,
            },
          });
          expect(
            (await bulletins(app)).some((b) => b.includes("removed")),
            "no \"removed\" before the folder has left the session's list",
          ).toBe(false);
          await app.ingestSessionMetadata("S", {
            type: "system_metadata",
            tug_session_id: SESSION_ID,
            cwd: PROJECT_DIR,
            additional_directories: [canonical],
            ipc_version: 2,
          });
          await waitForBulletin(app, "success", "removed");
          expect(await readDirectoriesRow(app), "the removed folder leaves the row").toEqual([canonical]);

          // ---- F. `/remove-dir` asks pane-modal and removes the same way. --
          await app.dispatchControlAction("run-card-command", { name: "remove-dir", args: GRANTED });
          await waitForBulletin(app, "warning", `This session doesn't hold ${GRANTED}`);

          await app.dispatchControlAction("run-card-command", { name: "remove-dir", args: canonical });
          await app.body("S").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(ALERT_TITLE)}) !== null`,
            { timeoutMs: 8_000 },
          );
          const sheet = await app.body("S").evalJS<{ title: string; message: string; buttons: string[] }>(
            `({
              title: (document.querySelector(${JSON.stringify(ALERT_TITLE)}).textContent || "").trim(),
              message: (document.querySelector('.tug-alert-message').textContent || "").trim(),
              buttons: Array.from(document.querySelectorAll('.tug-alert-actions button')).map(function (b) {
                return (b.textContent || "").trim();
              }),
            })`,
          );
          expect(sheet).toEqual({
            title: "Remove this directory?",
            message: `${canonical} is no longer readable or writable by this session.`,
            buttons: ["Cancel", "Remove"],
          });
          await app.body("S").click('[data-testid="alert-confirm"]');
          await app.body("S").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(ALERT_TITLE)}) === null`,
            { timeoutMs: 8_000 },
          );
          await app.body("S").driveSession({
            op: "ingestFrame",
            feedId: CODE_OUTPUT,
            decoded: {
              type: "directory_result",
              op: "remove",
              tug_session_id: SESSION_ID,
              directory: canonical,
              ok: true,
              additional_directories: [],
              ipc_version: 2,
            },
          });
          await app.ingestSessionMetadata("S", {
            type: "system_metadata",
            tug_session_id: SESSION_ID,
            cwd: PROJECT_DIR,
            additional_directories: [],
            ipc_version: 2,
          });
          await waitForBulletin(app, "success", `removed: ${canonical}`);
          expect(await readDirectoriesRow(app), "the last folder gone, the row goes too").toBeNull();

          // Bare, it opens the Session Summary.
          await app.body("S").revealPaneControls(".body-chrome-frame");
          await app.dispatchControlAction("run-card-command", { name: "remove-dir", args: "" });
          await app.body("S").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
            { timeoutMs: 8_000 },
          );
          await app.nativeKey("Escape");
          await app.body("S").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PANEL)}) === null`,
            { timeoutMs: 8_000 },
          );
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
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
