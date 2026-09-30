#!/usr/bin/env bun
/**
 * apply-theme-editor.ts — re-hue a theme's Key (selection/action) and Accent
 * (affordance) axes to a chosen TugColor hue, with additive lightness/chroma
 * deltas off each rung's base (OKLCH units, NOT a chroma multiplier).
 *
 * Computes every token absolutely from an identity-space baseline recipe, kept
 * live by diff-merging hand edits to the .css back in (so repeated applies never
 * compound and hand tuning survives). Shares the transform and the per-theme
 * state file with the dev-server POST /__theme-editor/apply endpoint via
 * theme-editor-core.ts.
 *
 * Deltas are on the 0–1000 --tug-color() authoring scale.
 *
 * Usage:
 *   bun run scripts/apply-theme-editor.ts <theme> <keyHue> <keyCDelta> <accentHue> <accentCDelta> [keyLDelta] [accentLDelta]
 *   bun run scripts/apply-theme-editor.ts ironclad cobalt -20 orange -30
 *   bun run scripts/apply-theme-editor.ts ketch purple 0 sky 0 -50 40
 */

import fs from "fs";
import path from "path";
import {
  applyDuet,
  diffMergeBaseline,
  extractBaseline,
  identitySeed,
  isKnownHue,
  type DuetSeed,
} from "../theme-editor-core";
import { fracFromAuthored, authoredFromFrac } from "../src/components/tugways/tugcolor";

interface ThemeEditorEntry {
  identityBaseline: Record<string, string>;
  appliedSeed: DuetSeed;
  lastGenCss: string;
}
type ThemeEditorState = Record<string, ThemeEditorEntry>;

const [, , theme, keyHue, keyCStr, accentHue, accentCStr, keyLStr, accentLStr] =
  process.argv;
if (!theme || !keyHue || keyCStr === undefined || !accentHue || accentCStr === undefined) {
  console.error("usage: apply-theme-editor.ts <theme> <keyHue> <keyCDelta> <accentHue> <accentCDelta> [keyLDelta] [accentLDelta]");
  process.exit(1);
}
if (!isKnownHue(keyHue) || !isKnownHue(accentHue)) {
  console.error(`unknown hue: ${isKnownHue(keyHue) ? accentHue : keyHue}`);
  process.exit(1);
}

// Deltas are absolute OKLCH nudges (×1000, like lightness) — not the relative
// chroma value scale — since one delta applies across many tokens of differing
// hue/lightness. Stored as oklch fractions.
const seed: DuetSeed = {
  keyHue,
  key: { cDelta: fracFromAuthored(parseFloat(keyCStr)), lDelta: keyLStr ? fracFromAuthored(parseFloat(keyLStr)) : 0, aDelta: 0 },
  accentHue,
  accent: { cDelta: fracFromAuthored(parseFloat(accentCStr)), lDelta: accentLStr ? fracFromAuthored(parseFloat(accentLStr)) : 0, aDelta: 0 },
};

const themesDir = path.resolve(import.meta.dir, "..", "styles", "themes");
const themeFile = path.join(themesDir, `${theme}.css`);
const statePath = path.join(themesDir, "theme-editor-state.json");

if (!fs.existsSync(themeFile)) {
  console.error(`no theme file: ${themeFile}`);
  process.exit(1);
}

const state: ThemeEditorState = (() => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8")) as ThemeEditorState;
  } catch {
    return {};
  }
})();

const current = fs.readFileSync(themeFile, "utf-8");
const prior = state[theme] ?? {
  identityBaseline: extractBaseline(current),
  appliedSeed: identitySeed(),
  lastGenCss: current,
};
const baseline = diffMergeBaseline(current, prior.lastGenCss, prior.identityBaseline, prior.appliedSeed);
const { css, keyCount, accentCount } = applyDuet(current, baseline, seed);
fs.writeFileSync(themeFile, css);
state[theme] = { identityBaseline: baseline, appliedSeed: seed, lastGenCss: css };
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
const del = (n: number): string => `${n >= 0 ? "+" : ""}${authoredFromFrac(n)}`;
console.log(
  `${theme}: re-hued ${keyCount} Key -> ${keyHue} (c${del(seed.key.cDelta)}, l${del(seed.key.lDelta)}), ` +
    `${accentCount} Accent -> ${accentHue} (c${del(seed.accent.cDelta)}, l${del(seed.accent.lDelta)})`,
);
