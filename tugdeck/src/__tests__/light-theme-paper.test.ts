/**
 * The paper invariants of the three light themes — harmony, aria and vivace.
 *
 * A light field carries its hue as a wash the whole screen shares, so the one
 * thing a light theme cannot afford is a tinted field: at the top of the
 * lightness range the same authored `c` that reads as a whisper on a dark
 * ground reads as a color, and a dozen fields each wearing a little of it add
 * up to a screen that is two hues rather than one. The settlement is paper:
 * every field is a tinted NEUTRAL on the theme's single tint hue, and the Key
 * hue survives only in the marks — badges, atoms, the focus ring, the caret,
 * the selection wash.
 *
 * This file guards the three numbers that settlement rests on, so a later
 * retune has to argue with a named failure rather than quietly undo it:
 *
 * - The chroma ceiling, C ≤ 0.007. Above it a field stops being paper and
 *   starts being a color. It is a RESOLVED chroma, because authored `c` is a
 *   fraction of MAX_CHROMA and what the eye gets is the resolved number.
 * - The elevation ladder. Four rungs, one lightness each, so depth on a light
 *   screen is read from lightness alone rather than from saturation. The
 *   inactive lid is LIGHTER than the focused band, not darker: on paper the
 *   focused thing is the one with more ink, so an unfocused card recedes by
 *   bleaching rather than by darkening.
 * - One hue per theme across every field. This is the invariant that was
 *   actually broken before: fields authored on the Key hue beside fields
 *   authored on the tint gave every light theme two hues at once.
 *
 * The hue assertion reads the hue NAME authored in the recipe rather than the
 * resolved `h` angle. At `c: 4` the resolved angle is numerically real and
 * perceptually meaningless, and the inactive lid is authored `gray`, which has
 * no hue to compare at all.
 *
 * Resolution goes through the contrast audit's own `buildDefs` / `resolveToken`
 * rather than a second parser, so a `var()` chain through a `--tugx-*` alias
 * resolves the way the browser resolves it.
 */
import { describe, it, expect } from "bun:test";
import path from "node:path";
import { buildDefs, resolveToken } from "../../scripts/audit-theme-contrast";

const THEMES_DIR = path.join(import.meta.dir, "../../styles/themes");

/** The three light themes and the tint hue each one's fields are authored on. */
const LIGHT_THEMES: ReadonlyArray<{ theme: string; tint: string }> = [
  { theme: "harmony", tint: "indigo" },
  { theme: "aria", tint: "orchid" },
  { theme: "vivace", tint: "cyan" },
];

/**
 * Every field token the chroma ceiling and the one-hue rule apply to.
 *
 * `screen` — the tooltip surface — is here for the ceiling and the hue, but not
 * for the ladder below: it is the light themes' documented exception to the
 * elevation ladder and sits at its own lightness. That exception is about
 * LIGHTNESS. A tooltip is still a field, so the chroma ceiling applies to it
 * exactly as it does to the rest.
 */
const FIELD_TOKENS = [
  "--tug7-surface-global-primary-normal-content-rest",
  "--tug7-surface-global-primary-normal-default-rest",
  "--tug7-surface-global-primary-normal-raised-rest",
  "--tug7-surface-global-primary-normal-overlay-rest",
  "--tug7-surface-global-primary-normal-sunken-rest",
  "--tugx-chrome-key-surface",
  "--tug7-surface-card-primary-normal-status-rest",
  "--tug7-surface-card-primary-normal-controlbar-rest",
  "--tug7-surface-card-primary-normal-block-rest",
  "--tug7-surface-card-primary-normal-well-rest",
  "--tug7-surface-global-primary-normal-screen-rest",
] as const;

/** A field is paper below this resolved chroma and a color above it. */
const CHROMA_CEILING = 0.007;

/** The elevation ladder: one lightness per rung, read from lightness alone. */
const LADDER: ReadonlyArray<{ rung: string; L: number; tokens: string[] }> = [
  {
    rung: "content",
    L: 0.985,
    tokens: [
      "--tug7-surface-global-primary-normal-content-rest",
      "--tug7-surface-global-primary-normal-default-rest",
      "--tug7-surface-global-primary-normal-raised-rest",
      "--tug7-surface-global-primary-normal-overlay-rest",
      "--tug7-surface-card-primary-normal-well-rest",
    ],
  },
  {
    rung: "rail + lid band",
    L: 0.965,
    tokens: [
      "--tug7-surface-global-primary-normal-sunken-rest",
      "--tugx-chrome-key-surface",
      "--tug7-surface-card-primary-normal-status-rest",
      "--tug7-surface-card-primary-normal-block-rest",
    ],
  },
  {
    rung: "control band (Z0)",
    L: 0.955,
    tokens: ["--tug7-surface-card-primary-normal-controlbar-rest"],
  },
] as const;

const INACTIVE_LID = "--tug7-surface-card-primary-normal-titlebar-inactive";
const FOCUSED_LID_BAND = "--tugx-chrome-key-surface";

const defsFor = (theme: string) => buildDefs(path.join(THEMES_DIR, `${theme}.css`));

/**
 * The hue NAME authored in a token's --tug-color() recipe, following the same
 * var() chain resolveToken follows. Null for a token that resolves to no recipe.
 */
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

describe("light-theme paper invariants", () => {
  for (const { theme, tint } of LIGHT_THEMES) {
    describe(theme, () => {
      const defs = defsFor(theme);

      it("holds every field below the paper chroma ceiling", () => {
        for (const token of FIELD_TOKENS) {
          const color = resolveToken(token, defs);
          expect(color, `${theme}: ${token} resolves to no color`).not.toBeNull();
          expect(
            color!.C,
            `${theme}: ${token} has chroma ${color!.C}, above the paper ceiling of ${CHROMA_CEILING} — a field this saturated reads as a color rather than as tinted paper`,
          ).toBeLessThanOrEqual(CHROMA_CEILING);
        }
      });

      it("authors every field on the theme's one tint hue", () => {
        for (const token of FIELD_TOKENS) {
          expect(
            authoredHue(token, defs),
            `${theme}: ${token} is not authored on ${tint} — a field on a second hue is what gives a light theme two hues at once`,
          ).toBe(tint);
        }
      });

      it("holds the elevation ladder at one lightness per rung", () => {
        for (const { rung, L, tokens } of LADDER) {
          for (const token of tokens) {
            const color = resolveToken(token, defs);
            expect(color, `${theme}: ${token} resolves to no color`).not.toBeNull();
            expect(
              color!.L,
              `${theme}: ${token} sits at L ${color!.L} rather than the ${rung} rung's ${L}`,
            ).toBeCloseTo(L, 5);
          }
        }
      });

      it("bleaches the inactive lid lighter than the focused band", () => {
        const inactive = resolveToken(INACTIVE_LID, defs);
        const focused = resolveToken(FOCUSED_LID_BAND, defs);
        expect(inactive, `${theme}: ${INACTIVE_LID} resolves to no color`).not.toBeNull();
        expect(focused, `${theme}: ${FOCUSED_LID_BAND} resolves to no color`).not.toBeNull();
        expect(
          inactive!.L,
          `${theme}: the inactive lid at L ${inactive!.L} is not lighter than the focused band at L ${focused!.L} — an unfocused card recedes by bleaching, not by darkening`,
        ).toBeGreaterThan(focused!.L);
      });
    });
  }
});
