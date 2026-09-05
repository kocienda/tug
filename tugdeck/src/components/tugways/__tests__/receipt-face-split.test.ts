/**
 * The receipt face split — the shade stays mono, a receipt reads as prose.
 *
 * Two surfaces wear the `.tugx-commit` scale: the History shade's compact
 * mono rows and the transcript's `/commit` and `/arc-join` receipts. They
 * want opposite faces, and the scale used to publish mono for both — which
 * is what put a receipt's English in a terminal face and defeated the commit
 * atom's `font-family: inherit` (`tuglaws/entity-presentation.md`: the pill
 * reads as the ink around it does, proportional in a receipt header).
 *
 * The split is a second scope class rather than a per-site override, so an
 * edit to the shade cannot silently re-break the receipt beside it. This test
 * reads the sheets and holds the split's four halves:
 *
 *   - `.tugx-commit` publishes the MONO face for the subject and the message.
 *   - `.tugx-commit-receipt` publishes the PROPORTIONAL face for both.
 *   - The stamp stays mono with tabular figures on both surfaces, and an
 *     author's `code` run inside a message body stays mono.
 *   - Every receipt root WEARS the receipt class, and no receipt sheet pins a
 *     family of its own — the two mono pins that used to are gone.
 *
 * It is a pure read of the CSS and TSX text: no DOM, no cascade. What it can
 * prove is that the declarations say what the split needs them to say.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

const TUGDECK = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

function read(rel: string): string {
  return readFileSync(join(TUGDECK, rel), "utf8");
}

const PRESENTATION_CSS = read("src/components/tugways/commit-presentation.css");
const COMMIT_RECEIPT_CSS = read(
  "src/components/tugways/cards/session-commit-receipt-block.css",
);
const JOIN_RECEIPT_CSS = read(
  "src/components/tugways/cards/session-join-receipt-block.css",
);
const COMMIT_RECEIPT_TSX = read(
  "src/components/tugways/cards/session-commit-receipt-block.tsx",
);
const JOIN_RECEIPT_TSX = read(
  "src/components/tugways/cards/session-join-receipt-block.tsx",
);

/** The body of the first rule whose selector list is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(
    `(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "m",
  );
  const m = re.exec(stripped);
  if (m === null) throw new Error(`no rule for \`${selector}\``);
  return m[2];
}

/** The declared value of `prop` inside a rule body, or `null`. */
function decl(body: string, prop: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`, "m");
  const m = re.exec(body);
  return m === null ? null : m[1].trim();
}

describe("the scale publishes the shade's mono face", () => {
  const scope = ruleBody(PRESENTATION_CSS, ".tugx-commit");

  test("the subject and the message body are mono", () => {
    expect(decl(scope, "--tugx-commit-subject-font")).toBe(
      "var(--tug-font-family-mono)",
    );
    expect(decl(scope, "--tugx-commit-message-font")).toBe(
      "var(--tug-font-family-mono)",
    );
  });

  test("the stamp is mono, and the stamp cell stacks its figures", () => {
    expect(decl(scope, "--tugx-commit-stamp-font")).toBe(
      "var(--tug-font-family-mono)",
    );
    const stamp = ruleBody(PRESENTATION_CSS, ".tugx-commit-stamp");
    expect(decl(stamp, "font-family")).toBe("var(--tugx-commit-stamp-font)");
    expect(decl(stamp, "font-variant-numeric")).toBe("tabular-nums");
  });
});

describe("the receipt scope publishes the proportional face", () => {
  const receipt = ruleBody(PRESENTATION_CSS, ".tugx-commit-receipt");

  test("the subject and the message body are sans", () => {
    expect(decl(receipt, "--tugx-commit-subject-font")).toBe(
      "var(--tug-font-family-sans)",
    );
    expect(decl(receipt, "--tugx-commit-message-font")).toBe(
      "var(--tug-font-family-sans)",
    );
  });

  test("the receipt scope restates no stamp face — the stamp is mono everywhere", () => {
    expect(decl(receipt, "--tugx-commit-stamp-font")).toBeNull();
  });
});

describe("the message body reads its face from whichever scope is above it", () => {
  const message = ruleBody(PRESENTATION_CSS, ".tugx-commit-message");

  test("the family is the token, with mono for a well under no scope", () => {
    expect(decl(message, "font-family")).toBe(
      "var(--tugx-commit-message-font, var(--tug-font-family-mono))",
    );
  });

  test("the well restates the size and the leading but never the face", () => {
    // Restating the face inside the well would cut the receipt scope off from
    // the one value it exists to set.
    expect(decl(message, "--tugx-commit-message-size")).not.toBeNull();
    expect(decl(message, "--tugx-commit-message-font")).toBeNull();
  });

  test("an author's backticked run keeps the code face", () => {
    const code = ruleBody(PRESENTATION_CSS, ".tugx-commit-message code");
    expect(decl(code, "font-family")).toBe("var(--tug-font-family-mono)");
  });
});

describe("the receipt surfaces take the face from the scope", () => {
  test("each receipt subject line reads the subject token", () => {
    for (const [css, selector] of [
      [COMMIT_RECEIPT_CSS, ".commit-receipt-header"],
      [JOIN_RECEIPT_CSS, ".join-receipt-header"],
      [JOIN_RECEIPT_CSS, ".join-boundary-detail"],
      [JOIN_RECEIPT_CSS, ".join-receipt-identity"],
    ] as const) {
      const family = decl(ruleBody(css, selector), "font-family");
      expect(family).toContain("var(--tugx-commit-subject-font");
    }
  });

  test("no receipt sheet pins the mono family — the two old pins are gone", () => {
    for (const css of [COMMIT_RECEIPT_CSS, JOIN_RECEIPT_CSS]) {
      expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain(
        "font-family: var(--tug-font-family-mono)",
      );
    }
  });

  test("every receipt root wears the receipt class", () => {
    expect(COMMIT_RECEIPT_TSX).toContain('className="tugx-commit-receipt"');
    // The join boundary and the discard receipt — two roots in one file.
    expect(
      JOIN_RECEIPT_TSX.match(/className="tugx-commit-receipt"/g)?.length,
    ).toBe(2);
  });
});
