/**
 * at0307-transcript-file-path-links-chips.test.ts — a verified path is the
 * same link from two more sources in the transcript:
 *
 *  - **a directory chip**, which used to render as an object the transcript
 *    showed and refused to act on.
 *  - **a Bash tool header**, React-rendered rather than markdown, with the
 *    path *inside* a longer command line, so it needed both the non-markdown
 *    entry point and matching a run rather than a whole element. Its `cd`
 *    target is a directory, which the loosened stat reports as reachable and
 *    the pass marks with the folder gesture rather than the file one.
 *
 * One piece of the at0307 split; the constants, frame builders and gestures
 * are `transcript-file-path-links-fixture.ts`. These two cases left
 * `at0307-transcript-file-path-links-surfaces.test.ts` so neither file
 * crosses the 20 s file budget.
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
  MISSING_NAME,
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
let missingPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0307-paths-"));
  realPath = join(projectDir, FILE_NAME);
  missingPath = join(projectDir, MISSING_NAME);
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
      "a directory chip is not inert — it carries the annotation its type earns",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-dir",
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

          // A `@`-mention whose value ends in `/` replays as a directory
          // atom. It used to render as a chip with nothing behind it —
          // an object the transcript showed and refused to act on.
          await ingest(replayStarted());
          await ingest(userMsg(`look in \`@${projectDir}/\``));
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          const CHIP = '[data-card-id="A"] [data-tug-annotation="directory"]';
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('${CHIP}') !== null`,
            { timeoutMs: 8000 },
          );
          const chip = JSON.parse(
            await app.body("A").evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector('${CHIP}');
              return {
                path: el.getAttribute('data-path'),
                annotated: el.classList.contains('tugx-annotation'),
                focus: el.getAttribute('data-tug-focus'),
                noActivate: el.hasAttribute('data-no-activate'),
              };
            })())`),
          ) as Record<string, unknown>;
          // The payload is a path, so the index form's trailing separator
          // is gone.
          expect(chip.path).toBe(projectDir);
          expect(chip.annotated).toBe(true);
          expect(chip.focus).toBe("refuse");
          expect(chip.noActivate).toBe(true);

          // The click is deliberately not driven here: it hands the path
          // to the Finder, and an app-test that opens Finder windows is a
          // test that fights the machine it runs on.

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
      "a path inside a Bash command line is annotated where it sits",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-bash",
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

          // The header is React-rendered, not markdown, and the path is a
          // fragment of a longer command line. Both were reasons the
          // annotator used to miss it: it only ran over rendered markdown,
          // and it only ever matched a whole element.
          // A `cd` target is a directory, and a directory is a real thing
          // to point at — the stat behind this asks whether anything is
          // there, not whether it is a regular file.
          const commandLine = `cd ${projectDir} && wc -l ${realPath} ${missingPath}`;
          await ingest(replayStarted());
          await ingest(userMsg("count them"));
          await ingest({
            type: "tool_use",
            tug_session_id: SID,
            msg_id: "m1",
            tool_use_id: "tc-b1",
            tool_name: "Bash",
            input: { command: commandLine },
            seq: 1,
          });
          await ingest({
            type: "tool_result",
            is_error: false,
            tug_session_id: SID,
            tool_use_id: "tc-b1",
            output: "5 total",
          });
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          const COMMAND =
            '[data-card-id="A"] [data-slot="bash-tool-block-command"]';
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('${COMMAND}') !== null`,
            { timeoutMs: 8000 },
          );

          // The run that names a real file becomes its own annotated span
          // inside the command; the run naming a missing sibling does not,
          // so verification still gates the affordance one fragment at a
          // time rather than for the header as a whole.
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('${COMMAND} [data-tug-annotation="file-path"]') !== null`,
            { timeoutMs: 8000 },
          );
          const marks = JSON.parse(
            await app.body("A").evalJS<string>(`JSON.stringify((function(){
              var host = document.querySelector('${COMMAND}');
              if (!host) return { found: false };
              var spans = Array.from(
                host.querySelectorAll('[data-tug-annotation="file-path"]'));
              var dirs = Array.from(
                host.querySelectorAll('[data-tug-annotation="directory"]'));
              return {
                found: true,
                count: spans.length,
                text: spans.map(function(s){ return s.textContent; }),
                paths: spans.map(function(s){ return s.getAttribute('data-path'); }),
                dirText: dirs.map(function(s){ return s.textContent; }),
                wrapped: spans.concat(dirs).every(function(s){
                  return s.hasAttribute('data-tugx-wrapped');
                }),
                // The command line itself is intact — splitting the runs
                // out must not disturb the text around them.
                whole: (host.textContent || ''),
              };
            })())`),
          ) as {
            found: boolean;
            count: number;
            text: string[];
            paths: (string | null)[];
            dirText: string[];
            wrapped: boolean;
            whole: string;
          };
          expect(marks.found).toBe(true);
          expect(marks.count).toBe(1);
          expect(marks.text).toEqual([realPath]);
          expect(marks.paths[0]?.endsWith(`/${FILE_NAME}`)).toBe(true);
          // The `cd` target resolves as a directory, not a file: same
          // reference shape in ink, different gesture, and only the
          // filesystem knows which.
          expect(marks.dirText).toEqual([projectDir]);
          expect(marks.wrapped).toBe(true);
          expect(marks.whole).toBe(commandLine);

          // And it opens, through the same delegated layer every other
          // annotation uses.
          await app.body("A").click(`${COMMAND} [data-tug-annotation="file-path"]`);
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
  },
);
