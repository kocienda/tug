/**
 * refs-match-search-fixture.ts — the shared body of the refs vertical slice
 * ([AT0427]): `/match`, `/search` and `/ref` against the REAL refs backend. A
 * `/match` or `/search` submitted through the prompt sends a run on
 * REFS_INPUT, tugcast walks the workspace on a blocking thread, and the
 * REFS_OUTPUT frames stream a numbered `#r` block into the transcript as
 * non-context ink. Nothing is injected — the paths in a block are paths the
 * Rust walk actually found on disk.
 *
 * The slice runs in two files so neither crosses the 20 s file budget:
 * `at0427-refs-match-search.test.ts` (match, search, `/ref`, and the reload
 * restore) and `at0427-refs-blocks.test.ts` (the Grep block's inert rows, a
 * long line's excerpt, and Cancel).
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "./_harness";
import { enforcedTimeout } from "./_harness/rpc";
import { sessionCardShape, SESSION_CARD_SIZE_SHORT } from "./_harness/shapes";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

export const SID = "b3c0d1ea-0000-4000-8000-000000000427";

export const CARD = '[data-card-id="A"]';
export const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
export const REFS_ROWS = `${CARD} [data-slot="session-transcript-refs-row"]`;
export const EDITOR = '[data-slot="tug-text-card-editor"] .cm-content';

// Every workspace below is realpath'd: macOS resolves the temp dir through
// /private, and the Rust walk reports paths under the root it was handed —
// encode + search the SAME string, or every absolute-path assertion is off by
// that prefix.

/**
 * The workspace the deterministic half searches: two files whose NAMES carry
 * the match needle (`kestrel`), and whose CONTENT carries the search needle
 * (`spinnaker`) on known lines, plus a third of each and a file neither needle
 * names, so a run that returns everything fails.
 */
export function makeProjectDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "at0427-proj-")));
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src", "kestrel-alpha.ts"),
    ["const a = 1;", "// spinnaker rides here", "const b = 2;"].join("\n"),
  );
  writeFileSync(
    join(dir, "src", "kestrel-beta.ts"),
    ["export const beta = 0;", "const c = 3;", "// spinnaker again", ""].join("\n"),
  );
  writeFileSync(
    join(dir, "src", "kestrel-gamma.ts"),
    ["export const gamma = 7;", "// spinnaker last", ""].join("\n"),
  );
  writeFileSync(join(dir, "src", "unrelated.ts"), "nothing to see\n");
  return dir;
}

/**
 * A workspace whose one file is a single very long line, minified-bundle
 * style: two hits 1,000 chars apart, 2,206 chars end to end — the shape a
 * `.jsonl` fixture or a minified bundle has, at a size an assertion can name
 * exactly.
 */
export function makeLongDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "at0427-long-")));
  writeFileSync(
    join(dir, "bundle.js"),
    `${"x".repeat(100)}spinnaker${"y".repeat(1000)}spinnaker${"z".repeat(1097)}\n`,
  );
  return dir;
}

/** A workspace big enough that a run over it is still going when we cancel. */
export function makeBigDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "at0427-big-")));
  const body = `${"// filler line\n".repeat(120)}const marker = "spinnaker";\n`;
  for (let i = 0; i < 8000; i++) {
    writeFileSync(join(dir, `f${i}.ts`), body);
  }
  return dir;
}

/** Seed one Session card, `A`, and wait for its host root. */
export async function seedSessionCard(app: App): Promise<void> {
  await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_SHORT, { title: "Session A" }), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
}

/**
 * Submit one line through the real prompt entry.
 *
 * The typed text is read back before the submit chord: an open Text card can
 * sit over the session pane, and a click that lands on it instead of the
 * composer would otherwise send the keystrokes nowhere and leave the caller
 * waiting on an outcome that was never asked for.
 */
export async function submit(app: App, line: string): Promise<void> {
  await app.body("A").nativeClickAtElement(PROMPT);
  await app.nativeType(line);
  await new Promise((r) => setTimeout(r, 200));
  // The command name becomes a chip atom, so the composer's text is the ARGS
  // alone — that tail is what proves the keystrokes landed here.
  const args = line.slice(line.indexOf(" ") + 1);
  const typed = await app.body("A").evalJS<string>(
    `(document.querySelector(${JSON.stringify(PROMPT)}) || {}).textContent || ""`,
  );
  if (!typed.includes(args)) {
    throw new Error(`composer did not receive "${line}" (it holds "${typed}")`);
  }
  await app.nativeKey("Enter", ["cmd"]);
}

/** Submit a refs command and block until run `expectedIndex` (0-based) has
 *  settled — the lifecycle dot leaves `in_flight`. */
export async function runRefs(app: App, line: string, expectedIndex: number): Promise<void> {
  await submit(app, line);
  await app.body("A").waitForCondition<boolean>(
    `(function(){
      var rows = document.querySelectorAll(${JSON.stringify(REFS_ROWS)});
      if (rows.length !== ${expectedIndex + 1}) return false;
      var strip = rows[${expectedIndex}].querySelector('[data-phase]');
      return strip !== null && strip.getAttribute("data-phase") !== "in_flight";
    })()`,
    { timeoutMs: 30_000 },
  );
}

export interface RefsRunFacts {
  command: string;
  summary: string;
  phase: string;
  paths: string[];
  lines: string[];
}

/** Per-run facts: the echoed command, the header count, the lifecycle phase,
 *  and every annotated row's path/line in document order. */
export async function refsRunFacts(app: App, index: number): Promise<RefsRunFacts> {
  return JSON.parse(
    await app.body("A").evalJS<string>(`JSON.stringify((function(){
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
  ) as RefsRunFacts;
}

/** The card ids of every Text card the host holds a body for: each is its own page. */
export async function textCardIds(app: App): Promise<string[]> {
  return (await app.bodies())
    .filter((b) => b.componentId === "text" && b.cardId !== null && (b.state === "bound" || b.state === "ready"))
    .map((b) => b.cardId as string);
}

/** The editor texts of the named Text cards, read card by card in each card's body. */
export async function editorTextsOf(app: App, ids: readonly string[]): Promise<string[]> {
  const texts: string[] = [];
  for (const id of ids) {
    texts.push(
      ...(await app.body(id).evalJS<string[]>(
        `Array.from(document.querySelectorAll(${JSON.stringify(EDITOR)}))
           .map(function(el){ return el.textContent || ""; })`,
      )),
    );
  }
  return texts;
}

/** Every open Text card's editor text. */
export async function editorTexts(app: App): Promise<string[]> {
  return editorTextsOf(app, await textCardIds(app));
}

/**
 * Wait until the editor texts `read` returns satisfy `holds` — the cross-page
 * form of a `waitForCondition` over every editor, since each Text card is its
 * own body. Timeout scaled as `waitForCondition`'s is.
 */
export async function waitForEditorTexts(
  app: App,
  holds: (texts: string[]) => boolean,
  opts: { timeoutMs: number; read?: () => Promise<string[]> },
): Promise<void> {
  const budget = enforcedTimeout(opts.timeoutMs);
  const deadline = Date.now() + budget;
  const read = opts.read ?? (() => editorTexts(app));
  for (;;) {
    // A body still loading may not answer yet; that is "not yet", not a verdict.
    const texts = await read().catch(() => null);
    if (texts !== null && holds(texts)) return;
    if (Date.now() >= deadline) {
      throw new Error(`the Text card editors did not reach the expected state within ${budget} ms (read ${JSON.stringify(texts)})`);
    }
    await Bun.sleep(100);
  }
}
