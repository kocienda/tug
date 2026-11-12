/**
 * audit-tokens-ratchet.test.ts — the token lint is held against its ratchet
 * both ways: a violation the ratchet does not allow fails, and so does an
 * entry the library no longer needs. And the `@tug-pairings` header is
 * required of a file that sets colour, not of a layout-only one.
 */

import { describe, expect, test } from "bun:test";
import path from "path";

import { lintCss, ratchetLint, type LintRatchet } from "../audit-tokens";

const TUGWAYS = path.resolve(import.meta.dir, "../../src/components/tugways");
const fixture = (name: string) => path.join(TUGWAYS, name);

/** A file that sets colour with a header and its surface named: clean. */
const CLEAN = `/* @tug-pairings {
  --tug7-element-global-text-normal-default-rest | --tug7-surface-global-primary-normal-default-rest | content
} */

/* @tug-renders-on: --tug7-surface-global-primary-normal-default-rest */
.fixture-label {
  color: var(--tug7-element-global-text-normal-default-rest);
}
`;

/** The same file with a second colour rule whose surface is not named. */
const ONE_NEW = `${CLEAN}
.fixture-hint {
  color: var(--tug7-element-global-text-normal-muted-rest);
}
`;

describe("token lint ratchet", () => {
  test("a clean file against an empty ratchet has no problems", () => {
    const violations = lintCss(fixture("fixture.css"), CLEAN);
    expect(violations).toEqual([]);
    expect(ratchetLint(violations, {})).toEqual([]);
  });

  test("a new violation the ratchet does not list fails, naming it", () => {
    const violations = lintCss(fixture("fixture.css"), ONE_NEW);
    const problems = ratchetLint(violations, {});
    expect(problems.some((p) => p.startsWith("MISSING_ANNOTATION fixture.css:") && p.includes("not on the ratchet"))).toBe(true);
    expect(problems.some((p) => p.includes(".fixture-hint"))).toBe(true);
  });

  test("a violation past the file's allowance fails", () => {
    const violations = lintCss(fixture("fixture.css"), ONE_NEW);
    const ratchet: LintRatchet = { MISSING_ANNOTATION: { "fixture.css": 0 }, UNRESOLVED_PAIRING: { "fixture.css": 1 } };
    const problems = ratchetLint(violations, ratchet);
    expect(problems.some((p) => p.startsWith("MISSING_ANNOTATION fixture.css:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("UNRESOLVED_PAIRING"))).toBe(false);
  });

  test("a listed violation within its allowance passes", () => {
    const violations = lintCss(fixture("fixture.css"), ONE_NEW);
    const ratchet: LintRatchet = { MISSING_ANNOTATION: { "fixture.css": 1 }, UNRESOLVED_PAIRING: { "fixture.css": 1 } };
    expect(ratchetLint(violations, ratchet)).toEqual([]);
  });

  test("an entry for a file that no longer violates is stale and fails", () => {
    const violations = lintCss(fixture("fixture.css"), CLEAN);
    const problems = ratchetLint(violations, { MISSING_ANNOTATION: { "fixture.css": 1 } });
    expect(problems).toEqual([
      "MISSING_ANNOTATION fixture.css: on the ratchet but no longer violates; remove the entry",
    ]);
  });

  test("an entry above what the file now has must come down", () => {
    const violations = lintCss(fixture("fixture.css"), ONE_NEW);
    const problems = ratchetLint(violations, {
      MISSING_ANNOTATION: { "fixture.css": 3 },
      UNRESOLVED_PAIRING: { "fixture.css": 1 },
    });
    expect(problems).toEqual([
      "MISSING_ANNOTATION fixture.css: the ratchet allows 3 but the file has 1; lower the entry to 1",
    ]);
  });

  test("a narrowed run judges only the files it read", () => {
    const violations = lintCss(fixture("fixture.css"), CLEAN);
    const ratchet: LintRatchet = { MISSING_ANNOTATION: { "elsewhere.css": 2 } };
    expect(ratchetLint(violations, ratchet, new Set(["fixture.css"]))).toEqual([]);
    expect(ratchetLint(violations, ratchet)).toHaveLength(1);
  });
});

describe("the pairings header", () => {
  test("is required of a file that sets colour", () => {
    const css = `/* @tug-renders-on: --tug7-surface-global-primary-normal-default-rest */
.fixture-label {
  color: var(--tug7-element-global-text-normal-default-rest);
}
`;
    const types = lintCss(fixture("fixture.css"), css).map((v) => v.type);
    expect(types).toContain("MISSING_PAIRINGS_BLOCK");
  });

  test("is not required of a layout-only file", () => {
    const css = `.fixture-row {
  display: flex;
  gap: var(--tug-space-lg);
}
`;
    expect(lintCss(fixture("fixture.css"), css)).toEqual([]);
  });
});
