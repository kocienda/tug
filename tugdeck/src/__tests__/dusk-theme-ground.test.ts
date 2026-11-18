/**
 * The ground invariants of the five Dusk themes — lugger, packet, tender,
 * cutter and trawler.
 *
 * Dusk is the family between dark and light: a mid-tone ground light enough
 * for dark ink. It takes the light themes' token families, since the ink
 * polarity is theirs, and breaks two of their rules on purpose. Colour may be
 * a field: the ground, the lid and the canvas carry the tint at a chroma a
 * paper theme is forbidden, so the light themes' chroma ceiling does not
 * apply here and `light-theme-paper.test.ts` names none of these themes. And
 * elevation steps both ways: raised surfaces are lighter than the ground,
 * while the sunken band, the lid and the canvas field are darker.
 *
 * This file guards what that settlement rests on, so a later retune has to
 * argue with a named failure rather than quietly undo it:
 *
 * - The ground. Every Dusk card ground is the tint at l: 775, c: 30 — the
 *   lightness the dark ink was cut against. `lugger` is the gray member and
 *   holds zero chroma there.
 * - One tint hue. Every neutral surface and every neutral ink is authored on
 *   the theme's one tint hue; the Key hue stays in marks, fills and washes.
 *   The hue is read as the NAME authored in the recipe, the same way the
 *   paper test reads it, because a resolved angle at low chroma is
 *   numerically real and perceptually meaningless, and `gray` has none.
 *   Body text is near-black `gray` on every theme and is not a tint ink.
 * - The two-way ladder. Raised, overlay and the code well sit above the
 *   ground; the sunken band, the focused and inactive lids and the canvas
 *   field sit below it.
 * - The Accent cut. The shared light-theme orange cannot hold contrast on a
 *   mid-tone ground, so each Dusk theme cuts its own, and it must hold 3 : 1
 *   against the ground it draws the focus ring and the caret on.
 *
 * - Every recipe parses as the build parses it. The audit's resolver drops a
 *   recipe it cannot parse as an unresolved token, so a hyphenated pair whose
 *   hues are not neighbours on the ring passes the audit and fails the build.
 *
 * Resolution goes through the contrast audit's own `buildDefs` /
 * `resolveToken`, so a `var()` chain resolves the way the browser resolves it.
 */
import { describe, it, expect } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { buildDefs, KNOWN_HUES, resolveRecipe, resolveToken } from "../../scripts/audit-theme-contrast";
import { ADJACENCY_RING, findTugColorCalls, oklchToHex, parseTugColor } from "../components/tugways/tugcolor";
import { computeWcagContrast } from "../components/tugways/theme-accessibility";
import { THEME_CATALOG } from "../theme-catalog";

const THEMES_DIR = path.join(import.meta.dir, "../../styles/themes");

/** The five Dusk themes and the tint hue each one's neutrals are authored on. */
const DUSK_THEMES: ReadonlyArray<{ theme: string; tint: string }> = [
  { theme: "lugger", tint: "gray" },
  { theme: "packet", tint: "honey" },
  { theme: "tender", tint: "jade" },
  { theme: "cutter", tint: "cerulean" },
  { theme: "trawler", tint: "orchid" },
];

/** The card ground: the tint at l: 775, c: 30. */
const GROUND_TOKENS = [
  "--tug7-surface-global-primary-normal-content-rest",
  "--tug7-surface-global-primary-normal-default-rest",
] as const;
const GROUND_L = 0.775;
const GROUND_C = 30;

/** The rungs that step up from the ground. */
const ABOVE_GROUND = [
  "--tug7-surface-global-primary-normal-raised-rest",
  "--tug7-surface-global-primary-normal-overlay-rest",
  "--tug7-surface-card-primary-normal-well-rest",
] as const;

/** The rungs that step down from it. */
const BELOW_GROUND = [
  "--tug7-surface-global-primary-normal-sunken-rest",
  "--tugx-chrome-key-surface",
  "--tug7-surface-card-primary-normal-titlebar-inactive",
  "--tug7-surface-global-primary-normal-canvas-rest",
] as const;

/** Every neutral surface: the ground, both ladders, and the card's bands. */
const NEUTRAL_SURFACES = [
  ...GROUND_TOKENS,
  ...ABOVE_GROUND,
  ...BELOW_GROUND,
  "--tug7-surface-global-primary-normal-screen-rest",
  "--tug7-surface-card-primary-normal-status-rest",
  "--tug7-surface-card-primary-normal-controlbar-rest",
  "--tug7-surface-card-primary-normal-block-rest",
] as const;

