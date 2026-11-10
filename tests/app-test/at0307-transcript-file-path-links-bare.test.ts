/**
 * at0307-transcript-file-path-links-bare.test.ts — a bare filename in
 * assistant prose, with no path at all, resolves through the project's file
 * index to where it actually lives, nowhere near the root it was resolved
 * against: backticked, and unbackticked split out of the sentence.
 *
 * One piece of the at0307 split; the constants, frame builders and gestures
 * are `transcript-file-path-links-fixture.ts`, and the claim the pieces share
 * is stated in `at0307-transcript-file-path-links-prose.test.ts`. These two
 * cases left that file so neither crosses the 20 s file budget.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/annotator/
 * @covers tugdeck/src/components/tugways/annotation-scope.tsx
 * @covers tugdeck/src/components/tugways/annotation-portals.tsx
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 * @covers tugdeck/src/components/tugways/cards/tug-atom-markdown-body.tsx
 * @covers tugrust/crates/tugcast/src/fs_stat.rs
 * @family at0307-transcript-file-path-links
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";
import {
  asstText,
  CODE_OUTPUT_FEED,
  INDEXED_NAME,
  replayComplete,
  replayStarted,
  REPO_ROOT,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  turnDone,
  userMsg,
} from "./transcript-file-path-links-fixture";

describe.skipIf(!SHOULD_RUN)(
  "AT0307: verified file paths in transcript prose become links",
  () => {
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
  },
);
