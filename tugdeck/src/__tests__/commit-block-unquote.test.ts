/**
 * `unquoteGitPath` — the one place in the deck that reads git's C-quoted
 * display form back to a real name.
 *
 * Every other path the deck paints is a typed field the Rust side read through
 * a `-z` listing, so it is never quoted. `commit-block.tsx` is the exception
 * because its source is a foreign transcript's `git commit` stdout, and the
 * cases below are the ones git actually produces: a non-ASCII byte written as
 * octal, the quotes and backslashes it escapes, and the ordinary name it
 * leaves alone.
 */

import { describe, expect, test } from "bun:test";

import { unquoteGitPath } from "@/components/tugways/body-kinds/commit-block";

describe("unquoteGitPath", () => {
  test("an unquoted path is returned untouched", () => {
    expect(unquoteGitPath("src/app.ts")).toBe("src/app.ts");
    // Git quotes only when it must, so a name it left bare stays bare even
    // when it holds characters that would need escaping inside quotes.
    expect(unquoteGitPath("01_Stanisław.jpg")).toBe("01_Stanisław.jpg");
  });

  test("octal escapes are decoded together as UTF-8 bytes", () => {
    // `ł` is U+0142 — two bytes, C5 82, and git writes one escape per byte.
    // Decoding them one at a time would yield two replacement characters.
    expect(unquoteGitPath('"01_Stanis\\305\\202aw_Form_B.jpg"')).toBe(
      "01_Stanisław_Form_B.jpg",
    );
    expect(unquoteGitPath('"range\\342\\200\\2232026.txt"')).toBe(
      "range–2026.txt",
    );
  });

  test("the escapes git writes for its own delimiters come back", () => {
    expect(unquoteGitPath('"quo\\"te.txt"')).toBe('quo"te.txt');
    expect(unquoteGitPath('"back\\\\slash.txt"')).toBe("back\\slash.txt");
    expect(unquoteGitPath('"tab\\tx.txt"')).toBe("tab\tx.txt");
    expect(unquoteGitPath('"two\\nlines.txt"')).toBe("two\nlines.txt");
  });

  test("a backslash git would not have written is kept, not guessed at", () => {
    expect(unquoteGitPath('"odd\\qname.txt"')).toBe("odd\\qname.txt");
  });
});
