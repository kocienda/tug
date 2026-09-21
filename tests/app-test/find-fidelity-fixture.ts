/**
 * find-fidelity-fixture.ts — one transcript carrying every row kind the
 * search index projects, for the fidelity sweep (`at0602`).
 *
 * ## Why this exists
 *
 * The transcript's match COUNT comes from a projected text index
 * (`tugdeck/src/lib/transcript-search-index.ts`) and the HIGHLIGHT comes
 * from a walk over the live DOM (`transcript-find-highlighter.ts`). The two
 * are joined only by ordinal — "the k-th DOM hit in a row is the k-th index
 * hit" — and nothing checks that at runtime. When a row kind projects text
 * the DOM does not hold (or holds differently), find paints the wrong range
 * with perfect confidence.
 *
 * This fixture exists so the check can be run over every kind at once. Each
 * exported frame group seeds one branch of the index's projection:
 * `rowSegments`, `messageSegments`, `toolUseSegments`, `shellSegments`.
 * Every row carries the letter `e`, which is the sweep's query — a probe
 * that matches everywhere is what makes every row paintable, and therefore
 * comparable (the painter's comparison only runs under a query with at
 * least one match).
 *
 * ## Kinds deliberately NOT covered here, and why
 *
 *  - **`refs_result` rows.** A refs run is produced by the refs pipeline
 *    rather than by a frame the session bridge accepts; `driveSession` has
 *    no op that seeds one, and no existing app-test seeds a `refs_result`
 *    row either (`at0427` covers the Grep TOOL block, a different kind).
 *    `refsSegments` is therefore unswept.
 *  - **`system_note` with `source: "other"`.** It projects nothing by
 *    design — there is no marked container — so there is nothing to compare.
 *  - **Subagent child tool calls.** `messageSegments` returns `[]` for any
 *    call carrying a `parentToolUseId`; they render inside the Agent block.
 *
 * @module tests/app-test/find-fidelity-fixture
 */

import type { SessionDriveAction } from "./_harness";

/** One decoded frame, as `driveSession({op:"ingestFrame"})` takes it. */
export type Frame = Record<string, unknown>;

/**
 * A step that is not a frame — a prompt or a shell exchange, each of which
 * rides its own `driveSession` op. Typed against the harness's own union so
 * a fixture cannot invent an op the bridge does not accept.
 */
export type FixtureDrive = Extract<SessionDriveAction, { op: "send" } | { op: "shellExchange" }>;

export type FixtureStep =
  | { kind: "frame"; frame: Frame }
  | { kind: "drive"; drive: FixtureDrive };

const f = (frame: Frame): FixtureStep => ({ kind: "frame", frame });
const d = (drive: FixtureDrive): FixtureStep => ({ kind: "drive", drive });

/**
 * Markdown exercising every block transformer the index reduces through
 * `markdownToText`: headings, lists, a fenced code block, a table, inline
 * code, fenced and unfenced math, and HTML entities. This is the row kind
 * the plan predicts will diverge — `markdownToText` joins a message's parsed
 * blocks with `"\n"`, while the DOM side concatenates text nodes with
 * whatever whitespace the rendered markup holds between blocks.
 */
export const MULTI_BLOCK_MARKDOWN = [
  "## Heading three elements",
  "",
  "A paragraph of prose with `inline code` and an entity: AT&amp;T &mdash; here.",
  "",
  "- first item",
  "- second item",
  "",
  "```ts",
  "const three = 3;",
  "```",
  "",
  "| column | other |",
  "|---|---|",
  "| cell | else |",
  "",
  "Unfenced math $\\varepsilon > 0$ and a fenced one:",
  "",
  "$$",
  "\\sum_{i=1}^{n} x_i",
  "$$",
  "",
  "The closing sentence.",
].join("\n");

/** A terminal body with ANSI, plain lines, and a stderr tail. */
export const ANSI_OUTPUT = [
  "[32mgreen line one[0m",
  "plain line two",
  "[1;31mbold red three[0m",
].join("\n");

/** A unified diff, which routes the Bash body to `DiffBlock` (unmarked). */
export const DIFF_OUTPUT = [
  "diff --git a/src/one.ts b/src/one.ts",
  "index 1111111..2222222 100644",
  "--- a/src/one.ts",
  "+++ b/src/one.ts",
  "@@ -1,3 +1,3 @@",
  "-const before = 1;",
  "+const after = 1;",
  " const same = 2;",
].join("\n");

