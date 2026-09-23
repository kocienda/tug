/**
 * at0441-configure-tug-git-row.test.ts — ConfigureTug's git row offers Apple's
 * Command Line Tools when the machine has no git, says what they cost, and
 * remembers a skip.
 *
 * Tug shells out to `git` for the entire changes and commit surface and for
 * every arc worktree, and ships none of it — git is GPLv2-only, so the offer
 * points at Apple's Command Line Tools and the user installs them from Apple.
 * Until this row existed, a machine with no git failed deep inside whatever
 * feature reached for one, phrased as that feature's error.
 *
 * Every machine that can run this corpus has git, so the interesting reading —
 * "no git, here is the offer" — cannot be produced by probing the host. The
 * test drives the real wire first (the boot probe answers with this machine's
 * actual git, which is the end-to-end assertion), then dispatches a
 * `host_tools_result` payload of its own through the real action table, which
 * is the same path a tugcast frame takes.
 *
 * What is pinned:
 *   1. The boot probe answers and the row settles on a real version line — the
 *      `check_host_tools` → `host_tools_result` round trip works.
 *   2. A no-git result turns the row into the offer, with the download's size
 *      in the copy and a Skip beside Install. An Install button that does not
 *      say what it costs is an ambush.
 *   3. Skip retires the row, and it stays retired across a reload — the flag
 *      lives in tugbank, not in this launch's memory.
 *   4. The git question never blocks the wizard: the rows below it are still
 *      there while the offer stands.
 *
 * Reached through Tug ▸ Configure Tug… (`dispatchControlAction("configure-tug")`,
 * the exact action the menu item posts), because the blocking wizard is
 * suppressed under the harness — an on-demand open is the only way it appears.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/configure-tug.tsx
 * @covers tugdeck/src/components/tugways/tug-step-row.tsx
 * @covers tugdeck/src/components/tugways/configure-tug-copy.ts
 * @covers tugdeck/src/lib/host-tools-store.ts
 * @covers tugdeck/src/settings-api.ts
 * @covers tugrust/crates/tugcast/src/feeds/host_tools.rs
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0441-configure-tug-git-row";
const SETUP = '[data-slot="configure-tug"]';
const GIT_ROW = `${SETUP} .configure-tug-step[data-step="host-tools"]`;
const GIT_LABEL = `${GIT_ROW} .tug-step-row-label`;
const GIT_DETAIL = `${GIT_ROW} .tug-step-row-detail`;
const GIT_ACTION = `${GIT_ROW} .tug-step-row-action`;
// The secondary CTA renders before the primary, so the first button in the
// action slot is Skip / Recheck and the last is Install / Retry.
const GIT_SECONDARY = `${GIT_ACTION} [data-slot="tug-push-button"]:first-child`;
const INSTALL_ROW = `${SETUP} .configure-tug-step[data-step="install"]`;

/** A `host_tools_result` for a machine with no git at all. */
const NO_GIT_RESULT = {
  gitVersion: null,
  gitPath: null,
  developerDir: null,
  gitFloor: "2.23",
  usable: false,
};

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 660 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["work"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

function text(selector: string): string {
  return `(function () {
    var node = document.querySelector(${JSON.stringify(selector)});
    return node === null ? "" : node.textContent;
  })()`;
}

function present(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)}) !== null`;
}

/** Push a `host_tools_result` through the real action table. */
function fakeProbe(result: Record<string, unknown>): string {
  return `(window.__tug.dispatchControlAction("host_tools_result", ${JSON.stringify(
    result,
  )}), null)`;
}

const OPEN_WIZARD = `(window.__tug.dispatchControlAction("configure-tug", {}), null)`;

describe.skipIf(!SHOULD_RUN)("AT0441: the git row offers the tools it needs", () => {
  test(
    "offers Apple's Command Line Tools, names the size, and remembers a skip",
    async () => {
      const app = await launchTugApp({ testName: "at0441-configure-tug-git-row" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });

        await app.evalJS<null>(OPEN_WIZARD);
        await app.waitForCondition<boolean>(present(SETUP), { timeoutMs: 8000 });

        // 1. The real probe. Every machine that can build and run this corpus
        //    has git, so waiting for the settled version line IS the assertion
        //    that `check_host_tools` → `host_tools_result` works end to end.
        await app.waitForCondition<boolean>(
          `/^Version \\d+\\.\\d+/.test(${text(GIT_DETAIL)})`,
          { timeoutMs: 20_000 },
        );
        const settled = await app.evalJS<string>(text(GIT_DETAIL));
        note(`at0441 real probe: ${JSON.stringify(settled)}`);
        expect(
          await app.evalJS<string>(text(GIT_LABEL)),
          "a machine with git reads as settled",
        ).toBe("git installed");

        // 2. The reading this machine cannot produce: no git, and the offer.
        await app.evalJS<null>(fakeProbe(NO_GIT_RESULT));
        await app.waitForCondition<boolean>(
          `${text(GIT_LABEL)} === "Install git"`,
          { timeoutMs: 4000 },
        );
        const offer = await app.evalJS<string>(text(GIT_DETAIL));
        note(`at0441 offer: ${JSON.stringify(offer)}`);
        expect(offer, "the offer says what it costs").toContain("3 GB");
        expect(
          await app.evalJS<string>(text(GIT_SECONDARY)),
          "the offer is deferrable",
        ).toBe("Skip for now");

        // 4. A missing git never blocks the wizard — the rows below it stand.
        expect(
          await app.evalJS<boolean>(present(INSTALL_ROW)),
          "the Claude row is still reachable while git is missing",
        ).toBe(true);

        // 3. Skip retires the row for this launch…
        await app.nativeClickAtElement(GIT_SECONDARY);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(GIT_ROW)}) === null`,
          { timeoutMs: 4000 },
        );

        // …and across a reload, because the flag went to tugbank rather than
        // into this page's memory. The re-faked probe is what proves the row
        // stayed away by choice rather than by the machine having git.
        await app.appReload();
        await app.waitForCondition<boolean>(
          `typeof window.__tug !== "undefined"`,
          { timeoutMs: 20_000 },
        );
        await app.evalJS<null>(OPEN_WIZARD);
        await app.waitForCondition<boolean>(present(SETUP), { timeoutMs: 8000 });
        await app.waitForCondition<boolean>(present(INSTALL_ROW), { timeoutMs: 8000 });
        await app.evalJS<null>(fakeProbe(NO_GIT_RESULT));
        // Give the row every chance to come back before concluding it didn't.
        await app.waitForCondition<boolean>(
          `${text(GIT_LABEL)} === "Install git"`,
          { timeoutMs: 2500 },
        ).then(
          () => {
            throw new Error("the skipped git row returned after a reload");
          },
          () => undefined,
        );
        expect(
          await app.evalJS<boolean>(present(GIT_ROW)),
          "a remembered skip keeps the row away",
        ).toBe(false);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0441-configure-tug-git-row] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
