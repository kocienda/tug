/**
 * at0459-transcript-commit-mention.test.ts — a confirmed sha in transcript
 * prose wears its label, and a later delta does not strip it.
 *
 * A commit sha the resolver confirms is displayed as `commit:<8ch>` wherever
 * it was written (`tuglaws/entity-presentation.md`). The annotator can only
 * mark the run; the label is written by a React portal that mounts into the
 * marked span, and the portal only learns a span exists when the markdown
 * block *announces* its annotation pass through `onAnnotated`.
 *
 * That announcement had one hole, and it was the ordinary case rather than a
 * corner: the streaming reconciler re-renders a block on every delta and
 * re-marks the DOM it builds, but said nothing. The late-arrival effect could
 * not cover for it — its verdict-batch re-mark fires only when a batch names
 * a verdict key the container consulted, and a delta that lands *after* the
 * verdict settles has already met the settled answer. The run ended up marked
 * with nothing listening: underlined and clickable in the transcript, still
 * spelling the raw hash the assistant typed, for the life of the app.
 *
 * So the shape here is two frames, not one:
 *
 *   1. prose citing this repository's HEAD as prose actually cites it — a
 *      backticked short sha, longer than the eight characters the label
 *      shows. The label replaces it once the verdict lands.
 *   2. a second delta appending a sentence, which rebuilds the paragraph.
 *      The label must still be there. Before the fix it reverted to the
 *      written characters and never came back.
 *
 * The second frame is what makes this a streaming test: the appended
 * sentence is waited on directly, so a run where the reconciler never fires
 * fails here rather than passing vacuously on the first frame's assertion.
 *
 * Driven against this checkout, whose HEAD is a sha the app's own git feed
 * can confirm — the same footing at0365 and at0239 stand on.
 *
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/commit-tip-portals.tsx
 * @covers tugdeck/src/components/tugways/tug-commit-atom.tsx
 * @covers tugdeck/src/components/tugways/annotation-portals.tsx
 * @covers tugdeck/src/lib/annotator/commit-resolution.ts
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

/** This repository — the app-test bootstrap workspace, and a real git repo. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO_ROOT })
  .toString()
  .trim();

/** The short form prose uses — deliberately NOT the label's eight. */
const WRITTEN_SHA = HEAD_SHA.slice(0, 9);

/** What the reader must end up seeing, whatever the prose spelled. */
const LABEL = `commit:${HEAD_SHA.slice(0, 8)}`;

const FIRST = `Step 9 landed as \`${WRITTEN_SHA}\`.`;
const SECOND = " Opening step 10 — the mini gauge.";

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
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

const userMsg = (text: string) => ({
  type: "add_user_message",
  tug_session_id: SID,
  content: [{ type: "text", text }],
});
const asstText = (msgId: string, text: string) => ({
  type: "assistant_text",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq: 1,
});
const turnDone = (msgId: string) => ({
  type: "turn_complete",
  tug_session_id: SID,
  msg_id: msgId,
  result: "success",
});
const replayStarted = () => ({ type: "replay_started", tug_session_id: SID });
const replayComplete = () => ({
  type: "replay_complete",
  tug_session_id: SID,
  count: 1,
  firstLoadedTurnIndex: 0,
  totalTurns: 1,
  hasOlder: false,
});
const asstDelta = (msgId: string, text: string, rev: number) => ({
  type: "assistant_text",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  // Partial, so the store APPENDS — which is what makes the second frame a
  // delta over a rendered block rather than a fresh row.
  is_partial: true,
  rev,
  seq: 0,
});

/** The marked commit run's state: what it says, and what it remembers. */
const RUN_STATE_JS = `JSON.stringify((function(){
  var el = document.querySelector(
    '[data-card-id="A"] .session-card-transcript-code-body [data-tug-annotation="commit-sha"]');
  if (!el) return { found: false };
  return {
    found: true,
    text: (el.textContent || "").trim(),
    sha: el.getAttribute("data-sha"),
    written: el.getAttribute("data-tugx-commit-text"),
  };
})())`;

describe.skipIf(!SHOULD_RUN)(
  "AT0459: a confirmed commit sha in transcript prose wears its label",
  () => {
    test(
      "the label replaces the written sha, and survives the next delta",
      async () => {
        const app = await launchTugApp({
          testName: "at0459-transcript-commit-mention",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });
        const readRun = async () =>
          JSON.parse(await app.evalJS<string>(RUN_STATE_JS)) as {
            found: boolean;
            text?: string;
            sha?: string | null;
            written?: string | null;
          };

        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          // The binding is what gives the annotator a commit root: this
          // repository, where the sha resolves.
          await app.bindSession("A", {
            tugSessionId: SID,
            projectDir: REPO_ROOT,
            sessionMode: "resume",
          });

          // A card bound to a session stands behind its restore veil until a
          // replay bracket closes; one committed turn is the cheapest way to
          // raise it and get at the live transcript underneath.
          await ingest(replayStarted());
          await ingest(userMsg("hello"));
          await ingest(asstText("m0", "Ready."));
          await ingest(turnDone("m0"));
          await ingest(replayComplete());

          // A live turn, not a replay bracket: the row has to be on screen
          // BEFORE the second delta arrives, which is the whole point.
          await app.driveSession("A", {
            op: "send",
            text: "how did step 9 go",
          });
          await ingest(asstDelta("m1", FIRST, 0));

          // The prose paints first; the verdict is a round trip to the git
          // feed, so the label is waited for rather than read.
          await app.waitForCondition<boolean>(
            `(document.querySelector('[data-card-id="A"]')?.textContent || "").indexOf("Step 9 landed") !== -1`,
            { timeoutMs: 10_000 },
          );

          // The label is
          // waited for rather than read.
          await app.waitForCondition<boolean>(
            `JSON.parse(${RUN_STATE_JS}).text === ${JSON.stringify(LABEL)}`,
            { timeoutMs: 15_000 },
          );
          const labelled = await readRun();
          note("at0459 after first frame", JSON.stringify(labelled));
          // The written characters are kept for the re-scan and unwrap paths
          // even though nobody reads them off the screen any more.
          expect(labelled.written).toBe(WRITTEN_SHA);
          expect(labelled.sha).toBe(WRITTEN_SHA);

          // --- the delta that used to strip it -------------------------
          await ingest(asstDelta("m1", SECOND, 1));
          await app.waitForCondition<boolean>(
            `(document.querySelector('[data-card-id="A"]')?.textContent || "").indexOf("Opening step 10") !== -1`,
            { timeoutMs: 15_000 },
          );

          // Waited for, not read: the portal refills the span it emptied on
          // the next React commit, so the settled state is the contract and a
          // read taken between the two catches a frame nobody sees. A run
          // that never gets its label back times out here, which is the
          // regression this test exists for.
          await app.waitForCondition<boolean>(
            `JSON.parse(${RUN_STATE_JS}).text === ${JSON.stringify(LABEL)}`,
            { timeoutMs: 15_000 },
          );
          const after = await readRun();
          note("at0459 after delta", JSON.stringify(after));
          expect(after.found).toBe(true);
          expect(after.written).toBe(WRITTEN_SHA);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0459] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