/** The bytes a `git commit` receipt is parsed out of. */
export const COMMIT_OUTPUT = [
  "[main 0123456] tugways(fixture): settle the element",
  " 1 file changed, 3 insertions(+)",
].join("\n");

/** A file body for the Read call's embedded editor (an `editor` segment). */
export function readFileBody(): string {
  const lines: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    lines.push(`const element${i} = ${i}; // everywhere`);
  }
  return lines.join("\n");
}

/** The `/commit` receipt bytes a bespoke command block claims. */
export const COMMIT_RECEIPT = [
  "committed 89abcdef01 · 1 file(s) · +3 −0",
  'files: [{"path":"src/c.rs","status":"created","added":3,"removed":0}]',
  "tugways(fixture): mark the element",
  "",
  "A receipt body the block renders and the raw terminal never shows.",
].join("\n");

/** The `/arc-join` receipt bytes, same treatment by a different block. */
export const JOIN_RECEIPT = [
  "joined 0123456789 · fixture-lane → main · 5 round(s)",
  'files: [{"path":"src/a.rs","status":"modified","added":16,"removed":1}]',
  "tugarc(fixture-lane): land the element",
  "",
  "The join receipt body, rendered by its own block.",
].join("\n");

/**
 * The ordered steps that build the fixture transcript. `at0602` walks these
 * in order, feeding frames through `ingestFrame` and drives through their
 * own ops.
 *
 * Every step's text carries the letter `e` at least once, deliberately: the
 * sweep's query is `e`, and a row that cannot match is a row the painter
 * never compares.
 */
