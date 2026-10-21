/**
 * row-40-ask-redelivered.test.ts — a question standing in a body survives the
 * body's eviction: the card comes back with the dialog up, and the answer
 * given there reaches the caller.
 *
 * Two Session cards share a pane. A command-line caller asks the second
 * card's session a question (`tugtool host ask`, blocking, as an app-test run
 * asks consent), and the dialog stands in the second card's page. The first
 * tab is chosen, so the second stands behind it as a sibling with its dialog
 * still up; critical pressure evicts it. The question is a `session.ask`
 * request with a person horizon, declared `redeliver`: the card's detach does
 * not answer it, so the caller is still blocked while the card has no body.
 * Choosing the second tab again brings the card back as an arrival, its new
 * page says hello, the request is sent again, and the dialog stands in the new
 * page. Answered there, the caller exits with the chosen option's value.
 *
 * @foreground
 * @covers tugdeck/src/lib/pending-ask-store.ts
 * @covers tugdeck/src/bus/request.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { launchTugApp, note } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "../_harness/tugbank-helpers";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { bodyOf, pollFor } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const A = "r40-a";
const B = "r40-b";
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const TUGTOOL = resolve(REPO_ROOT, "tugrust/target/debug/tugtool");
const DIALOG = '[data-slot="session-app-test-ask-dialog"]';
const BUTTONS = `${DIALOG} [data-slot="tug-inline-dialog-actions"] button`;
const DIALOG_UP = `document.querySelector(${JSON.stringify(DIALOG)}) !== null`;

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: B, componentId: "session", title: "B", closable: true },
    ],
    panes: [
      {
        id: "r40-pane",
        position: { x: 40, y: 40 },
        size: { width: 640, height: 480 },
        cardIds: [A, B],
        activeCardId: B,
        title: "",
        acceptsFamilies: ["maker"],
        slot: 0,
      },
    ],
    activePaneId: "r40-pane",
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The labels of the dialog's buttons, in order, in the page it is read in. */
const BUTTON_LABELS = `Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(BUTTONS)}), function (b) { return (b.textContent || "").trim(); })`;

/** Ask session `sid` a two-option question without waiting: the caller blocks until it is answered. */
function startAsk(instanceId: string, sid: string) {
  return Bun.spawn(
    [
      TUGTOOL, "host", "ask", "--instance", instanceId,
      "--title", "Row 40 asks across an eviction",
      "--option", "keep:Keep it",
      "--option", "drop:Drop it",
      "--timeout-secs", "60",
    ],
    { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT, env: { ...process.env, TUG_SESSION_ID: sid } },
  );
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 40: an ask redelivered across an eviction", () => {
  test(
    "a question standing in an evicted sibling stands again when its tab is chosen, and its answer reaches the caller",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r40-project-")));
      onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: "body-grounding-row-40-ask-redelivered",
        foreground: true,
        persistInTestMode: true,
        restoreInTestMode: true,
        env: { TUGBANK_PATH: tugbankPath },
      });
      let proc: ReturnType<typeof startAsk> | null = null;
      try {
        await app.seedDeckState({ state: deck(), focusCardId: B });
        await pollFor(() => bodyOf(app, B), (b) => b?.state === "ready" && b.visible, 30_000);
        const sid = randomUUID();
        await app.spawnSessionNew(B, { tugSessionId: sid, projectDir });

        // ---- A caller asks the second card's session, and blocks ----
        proc = startAsk(app.instanceId, sid);
        try {
          await app.body(B).waitForCondition<boolean>(DIALOG_UP, { timeoutMs: 15_000 });
        } catch (error) {
          proc.kill();
          throw new Error(`the dialog never stood; tugtool host ask said: ${await new Response(proc.stderr).text()}`, { cause: error });
        }

        // ---- The first tab chosen; the sibling, dialog up, evicted ----
        await app.body(B).click(`[data-testid="tug-tab-${A}"]`);
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 10_000);
        await pollFor(() => bodyOf(app, B), (b) => b !== null && !b.visible, 5_000);
        await app.simulateMemoryPressure("critical");
        const gone = await pollFor(() => app.bodies(), (all) => !all.some((b) => b.cardId === B), 5_000);
        expect(gone.some((b) => b.cardId === B), "the sibling with the dialog up is evicted").toBe(false);
        await Bun.sleep(500);
        expect(proc.exitCode, "the caller is still blocked while the card has no body: the detach did not answer it").toBeNull();

        // ---- The second tab chosen: the card back, the question with it ----
        const chose = performance.now();
        await app.body(A).click(`[data-testid="tug-tab-${B}"]`);
        await pollFor(() => bodyOf(app, B), (b) => b?.state === "ready" && b.painted && b.visible, 10_000);
        await app.body(B).waitForCondition<boolean>(DIALOG_UP, { timeoutMs: 10_000 });
        note(`the dialog stood again ${Math.round(performance.now() - chose)} ms after the tab was chosen`);
        const labels = await app.body(B).evalJS<string[]>(BUTTON_LABELS);
        expect([...labels].sort(), "the redelivered dialog carries the caller's two options").toEqual(["Drop it", "Keep it"]);

        // ---- Answered in the new page, the answer reaches the caller ----
        await app.body(B).click(`${BUTTONS}:nth-child(${labels.indexOf("Keep it") + 1})`);
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        expect(proc.exitCode, "the caller is released").toBe(0);
        expect(stdout.trim(), "the caller hears the option chosen in the card's new page").toBe("keep");
        await app.body(B).waitForCondition<boolean>(`!(${DIALOG_UP})`, { timeoutMs: 5_000 });
      } finally {
        proc?.kill();
        await app.simulateMemoryPressure("normal").catch(() => undefined);
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
