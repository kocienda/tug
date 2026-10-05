/**
 * at0707-bash-live-progress.test.ts — a running Bash block shows what its
 * command says it is doing, and the engine's own clock.
 *
 * A long `just test` used to be a block with a dot and a clock and nothing
 * else for minutes. Two frames now speak for it: the engine's
 * `tool_progress` heartbeat, which the header clock reads (so it is right
 * from the first heartbeat, and marked `live`), and a `run_progress`
 * report the command posted about itself, which rides a live band between
 * the header and the body — readable while the block is collapsed, which is
 * how a shell block mounts.
 *
 * The drive: a Bash `tool_use` for `just test`, a heartbeat at 125 s, a
 * report attached to the call. The band reads the report, the clock reads
 * the engine; the call's result removes the band. A second report that no
 * call claimed lands on the JOBS placard's card-level line.
 *
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 * @covers tugdeck/src/lib/run-progress-store.ts
 * @covers tugdeck/src/components/tugways/blocks/block-header.tsx
 * @covers tugdeck/src/components/tugways/blocks/block-chrome.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;

const SID = "at0707-A";
const USE_ID = `${SID}-tc1`;
const BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${USE_ID}"]`;
const BAND = `${BLOCK} [data-slot="bash-live-band"]`;
const ELAPSED = `${BLOCK} [data-slot="tool-call-header-elapsed"]`;
const JOBS_CELL = '[data-slot="tug-status-cell"][data-priority="jobs"]';
const LIVE_RUN = '[data-slot="session-jobs-popover-live-run"]';

function deckShape(): Record<string, unknown> {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 700 },
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

function frame(app: App, decoded: Record<string, unknown>): Promise<unknown> {
  return app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, ...decoded },
  });
}

function text(app: App, selector: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () { const el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.textContent; })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0707: live progress on a running Bash block", () => {
  test(
    "the band carries the report, the clock the engine, and the result ends both",
    async () => {
      const app = await launchTugApp({ testName: "at0707-live-progress" });
      try {
        // `awaitEngineReady` reads the deck trace, which records nothing
        // until it is enabled.
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A", { timeoutMs: 20_000 });

        await app.driveSession("A", { op: "send", text: "run the tests" });
        await frame(app, { type: "prompt_anchor", promptUuid: `${SID}-u1` });
        await frame(app, {
          type: "tool_use",
          msg_id: `${SID}-m1`,
          tool_use_id: USE_ID,
          tool_name: "Bash",
          input: { command: "just test" },
          seq: 1,
        });
        await frame(app, {
          type: "tool_progress",
          tool_use_id: USE_ID,
          tool_name: "Bash",
          elapsed_time_seconds: 125,
          parent_tool_use_id: null,
        });
        await frame(app, {
          type: "run_progress",
          tool_use_id: USE_ID,
          label: "rust",
          text: "compiling tugcast",
          done: 3,
          total: 10,
        });

        await app.waitForCondition<boolean>(
          `!!document.querySelector(${JSON.stringify(BAND)})`,
          { timeoutMs: 10_000 },
        );
        expect(
          await app.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(BLOCK)}) || { getAttribute: () => null }).getAttribute("data-block-collapsed")`,
          ),
          "a shell block mounts collapsed, and the band reads anyway",
        ).toBe("true");
        expect(await text(app, BAND)).toContain("rust · 3/10 · compiling tugcast");

        // The engine's reading, not the local clock since the replayed
        // start: 125 s at the heartbeat, carried forward.
        const elapsed = (await text(app, ELAPSED)) ?? "";
        const m = /(\d+)m (\d+)s/.exec(elapsed);
        expect(m, `elapsed reads ${JSON.stringify(elapsed)}`).not.toBeNull();
        expect(Number(m![1]) * 60 + Number(m![2])).toBeGreaterThanOrEqual(125);
        expect(
          await app.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(ELAPSED)}) || { getAttribute: () => null }).getAttribute("data-engine")`,
          ),
        ).toBe("live");

        await frame(app, {
          type: "tool_result",
          tool_use_id: USE_ID,
          is_error: false,
          output: "ok",
        });
        await app.waitForCondition<boolean>(
          `!document.querySelector(${JSON.stringify(BAND)})`,
          { timeoutMs: 10_000 },
        );

        // A report no call claimed: the card's line, on the JOBS placard.
        await frame(app, {
          type: "run_progress",
          tool_use_id: null,
          label: "app-test",
          text: "at0603 PASS",
          done: 7,
          total: 20,
        });
        await app.evalJS<boolean>(
          `(function () { const c = document.querySelector(${JSON.stringify(JOBS_CELL)}); if (c === null) return false; c.click(); return true; })()`,
        );
        await app.waitForCondition<boolean>(
          `!!document.querySelector(${JSON.stringify(LIVE_RUN)})`,
          { timeoutMs: 10_000 },
        );
        expect(await text(app, LIVE_RUN)).toBe("app-test · 7/20 · at0603 PASS");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
