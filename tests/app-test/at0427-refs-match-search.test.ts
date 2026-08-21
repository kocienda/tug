/**
 * at0427-refs-match-search.test.ts — `/match`, `/search`, `/ref` end to end.
 *
 * Drives the REAL refs backend: a `/match` or `/search` submitted through the
 * prompt sends a run on REFS_INPUT, tugcast walks the workspace on a blocking
 * thread, and the REFS_OUTPUT frames stream a numbered `#r` block into the
 * transcript as non-context ink. Nothing here is injected — the paths in the
 * block are paths the Rust walk actually found on disk.
 *
 *   1. **`/match` finds files by name** — the block settles with one numbered
 *      row per file, rendered through `PathListBlock`, and the rows are
 *      annotated (`data-tug-annotation="file-path"`) with ABSOLUTE paths: the
 *      wire carries them relative to the run's root, and the view joins the
 *      root so every path handed to `OPEN_FILE` is absolute.
 *   2. **`/search` finds lines by content** — matched lines render through
 *      `SearchResultBlock`, each match row carrying its own annotation and
 *      the line it sits on. Clicking one opens that file in a Text card.
 *   3. **Latest-only** — a second run is its own block; the refs `/ref`
 *      resolves against are the newest run's, so `/ref 1` after a second run
 *      opens the second run's first ref, not the first run's.
 *   4. **`/ref` opens by number** — and reports a number the run does not
 *      have rather than opening something else.
 *   5. **Reload restore** — after Maker ▸ Reload the last settled run comes
 *      back from the ledger with its numbering intact, and `/ref N` still
 *      resolves against it.
 *   6. **Excerpting** — a hit inside a very long line renders as windows
 *      around each match with the rest elided, and the spans the row hands
 *      the editor still name the whole line.
 *   7. **Cancel** — a run over a large tree settles as `interrupted` when the
 *      block's Cancel is pressed, keeping the refs it had already found.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugrust/crates/tugcast/src/feeds/refs.rs
 * @covers tugrust/crates/tugcast/src/feeds/text_ref.rs
 * @covers tugrust/crates/tugcast/src/refs_ledger.rs
 * @covers tugdeck/src/lib/refs-session-store.ts
 * @covers tugdeck/src/lib/ledger-restore-fetch.ts
 * @covers tugdeck/src/lib/refs-flags.ts
 * @covers tugdeck/src/lib/ref-spec.ts
 * @covers tugdeck/src/components/tugways/cards/refs-result-block.tsx
 * @covers tugdeck/src/components/tugways/cards/refs-result-view.ts
 * @covers tugdeck/src/components/tugways/body-kinds/search-result-block.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/path-list-block.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "b3c0d1ea-0000-4000-8000-000000000427";

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const REFS_ROWS = `${CARD} [data-slot="session-transcript-refs-row"]`;
const EDITOR = '[data-slot="tug-text-card-editor"] .cm-content';

/** The workspace the deterministic half searches. */
let projectDir = "";
/** A workspace big enough that a run over it is still going when we cancel. */
let bigDir = "";
/** A workspace whose one file is a single very long line, minified-bundle style. */
let longDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // realpath: macOS resolves the temp dir through /private, and the Rust walk
  // reports paths under the root it was handed — encode + search the SAME
  // string, or every absolute-path assertion here is off by that prefix.
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0427-proj-")));
  mkdirSync(join(projectDir, "src"));
  // Two files whose NAMES carry the match needle, and whose CONTENT carries
  // the search needle on known lines.
  writeFileSync(
    join(projectDir, "src", "kestrel-alpha.ts"),
    ["const a = 1;", "// spinnaker rides here", "const b = 2;"].join("\n"),
  );
  writeFileSync(
    join(projectDir, "src", "kestrel-beta.ts"),
    ["export const beta = 0;", "const c = 3;", "// spinnaker again", ""].join("\n"),
  );
  writeFileSync(
    join(projectDir, "src", "kestrel-gamma.ts"),
    ["export const gamma = 7;", "// spinnaker last", ""].join("\n"),
  );
  // A file neither needle names, so a run that returns everything fails.
  writeFileSync(join(projectDir, "src", "unrelated.ts"), "nothing to see\n");

  // One line, two hits 1,000 chars apart, 2,206 chars end to end — the shape
  // a `.jsonl` fixture or a minified bundle has, at a size an assertion can
  // name exactly.
  longDir = realpathSync(mkdtempSync(join(tmpdir(), "at0427-long-")));
  writeFileSync(
    join(longDir, "bundle.js"),
    `${"x".repeat(100)}spinnaker${"y".repeat(1000)}spinnaker${"z".repeat(1097)}\n`,
  );

  bigDir = realpathSync(mkdtempSync(join(tmpdir(), "at0427-big-")));
  const body = `${"// filler line\n".repeat(120)}const marker = "spinnaker";\n`;
  for (let i = 0; i < 8000; i++) {
    writeFileSync(join(bigDir, `f${i}.ts`), body);
  }
});