/** Every neutral ink: secondary text and the plain icons. */
const NEUTRAL_INKS = [
  "--tug7-element-global-text-normal-muted-rest",
  "--tug7-element-global-text-normal-subtle-rest",
  "--tug7-element-global-text-normal-placeholder-rest",
  "--tug7-element-global-text-normal-plain-disabled",
  "--tug7-element-global-icon-normal-default-rest",
  "--tug7-element-global-icon-normal-muted-rest",
  "--tug7-element-global-icon-normal-plain-disabled",
] as const;

const ACCENT = "--tugx-accent";
const ACCENT_MIN_CONTRAST = 3;

const defsFor = (theme: string) => buildDefs(path.join(THEMES_DIR, `${theme}.css`));

/** The hue NAME authored in a token's --tug-color() recipe, following var() chains. */
function authoredHue(name: string, defs: Map<string, string>, seen = new Set<string>()): string | null {
  if (seen.has(name)) return null;
  seen.add(name);
  const value = defs.get(name);
  if (value === undefined) return null;
  const recipe = value.match(/--tug-color\(\s*([a-z][a-z0-9-]*)/i);
  if (recipe) return recipe[1];
  const varMatch = value.match(/var\(\s*(--(?:tug7|tugc|tugx|tug)-[\w-]+)/);
  return varMatch ? authoredHue(varMatch[1], defs, seen) : null;
}

function resolved(token: string, defs: Map<string, string>, theme: string) {
  const color = resolveToken(token, defs);
  expect(color, `${theme}: ${token} resolves to no color`).not.toBeNull();
  return color!;
}

describe("dusk-theme ground invariants", () => {
  it("names exactly the catalog's Dusk themes", () => {
    const catalogDusk = THEME_CATALOG.filter((t) => t.mode === "dusk").map((t) => t.name);
    expect(catalogDusk).toEqual(DUSK_THEMES.map((t) => t.theme));
  });

  for (const { theme, tint } of DUSK_THEMES) {
    describe(theme, () => {
      const defs = defsFor(theme);

      it("writes every recipe the build can parse", () => {
        const css = fs.readFileSync(path.join(THEMES_DIR, `${theme}.css`), "utf-8");
        for (const call of findTugColorCalls(css)) {
          const parsed = parseTugColor(call.inner, KNOWN_HUES, ADJACENCY_RING);
          expect(
            parsed.ok ? null : parsed.errors.map((e) => e.message).join("; "),
            `${theme}: --tug-color(${call.inner}) does not parse as postcss-tug-color parses it`,
          ).toBeNull();
        }
      });

      it("sets the card ground on the tint at l: 775, c: 30", () => {
        const expected = tint === "gray" ? 0 : resolveRecipe(`--tug-color(${tint}, l: 775, c: ${GROUND_C})`)!.C;
        for (const token of GROUND_TOKENS) {
          const color = resolved(token, defs, theme);
          expect(color.L, `${theme}: ${token} sits at L ${color.L} rather than the Dusk ground's ${GROUND_L}`).toBeCloseTo(GROUND_L, 5);
          expect(color.C, `${theme}: ${token} has chroma ${color.C} rather than the ground's ${expected}`).toBeCloseTo(expected, 5);
        }
      });

      it("authors every neutral surface and neutral ink on the one tint hue", () => {
        for (const token of [...NEUTRAL_SURFACES, ...NEUTRAL_INKS]) {
          expect(
            authoredHue(token, defs),
            `${theme}: ${token} is not authored on ${tint} — a neutral on a second hue gives a Dusk theme two hues at once`,
          ).toBe(tint);
          if (tint === "gray") {
            expect(resolved(token, defs, theme).C, `${theme}: ${token} carries chroma on the gray member`).toBe(0);
          }
        }
      });

      it("steps elevation both ways from the ground", () => {
        const ground = resolved(GROUND_TOKENS[0], defs, theme);
        for (const token of ABOVE_GROUND) {
          const color = resolved(token, defs, theme);
          expect(color.L, `${theme}: ${token} at L ${color.L} is not above the ground at ${ground.L}`).toBeGreaterThan(ground.L);
        }
        for (const token of BELOW_GROUND) {
          const color = resolved(token, defs, theme);
          expect(color.L, `${theme}: ${token} at L ${color.L} is not below the ground at ${ground.L}`).toBeLessThan(ground.L);
        }
      });

      it("cuts an Accent that holds 3 : 1 against the ground", () => {
        const ground = resolved(GROUND_TOKENS[0], defs, theme);
        const accent = resolved(ACCENT, defs, theme);
        const ratio = computeWcagContrast(
          oklchToHex(accent.L, accent.C, accent.h),
          oklchToHex(ground.L, ground.C, ground.h),
        );
        expect(ratio, `${theme}: the Accent holds ${ratio.toFixed(2)} : 1 on the ground, below ${ACCENT_MIN_CONTRAST} : 1`).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
      });
    });
  }
});
