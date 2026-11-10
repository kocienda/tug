/**
 * at0307-transcript-file-path-links-surfaces.test.ts — a verified file path
 * is the same link wherever in the transcript it comes from.
 *
 * One piece of the at0307 split; the constants, frame builders and gestures
 * are `transcript-file-path-links-fixture.ts`. One test per source the same
 * annotation comes from, because each was a distinct way the annotator used
 * to miss:
 *
 *  - **a tool-call header's file ref** — born confirmed (the tool just
 *    touched the file) and owning no handlers of its own; the delegated layer
 *    services it exactly as it services prose, and it wears the same resting
 *    rule a mention wears — on its label, so the leading glyph takes no line.
 *  - **a Glob result row** — the same annotation from a third source, cashing
 *    in the "make rows interactive" deferral `PathListBlock`'s docstring
 *    carried.
 *  - **a subagent's own prose**, which was skipped wholesale: markdown nested
 *    several components below the transcript cell. It also pins the whole
 *    path matching as one run — link detection splits a text node at a
 *    filename whose extension is a top-level domain (`.md` is Moldova's),
 *    and a half-scanned path reads as its own parent directory.
 *
 * A directory chip and a Bash tool header are the same claim again, in
 * `at0307-transcript-file-path-links-chips.test.ts`, split out so neither
 * file crosses the 20 s file budget.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/annotator/
 * @covers tugdeck/src/lib/open-file-in-card.ts
 * @covers tugdeck/src/components/tugways/tug-editor-context-menu.tsx
 * @covers tugdeck/src/components/tugways/annotation-scope.tsx
 * @covers tugdeck/src/components/tugways/annotation-portals.tsx
 * @covers tugdeck/src/components/tugways/commit-tip-portals.tsx
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 * @covers tugdeck/src/components/tugways/tug-atom-ref.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/path-list-block.tsx
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 * @covers tugdeck/src/components/tugways/cards/tug-atom-text-body.tsx
 * @covers tugdeck/src/components/tugways/cards/tug-atom-markdown-body.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/agent-transcript-block.tsx
 * @covers tugrust/crates/tugcast/src/fs_stat.rs
 * @family at0307-transcript-file-path-links
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";
import {
  CODE_OUTPUT_FEED,
  FILE_BODY,
  FILE_NAME,
  replayComplete,
  replayStarted,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  turnDone,
  userMsg,
} from "./transcript-file-path-links-fixture";

let projectDir = "";
let realPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0307-paths-"));
  realPath = join(projectDir, FILE_NAME);
  writeFileSync(realPath, FILE_BODY, "utf8");
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});


describe.skipIf(!SHOULD_RUN)(
  "AT0307: verified file paths in transcript prose become links",
  () => {
    test(
      "a tool header's file ref is the same annotation, serviced by the same layer",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-header",
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
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
          });

          await ingest(replayStarted());
          await ingest(userMsg("read it"));
          await ingest({
            type: "tool_use",
            tug_session_id: SID,
            msg_id: "m1",
            tool_use_id: "tc-1",
            tool_name: "Read",
            input: { file_path: realPath },
            seq: 1,
          });
          await ingest({
            type: "tool_result",
            is_error: false,
            tug_session_id: SID,
            tool_use_id: "tc-1",
            output: FILE_BODY,
          });
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          // The header ref is born confirmed — the tool just read this
          // file — so it carries the annotation immediately, with no
          // probe and nothing to wait for.
          const HEADER_REF = '[data-card-id="A"] [data-slot="read-tool-block-path"]';
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('${HEADER_REF}') !== null`,
            { timeoutMs: 8000 },
          );
          const ref = JSON.parse(
            await app.body("A").evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector('${HEADER_REF}');
              if (!el) return { found: false };
              return {
                found: true,
                kind: el.getAttribute('data-tug-annotation'),
                path: el.getAttribute('data-path'),
                annotated: el.classList.contains('tugx-annotation'),
                focus: el.getAttribute('data-tug-focus'),
                noActivate: el.hasAttribute('data-no-activate'),
              };
            })())`),
          ) as Record<string, unknown>;
          expect(ref.kind).toBe("file-path");
          expect(ref.annotated).toBe(true);
          expect(ref.path).toBe(realPath);
          expect(ref.focus).toBe("refuse");
          expect(ref.noActivate).toBe(true);

          // And it wears the same resting rule a confirmed mention wears
          // in prose — the whole point of one declaration keyed on the
          // contract. The rule sits on the LABEL, not on the skin: a
          // decoration on the skin would paint across the leading glyph
          // too, and an atom's mark is its name.
          const decoration = (selector: string) =>
            app.body("A").evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector(${JSON.stringify(selector)});
              if (el === null) return null;
              var s = getComputedStyle(el);
              return { line: s.textDecorationLine, thickness: s.textDecorationThickness, style: s.textDecorationStyle };
            })())`);
          const labelRule = JSON.parse(
            await decoration(`${HEADER_REF} .tug-atom-ref-label`),
          ) as { line: string; thickness: string; style: string };
          expect(labelRule.line).toBe("underline");
          expect(labelRule.thickness).toBe("1px");
          expect(labelRule.style).toBe("solid");
          const skinRule = JSON.parse(await decoration(HEADER_REF)) as {
            line: string;
          };
          expect(skinRule.line).toBe("none");

          // And the delegated layer — not any handler the component owns
          // — turns a click on it into an open.
          await app.body("A").click(HEADER_REF);
          // The Text card the click opened is its own body, not A's: its
          // editor is read in that card's page.
          await kindBody(app, "text").waitForCondition<boolean>(
            `(function(){
              var ed = document.querySelector('[data-slot="tug-text-card-editor"] .cm-content');
              return ed !== null && (ed.textContent || '').indexOf("charlie") !== -1;
            })()`,
            { timeoutMs: 12_000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a Glob result row opens the file it names",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-glob",
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
          await app.bindSession("A", { tugSessionId: SID });
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('[data-card-id="A"] [data-slot="session-telemetry-status-row"]') !== null`,
            { timeoutMs: 8000 },
          );

          // A live turn, not a replay: the tool call has to reach its
          // settled state for the block to render a body at all.
          await app.driveSession("A", { op: "send", text: "find it" });
          await ingest({
            type: "tool_use",
            msg_id: "m1",
            tool_use_id: "tc-g1",
            tool_name: "Glob",
            input: { pattern: "*.md", path: projectDir },
            seq: 1,
          });
          await ingest({
            type: "tool_result",
            is_error: false,
            tool_use_id: "tc-g1",
            output: realPath,
          });
          await ingest({
            type: "tool_use_structured",
            tool_use_id: "tc-g1",
            tool_name: "Glob",
            structured_result: {
              filenames: [realPath],
              numFiles: 1,
              truncated: false,
            },
          });
          await ingest({ type: "turn_complete", seq: 0, msg_id: "m1", result: "success" });

          // A Glob block mounts collapsed — its header is the whole block
          // until the disclosure is opened, so the rows are not in the DOM
          // yet.
          const GLOB = '[data-card-id="A"] [data-slot="glob-tool-block"]';
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('${GLOB}') !== null`,
            { timeoutMs: 8000 },
          );
          await app.body("A").click(`${GLOB} [data-slot="tool-call-header-disclosure"]`);

          const ROW = '[data-card-id="A"] [data-slot="path-list-row"]';
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('${ROW}') !== null`,
            { timeoutMs: 8000 },
          );
          const row = JSON.parse(
            await app.body("A").evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector('${ROW}');
              if (!el) return { found: false };
              return {
                found: true,
                kind: el.getAttribute('data-tug-annotation'),
                path: el.getAttribute('data-path'),
                annotated: el.classList.contains('tugx-annotation'),
              };
            })())`),
          ) as Record<string, unknown>;
          expect(row.kind).toBe("file-path");
          expect(row.annotated).toBe(true);
          expect(row.path).toBe(realPath);

          await app.body("A").click(ROW);
          // The Text card the click opened is its own body, not A's: its
          // editor is read in that card's page.
          await kindBody(app, "text").waitForCondition<boolean>(
            `(function(){
              var ed = document.querySelector('[data-slot="tug-text-card-editor"] .cm-content');
              return ed !== null && (ed.textContent || '').indexOf("charlie") !== -1;
            })()`,
            { timeoutMs: 12_000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a subagent's own prose is annotated like everyone else's",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-subagent",
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
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
          });

          // A subagent's answer is markdown nested several components
          // below the transcript cell. It was skipped wholesale, because
          // every intervening renderer would have had to forward a context
          // prop it does not otherwise care about — and none did.
          await ingest(replayStarted());
          await ingest(userMsg("go look"));
          await ingest({
            type: "tool_use",
            tug_session_id: SID,
            msg_id: "m1",
            tool_use_id: "tc-a1",
            tool_name: "Agent",
            input: { subagent_type: "Explore", description: "find it" },
            seq: 1,
          });
          await ingest({
            type: "tool_use_structured",
            tug_session_id: SID,
            tool_use_id: "tc-a1",
            tool_name: "Agent",
            structured_result: {
              agentType: "Explore",
              status: "completed",
              content: [
                {
                  type: "text",
                  text: `File: ${realPath}\n\nAlso see \`${realPath}\`.`,
                },
              ],
            },
          });
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          const AGENT_TEXT = `[data-card-id="A"] [data-slot="agent-transcript-text"]`;
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('${AGENT_TEXT}') !== null`,
            { timeoutMs: 10_000 },
          );
          await app.body("A").waitForCondition<boolean>(
            `document.querySelectorAll('${AGENT_TEXT} [data-tug-annotation="file-path"]').length === 2`,
            { timeoutMs: 15_000 },
          );
          const marks = JSON.parse(
            await app.body("A").evalJS<string>(`JSON.stringify((function(){
              var els = Array.from(document.querySelectorAll(
                '${AGENT_TEXT} [data-tug-annotation="file-path"]'));
              return {
                paths: els.map(function(e){ return e.getAttribute('data-path'); }),
                tags: els.map(function(e){ return e.tagName; }),
              };
            })())`),
          ) as { paths: (string | null)[]; tags: string[] };
          // Both forms resolve to the same file: the absolute path in
          // running prose (unmistakable, so prose keeps it) and the one
          // written as code. The prose one also proves the whole path is
          // matched as one run — link detection splits a text node at a
          // filename whose extension is a top-level domain (`.md` is
          // Moldova's), and a half-scanned path reads as its own parent
          // directory.
          expect(marks.paths.every((p) => p?.endsWith(`/${FILE_NAME}`))).toBe(
            true,
          );
          expect(marks.tags).toContain("CODE");
          expect(marks.tags).toContain("SPAN");

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0307] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