afterAll(() => {
  for (const dir of [projectDir, bigDir, longDir]) {
    if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session A", closable: true }],
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

/**
 * Submit one line through the real prompt entry.
 *
 * The typed text is read back before the submit chord: an open Text card can
 * sit over the session pane, and a click that lands on it instead of the
 * composer would otherwise send the keystrokes nowhere and leave the caller
 * waiting on an outcome that was never asked for.
 */
async function submit(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(PROMPT);
  await app.nativeType(line);
  await new Promise((r) => setTimeout(r, 200));
  // The command name becomes a chip atom, so the composer's text is the ARGS
  // alone — that tail is what proves the keystrokes landed here.
  const args = line.slice(line.indexOf(" ") + 1);
  const typed = await app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(PROMPT)}) || {}).textContent || ""`,
  );
  if (!typed.includes(args)) {
    throw new Error(`composer did not receive "${line}" (it holds "${typed}")`);
  }
  await app.nativeKey("Enter", ["cmd"]);
}

/** Submit a refs command and block until run `expectedIndex` (0-based) has
 *  settled — the lifecycle dot leaves `in_flight`. */
async function runRefs(app: App, line: string, expectedIndex: number): Promise<void> {
  await submit(app, line);
  await app.waitForCondition<boolean>(
    `(function(){
      var rows = document.querySelectorAll(${JSON.stringify(REFS_ROWS)});
      if (rows.length !== ${expectedIndex + 1}) return false;
      var strip = rows[${expectedIndex}].querySelector('[data-phase]');
      return strip !== null && strip.getAttribute("data-phase") !== "in_flight";
    })()`,
    { timeoutMs: 30_000 },
  );
}

/** Per-run facts: the echoed command, the header count, the lifecycle phase,
 *  and every annotated row's path/line in document order. */
async function refsRunFacts(
  app: App,
  index: number,
): Promise<{
  command: string;
  summary: string;
  phase: string;
  paths: string[];
  lines: string[];
}> {
  return JSON.parse(
    await app.evalJS<string>(`JSON.stringify((function(){
      var row = document.querySelectorAll(${JSON.stringify(REFS_ROWS)})[${index}];
      if (!row) return { command: "", summary: "", phase: "", paths: [], lines: [] };
      var cmd = row.querySelector(".refs-result-command-text");
      var sum = row.querySelector('[data-slot="tool-call-header-summary"]');
      var strip = row.querySelector('[data-phase]');
      var marks = Array.from(row.querySelectorAll('[data-tug-annotation="file-path"]'));
      return {
        command: cmd ? cmd.textContent.trim() : "",
        summary: sum ? sum.textContent.trim() : "",
        phase: strip ? (strip.getAttribute("data-phase") || "") : "",
        paths: marks.map(function(m){ return m.getAttribute("data-path") || ""; }),
        lines: marks.map(function(m){ return m.getAttribute("data-line") || ""; }),
      };
    })())`),
  ) as {
    command: string;
    summary: string;
    phase: string;
    paths: string[];
    lines: string[];
  };
}

/** Every open Text card's editor text. */
async function editorTexts(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(EDITOR)}))
       .map(function(el){ return el.textContent || ""; })`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "AT0427: /match, /search, /ref — the refs vertical slice",
  () => {
    test(
      "match and search stream numbered clickable refs; /ref opens them; reload restores them",
      async () => {
        const app = await launchTugApp({ testName: "at0427-refs-match-search" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            projectDir,
            workspaceKey: projectDir,
          });

          // --- /match: files by name ------------------------------------
          await runRefs(app, "/match kestrel", 0);
          const match = await refsRunFacts(app, 0);
          expect(match.command).toBe("/match kestrel");
          expect(match.phase).toBe("success");
          expect(match.summary).toContain("3 refs");
          // Absolute, and only the files whose names carry the needle.
          expect(match.paths.every((p) => p.startsWith("/"))).toBe(true);
          expect([...match.paths].sort()).toEqual([
            join(projectDir, "src", "kestrel-alpha.ts"),
            join(projectDir, "src", "kestrel-beta.ts"),
            join(projectDir, "src", "kestrel-gamma.ts"),
          ]);
          // A filename ref cites no line — the row opens the file, not a line.
          expect(match.lines.every((l) => l === "")).toBe(true);

          // --- /search: lines by content --------------------------------
          await runRefs(app, "/search spinnaker", 1);
          const search = await refsRunFacts(app, 1);
          expect(search.command).toBe("/search spinnaker");
          expect(search.summary).toContain("3 refs");
          expect(search.paths.every((p) => p.startsWith("/"))).toBe(true);
          // Each match row cites the line it sits on, 1-based.
          const cited = search.paths.map((p, i) => `${p}:${search.lines[i]}`);
          expect([...cited].sort()).toEqual([
            `${join(projectDir, "src", "kestrel-alpha.ts")}:2`,
            `${join(projectDir, "src", "kestrel-beta.ts")}:3`,
            `${join(projectDir, "src", "kestrel-gamma.ts")}:2`,
          ]);

          // --- /ref: open by number -------------------------------------
          // A range opens each numbered ref, resolved against the LATEST run
          // (the search) — latest-only is the model. Run before any Text card
          // exists: an open card can sit over the composer.
          // An out-of-range number is reported and skipped, not silently
          // dropped — the numbers are addresses, not positions.
          await submit(app, "/ref 99");
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll('[data-sonner-toast]'))
               .some(function(e){ return (e.textContent || "").indexOf("No ref 99") !== -1; })`,
            { timeoutMs: 10_000 },
          );
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(EDITOR)}).length`,
            ),
            "a spec that resolves to nothing opens nothing",
          ).toBe(0);

          // A range opens EVERY ref it names. Opening a card re-seats the
          // first responder, so the whole spec travels as one dispatch.
          await submit(app, "/ref 1-2");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(EDITOR)}).length === 2`,
            { timeoutMs: 20_000 },
          );
          const markerFor = (file: string): string =>
            file.endsWith("alpha.ts")
              ? "const a = 1;"
              : file.endsWith("beta.ts")
                ? "export const beta = 0;"
                : "export const gamma = 7;";
          const opened = await editorTexts(app);
          for (const ref of [cited[0], cited[1]]) {
            const file = ref.split(":")[0];
            expect(
              opened.some((t) => t.includes(markerFor(file))),
              `/ref opened ${file}`,
            ).toBe(true);
          }
          expect(
            opened.filter((t) => t.indexOf("nothing to see") !== -1).length,
            "/ref opens the ref it names and nothing else",
          ).toBe(0);

          // Clicking another match row opens ITS file — the delegated
          // annotation layer services the click; the row owns no handler
          // ([L11]). The row names its own path, so the click needs no index.
          const lastFile = cited[2].split(":")[0];
          const LAST_ROW = `${REFS_ROWS} [data-slot="search-result-match"][data-path="${lastFile}"]`;
          // It also names the characters that matched, so the open lands on
          // the span rather than the whole line ([P10], [P14]): the needle
          // sits at columns 3..12 of `// spinnaker …` in every fixture file.
          expect(
            await app.evalJS<string | null>(
              `(document.querySelector(${JSON.stringify(LAST_ROW)}) || {}).getAttribute
                 ? document.querySelector(${JSON.stringify(LAST_ROW)}).getAttribute("data-columns")
                 : null`,
            ),
            "a search ref carries its match span, 0-based and half-open",
          ).toBe("3,12");
          await app.click(LAST_ROW);
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(EDITOR)}).length === 3`,
            { timeoutMs: 20_000 },
          );

          // --- Maker ▸ Reload: the ledger restores the latest run --------
          await app.appReload();
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 20_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            projectDir,
            workspaceKey: projectDir,
          });

          // Latest-only: exactly ONE block comes back, and it is the search.
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(REFS_ROWS)}).length === 1`,
            { timeoutMs: 20_000 },
          );
          const restored = await refsRunFacts(app, 0);
          expect(restored.command).toBe("/search spinnaker");
          expect(restored.phase).toBe("success");
          expect(restored.paths.every((p) => p.startsWith("/"))).toBe(true);
          expect(
            restored.paths.map((p, i) => `${p}:${restored.lines[i]}`).sort(),
            "a restored run is numbered and located exactly as the live one was",
            // Both sides sorted: files are scanned in parallel, so which one
            // finishes first — and therefore the order the run emitted and
            // the ledger stored — is not fixed. The claim is that the same
            // refs came back, not that a race resolved the same way twice.
          ).toEqual([...cited].sort());

          // And the restored refs are what `/ref` resolves against — the
          // block on screen would be a lie if its numbers opened nothing.
          await submit(app, "/ref 1");
          await app.waitForCondition<boolean>(
            `(function(){
               var eds = Array.from(document.querySelectorAll(${JSON.stringify(EDITOR)}));
               return eds.length === 1
                 && (eds[0].textContent || "").indexOf("spinnaker") !== -1;
             })()`,
            { timeoutMs: 20_000 },
          );

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
      "a Grep tool block's match rows stay inert — clickability is opt-in",
      async () => {
        const app = await launchTugApp({ testName: "at0427-refs-grep-inert" });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", { op: "ingestFrame", feedId: 0x40, decoded });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
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
          await ingest({ type: "turn_complete", msg_id: "m1", result: "success" });

          const GREP = `${CARD} [data-slot="grep-tool-block"]`;
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(GREP)}) !== null`,
            { timeoutMs: 10_000 },
          );
          await app.click(`${GREP} [data-slot="tool-call-header-disclosure"]`);
          await app.waitForCondition<boolean>(
            `document.querySelector(
               ${JSON.stringify(`${GREP} [data-slot="search-result-match"]`)}) !== null`,
            { timeoutMs: 10_000 },
          );
          const annotated = await app.evalJS<number>(
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
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: `${SID}-excerpt`,
            projectDir: longDir,
            workspaceKey: longDir,
          });

          await runRefs(app, "/search spinnaker", 0);

          // What the row DRAWS. The line is 2,206 chars with two hits 1,000
          // apart; the row shows two windows and the elisions between them.
          const drawn = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(
              `${REFS_ROWS} [data-slot="search-result-match"] .tugx-search-linetext`,
            )}) || {}).textContent || ""`,
          );
          expect(
            drawn.length,
            "the row is an excerpt, not a 2,206-char line",
          ).toBeLessThan(200);
          expect(drawn).toContain("spinnaker");
          const elisions = await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(
              `${REFS_ROWS} [data-slot="search-result-elision"]`,
            )}).length`,
          );
          expect(elisions, "head, middle, and tail of the line are elided").toBe(3);

          // BOTH hits paint — an excerpt that showed only the first match
          // would be answering a different question than the one asked.
          const hits = await app.evalJS<string[]>(
            `Array.from(document.querySelectorAll(${JSON.stringify(
              `${REFS_ROWS} .tugx-search-hit`,
            )})).map(function(m){ return m.textContent || ""; })`,
          );
          expect(hits).toEqual(["spinnaker", "spinnaker"]);

          // And the span the row hands the editor still names the LINE: the
          // first hit sits at chars 100..109, not at its offset inside the
          // window that draws it.
          const columns = await app.evalJS<string | null>(
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
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          // A workspace of four thousand matching files: the run streams a
          // frame per file, so it is unambiguously still going when we press
          // Stop — no sleep-and-hope.
          await app.bindSession("A", {
            tugSessionId: `${SID}-cancel`,
            projectDir: bigDir,
            workspaceKey: bigDir,
          });

          await submit(app, "/search spinnaker");
          const CANCEL = `${REFS_ROWS} [data-slot="refs-result-cancel"]`;
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CANCEL)}) !== null`,
            { timeoutMs: 20_000 },
          );
          await app.click(CANCEL);

          // The block settles as interrupted, keeping what it had found —
          // a cancel is a stop, not a discard.
          await app.waitForCondition<boolean>(
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
