/**
 * clamp-theme-gamut — bring authored --tug-color() chroma within Display P3.
 *
 * A recipe whose resolved (L, C, h) is out of P3 is already clamped by the browser
 * at render time (CSS gamut-mapping reduces OKLCH chroma holding L + h). This bakes
 * that clamp into the authored `c`: each out-of-P3 recipe's chroma is reduced to the
 * P3 ceiling at its lightness + hue, so the authored number equals what a P3 display
 * actually shows. Visually a no-op on P3 hardware; it only makes the value honest.
 *
 * Only out-of-P3 recipes are touched, and only their `c` changes — hue, lightness,
 * and alpha are preserved, so the diff is exactly the chroma corrections.
 *
 * Usage:
 *   bun run scripts/clamp-theme-gamut.ts            # dry run: count + sample
 *   bun run scripts/clamp-theme-gamut.ts --write    # apply in place
 */

import fs from "fs";
import path from "path";
import {
  HUE_FAMILIES,
  NAMED_GRAYS,
  ADJACENCY_RING,
  authoredFromFrac,
  authoredFromChroma,
  resolveTugColorToOklch,
  isInP3Gamut,
  maxChromaInGamut,
} from "../src/components/tugways/tugcolor";
import { parseTugColor, findTugColorCallsWithWarnings } from "../src/components/tugways/tugcolor";

const TUGDECK = path.resolve(import.meta.dir, "..");

const TARGET_FILES = [
  "styles/themes/ketch.css",
  "styles/themes/barque.css",
  "styles/themes/ironclad.css",
  "styles/themes/sloop.css",
  "styles/themes/caravel.css",
  "styles/themes/collier.css",
  "styles/themes/galleon.css",
  "styles/themes/kayak.css",
  "styles/themes/pinnace.css",
  "styles/themes/skiff.css",
  "styles/tug.css",
  "src/components/tugways/tug-code.css",
  "src/components/tugways/tug-data.css",
  "src/components/tugways/tug-dialog.css",
  "src/components/tugways/tug-dock.css",
];

const KNOWN_HUES: ReadonlySet<string> = new Set([
  ...Object.keys(HUE_FAMILIES),
  "black", "white", "gray", "transparent",
  ...NAMED_GRAYS,
]);

/** Format an oklch lightness/alpha fraction as an authored integer (0–1000). */
const u = (n: number): string => String(authoredFromFrac(n));

interface Stats { files: number; calls: number; clamped: number; }

function clampFile(rel: string, write: boolean, stats: Stats, sample: string[]): void {
  const abs = path.join(TUGDECK, rel);
  const src = fs.readFileSync(abs, "utf-8");
  const { calls } = findTugColorCallsWithWarnings(src);
  if (calls.length === 0) return;

  let result = src;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    const parsed = parseTugColor(call.inner, KNOWN_HUES, ADJACENCY_RING);
    if (!parsed.ok) continue;
    stats.calls++;
    const { color, lightness, chroma, alpha } = parsed.value;
    const { L, C, h } = resolveTugColorToOklch(color.name, color.adjacentName, lightness, chroma, alpha);
    if (C <= 0 || isInP3Gamut(L, C, h)) continue; // achromatic or already in P3

    // The P3 ceiling in authored units. Under absolute chroma the parser already
    // gamut-clamps at resolve time (chromaFromAuthored), so resolved C is in-P3 by
    // construction and this path is effectively a no-op safety net.
    const ceilingH = authoredFromChroma(maxChromaInGamut(L, h, isInP3Gamut), L, h);
    const token = color.adjacentName ? `${color.name}-${color.adjacentName}` : color.name;
    const alphaArg = alpha < 1 ? `, a: ${u(alpha)}` : "";
    const replacement = `--tug-color(${token}, l: ${u(lightness)}, c: ${ceilingH}${alphaArg})`;
    const original = result.slice(call.start, call.end);
    if (sample.length < 6 && replacement !== original) {
      sample.push(`  ${original}\n    → ${replacement}`);
    }
    result = result.slice(0, call.start) + replacement + result.slice(call.end);
    stats.clamped++;
  }

  if (write && result !== src) fs.writeFileSync(abs, result, "utf-8");
  stats.files++;
}

function main(): void {
  const write = process.argv.includes("--write");
  const stats: Stats = { files: 0, calls: 0, clamped: 0 };
  const sample: string[] = [];
  console.log(write ? "Clamping out-of-P3 chroma (writing in place)\n" : "DRY RUN — out-of-P3 chroma → P3 ceiling (no files written)\n");
  for (const rel of TARGET_FILES) clampFile(rel, write, stats, sample);
  if (sample.length) console.log(sample.join("\n") + "\n");
  console.log(`${stats.files} files, ${stats.calls} calls, ${stats.clamped} clamped to P3.`);
  if (!write) console.log("\nRe-run with --write to apply.");
}

main();
