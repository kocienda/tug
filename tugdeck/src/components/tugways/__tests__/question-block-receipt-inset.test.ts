/**
 * The question block sits at the receipt inset, and the wizard → record morph
 * still holds its rows still horizontally.
 *
 * Every framed receipt in the transcript pads its body with one inset —
 * compact row padding + indicator gutter inline, `--tug-space-sm` block — read
 * from `--tugx-block-receipt-inset-*`. The question block's answered rows are
 * the shared `QuestionSummaryList`, whose base inset must stay its own for its
 * other hosts, so the block narrows them by overriding `--tugx-qrow-pad-inline`
 * on its own slot. The live wizard mounts under that same slot, and the morph
 * from wizard to record is only still if the wizard's summary and button
 * cluster read the rows' tokens rather than the list row's directly.
 *
 * A pure read of the CSS text: no DOM, no cascade. It proves the declarations
 * say what the alignment needs them to say.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

const TUGDECK = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

function read(rel: string): string {
  return readFileSync(join(TUGDECK, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

const BLOCK_CSS = read("src/components/tugways/cards/blocks/ask-user-question-tool-block.css");
const DIALOG_CSS = read("src/components/tugways/chrome/session-question-dialog.css");
const ROWS_CSS = read("src/components/tugways/question-summary-list.css");
const TOKENS_CSS = read("styles/tugx-block.css");

/** The body of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const re = new RegExp(
    `(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "m",
  );
  const m = re.exec(css);
  if (m === null) throw new Error(`no rule for \`${selector}\``);
  return m[2]!;
}

/** The value of `prop` in a rule body, whitespace collapsed. */
function decl(body: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+);`).exec(body);
  return m === null ? null : m[1]!.replace(/\s+/g, " ").trim();
}

const ROW_START = "calc(var(--tugx-qrow-pad-inline) + var(--tugx-qrow-gutter))";
const RECEIPT_PAIR =
  "var(--tugx-block-receipt-inset-block) var(--tugx-block-receipt-inset-inline)";

describe("the rows take the receipt inset inside the question block", () => {
  test("the block narrows the shared rows to the compact row's padding", () => {
    expect(
      decl(ruleBody(BLOCK_CSS, '[data-slot="ask-user-question-tool-block"]'), "--tugx-qrow-pad-inline"),
    ).toBe("var(--tugx-list-row-padding-inline-compact)");
  });

  test("so a row's content starts where the receipt inset says", () => {
    // Row start = pad-inline + gutter; with pad-inline at the compact value
    // that is exactly the receipt inset's own definition.
    expect(decl(ruleBody(ROWS_CSS, ".question-summary-row"), "padding-inline-start")).toBe(ROW_START);
    expect(decl(ruleBody(ROWS_CSS, "body"), "--tugx-qrow-gutter")).toBe(
      "var(--tugx-list-row-indicator-gutter, 0.2rem)",
    );
    expect(decl(TOKENS_CSS, "--tugx-block-receipt-inset-inline")).toBe(
      "calc( var(--tugx-list-row-padding-inline-compact) + var(--tugx-list-row-indicator-gutter) )",
    );
  });

  test("the shared list's base inset is untouched for its other hosts", () => {
    expect(decl(ruleBody(ROWS_CSS, "body"), "--tugx-qrow-pad-inline")).toBe(
      "var(--tugx-list-row-padding-inline, 14px)",
    );
  });
});

describe("the wizard → record morph holds still horizontally", () => {
  test("the wizard's summary and the record's summary start on the rows' marker column", () => {
    expect(decl(ruleBody(DIALOG_CSS, ".session-question-dialog-nav-summary"), "padding-inline-start")).toBe(
      ROW_START,
    );
    expect(decl(ruleBody(BLOCK_CSS, ".ask-user-question-tool-block-summary"), "padding-inline-start")).toBe(
      ROW_START,
    );
  });

  test("the wizard's button cluster ends on the rows' trailing edge", () => {
    expect(decl(ruleBody(DIALOG_CSS, ".session-question-dialog-actionbar-buttons"), "margin-inline-end")).toBe(
      "var(--tugx-qrow-pad-inline)",
    );
    expect(decl(ruleBody(ROWS_CSS, ".question-summary-row"), "padding-inline-end")).toBe(
      "var(--tugx-qrow-pad-inline)",
    );
  });
});

describe("the record is no taller than its content", () => {
  test("the summary line reserves no button box and no margins", () => {
    const summary = ruleBody(BLOCK_CSS, ".ask-user-question-tool-block-summary");
    expect(decl(summary, "min-height")).toBeNull();
    expect(decl(summary, "margin-block")).toBeNull();
  });

  test("the record pads with the receipt's block inset, and the list adds no tail", () => {
    expect(decl(ruleBody(BLOCK_CSS, ".ask-user-question-tool-block-answered"), "padding-block")).toBe(
      "var(--tugx-block-receipt-inset-block)",
    );
    expect(BLOCK_CSS).not.toContain(".ask-user-question-tool-block-list");
  });
});

describe("the other question states take the receipt inset", () => {
  test("declined and empty pad with the receipt pair", () => {
    for (const sel of [".ask-user-question-tool-block-declined", ".ask-user-question-tool-block-empty"]) {
      expect(decl(ruleBody(BLOCK_CSS, sel), "padding")).toBe(RECEIPT_PAIR);
    }
  });

  test("salvage pads with the receipt pair", () => {
    expect(decl(ruleBody(BLOCK_CSS, ".ask-user-question-tool-block-salvage"), "padding")).toBe(
      "var(--tugx-askquestion-salvage-padding)",
    );
    expect(BLOCK_CSS.replace(/\s+/g, " ")).toContain(
      `--tugx-askquestion-salvage-padding: ${RECEIPT_PAIR};`,
    );
  });
});
