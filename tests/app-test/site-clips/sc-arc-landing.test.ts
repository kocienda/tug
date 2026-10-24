/**
 * sc-arc-landing.test.ts — the site's arc-landing clip: an arc's join lands
 * in the transcript as one commit receipt with the `Joined` boundary beneath
 * it, under the stage the wheel had seated.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene is built the way the at0474 family builds theirs: one Session
 * card bound synthetically, a stage rotation ingested on the code feed so
 * the wheel's prompt and the stage divider stand in the transcript, a short
 * assistant turn closing the stage, and then — during the burst — the join
 * receipt appended as a settled `/arc-join` exchange (the shape at0419
 * drives), whose summary names this checkout's own `HEAD` so the receipt's
 * file rows are real. The capture is cropped to the transcript column.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { CODE_OUTPUT_FEED } from "../arc-run-transcript-fixture";
import { rectIn } from "../one-view-fixture";
import { RUNS, burstTo, contentSize, cropAround, launchForMode, outDirFor } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const CARD = "sc-landing";
const TUG_SESSION_ID = "sc-landing-session";
const ARC = "live-pictures";
const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';
const JOIN_BOUNDARY = '[data-boundary="join"]';
/** The directory the receipt's header names: a plain one, not this machine's checkout path. */
const SHOWN_CWD = "/Users/ken/src/tug-site";

/** Rest on the seated stage before the join lands, and the hold on the receipt. */
const REST_MS = 2_000;
const HOLD_MS = 4_500;

const STAGE_PROMPT = `/tugplug:arc-implement ${ARC} implement Step 11 and end the turn; it is the arc's last step`;
const CLOSING_TEXT =
  "Step 11 closed: the home page plays every behaviour it describes, in both modes, and the build gate is clean.";

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 720, height: 900 },
        cardIds: [CARD],
        activeCardId: CARD,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${CARD}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/**
 * The S01 join summary for a landing of this checkout's `HEAD`: the receipt's
 * file rows come from the summary's `files:` line, and a diff fetch for the
 * sha resolves against the app's own checkout, so a real sha is what keeps
 * the rows from expanding into a notice.
 */
function joinSummary(): { summary: string } {
  const repo = git(import.meta.dir, ["rev-parse", "--show-toplevel"]);
  const sha = git(repo, ["rev-parse", "HEAD"]);
  const base = git(repo, ["rev-parse", "HEAD~1"]);
  const files = git(repo, ["diff-tree", "--no-commit-id", "--root", "-r", "-M", "--numstat", sha])
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [added, removed, path] = l.split("\t");
      return { path, status: "modified", added: Number(added) || 0, removed: Number(removed) || 0 };
    });
  const summary =
    `joined ${sha.slice(0, 10)} · ${ARC} → main · 11 round(s)\n` +
    `fit: verified ${sha.slice(0, 10)} onto ${base.slice(0, 10)}\n` +
    `arc: opened on .tug/arcs/${ARC}/brief.md\n` +
    "arc: devise · opus · sess-devise\n" +
    "arc: review · opus · sess-review\n" +
    "arc: implement · opus · sess-implement\n" +
    "arc: audit · opus · sess-audit\n" +
    `files: ${JSON.stringify(files)}\n` +
    "Play the home page's pictures live in both modes";
  return { summary };
}

function ingest(app: App, decoded: Record<string, unknown>): Promise<unknown> {
  return app.driveSession(CARD, {
    op: "ingestFrame",
    feedId: CODE_OUTPUT_FEED,
    decoded: { tug_session_id: TUG_SESSION_ID, ipc_version: 2, ...decoded },
  });
}

describe.skipIf(!RUNS)("site clip: arc landing", () => {
  test(
    "records a join landing as a receipt beneath the stage that finished",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "sc-landing-project-")));
      onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
      const { summary } = joinSummary();
      const app = await launchForMode("sc-arc-landing", deck());
      try {
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD)})`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession(CARD, { tugSessionId: TUG_SESSION_ID, projectDir, workspaceKey: projectDir });
        await app.awaitEngineReady(CARD, { timeoutMs: 30_000 });

        // The stage the wheel seated, and the turn that closed it.
        await ingest(app, {
          type: "session_segment",
          kind: "rotation",
          parentSessionId: "claude-audit",
          newSessionId: "claude-implement",
          stage: "implement",
          model: "opus",
          document: `.tug/arcs/${ARC}/plan.md`,
          arc: ARC,
          prompt: STAGE_PROMPT,
        });
        await ingest(app, { type: "session_init", session_id: "claude-implement" });
        await ingest(app, { type: "content_block_start", msg_id: "m1", block_index: 0, kind: "text" });
        await ingest(app, {
          type: "assistant_text",
          msg_id: "m1",
          block_index: 0,
          seq: 1,
          rev: 0,
          text: CLOSING_TEXT,
          is_partial: false,
          status: "complete",
        });
        await ingest(app, { type: "turn_complete", msg_id: "m1", seq: 2, result: "success" });
        await app.body(CARD).waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(".tug-transcript-entry")).some((el) => (el.textContent || "").includes(${JSON.stringify(CLOSING_TEXT.slice(0, 20))}))`,
          { timeoutMs: 10_000 },
        );
        await Bun.sleep(800);

        const view = (await app.bodies()).find((b) => b.cardId === CARD)?.frame;
        expect(view, "the card's body is placed").toBeDefined();
        const scroller = await rectIn(app.body(CARD), SCROLLER);
        expect(scroller, "the transcript scroller is mounted").not.toBeNull();
        const column = { x: view!.x + scroller!.x, y: view!.y + scroller!.y, width: scroller!.width, height: scroller!.height };
        const crop = cropAround([column], 0, await contentSize(app));

        const reading = await burstTo(app, crop, REST_MS + HOLD_MS, outDirFor("arc-landing"), async () => {
          await Bun.sleep(REST_MS);
          await app.driveSession(CARD, {
            op: "shellExchange",
            exchangeId: "join-1",
            command: "/arc-join",
            output: summary,
            cwd: SHOWN_CWD,
            exitCode: 0,
            startedAtMs: Date.now(),
          });
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
        expect(
          await app.body(CARD).evalJS<boolean>(`document.querySelector(${JSON.stringify(JOIN_BOUNDARY)}) !== null`),
          "the join landed as a boundary",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
