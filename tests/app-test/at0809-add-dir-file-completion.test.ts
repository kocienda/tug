/**
 * at0809-add-dir-file-completion.test.ts — a folder the session holds beyond
 * its project is in the `@` completion, and its row names it absolutely.
 *
 * ## What this gates
 *
 * `/add-dir` grants a session another folder, and the session metadata store
 * lists it (`additionalDirectories`). The `@` popup must then offer that
 * folder's files beside the project's: the card takes a browse hold on the
 * folder, queries it at its own root, and merges its answers in. Only the
 * running app has the pieces together — the hold is a real
 * `/api/workspace/acquire`, the index is tugcast's, and the answer rides the
 * shared FILETREE feed through a per-folder workspace filter.
 *
 *   A. **The folder's file is offered**, labelled `<folder>/<path>`.
 *   B. **Accepting it inserts a chip whose address is the absolute path**,
 *      since a path relative to the project could not name it.
 *
 * The merge, the hold-once rule and letting go of a folder are the unit
 * suite's (`session-file-completion.test.ts`).
 *
 * @covers tugdeck/src/lib/session-file-completion.ts
 * @covers tugdeck/src/lib/card-services-store.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const SESSION_ID = "b9e1e2d3-1c4f-4a6b-8d7e-8f9a0b1c2d3e";

const COMPOSER = '[data-card-id="S"] [data-slot="tug-text-editor"] .cm-content';
const COMPLETION_MENU = '[data-slot="tug-completion-menu"]';
const CHIP = `${COMPOSER} img[data-atom-label]`;
const ITEMS_JS = `Array.from(
  document.querySelectorAll(${JSON.stringify(`${COMPLETION_MENU} .tug-completion-menu-item`)}),
).map(function (el) { return (el.textContent || "").trim(); })`;

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

/** The server's canonical spelling of `path` ([L29]), from the gateway the card asks. */
async function serverCanonical(app: App, path: string): Promise<string> {
  await app.body("S").evalJS(`(() => {
    window.__at0809_canonical = undefined;
    fetch("/api/fs/stat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [${JSON.stringify(path)}], kind: "dir" }),
    })
      .then((r) => r.json())
      .then((j) => { window.__at0809_canonical = (j.canonical || {})[${JSON.stringify(path)}] || ""; })
      .catch(() => { window.__at0809_canonical = ""; });
  })()`);
  await app.body("S").waitForCondition<boolean>(`window.__at0809_canonical !== undefined`, {
    timeoutMs: 8_000,
  });
  return app.body("S").evalJS<string>(`window.__at0809_canonical`);
}

describe.skipIf(!SHOULD_RUN)("at0809 — @ completes in a folder the session was granted", () => {
  test(
    "the added folder's file is offered as <folder>/<path> and accepted as its absolute path",
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), "at0809-"));
      const project = join(scratch, "project");
      const site = join(scratch, "site");
      await Bun.write(join(project, "README.md"), "project\n");
      await Bun.write(join(site, "src", "zephyrine.astro"), "---\n---\n");
      const app = await launchTugApp({ testName: "at0809-add-dir-file-completion" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "S" });
        await waitForBodyReady(app, "S");
        const projectDir = await serverCanonical(app, project);
        const siteDir = await serverCanonical(app, site);
        expect(siteDir, "the gateway answers for the folder").not.toBe("");
        await app.bindSession("S", { tugSessionId: SESSION_ID, projectDir });

        // The session reports the folder it holds, as tugcode does after a grant.
        await app.ingestSessionMetadata("S", {
          type: "system_metadata",
          tug_session_id: SESSION_ID,
          cwd: projectDir,
          additional_directories: [siteDir],
          ipc_version: 2,
        });

        // ---- A. The folder's file is offered. -----------------------------
        await app.body("S").nativeClickAtElement(COMPOSER);
        await app.nativeType("@zephyr");
        const label = "site/src/zephyrine.astro";
        await app.body("S").waitForCondition<boolean>(
          `(function () { return ${ITEMS_JS}.indexOf(${JSON.stringify(label)}) !== -1; })()`,
          { timeoutMs: 15_000 },
        );
        note("the popup", JSON.stringify(await app.body("S").evalJS<string[]>(ITEMS_JS)));

        // ---- B. Accepted, the chip's address is the absolute path. --------
        await app.body("S").waitForCondition<boolean>(
          `(function () { return ${ITEMS_JS}[0] === ${JSON.stringify(label)}; })()`,
          { timeoutMs: 8_000 },
        );
        await app.nativeKey("Return");
        await app.body("S").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const chip = await app.body("S").evalJS<{ label: string | null; path: string | null }>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(CHIP)});
            return { label: el.getAttribute("data-atom-label"), path: el.getAttribute("data-path") };
          })()`,
        );
        note("the chip", JSON.stringify(chip));
        expect(chip.label).toBe(label);
        expect(chip.path).toBe(`${siteDir}/src/zephyrine.astro`);
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0809] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
