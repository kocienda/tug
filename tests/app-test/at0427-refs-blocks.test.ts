/**
 * at0427-refs-blocks.test.ts — the refs blocks' rows: inert where they are
 * not refs, excerpted where a line is long, and stoppable ([AT0427]).
 *
 * The other half of the refs vertical slice; `at0427-refs-match-search.test.ts`
 * holds `/match`, `/search`, `/ref` and the reload restore, and
 * `refs-match-search-fixture.ts` the shared body. Split so each file stays
 * under the 20 s file budget.
 *
 *   1. **Opt-in clickability** — a Grep tool block renders the same body kind
 *      the refs block uses, and its match rows carry no annotation: they name
 *      files Claude searched, not refs the user asked to open.
 *   2. **Excerpting** — a hit inside a very long line renders as windows
 *      around each match with the rest elided, and the spans the row hands
 *      the editor still name the whole line.
 *   3. **Cancel** — a run over a large tree settles as `interrupted` when the
 *      block's Cancel is pressed, keeping the refs it had already found.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugrust/crates/tugcast/src/feeds/refs.rs
 * @covers tugdeck/src/lib/refs-session-store.ts
 * @covers tugdeck/src/components/tugways/cards/refs-result-block.tsx
 * @covers tugdeck/src/components/tugways/cards/refs-result-view.ts
 * @covers tugdeck/src/components/tugways/body-kinds/search-result-block.tsx
 * @family at0427-refs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launchTugApp } from "./_harness";
import {
  CARD,
  REFS_ROWS,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  makeBigDir,
  makeLongDir,
  makeProjectDir,
  refsRunFacts,
  runRefs,
  seedSessionCard,
  submit,
} from "./refs-match-search-fixture";

let projectDir = "";
let longDir = "";
let bigDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = makeProjectDir();
  longDir = makeLongDir();
  bigDir = makeBigDir();
});

afterAll(() => {
  for (const dir of [projectDir, longDir, bigDir]) {
    if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!SHOULD_RUN)(
  "AT0427: the refs blocks' rows",
  () => {
    test(
      "a Grep tool block's match rows stay inert — clickability is opt-in",
      async () => {
        const app = await launchTugApp({ testName: "at0427-refs-grep-inert" });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", { op: "ingestFrame", feedId: 0x40, decoded });
        try {
          await seedSessionCard(app);
          await app.bindSession("A", { tugSessionId: `${SID}-grep`, projectDir });

          // The same body kind the refs block uses, from its other consumer.
          // A Grep result names files Claude searched, not refs the user
          // asked to open, so its rows carry no annotation: `openable` is
          // opt-in, and only the refs block opts in.
          const hit = join(projectDir, "src", "kestrel-alpha.ts");
          await app.driveSession("A", { op: "send", text: "grep it" });
          await ingest({
            type: "tool_use",
            msg_id: "m1",
            tool_use_id: "tc-g1",
            tool_name: "Grep",
            input: { pattern: "spinnaker", path: projectDir, output_mode: "content" },
            seq: 1,
          });
          await ingest({
            type: "tool_result",
            is_error: false,
            tool_use_id: "tc-g1",
            output: `${hit}:2:// spinnaker rides here`,
          });
          await ingest({
            type: "tool_use_structured",
            tool_use_id: "tc-g1",
            tool_name: "Grep",
            structured_result: {
              mode: "content",
              numFiles: 1,
              truncated: false,
              files: [
                {
                  path: hit,
                  matches: [{ line: 2, text: "// spinnaker rides here", spans: [[3, 12]] }],
                },
              ],
            },
          });
          await ingest({ type: "turn_complete", seq: 0, msg_id: "m1", result: "success" });

          const GREP = `${CARD} [data-slot="grep-tool-block"]`;
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(GREP)}) !== null`,
            { timeoutMs: 10_000 },
          );
          await app.body("A").click(`${GREP} [data-slot="tool-call-header-disclosure"]`);
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(
               ${JSON.stringify(`${GREP} [data-slot="search-result-match"]`)}) !== null`,
            { timeoutMs: 10_000 },
          );
          const annotated = await app.body("A").evalJS<number>(
            `document.querySelectorAll(
               ${JSON.stringify(`${GREP} [data-slot="search-result-match"][data-tug-annotation]`)}).length`,
          );
          expect(annotated, "Grep match rows carry no file-path annotation").toBe(0);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0427] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a hit inside a very long line renders as an excerpt, not the line",
      async () => {
        const app = await launchTugApp({ testName: "at0427-refs-excerpt" });
        try {
          await seedSessionCard(app);
          await app.bindSession("A", {
            tugSessionId: `${SID}-excerpt`,
            projectDir: longDir,
            workspaceKey: longDir,
          });

          await runRefs(app, "/search spinnaker", 0);

          // What the row DRAWS. The line is 2,206 chars with two hits 1,000
          // apart; the row shows two windows and the elisions between them.
          const drawn = await app.body("A").evalJS<string>(
            `(document.querySelector(${JSON.stringify(
              `${REFS_ROWS} [data-slot="search-result-match"] .tugx-search-linetext`,
            )}) || {}).textContent || ""`,
          );
          expect(
            drawn.length,
            "the row is an excerpt, not a 2,206-char line",
          ).toBeLessThan(200);
          expect(drawn).toContain("spinnaker");
          const elisions = await app.body("A").evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(
              `${REFS_ROWS} [data-slot="search-result-elision"]`,
            )}).length`,
          );
          expect(elisions, "head, middle, and tail of the line are elided").toBe(3);

          // BOTH hits paint — an excerpt that showed only the first match
          // would be answering a different question than the one asked.
          const hits = await app.body("A").evalJS<string[]>(
            `Array.from(document.querySelectorAll(${JSON.stringify(
              `${REFS_ROWS} .tugx-search-hit`,
            )})).map(function(m){ return m.textContent || ""; })`,
          );
          expect(hits).toEqual(["spinnaker", "spinnaker"]);

          // And the span the row hands the editor still names the LINE: the
          // first hit sits at chars 100..109, not at its offset inside the
          // window that draws it.
          const columns = await app.body("A").evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(
              `${REFS_ROWS} [data-slot="search-result-match"]`,
            )}) || {}).getAttribute
               ? document.querySelector(${JSON.stringify(
                 `${REFS_ROWS} [data-slot="search-result-match"]`,
               )}).getAttribute("data-columns")
               : null`,
          );
          expect(columns, "spans stay in whole-line coordinates ([P14])").toBe("100,109");

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0427] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a long run settles as interrupted when its Cancel is pressed",
      async () => {
        const app = await launchTugApp({ testName: "at0427-refs-cancel" });
        try {
          await seedSessionCard(app);
          // A workspace of eight thousand matching files: the run streams a
          // frame per file, so it is unambiguously still going when we press
          // Stop — no sleep-and-hope.
          await app.bindSession("A", {
            tugSessionId: `${SID}-cancel`,
            projectDir: bigDir,
            workspaceKey: bigDir,
          });

          await submit(app, "/search spinnaker");
          const CANCEL = `${REFS_ROWS} [data-slot="refs-result-cancel"]`;
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CANCEL)}) !== null`,
            { timeoutMs: 20_000 },
          );
          await app.body("A").click(CANCEL);

          // The block settles as interrupted, keeping what it had found —
          // a cancel is a stop, not a discard.
          await app.body("A").waitForCondition<boolean>(
            `(function(){
              var strip = document.querySelector(
                ${JSON.stringify(`${REFS_ROWS} [data-phase]`)});
              return strip !== null && strip.getAttribute("data-phase") === "interrupted";
            })()`,
            { timeoutMs: 20_000 },
          );
          const cancelled = await refsRunFacts(app, 0);
          expect(cancelled.phase).toBe("interrupted");
          expect(cancelled.summary).toContain("ref");

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0427] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
