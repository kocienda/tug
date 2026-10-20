/**
 * at0307-transcript-file-path-links-prose.test.ts — file paths in assistant
 * prose become links, but only the ones that are real.
 *
 * One piece of the at0307 split; the constants, frame builders and gestures
 * are `transcript-file-path-links-fixture.ts`.
 *
 * A path the assistant writes in backticks is inert text until the annotator
 * has asked the filesystem about it. This drives that whole round trip
 * against the real app and the real `POST /api/fs/stat`: two path-shaped
 * spans render, one naming a file that exists on disk and one naming a
 * sibling that does not, and only the first ever becomes clickable. That
 * asymmetry is the feature — a link that dead-ends is worse than plain text,
 * so verification, not grammar, is the gate. Then the payoff: clicking the
 * confirmed path opens it in a Text card, at the line the reference cited.
 *
 * Asserts:
 *  - **verification gates the affordance**: the existing path gains
 *    `data-tug-annotation="file-path"` + `data-path`; the missing one never
 *    does, however long we wait;
 *  - **the canonical path is what is stamped**, not the string as written
 *    (the endpoint resolves symlinks — on macOS the temp dir is one);
 *  - **focus discipline**: the annotation carries the attributes that stop a
 *    click from stealing the composer's caret;
 *  - **the click opens the file** in a Text card showing its content;
 *  - **Open in Editor**, the reference's own menu item, sends the same
 *    `open-file` command carrying the same target;
 *  - **a bare filename** with no path at all resolves through the project's
 *    file index — backticked, and unbackticked split out of the sentence —
 *    where it actually lives, nowhere near the root the name was resolved
 *    against;
 *  - **a cited line range** (`path:124-135`) opens the file at those lines;
 *    until the range parsed, the suffix rode along as part of the path and
 *    the reference resolved to nothing.
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
  activateMenuItem,
  asstText,
  CITED_LINE,
  CODE_OUTPUT_FEED,
  FILE_BODY,
  FILE_NAME,
  INDEXED_NAME,
  MISSING_NAME,
  openAnnotationMenu,
  replayComplete,
  replayStarted,
  REPO_ROOT,
  SHOULD_RUN,
  SID,
  spanStateJS,
  TEST_TIMEOUT_MS,
  turnDone,
  userMsg,
} from "./transcript-file-path-links-fixture";
import { restoreGateGone } from "./overlay-fixture";

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
      "only the path that exists becomes clickable, and clicking it opens the file",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });
        const readSpan = async (needle: string) =>
          JSON.parse(await app.body("A").evalJS<string>(spanStateJS(needle))) as {
            found: boolean;
            kind?: string | null;
            path?: string | null;
            line?: string | null;
            focus?: string | null;
            noActivate?: boolean;
          };

        // One span per case: an existing file with a line citation, and a
        // sibling that was never written.
        const citedSpan = `${realPath}:${CITED_LINE}`;
        const assistantText =
          `See \`${citedSpan}\` — but not \`${missingPath}\`.`;

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
          await ingest(userMsg("where is it"));
          await ingest(asstText("m1", assistantText, 1));
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          // Both spans render. Neither is actionable yet — nothing has
          // been asked of the filesystem at paint time.
          await app.body("A").waitForCondition<boolean>(
            `JSON.parse(${spanStateJS(citedSpan)}).found === true`,
            { timeoutMs: 8000 },
          );

          // --- verification confirms one and refuses the other ---------
          await app.body("A").waitForCondition<boolean>(
            `JSON.parse(${spanStateJS(citedSpan)}).kind === "file-path"`,
            { timeoutMs: 8000 },
          );
          const confirmed = await readSpan(citedSpan);
          // The stamped path is the endpoint's canonical form, so it may
          // differ from what was written (macOS resolves the temp dir
          // through /private) — what must hold is that it is absolute and
          // names the file.
          expect(confirmed.path?.startsWith("/")).toBe(true);
          expect(confirmed.path?.endsWith(`/${FILE_NAME}`)).toBe(true);
          expect(confirmed.line).toBe(String(CITED_LINE));
          // Focus discipline: a click here must not pull the caret out of
          // wherever the user is typing.
          expect(confirmed.focus).toBe("refuse");
          expect(confirmed.noActivate).toBe(true);

          const missing = await readSpan(missingPath);
          expect(missing.found).toBe(true);
          expect(missing.kind).toBeNull();
          expect(missing.path).toBeNull();

          // --- the click opens the file --------------------------------
          await app.body("A").click(
            `[data-card-id="A"] code[data-tug-annotation="file-path"]`,
          );
          // The file opens in a new Text card, in a body of its own.
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
      "the reference's Open in Editor menu item opens it too",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-menu",
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

          const HEADER_REF = '[data-card-id="A"] [data-slot="read-tool-block-path"]';
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('${HEADER_REF}') !== null`,
            { timeoutMs: 8000 },
          );

          // The item names what it acts on: its dispatch carries the
          // annotation's path as its own value, so it reaches the deck's
          // open-file handler rather than stopping at a surface that
          // would have had to supply the argument.
          await restoreGateGone(app);
          await openAnnotationMenu(app.body("A"), HEADER_REF, "open-file");
          await activateMenuItem(app.body("A"), "open-file");
          // The file opens in a new Text card, in a body of its own.
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
      "a bare filename in prose resolves through the project's file index",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-name",
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
          // Bound to this repository, which is the app-test bootstrap
          // workspace — so FILETREE answers about real files here.
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
            projectDir: REPO_ROOT,
            workspaceKey: REPO_ROOT,
          });

          // A bare filename with no path at all, written as code — the
          // form the corpus actually uses, and the one the grammar
          // trusts. `fs/stat` cannot answer it (a name says what to look
          // for, not where), so the whole case rests on the index.
          await ingest(replayStarted());
          await ingest(userMsg("which file"));
          await ingest(
            asstText("m1", `I changed \`${INDEXED_NAME}\` to match.`, 1),
          );
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          // The span is entirely one reference, so it is marked on the
          // `<code>` element it already has rather than split out.
          const MARK = `[data-card-id="A"] code[data-tug-annotation="file-path"]`;
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('${MARK}') !== null`,
            { timeoutMs: 20_000 },
          );
          const mark = JSON.parse(
            await app.body("A").evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector('${MARK}');
              return { text: el.textContent, path: el.getAttribute('data-path') };
            })())`),
          ) as { text: string; path: string | null };
          expect(mark.text).toBe(INDEXED_NAME);
          // The index knows where it actually lives, which is nowhere near
          // the repo root the name was resolved against.
          expect(mark.path).toBe(
            `${REPO_ROOT}/tugdeck/src/components/tugways/internal/${INDEXED_NAME}`,
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
      "the same bare filename marks unbackticked, split out of the sentence",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-bare",
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
            projectDir: REPO_ROOT,
            workspaceKey: REPO_ROOT,
          });

          // The same name as the case above, with the backticks taken
          // off. Whether the model reached for backticks decides the code
          // TONE and nothing else; the resolver is the only gate on the
          // mark, so this run has to come back marked exactly like its
          // backticked twin — split out of the sentence, since it is a run
          // inside a longer text node rather than its own element.
          await ingest(replayStarted());
          await ingest(userMsg("which file"));
          await ingest(asstText("m1", `I changed ${INDEXED_NAME} to match.`, 1));
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          const MARK = `[data-card-id="A"] span[data-tugx-wrapped][data-tug-annotation="file-path"]`;
          // The mark's own words come back one render after the mark does:
          // the file tip portals into the run, and hosting a portal means
          // emptying the span first (`file-tip-portals.tsx`). Waiting on the
          // element alone would read the empty host mid-flight.
          await app.body("A").waitForCondition<boolean>(
            `(function () {
              var el = document.querySelector('${MARK}');
              return el !== null && (el.textContent || "") !== "";
            })()`,
            { timeoutMs: 20_000 },
          );
          const mark = JSON.parse(
            await app.body("A").evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector('${MARK}');
              return {
                text: el.textContent,
                path: el.getAttribute('data-path'),
                inCode: el.closest('code') !== null,
              };
            })())`),
          ) as { text: string; path: string | null; inCode: boolean };
          expect(mark.text).toBe(INDEXED_NAME);
          expect(mark.path).toBe(
            `${REPO_ROOT}/tugdeck/src/components/tugways/internal/${INDEXED_NAME}`,
          );
          // Running prose, not a code span — this is the run the old
          // license refused.
          expect(mark.inCode).toBe(false);

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
      "a cited line range in prose opens the file at those lines",
      async () => {
        const app = await launchTugApp({
          testName: "at0307-transcript-file-path-links-range",
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

          // The shape prose uses to cite a function or a docstring. Before
          // the range was parsed, the `:124-135` suffix rode along as part
          // of the path, so the whole reference resolved to nothing and
          // sat inert — not merely line-less, entirely unmarked.
          await ingest(replayStarted());
          await ingest(userMsg("where is it"));
          await ingest(
            asstText("m1", `Model A (${realPath}:2-4) wires it.`, 1),
          );
          await ingest(turnDone("m1"));
          await ingest(replayComplete());

          const MARK = `[data-card-id="A"] [data-tug-annotation="file-path"]`;
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('${MARK}') !== null`,
            { timeoutMs: 15_000 },
          );
          const mark = JSON.parse(
            await app.body("A").evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector('${MARK}');
              return {
                text: el.textContent,
                path: el.getAttribute('data-path'),
                line: el.getAttribute('data-line'),
                endLine: el.getAttribute('data-end-line'),
              };
            })())`),
          ) as Record<string, unknown>;
          // The citation is inside the link and the parenthesis is not.
          expect(mark.text).toBe(`${realPath}:2-4`);
          expect(mark.path).toBe(`/private${realPath}`);
          expect(mark.line).toBe("2");
          expect(mark.endLine).toBe("4");

          // And the click lands on the cited lines, not merely the file.
          await app.body("A").click(MARK);
          // The file opens in a new Text card, in a body of its own.
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
