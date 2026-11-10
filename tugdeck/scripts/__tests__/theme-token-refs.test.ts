import { describe, expect, test } from "bun:test";

import { findBaseTokenProblems, findThemeTokenProblems, themeDefinitions } from "../theme-token-refs";

const DARK = themeDefinitions(`
  --tug7-element-global-text-normal-default-rest: --tug-color(white);
  --tug7-surface-global-primary-normal-overlay-rest: --tug-color(black);
`);
const LIGHT = themeDefinitions(`
  --tug7-element-global-text-normal-default-rest: --tug-color(black);
  --tug7-surface-global-primary-normal-overlay-rest: --tug-color(white);
  --tug7-element-card-border-normal-frame-rest: --tug-color(indigo);
`);
const THEMES = new Map([
  ["ironclad", DARK],
  ["sloop", LIGHT],
]);

function check(text: string) {
  return findThemeTokenProblems(THEMES, [{ path: "x.css", text }]);
}

describe("findThemeTokenProblems", () => {
  test("a defined token passes wherever it is written", () => {
    expect(
      check(
        [
          "a { color: var(--tug7-element-global-text-normal-default-rest); }",
          "/* @tug-renders-on var(--tug7-surface-global-primary-normal-overlay-rest) */",
          ' * | --tug7-element-global-text-normal-default-rest | --tug7-surface-global-primary-normal-overlay-rest | content |',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("an undefined token is named with its line, in a var(), a comment or a string", () => {
    const problems = check(
      [
        "a { color: var(--tug7-element-global-text-normal-info-rest); }",
        "/* @tug-renders-on var(--tug7-surface-popover-primary-normal-default-rest) */",
        'const t = "--tug7-surface-1";',
      ].join("\n"),
    );
    expect(problems.map((p) => [p.line, p.token, p.kind])).toEqual([
      [1, "--tug7-element-global-text-normal-info-rest", "undefined"],
      [2, "--tug7-surface-popover-primary-normal-default-rest", "undefined"],
      [3, "--tug7-surface-1", "undefined"],
    ]);
  });

  test("a fallback does not excuse an undefined token", () => {
    expect(check("a { color: var(--tug7-element-field-fill-rest, #000); }")).toHaveLength(1);
  });

  test("a family prefix is not a token", () => {
    expect(
      check(
        [
          " * driven by --tug7-field-* tokens",
          "const t = `--tug7-surface-toggle-primary-normal-${suffix}-rest`;",
          'const P = "--tug7-element-chart-fill-";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("a token only some themes define needs a fallback where it is read", () => {
    expect(
      check(
        "a { border-color: var(--tug7-element-card-border-normal-frame-rest, var(--tug7-element-global-text-normal-default-rest)); }",
      ),
    ).toEqual([]);
    const [problem] = check("a { border-color: var(--tug7-element-card-border-normal-frame-rest); }");
    expect(problem.kind).toBe("partial-without-fallback");
    expect(problem.missingFrom).toEqual(["ironclad"]);
  });
});

describe("findBaseTokenProblems", () => {
  const SCALE = { path: "styles/tug.css", text: "body { --tug-space-xl: 16px; }" };
  const tokens = (files: { path: string; text: string }[], knobs = new Map<string, string>()) =>
    findBaseTokenProblems(files, knobs).map((p) => [p.file, p.line, p.token]);

  test("a read of a declared property passes", () => {
    expect(tokens([SCALE, { path: "a.css", text: "a { padding: var(--tug-space-xl); }" }])).toEqual([]);
  });

  test("a fallback does not excuse a read nothing declares", () => {
    expect(
      tokens([SCALE, { path: "a.css", text: "a {\n  padding: var(--tug-space-4, 16px);\n}" }]),
    ).toEqual([["a.css", 2, "--tug-space-4"]]);
  });

  test("a TypeScript writer defines the property; a CSS comment does not", () => {
    const read = { path: "a.css", text: "/* `--tug-row-height` */ a { height: var(--tug-row-height); }" };
    expect(tokens([read])).toEqual([["a.css", 1, "--tug-row-height"]]);
    expect(
      tokens([read, { path: "w.ts", text: 'el.style.setProperty("--tug-row-height", px);' }]),
    ).toEqual([]);
  });

  test("a template writes a family", () => {
    expect(
      tokens([
        { path: "a.css", text: "a { left: var(--tug-inset-left); }" },
        { path: "w.ts", text: "el.style.setProperty(`--tug-inset-${side}`, px);" },
      ]),
    ).toEqual([]);
  });

  test("a declared knob passes, and a family prefix is not a token", () => {
    const read = { path: "a.css", text: "a { translate: var(--tug-slide-x, 0); }\n/* var(--tug-space-*) */" };
    expect(tokens([read])).toEqual([["a.css", 1, "--tug-slide-x"]]);
    expect(tokens([read], new Map([["--tug-slide-x", "a knob"]]))).toEqual([]);
  });
});
