/**
 * at0411-atom-chip-label-survives-annotator.test.ts — an atom chip keeps its
 * label after the annotator has run over the ink around it.
 *
 * ## The regression this pins
 *
 * A submitted prompt renders as markdown with its atom chips portalled back
 * in at their `U+FFFC` positions. A chip is an inline `<svg>`: a rect, a
 * glyph, and a `<text>` holding the label, at a width the renderer measured
 * that label at.
 *
 * The content annotator's text scan walked into that `<svg>`. It found the
 * label, the resolver confirmed the file, and the run was wrapped in an HTML
 * `<span>`: a foreign-namespace element inside an SVG, which paints nothing.
 * The chip kept its measured width and lost every character in it. An empty
 * atom. What keeps the scan out is the namespace rule in `collectTextNodes`
 * — a drawing is not prose — and nothing else: the mention here carries a
 * *relative* value (that is what `@`-completion mints), so this is also the
 * chip whose host the payload layer once refused to annotate at all.
 *
 * ## Shape
 *
 *   1. A real file at a real relative path inside a temp project, and a
 *      session whose `cwd` is that project — so the resolver can confirm.
 *   2. Replay one user turn that names the file twice: once as a mention
 *      marker (which renders as the chip) and once as bare prose. The prose
 *      reference is what makes the body await a verdict, and awaiting one is
 *      what brings the pass back after the chips have been grafted in — the
 *      only moment at which the scan can reach a chip at all.
 *   3. Wait on that prose run: it becomes a wrapped, annotated span. That is
 *      proof the verdict landed and the wrapping pass ran a second time —
 *      without it a green result would only mean the annotator never got an
 *      answer.
 *   4. Assert the chip's `<text>` still holds its characters directly: the
 *      label verbatim, and NO element children. Wrapping leaves `textContent`
 *      intact (the span holds the same characters), so the element count is
 *      the assertion that separates painted text from invisible text.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/annotator/wrap-matches.ts
 * @covers tugdeck/src/lib/annotator/annotate-content.ts
 * @covers tugdeck/src/components/tugways/cards/tug-atom-markdown-body.tsx
 * @covers tugdeck/src/lib/tug-atom-chip.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A";

/** The mention's value: relative, which is the shape `@`-completion mints. */
const REL_PATH = "docs/notes.md";

/** The wire form of that mention: the value wrapped as a backtick-`@` marker. */
const MENTION = "`@" + REL_PATH + "`";

const CHIP_TEXT =
  '[data-card-id="A"] [data-slot="tug-atom-markdown-body"] .tug-atom-chip-host svg text';
const WRAPPED_PROSE =
  `[data-card-id="A"] [data-tugx-wrapped][data-tug-annotation="file-path"]`;

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0411-atom-label-"));
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, REL_PATH), "alpha\nbravo\n", "utf8");
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

/** What the chip's `<text>` element actually holds. */
interface ChipLabel {
  /** Every character under the element, wrapped or not. */
  text: string;
  /** Element children — one or more means the run was split and wrapped. */
  elements: number;
  /** Width the chip was measured at, in px. */
  width: number;
}

describe.skipIf(!SHOULD_RUN)("AT0411: the annotator leaves a chip's label alone", () => {
  test(
    "a chip naming a confirmed relative path still shows its label",
    async () => {
      const app = await launchTugApp({
        testName: "at0411-atom-chip-label",
      });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded,
        });

      try {
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_SHORT), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", { tugSessionId: SID, sessionMode: "resume" });
        // The cwd a relative reference is resolved against.
        await app.ingestSessionMetadata("A", {
          type: "system_metadata",
          cwd: projectDir,
          ipc_version: 2,
        });

        await ingest({ type: "replay_started", tug_session_id: SID });
        await ingest({
          type: "add_user_message",
          tug_session_id: SID,
          // Two references to the same file in one turn, which is what puts
          // the chip in the scan's way:
          //
          //  - `MENTION` is the wire form of an `@`-mention atom — the value
          //    wrapped as a backtick-`@` marker, which the synthesizer
          //    re-mints as a chip. Its value is relative, so the chip's host
          //    carries no annotation of its own.
          //  - the bare path in the prose is unresolved on the first pass, so
          //    the body is flagged as awaiting a verdict. That flag is what
          //    brings the pass BACK — and by then the chips are grafted in,
          //    which is the only moment the scan can reach one.
          //
          // The prose reference is also the control (see below).
          content: [
            { type: "text", text: `look at ${MENTION} — the file is ${REL_PATH}` },
          ],
        });
        await ingest({
          type: "assistant_text",
          status: "complete",
          tug_session_id: SID,
          msg_id: "m1",
          text: "Reading it now.",
          is_partial: false,
          rev: 0,
          seq: 1,
        });
        await ingest({
          type: "turn_complete",
          seq: 0,
          tug_session_id: SID,
          msg_id: "m1",
          result: "success",
        });
        await ingest({
          type: "replay_complete",
          tug_session_id: SID,
          count: 1,
          firstLoadedTurnIndex: 0,
          totalTurns: 1,
          hasOlder: false,
        });

        // The chip is there before any verdict is.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP_TEXT)}) !== null`,
          { timeoutMs: 15_000 },
        );

        // The control: the prose run is wrapped and marked, so the filesystem
        // confirmed the path and the wrapping pass has run over this
        // transcript. Only now does the chip's state mean anything.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(WRAPPED_PROSE)}) !== null`,
          { timeoutMs: 20_000 },
        );

        const label = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify((function(){
              var t = document.querySelector(${JSON.stringify(CHIP_TEXT)});
              if (t === null) return null;
              var svg = t.ownerSVGElement;
              return {
                text: t.textContent || "",
                elements: t.children.length,
                width: svg === null ? 0 : svg.getBoundingClientRect().width,
              };
            })())`,
          ),
        ) as ChipLabel | null;

        expect(label).not.toBeNull();
        // The label reads as the value the user mentioned...
        expect(label?.text).toBe(REL_PATH);
        // ...and it is still the `<text>` element's own characters. A wrapped
        // run reads the same here and paints nothing.
        expect(
          label?.elements,
          "the chip's label must not be split into a wrapper element",
        ).toBe(0);
        // A chip wide enough to have been measured at that label — the empty
        // atom kept its width, so this is a floor, not the assertion.
        expect(label?.width ?? 0).toBeGreaterThan(30);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0411] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
