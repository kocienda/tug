/**
 * at0443-no-git-notice.test.ts — the Changes and History shades say when the
 * machine has no git, and say it instead of offering to `git init`.
 *
 * Tug shells out to `git` for the whole changes and commit surface and ships
 * none of it — git is GPLv2-only, so the offer points at Apple's Command Line
 * Tools. A remembered skip in ConfigureTug's git row is only honest because the
 * offer comes back where the need is real, and these two shades are where it is
 * most real: without git there is nothing for either of them to show.
 *
 * The precedence is the subject. `TugNonRepoNotice` offers to initialize a
 * repository in a directory that has none — a button that cannot possibly work
 * on a machine with no git — so the no-git reading has to win, and in both
 * views it is decided ahead of every other reading those views can take.
 *
 * What is asserted is the displacement itself, on both routes: with git
 * present neither shade says a word about git, and the moment no git is
 * reported both replace whatever they were rendering with the offer — and
 * neither offers to `git init`. That is the whole of what the precedence buys,
 * because `shouldShowNoGitNotice` is decided ahead of every other reading in
 * both views, `no_repo` among them.
 *
 * The non-repo reading is not itself reachable here, and neither is a settled
 * changeset: a project scan does not complete inside an app-test's lifetime, so
 * both shades sit on "Waiting for project scan…" until something displaces
 * them. That is what the diagnostics show being displaced.
 *
 * Every machine that can run this corpus has git, so the no-git reading is
 * produced by dispatching a `host_tools_result` payload through the real action
 * table — the same path a tugcast frame takes.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/tug-no-git-notice.tsx
 * @covers tugdeck/src/components/tugways/tug-no-git-notice-copy.ts
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/components/tugways/cards/session-history/session-history-view.tsx
 * @covers tugdeck/src/lib/host-tools-store.ts
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The worktree — the real repo tugcast serves as its bootstrap tree. */
const REPO = resolve(import.meta.dir, "..", "..");

const CARD = '[data-card-id="D"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const CHANGES = '[data-slot="session-changes-view"]';
const HISTORY = '[data-slot="session-history-view"]';
const NO_GIT = '[data-testid="tug-no-git-notice"]';
const NO_GIT_CTA = '[data-testid="tug-no-git-notice-install"]';
const NON_REPO = '[data-testid="tug-non-repo-notice"]';

/** A `host_tools_result` for a machine with no git at all. */
const NO_GIT_RESULT = {
  gitVersion: null,
  gitPath: null,
  developerDir: null,
  gitFloor: "2.23",
  usable: false,
};

const settle = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function deckShape() {
  return {
    cards: [{ id: "D", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 960, height: 700 },
        cardIds: ["D"],
        activeCardId: "D",
        title: "",
        acceptsFamilies: ["work"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

function present(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)}) !== null`;
}

function text(selector: string): string {
  return `(function () {
    var node = document.querySelector(${JSON.stringify(selector)});
    return node === null ? "" : node.textContent;
  })()`;
}

describe.skipIf(!SHOULD_RUN)("AT0443: the shades say when there is no git", () => {
  test(
    "reporting no git replaces what each shade was showing, on both shades",
    async () => {
      const app = await launchTugApp({ testName: "at0443-no-git-notice" });
      try {
        await app.waitForCondition<boolean>(
          `typeof window.__tug !== "undefined"`,
          { timeoutMs: 15_000 },
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "D" });
        await app.waitForCondition<boolean>(
          `window.__tug.assertHostRootRegistered("D")`,
          { timeoutMs: 15_000 },
        );
        await app.bindSession("D", { projectDir: REPO });
        await app.waitForCondition<boolean>(present(EDITOR), { timeoutMs: 15_000 });
        await app.nativeClickAtElement(EDITOR);
        await settle(300);

        // ---- Changes: the ordinary reading, then the no-git one ----
        await app.nativeKey("c", ["ctrl", "cmd"]);
        await app.waitForCondition<boolean>(present(CHANGES), { timeoutMs: 15_000 });
        // The machine running this HAS git, so the shade shows its ordinary
        // content and says nothing about git. That absence is what makes the
        // displacement below mean something.
        await settle(1500);
        const before = await app.evalJS<string>(text(CHANGES));
        note(`at0443 changes before: ${JSON.stringify(before.slice(0, 80))}`);
        expect(
          await app.evalJS<boolean>(present(NO_GIT)),
          "a machine with git says nothing about git",
        ).toBe(false);

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("host_tools_result", ${JSON.stringify(
            NO_GIT_RESULT,
          )}), null)`,
        );
        await app.waitForCondition<boolean>(present(NO_GIT), { timeoutMs: 8000 });
        note(`at0443 changes notice: ${await app.evalJS<string>(text(NO_GIT))}`);
        expect(
          await app.evalJS<boolean>(present(NON_REPO)),
          "a machine with no git is never offered a git init it cannot run",
        ).toBe(false);
        expect(
          (await app.evalJS<string>(text(NO_GIT_CTA))).trim(),
          "the shade carries the same offer the wizard's row does",
        ).toBe("Install");

        // ---- History: the same reading, on the other route ----
        await app.nativeKey("c", ["ctrl", "cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHANGES)}) === null`,
          { timeoutMs: 8000 },
        );
        await app.nativeKey("h", ["ctrl", "cmd"]);
        await app.waitForCondition<boolean>(present(HISTORY), { timeoutMs: 15_000 });
        await app.waitForCondition<boolean>(present(NO_GIT), { timeoutMs: 8000 });
        note(`at0443 history notice: ${await app.evalJS<string>(text(NO_GIT))}`);
        expect(
          await app.evalJS<boolean>(present(NON_REPO)),
          "the two shades read identically on the same machine",
        ).toBe(false);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0443-no-git-notice] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
