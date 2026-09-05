/**
 * at0106-compact-boundary-divider.test.ts — the session-card transcript shows
 * a soft compaction divider when claude auto-compacts mid-turn ([AT0106]).
 *
 * ## Why this exists
 *
 * Claude compacts its context — at capacity (auto) or on a native
 * `/compact` dispatched over the stream-json bridge — and emits a
 * `system`/`compact_boundary`. The session card mirrors it as a single
 * session-meta bar — a set-off marker at the compaction point. The recap
 * itself rides a dedicated `compact_summary` frame into the bar's body
 * (see at0193); this test covers the marker live.
 * The pure halves (`compactionNoteText`, the reducer's
 * `handleCompactBoundary`) are unit-tested; the tugcode emit is covered
 * in `tugcode/src/__tests__/session.test.ts`. This drives the **live
 * render**: open a turn, inject a synthetic `compact_boundary` through the
 * store's real `frameToEvent → dispatch` path, and assert the divider.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/compaction-progress-store.ts
 * @covers tugdeck/src/lib/compaction-request.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/session-boundary.tsx
 * @covers tugdeck/src/components/tugways/cards/session-compaction-entry.tsx
 * @covers tugcode/
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const DIVIDER = '[data-boundary="compaction"]';
// The compaction point renders ONE session-meta bar (event + trailing token
// count) inside the boundary; assert its combined header text.
const DIVIDER_LABEL = `${DIVIDER} [data-slot="session-boundary-bar"]`;
const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const TUG_SESSION_ID = "test-session-A"; // bindSession default

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0106-compact-"));
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
        size: { width: 820, height: 620 },
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

describe.skipIf(!SHOULD_RUN)(
  "AT0106: compaction divider renders for an auto-compaction boundary",
  () => {
    test(
      "a mid-turn compact_boundary appends a soft divider with the token count",
      async () => {
        const app = await launchTugApp({ testName: "at0106-compact-boundary-divider" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            // Generous: a cold single-file run pays the tugdeck Vite
            // first-compile cost, which exceeds the 10s default.
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          // Open a turn so there is an active turn for the boundary to
          // attach to (auto-compaction fires mid-turn). No backend
          // response flows in stub mode — the active turn stays in flight.
          await app.driveSession("A", { op: "send", text: "do a long thing", atoms: [] });

          // Inject a synthetic compact_boundary through the store's real
          // frameToEvent → dispatch path.
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "compact_boundary",
              tug_session_id: TUG_SESSION_ID,
              trigger: "auto",
              pre_tokens: 48000,
            },
          });

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DIVIDER)}) !== null`,
            { timeoutMs: 6000 },
          );
          const label = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(DIVIDER_LABEL)})||{}).textContent || ""`,
          );
          // Bar header label + trailing token count, concatenated in the DOM.
          expect(label).toContain("Session compacted");
          expect(label).toContain("48k tokens");

          // A compaction-only turn stands OUTSIDE the assistant attribution —
          // the marker bar has no `.tug-transcript-entry` ancestor (no
          // `Opus …` / `#a` header, per the session-meta treatment).
          const attributed = await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(DIVIDER)}).closest(".tug-transcript-entry") !== null`,
          );
          expect(attributed).toBe(false);

          // …and it lands at the transcript's own edge, the seat every
          // boundary takes. The comparison is against a neighbouring entry's
          // left, which is where a speaker's row begins: a boundary belongs to
          // the transcript rather than to a column inside one.
          const edge = await app.evalJS<number | null>(
            `(() => {
               const b = document.querySelector(${JSON.stringify(DIVIDER)});
               const entry = document.querySelector(".session-card-transcript .tug-transcript-entry");
               if (b === null || entry === null) return null;
               return Math.round(
                 b.getBoundingClientRect().left - entry.getBoundingClientRect().left,
               );
             })()`,
          );
          note(`at0106 boundary edge offset: ${JSON.stringify(edge)}`);
          expect(edge).not.toBeNull();
          expect(Math.abs(edge ?? 99)).toBeLessThanOrEqual(1);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0106] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
