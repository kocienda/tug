/**
 * at0387-error-block-follow-bottom.test.ts — a failing tool block must
 * not release the live edge.
 *
 * Field report: a Bash block that ends with a non-zero exit — the red
 * header dot plus the error notice band under it — very often leaves
 * the transcript parked with the jump-to-bottom affordance showing,
 * mid-stream, with the user's hands nowhere near the scroller.
 *
 * The drive is the report: stand a transcript up at the live edge with
 * eviction armed, append Bash calls that settle with `is_error: true`
 * and a multi-line output, and ask whether follow-bottom survived. The
 * dev log's follow-bottom transitions name the culprit if it did not.
 *
 * The rule behind it — a pixel of jitter under fresh growth is not the
 * user leaving — and the flip record's shape are pinned on a real
 * `SmartScroll` in `tugdeck/src/__tests__/smart-scroll-jitter.test.ts`.
 *
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import type { SessionDriveAction } from "./_harness/client";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const FEED_CODE_OUTPUT = 0x40;

const SID = "at0387-A";
const TURNS = 30;
const BASH_TURNS = 3;
const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';
const JUMP_BUTTON = ".tug-jump-to-bottom-button";

function frame(decoded: Record<string, unknown>): SessionDriveAction {
  return {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, ...decoded },
  };
}

/** One committed prompt→reply turn, sent as one batch. */
function seedTurn(app: App, n: number): Promise<void> {
  const msgId = `${SID}-m${n}`;
  return app.driveSessionBatch("A", [
    { op: "send", text: `prompt ${n}` },
    frame({ type: "prompt_anchor", promptUuid: `${SID}-u${n}` }),
    frame({
      type: "content_block_start",
      msg_id: msgId,
      block_index: 0,
      kind: "text",
    }),
    frame({
      type: "assistant_text",
      seq: 0,
      rev: 0,
      status: "complete",
      msg_id: msgId,
      block_index: 0,
      text: [
        `## step ${n}`,
        "",
        `Reply number ${n}, long enough that a dozen of these overflow the`,
        "transcript scrollport and put the card genuinely at a live edge.",
        "",
        `- marker ${n}`,
      ].join("\n"),
      is_partial: false,
    }),
    frame({ type: "turn_complete", seq: 0, msg_id: msgId, result: "success" }),
  ]);
}

/** A real failing `just app-test` tail — long enough that the block's
 *  body is a substantial cell of its own. */
function failingOutput(): string {
  const lines = [
    "Exit code 1",
    "==> app-test instance prefix: apptest-main",
    "==> app-test bundle id: dev.tugapp.app.apptest (identity: dev.tugapp.app.apptest)",
    "swept 5 tmux socket files",
    "",
    "========================================================",
    "APP-TEST SUMMARY",
    "========================================================",
    "Sweep:          explicit-files",
    "Files run:      1",
    "Files passed:   0",
    "Files failed:   1",
    "",
    "Per-file results:",
    "  [FAIL] at0386-session-description-hover.test.ts            (1/3)",
    "",
    "Failures:",
    "  at0386-session-description-hover.test.ts",
  ];
  for (let i = 0; i < 24; i += 1) {
    lines.push(`    expect(received).toBe(expected)  # assertion ${i}`);
  }
  lines.push("VERDICT: FAIL");
  return lines.join("\n");
}

/** One Bash call that settles with a non-zero exit: the call lands and
 *  renders running, then its result and the rest of the turn arrive. */
async function seedFailingBashTurn(app: App, n: number): Promise<void> {
  const msgId = `${SID}-b${n}`;
  const useId = `${SID}-tc${n}`;
  await app.driveSessionBatch("A", [
    { op: "send", text: `run ${n}` },
    frame({ type: "prompt_anchor", promptUuid: `${SID}-bu${n}` }),
    frame({
      type: "tool_use",
      msg_id: msgId,
      tool_use_id: useId,
      tool_name: "Bash",
      input: {
        command:
          "cd /Users/kocienda/Mounts/u/src/tugtool && just app-test " +
          "at0386-session-description-hover.test.ts 2>&1 | tail -28",
      },
      seq: 1,
    }),
  ]);
  await new Promise((r) => setTimeout(r, 250));
  await app.driveSessionBatch("A", [
    frame({
      type: "tool_result",
      tool_use_id: useId,
      is_error: true,
      output: failingOutput(),
    }),
    // The turn does not end at the result — the assistant keeps talking
    // about the failure, which is the shape the field report sits in.
    frame({
      type: "content_block_start",
      msg_id: msgId,
      block_index: 2,
      kind: "text",
    }),
    frame({
      type: "assistant_text",
      seq: 0,
      rev: 0,
      status: "complete",
      msg_id: msgId,
      block_index: 2,
      text: "The run came back non-zero. Reading the failure now.",
      is_partial: false,
    }),
    frame({ type: "turn_complete", seq: 0, msg_id: msgId, result: "success" }),
  ]);
}

