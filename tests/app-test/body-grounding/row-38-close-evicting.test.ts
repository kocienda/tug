/**
 * row-38-close-evicting.test.ts — a card closed while its eviction is in
 * flight is removed by its close alone: the eviction keeps no cover for it
 * and tells the shell nothing.
 *
 * A Session card is hidden past a shortened `evictAfterMs` by parking its
 * workspace, and the clock starts its eviction. The host is launched so the
 * eviction's snapshot never answers (`TUG_BODY_STALL_SNAPSHOTS`), which holds
 * the eviction open until the snapshot's deadline. Once its save has
 * answered, the card's page is kept busy past that deadline and a saving
 * close (`bodyDestroy` with `save`) is posted behind the busy script, so the
 * eviction's end lands while the close still waits on its own save — the
 * order in which an eviction used to keep a cover for a closed card, remove
 * its body a second time and report it `evicted`. The host's log must say
 * the eviction was abandoned for the close and never that the card was
 * evicted, and the body must be gone once the close's save answers.
 *
 * @family row-38
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { bodyOf, pollFor, sessionPane } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r38c-a";
/** The reader's delay before eviction, shortened from fifteen minutes for the row. */
const EVICT_AFTER_MS = 1_000;
/** The host's `saveDeadline`, which the snapshot's deadline is too. */
const SNAPSHOT_DEADLINE_MS = 2_000;
/** How long the card's page is kept busy: past the snapshot's deadline. */
const BUSY_MS = 3_000;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The host log's `bodies` lines naming card `A`. */
function linesFor(app: App): string[] {
  return app
    .tugappLog()
    .split("\n")
    .filter((line) => line.includes("tugapp::bodies:") && line.includes(`card=${A}`));
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 38: a close during an eviction", () => {
  test(
    "a card closed while its eviction waits on its snapshot is removed by the close, with no cover kept and no eviction reported",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r38c-project-")));
      onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
      const app = await launchTugApp({ testName: "body-grounding-row-38-close-evicting", env: { TUG_BODY_STALL_SNAPSHOTS: "1" } });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 30_000);
        await app.spawnSessionNew(A, { tugSessionId: randomUUID(), projectDir });
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.body-dormancy", "evictAfterMs", { kind: "i64", value: ${EVICT_AFTER_MS} }), null)`,
        );

        // ---- Parked; the clock starts its eviction, whose snapshot never answers ----
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        const started = await pollFor(
          async () => linesFor(app).some((line) => line.includes(": evicting ")),
          (yes) => yes,
          EVICT_AFTER_MS + 5_000,
        );
        expect(started, "the clock started the card's eviction").toBe(true);
        // The eviction's save is the page's first call; give it time to answer.
        await new Promise((resolve) => setTimeout(resolve, 400));

        // ---- The page kept busy past the deadline, a saving close queued behind it ----
        const busy = app
          .body(A)
          .evalJS<null>(`(function () { var end = Date.now() + ${BUSY_MS}; while (Date.now() < end) {} return null; })()`, {
            timeoutMs: BUSY_MS + 5_000,
          })
          .catch(() => null);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const closedAt = Date.now();
        await app.evalJS<null>(
          `(window.webkit.messageHandlers.bodyDestroy.postMessage(JSON.stringify({ cardId: ${JSON.stringify(A)}, save: true })), null)`,
        );
        await busy;

        // ---- The close alone removes the body ----
        const after = await pollFor(() => app.bodies(), (all) => !all.some((b) => b.cardId === A), 5_000);
        expect(after.some((b) => b.cardId === A), "the close removed the card's body").toBe(false);
        const abandoned = await pollFor(
          async () => linesFor(app).filter((line) => line.includes(": eviction abandoned ")),
          (lines) => lines.length > 0,
          SNAPSHOT_DEADLINE_MS + 3_000,
        );
        const lines = linesFor(app);
        note(`${Date.now() - closedAt} ms after the close, the host's lines for the card:\n  ${lines.map((l) => l.replace(/^\S+ /, "")).join("\n  ")}`);
        expect(abandoned.length, "the eviction was abandoned for the close").toBe(1);
        expect(abandoned[0], "and says the card was closed").toContain("why=closed");
        expect(
          lines.filter((line) => line.includes(": evicted ")),
          "the eviction kept no cover and did not report the closed card evicted",
        ).toEqual([]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
