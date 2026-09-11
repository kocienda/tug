/**
 * The two Key rules' knobs — the light themes declare them, the dark themes do not.
 *
 * Once a light theme's fields go paper, focus and selection have no field left
 * to say themselves in: the focused lid is the same near-neutral as the rail
 * beside it, and the selection wash is pale. So each gets a MARK instead — a
 * rule along the focused lid's top edge, and one down a selected row's leading
 * edge — and the four knobs here are where a theme states the two.
 *
 * A dark theme wants neither: its bands already differ by lightness, and a Key
 * rule over them would be a stripe on a surface that is already saying the
 * thing. So a dark theme declares NOTHING, and the whole of its answer is the
 * fallback in the consumer rule. That is the contract this file guards, from
 * both ends:
 *
 * - The three light themes declare all four knobs, so the rules have values.
 * - The three dark themes declare none of them, so a knob never leaks into a
 *   theme that did not ask for one.
 * - Both consumer rules read every knob through `var(…, <default>)`, and the
 *   default is `0px` for a width and `transparent` for a color. That is what
 *   makes the dark themes' silence safe: a zero-width, transparent rule paints
 *   nothing and moves nothing, so the dark appearance is byte-identical to what
 *   it was before the rules existed.
 *
 * The test reads the CSS text rather than a browser, because what it is
 * checking is the authoring contract — declared or not, fallback present or
 * not — and neither is a question about rendering.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const TUGDECK = path.join(import.meta.dir, "../..");
const THEMES_DIR = path.join(TUGDECK, "styles/themes");
const TUGWAYS_DIR = path.join(TUGDECK, "src/components/tugways");

const LIGHT_THEMES = ["harmony", "aria", "vivace"] as const;
const DARK_THEMES = ["brio", "nocturne", "bravura"] as const;

/** Each knob and the default its consumers must fall back to. */
const KNOBS = [
  { name: "--tugx-chrome-lid-rule-width", fallback: "0px" },
  { name: "--tugx-chrome-lid-rule-color", fallback: "transparent" },
  { name: "--tugx-chrome-selection-rule-width", fallback: "0px" },
  { name: "--tugx-chrome-selection-rule-color", fallback: "transparent" },
] as const;

/** The consumer file each rule lives in, and the knobs it reads. */
const CONSUMERS = [
  { file: "tug-pane.css", knobs: ["--tugx-chrome-lid-rule-width", "--tugx-chrome-lid-rule-color"] },
  {
    file: "tug-list-row.css",
    knobs: ["--tugx-chrome-selection-rule-width", "--tugx-chrome-selection-rule-color"],
  },
] as const;

const readTheme = (theme: string) => fs.readFileSync(path.join(THEMES_DIR, `${theme}.css`), "utf-8");
const readConsumer = (file: string) => fs.readFileSync(path.join(TUGWAYS_DIR, file), "utf-8");

/** True when the file DECLARES the knob — `--knob: value`, not a var() read of it. */
const declares = (css: string, knob: string): boolean =>
  new RegExp(`^\\s*${knob}\\s*:`, "m").test(css);

describe("the two Key rules' knobs", () => {
  for (const theme of LIGHT_THEMES) {
    it(`${theme} declares all four knobs`, () => {
      const css = readTheme(theme);
      for (const { name } of KNOBS) {
        expect(
          declares(css, name),
          `${theme} does not declare ${name} — the rule it feeds would fall back to painting nothing`,
        ).toBe(true);
      }
    });
  }

  for (const theme of DARK_THEMES) {
    it(`${theme} declares none of them`, () => {
      const css = readTheme(theme);
      for (const { name } of KNOBS) {
        expect(
          declares(css, name),
          `${theme} declares ${name} — a dark theme's answer to both rules is the consumer's fallback, not a value of its own`,
        ).toBe(false);
      }
    });
  }

  for (const { file, knobs } of CONSUMERS) {
    it(`${file} reads its knobs through a fallback`, () => {
      const css = readConsumer(file);
      for (const knob of knobs) {
        const fallback = KNOBS.find((k) => k.name === knob)!.fallback;
        expect(
          new RegExp(`var\\(\\s*${knob}\\s*,\\s*${fallback}\\s*\\)`).test(css),
          `${file} does not read ${knob} as var(${knob}, ${fallback}) — without that default a theme declaring nothing gets an invalid value rather than no rule`,
        ).toBe(true);
      }
    });
  }
});