interface Snap {
  top: number;
  maxScroll: number;
  distance: number;
  buttonVisible: string;
  /** Last follow-bottom transition in the dev log; true when none yet
   *  (the transcript scroller is constructed engaged). */
  following: boolean;
  /** The clamp counter. Per [at0335] the honest reading is `"0"` — a
   *  record means the extent floor has a hole. */
  displacements: string | null;
}

function readSnap(app: App): Promise<Snap> {
  return app.evalJS<Snap>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  var btn = document.querySelector('${JUMP_BUTTON}');
  var max = el.scrollHeight - el.clientHeight;
  var flips = window.tugDevLog.getSnapshot().entries.filter(function (e) {
    return e.source === "smart-scroll" && e.message === "follow-bottom";
  });
  return {
    top: el.scrollTop,
    maxScroll: max,
    distance: max - el.scrollTop,
    buttonVisible: (btn === null ? null : btn.getAttribute("data-visible")) || "false",
    following: flips.length === 0 ? true : !!flips[flips.length - 1].data.following,
    displacements: el.getAttribute("data-scroll-displacements"),
  };
})()`);
}

/** Eviction's height-accounting error, per swap: the ledger's charge
 *  for a departed row minus the extent it actually occupied. A nonzero
 *  `delta` IS the document-height error a browser clamp then acts on. */
function readConservation(app: App): Promise<unknown> {
  return app.evalJS(`(function () {
  var c = window.__tug.getListConservation('${SCROLLER}');
  var bad = c.events.filter(function (e) { return Math.abs(e.delta) >= 0.5; });
  return {
    swaps: c.events.length,
    floor: c.floor,
    badSwaps: bad.length,
    worst: bad.slice(-6).map(function (e) {
      return {
        departed: e.departed, delta: Math.round(e.delta * 100) / 100,
        rows: e.rows.map(function (r) {
          return r.kind + "#" + r.index + " ledger=" + Math.round(r.ledger) + " live=" + Math.round(r.live);
        }),
      };
    }),
  };
})()`);
}

/** Follow-bottom transitions in the dev log, oldest first. */
function readFollowBottom(app: App): Promise<
  { following: boolean; source: string; scrollTop: number; scrollHeight: number }[]
> {
  return app.evalJS(`(function () {
  return window.tugDevLog.getSnapshot().entries
    .filter(function (e) {
      return e.source === "smart-scroll" && e.message === "follow-bottom";
    })
    .map(function (e) {
      return {
        following: e.data.following,
        source: e.data.source,
        scrollTop: Math.round(e.data.scrollTop),
        scrollHeight: Math.round(e.data.scrollHeight),
      };
    });
})()`);
}

// Kept local: every file's `standUp` launches into its own deck and transcript,
// so the name is shared and the function is not.
async function standUp(testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 700 }), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 20_000 });
  for (let n = 0; n < TURNS; n += 1) {
    await seedTurn(app, n);
  }
  await app.waitForCondition<boolean>(
    `!!document.querySelector('${SCROLLER}[data-evict-active]')`,
    { timeoutMs: 30_000 },
  );
  await new Promise((r) => setTimeout(r, 600));
  return app;
}

describe.skipIf(!SHOULD_RUN)("AT0387: error block vs follow-bottom", () => {
  test(
    "a failing Bash block keeps the transcript at the live edge",
    async () => {
      const app = await standUp("at0387-error");
      try {
        const before = await readSnap(app);
        expect(before.maxScroll).toBeGreaterThan(0);
        expect(before.following).toBe(true);

        const snaps: Snap[] = [];
        for (let n = 0; n < BASH_TURNS; n += 1) {
          await seedFailingBashTurn(app, n);
          await new Promise((r) => setTimeout(r, 400));
          snaps.push(await readSnap(app));
        }
        const sources = await readFollowBottom(app);
        note("at0387-error", {
          flips: sources,
          snaps: snaps.map(
            (s) => `d=${s.distance} btn=${s.buttonVisible} disp=${s.displacements}`,
          ),
          conservation: await readConservation(app),
        });
        const after = snaps[snaps.length - 1]!;
        expect(sources.filter((s) => !s.following)).toHaveLength(0);
        // [at0335] the clamp is impossible by construction; a record
        // means the extent floor has a hole under tool-block content.
        expect(after.displacements).toBe("0");
        expect(after.following).toBe(true);
        expect(after.buttonVisible).toBe("false");
        expect(after.distance).toBeLessThanOrEqual(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
