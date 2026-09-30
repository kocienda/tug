/**
 * Token coverage for the markdown typography pass.
 *
 * `--tugx-md-*` slots are component-local per tuglaws/token-naming.md:
 * declared in `tug-markdown-view.css`'s `body {}` block (the canonical
 * home for a public component's `--tugx-*` slots). Per-theme variance
 * flows through the `--tug7-*` base tokens those aliases resolve to.
 *
 * What this test guards:
 *  - Every `--tugx-md-*` token referenced by markdown CSS is declared
 *    in `tug-markdown-view.css`.
 *  - Theme files (`ironclad.css`, `sloop.css`) DO NOT declare any
 *    `--tugx-md-*` slot — that would be the original-sin pattern this
 *    migration cleaned up.
 *
 * Token names are extracted via a simple `--tugx-md-([a-z0-9-]+):`
 * regex; the test does NOT validate values, only declared/referenced
 * token names.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, test, expect } from "bun:test";

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

const TUGDECK = join(__dir, "../../../..");
const IRONCLAD = join(TUGDECK, "styles/themes/ironclad.css");
const SLOOP = join(TUGDECK, "styles/themes/sloop.css");
const MARKDOWN_VIEW_CSS = join(
  TUGDECK,
  "src/components/tugways/tug-markdown-view.css",
);
const MARKDOWN_BLOCK_CSS = join(
  TUGDECK,
  "src/components/tugways/tug-markdown-block.css",
);

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/** Tokens this theme file *declares* — `--tugx-md-foo: value;`. */
function extractDeclared(cssText: string): Set<string> {
  const set = new Set<string>();
  const re = /--tugx-md-([a-z0-9-]+)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cssText)) !== null) {
    set.add(`--tugx-md-${m[1]}`);
  }
  return set;
}

/** Tokens a CSS file *references* — `var(--tugx-md-foo[, ...])`.
 *  Captures only the var name, not its fallback. */
function extractReferenced(cssText: string): Set<string> {
  const set = new Set<string>();
  const re = /var\(\s*(--tugx-md-[a-z0-9-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cssText)) !== null) {
    set.add(m[1]);
  }
  return set;
}

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("markdown token coverage", () => {
  test("theme files declare zero --tugx-md-* slots (the component-local migration cleared them)", () => {
    const ironclad = extractDeclared(read(IRONCLAD));
    const sloop = extractDeclared(read(SLOOP));

    expect(ironclad.size).toBe(0);
    expect(sloop.size).toBe(0);
  });

  test("every --tugx-md-* token referenced by markdown CSS is declared in tug-markdown-view.css", () => {
    const referenced = new Set<string>([
      ...extractReferenced(read(MARKDOWN_VIEW_CSS)),
      ...extractReferenced(read(MARKDOWN_BLOCK_CSS)),
    ]);
    const declared = extractDeclared(read(MARKDOWN_VIEW_CSS));

    const undeclared = [...referenced].filter((t) => !declared.has(t)).sort();

    expect(undeclared).toEqual([]);
  });

  test("token vocabulary covers every md-specific typography axis the pass commits to", () => {
    // Spot-check a representative subset of the *md-specific* tokens so a
    // future refactor that accidentally drops a category fails loudly here.
    //
    // Note: tokens that were previously md-specific but are now consumed
    // from the shared block-surface family — body color, heading color,
    // h6 color, mono font, inline/fenced code bg, blockquote border, hr
    // color, table border, table header bg, footnote color — are
    // intentionally NOT in this list. They live in `--tugx-block-*` via
    // `styles/tugx-block.css`.
    const declared = extractDeclared(read(MARKDOWN_VIEW_CSS));
    const required: ReadonlyArray<string> = [
      // Body rhythm
      "--tugx-md-body-line-height",
      "--tugx-md-paragraph-margin",
      // Heading scale (sizes + weights)
      "--tugx-md-h1-size",
      "--tugx-md-h2-size",
      "--tugx-md-h3-size",
      "--tugx-md-h4-size",
      "--tugx-md-h5-size",
      "--tugx-md-h6-size",
      "--tugx-md-heading-line-height",
      "--tugx-md-heading-margin-top",
      "--tugx-md-heading-margin-bottom",
      "--tugx-md-h1-weight",
      "--tugx-md-h6-weight",
      // Inline
      "--tugx-md-strong-weight",
      "--tugx-md-em-style",
      "--tugx-md-strikethrough-decoration",
      // Links
      "--tugx-md-link-color",
      "--tugx-md-link-color-hover",
      "--tugx-md-link-decoration",
      // Inline code geometry (chrome comes from --tugx-block-*)
      "--tugx-md-inline-code-padding",
      "--tugx-md-inline-code-radius",
      "--tugx-md-inline-code-size",
      // Fenced code geometry (chrome + buttons come from --tugx-block-*,
      // --tug-button-xs-*, and --tug7-* ghost-action tokens — the fence
      // matches the tool-block header directly, so no fence-specific
      // header/button geometry tokens remain).
      "--tugx-md-fenced-code-padding",
      "--tugx-md-fenced-code-size",
      "--tugx-md-fenced-code-line-height",
      "--tugx-md-fenced-code-margin",
      // Blockquote / hr / lists / table / image / footnote — bespoke
      // dimensions only; colors come from --tugx-block-*
      "--tugx-md-blockquote-border-width",
      "--tugx-md-blockquote-padding",
      "--tugx-md-blockquote-margin",
      "--tugx-md-hr-margin",
      "--tugx-md-list-indent",
      "--tugx-md-list-margin",
      "--tugx-md-list-item-margin",
      "--tugx-md-table-header-weight",
      "--tugx-md-table-cell-padding",
      "--tugx-md-table-margin",
      "--tugx-md-image-radius",
      "--tugx-md-image-margin",
      "--tugx-md-footnote-size",
      // Layout
      "--tugx-md-block-padding-x",
      "--tugx-md-bottom-buffer",
    ];
    const missing = required.filter((t) => !declared.has(t));
    expect(missing).toEqual([]);
  });

  test("markdown CSS references no --tugx-md-* fallback literals (theme is the sole source)", () => {
    const view = read(MARKDOWN_VIEW_CSS);
    const block = read(MARKDOWN_BLOCK_CSS);
    // After the typography pass, every var() should reference the
    // declared token without a comma-separated fallback. The
    // existence of `var(--tugx-md-..., <fallback>)` would mean a
    // theme-level value can be overridden by a hardcoded literal —
    // which defeats the per-theme contract.
    //
    // tug-markdown-block.css's `--tugx-md-block-padding-x` is the
    // intentional exception (a soft default for consumers that mount
    // a Block without theme tokens, per its module docstring); the
    // regex below skips that single token.
    const allRefsView = [...view.matchAll(/var\(\s*(--tugx-md-[a-z0-9-]+)\s*,/g)].map((m) => m[1]);
    const allRefsBlock = [...block.matchAll(/var\(\s*(--tugx-md-[a-z0-9-]+)\s*,/g)].map((m) => m[1]);
    const fallbacked = [...allRefsView, ...allRefsBlock].filter(
      (t) => t !== "--tugx-md-block-padding-x",
    );
    expect(fallbacked).toEqual([]);
  });
});