export function fidelityFixtureSteps(sessionId: string): FixtureStep[] {
  const steps: FixtureStep[] = [];
  let turn = 0;
  const nextMsg = (): string => `${sessionId}-m${turn++}`;

  // --- 1. A plain user body, then one with the `> ` quote prefix. ---
  steps.push(d({ op: "send", text: "the element, please" }));
  const m1 = nextMsg();
  steps.push(f({ type: "prompt_anchor", promptUuid: `${sessionId}-u1` }));
  steps.push(f({ type: "content_block_start", msg_id: m1, block_index: 0, kind: "text" }));
  steps.push(
    f({
      type: "assistant_text",
      msg_id: m1,
      block_index: 0,
      text: "A short single-block reply mentioning the element once.",
      is_partial: false,
    }),
  );
  steps.push(f({ type: "turn_complete", msg_id: m1, result: "success" }));

  steps.push(d({ op: "send", text: "> a quoted prompt about the element\n> second line here" }));
  const m2 = nextMsg();
  steps.push(f({ type: "prompt_anchor", promptUuid: `${sessionId}-u2` }));
  steps.push(f({ type: "content_block_start", msg_id: m2, block_index: 0, kind: "text" }));
  steps.push(
    f({
      type: "assistant_text",
      msg_id: m2,
      block_index: 0,
      text: MULTI_BLOCK_MARKDOWN,
      is_partial: false,
    }),
  );
  steps.push(f({ type: "turn_complete", msg_id: m2, result: "success" }));

  // --- 2. Thinking, which projects its label plus prose (expanded) or a
  //        one-line preview (collapsed). Seeded expanded; `at0602` folds it.
  steps.push(d({ op: "send", text: "think about the element" }));
  const m3 = nextMsg();
  steps.push(f({ type: "prompt_anchor", promptUuid: `${sessionId}-u3` }));
  steps.push(
    f({ type: "content_block_start", msg_id: m3, block_index: 0, kind: "thinking" }),
  );
  steps.push(
    f({
      type: "assistant_thinking",
      msg_id: m3,
      block_index: 0,
      text: [
        "The first line of reasoning about the element.",
        "",
        "A second paragraph, so the preview and the prose differ.",
      ].join("\n"),
      is_partial: false,
    }),
  );
  steps.push(
    f({
      type: "assistant_text",
      msg_id: m3,
      block_index: 1,
      text: "And the reply that followed the thinking, with an element.",
      is_partial: false,
    }),
  );
  steps.push(f({ type: "turn_complete", msg_id: m3, result: "success" }));

  // --- 3. System notes, one per rendered source. ---
  for (const [source, text] of [
    ["compact", "Compacted the conversation · 12,345 tokens recovered"],
    ["scheduled", "Woke on a **scheduled** trigger, element checked"],
    ["notice", "A tug notice mentioning the element."],
    ["arc", "The arc went quiet waiting on an element."],
  ] as const) {
    const mn = nextMsg();
    steps.push(
      f({
        type: "system_note",
        msg_id: mn,
        source,
        text,
      }),
    );
  }

  // --- 4. Bash calls: plain, ANSI, stderr, diff-routed, commit receipt. ---
  const bashCases: Array<{ id: string; command: string; output: string; stderr?: string }> = [
    { id: "tc-plain", command: "echo the element", output: "the element line\nsecond line here" },
    { id: "tc-ansi", command: "ls --color=always /tmp/elements", output: ANSI_OUTPUT },
    {
      id: "tc-stderr",
      command: "cat /tmp/elements/missing",
      output: "",
      stderr: "cat: /tmp/elements/missing: No such file or directory",
    },
    { id: "tc-diff", command: "git diff -- src/one.ts", output: DIFF_OUTPUT },
    { id: "tc-commit", command: 'git commit -m "settle the element"', output: COMMIT_OUTPUT },
  ];
  for (const c of bashCases) {
    const mb = nextMsg();
    steps.push(d({ op: "send", text: `run ${c.id}` }));
    steps.push(f({ type: "prompt_anchor", promptUuid: `${sessionId}-u-${c.id}` }));
    steps.push(
      f({
        type: "tool_use",
        msg_id: mb,
        tool_use_id: c.id,
        tool_name: "Bash",
        input: { command: c.command, description: `the ${c.id} element` },
      }),
    );
    steps.push(
      f({
        type: "tool_result",
        tool_use_id: c.id,
        output: c.stderr !== undefined ? c.stderr : c.output,
        is_error: c.stderr !== undefined,
      }),
    );
    steps.push(f({ type: "turn_complete", msg_id: mb, result: "success" }));
  }

  // --- 5. A Read call — its body is an embedded editor (`editor` segment),
  //        which the DOM walk cannot reach and the comparison skips.
  const mr = nextMsg();
  steps.push(d({ op: "send", text: "read the element file" }));
  steps.push(
    f({
      type: "tool_use",
      msg_id: mr,
      tool_use_id: "tc-read",
      tool_name: "Read",
      input: { file_path: "/tmp/at0602/elements.ts" },
    }),
  );
  steps.push(f({ type: "tool_result", tool_use_id: "tc-read", output: "ok" }));
  steps.push(
    f({
      type: "tool_use_structured",
      tool_use_id: "tc-read",
      tool_name: "Read",
      structured_result: {
        type: "text",
        file: {
          content: readFileBody(),
          filePath: "/tmp/at0602/elements.ts",
          startLine: 1,
          numLines: 60,
          totalLines: 60,
        },
      },
    }),
  );
  steps.push(f({ type: "turn_complete", msg_id: mr, result: "success" }));

  // --- 6. A default-routed tool whose result is markdown — the branch
  //        `pickOutputBody` reduces through the parse cache.
  const md = nextMsg();
  steps.push(d({ op: "send", text: "fetch the element" }));
  steps.push(
    f({
      type: "tool_use",
      msg_id: md,
      tool_use_id: "tc-default",
      tool_name: "WebFetch",
      input: { url: "https://example.test/elements", prompt: "summarise" },
    }),
  );
  steps.push(
    f({
      type: "tool_result",
      tool_use_id: "tc-default",
      output: ["### Fetched", "", "- an element", "- another element"].join("\n"),
      is_error: false,
    }),
  );
  steps.push(f({ type: "turn_complete", msg_id: md, result: "success" }));

  // --- 7. Shell exchanges: a plain one, and two claimed by bespoke blocks. ---
  steps.push(
    d({
      op: "shellExchange",
      exchangeId: `${sessionId}-x0`,
      command: "echo a shell element",
      output: "a shell element line\nand a second line here",
      cwd: "/tmp",
      exitCode: 0,
      startedAtMs: 1_700_000_000_000,
    }),
  );
  steps.push(
    d({
      op: "shellExchange",
      exchangeId: `${sessionId}-x1`,
      command: "/commit",
      output: COMMIT_RECEIPT,
      cwd: "/tmp",
      exitCode: 0,
      startedAtMs: 1_700_000_000_001,
    }),
  );
  steps.push(
    d({
      op: "shellExchange",
      exchangeId: `${sessionId}-x2`,
      command: "/arc-join",
      output: JOIN_RECEIPT,
      cwd: "/tmp",
      exitCode: 0,
      startedAtMs: 1_700_000_000_002,
    }),
  );

  return steps;
}
