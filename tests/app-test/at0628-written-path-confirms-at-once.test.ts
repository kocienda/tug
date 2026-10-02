/**
 * at0628-written-path-confirms-at-once.test.ts — a hand-off line printed in
 * the same turn that wrote the file it names is live immediately.
 *
 * This is [F23]'s shape, end to end against the real app. A brief-writing
 * turn names its path in a `Write` tool block, the annotator probes that path
 * *then* — before the bytes are on disk — and records `missing`. The verdict
 * is trusted for a minute, so the path stays plain ink for a minute over a
 * file that is really there.
 *
 * The repair is the resolver's third door. A live `Write` or `Edit` result,
 * and a `TUG-FILE-RECEIPT` on a shell result, are the session's own word that
 * a file landed, and the transcript hands those paths to the store as
 * confirmed rather than waiting out the retry. So:
 *
 *   1. The hand-off renders and the resolver answers `missing` — the brief is
 *      genuinely not on disk, so its path is not a link. The Run rows are live
 *      regardless: an offered run is never dimmed over its arguments.
 *   2. A live turn lands a `Write` naming that same path.
 *   3. The brief's path becomes a link at once, not a minute later.
 *
 * **The file is never created on disk, deliberately.** That is what makes the
 * assertion discriminating: nothing but the tool result can account for the
 * link appearing, so a green run cannot be a probe that happened to land or
 * a filesystem frame that happened to arrive. What is under test is that the
 * deck takes its own tool's word for a write it watched happen.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/annotator/written-paths.ts
 * @covers tugdeck/src/lib/annotator/path-resolution.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/lib/code-session-store/effects.ts
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/components/tugways/use-annotation-menu.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

const CMD = "arc";
const SPAN = `[data-card-id="A"] code.tugx-annotation[data-slash-command="${CMD}"]`;

let projectDir = "";
/**
 * The path the hand-off line names, absolute.
 *
 * Absolute rather than cwd-relative so the reading under test is the
 * resolver's and only the resolver's: a relative candidate is parked until
 * the session handshake's cwd lands, and a row that read live because
 * nothing had been asked yet would pass this test for the wrong reason.
 *
 * Short, and under `/tmp` rather than the platform temp dir, for a reason
 * the card can see: the command line renders as one inline span, and a span
 * long enough to wrap has a bounding box whose centre falls between its line
 * boxes — where a right-click lands on the paragraph rather than on the
 * annotation, and no menu opens at all.
 */
let briefPath = "";
/** A file that exists, in the same prose and so in the same probe batch. */
let sentinelPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // No `briefs/` and no file in it: the resolver's honest answer is `missing`,
  // and the only thing that can move it is the write the session reports.
  projectDir = mkdtempSync("/tmp/at0628-");
  briefPath = join(projectDir, "b.md");
  // A file that IS there, named in the same prose as the brief. It is the
  // test's clock: one probe batch carries both paths, so the sentinel
  // becoming a link is the proof that the brief's `missing` is recorded.
  sentinelPath = join(projectDir, "s.md");
  writeFileSync(sentinelPath, "# here\n");
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

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

const capabilities = (commands: string[]) => ({
  type: "session_capabilities",
  models: [{ value: "default", displayName: "Default" }],
  commands,
  agents: [],
  available_output_styles: [],
  output_style: "default",
  account: null,
  effort: null,
  ipc_version: 2,
});

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
  seq: 0,
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

type App = Awaited<ReturnType<typeof launchTugApp>>;
type Row = { action: string; disabled: boolean };

/** How many paths in card A's prose the resolver has confirmed into links. */
async function fileLinkCount(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll('[data-card-id="A"] [data-tug-annotation="file-path"]').length`,
  );
}

/** Right-click the command line, read every menu row, and dismiss the menu. */
async function readMenuRows(app: App): Promise<Row[]> {
  await app.evalJS(
    `(() => { const el = document.querySelector(${JSON.stringify(SPAN)}); if (el) el.scrollIntoView({ block: "center" }); return !!el; })()`,
  );
  await app.nativeRightClickAtElement(SPAN);
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-item-action="copy-command"]') !== null`,
    { timeoutMs: 6000 },
  );
  const rows = JSON.parse(
    await app.evalJS<string>(
      `JSON.stringify(Array.from(document.querySelectorAll('[data-item-action]')).map(function(el){
        return {
          action: el.getAttribute('data-item-action'),
          disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
        };
      }))`,
    ),
  ) as Row[];
  await app.nativeKey("Escape");
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-item-action="copy-command"]') === null`,
    { timeoutMs: 6000 },
  );
  return rows;
}

const runRows = (rows: Row[]): Row[] =>
  rows.filter(
    (r) =>
      r.action === "run-command-here" ||
      r.action === "run-command-in-new-session",
  );

describe.skipIf(!SHOULD_RUN)("AT0628: a write the session watched", () => {
  test(
    "the Run rows come back the moment the write is reported, not a minute later",
    async () => {
      const app = await launchTugApp({
        testName: "at0628-written-path-confirms-at-once",
      });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded,
        });

      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          sessionMode: "resume",
          projectDir,
        });
        await app.ingestSessionMetadata("A", capabilities([CMD]));

        // --- 1. The hand-off line, over a file that is not there ---------
        await ingest(replayStarted());
        await ingest(userMsg("write a brief"));
        await ingest(
          asstText(
            "m1",
            `Wrote \`${briefPath}\` beside \`${sentinelPath}\`.\n\n` +
              `\`/${CMD} a @${briefPath}\``,
          ),
        );
        await ingest(turnDone("m1"));
        await ingest(replayComplete());
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SPAN)}) !== null`,
          { timeoutMs: 10_000 },
        );

        // The verdict arrives over the wire, and the menu reads whatever is
        // held the moment it opens — so wait for the answer before opening
        // one. The sentinel is the wait: it is in the same prose, so it is in
        // the same debounced probe batch, and its becoming a link is the
        // batch having come back. The brief's `missing` was recorded by the
        // same response.
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-card-id="A"] [data-tug-annotation="file-path"]') !== null`,
          { timeoutMs: 15_000 },
        );
        expect(await fileLinkCount(app)).toBe(1);
        const before = runRows(await readMenuRows(app));
        expect(before.map((r) => r.disabled)).toEqual([false, false]);

        // --- 2. A live turn writes the file ------------------------------
        // `send` opens a live turn — the `tool_result` below is then a live
        // result rather than a replayed one, which is the whole difference:
        // a replayed write is a claim about a moment that has passed.
        await app.driveSession("A", { op: "send", text: "write it" });
        await ingest({
          type: "tool_use",
          tug_session_id: SID,
          msg_id: "m2",
          tool_use_id: "tc-w1",
          tool_name: "Write",
          input: { file_path: briefPath, content: "# A thing\n" },
          seq: 0,
        });
        await ingest({
          type: "tool_result",
          tug_session_id: SID,
          tool_use_id: "tc-w1",
          output: `File created successfully at: ${briefPath}`,
        });
        await ingest(turnDone("m2"));

        // --- 3. The brief's path is a link now, and the rows still live ---
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('[data-card-id="A"] [data-tug-annotation="file-path"]').length >= 2`,
          { timeoutMs: 5_000 },
        );
        const live = runRows(await readMenuRows(app));
        expect(live.length).toBe(2);
        expect(live.map((r) => r.disabled)).toEqual([false, false]);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0628] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
