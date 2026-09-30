/**
 * theme-editor-core.ts — shared Key/Accent re-hue transform.
 *
 * Single source of truth for classifying a theme's selection/action axis (Key)
 * and affordance axis (Accent) tokens and re-hueing them on the TugColor model.
 * Used by:
 *   - scripts/apply-theme-editor.ts (CLI)
 *   - the dev-server POST /__theme-editor/apply endpoint (vite.config.ts), driven
 *     by the Theme Editor card's Apply button
 *
 * Re-hue is computed from an identity-space BASELINE recipe (per-token
 * lightness/chroma with the hue and l/c/a deltas removed) so applying repeatedly
 * with new hues/deltas never compounds — each apply is absolute. The baseline is not
 * a frozen file: the dev-server keeps it live by diff-merging hand edits made
 * directly to the theme CSS back into it (diffMergeBaseline / inverseSeed), so
 * the .css files stay the single source of truth and hand tuning survives Apply.
 */

import {
  HUE_FAMILIES,
  MAX_CHROMA,
  fracFromAuthored,
  chromaFromAuthored,
  authoredFromFrac,
  authoredFromChroma,
  resolveHueAngle,
} from "./src/components/tugways/tugcolor";

const CHROMATIC = new Set(Object.keys(HUE_FAMILIES));

/** A chrome treatment — a TugColor of the Key hue with its own lightness / chroma (/ alpha). */
export interface DuetTreatment {
  l: number;
  c: number;
  a?: number;
}

/**
 * An adjustment off a base color — additive deltas in OKLCH lightness / chroma
 * / alpha units (NOT a chroma multiplier or hue offset). Applied to every rung
 * of an axis: out = clamp(base + delta). Additive so it inverts by subtraction.
 */
export interface DuetAdjust {
  lDelta: number;
  cDelta: number;
  aDelta?: number;
}

export interface DuetSeed {
  keyHue: string;
  /** Lightness/chroma/alpha deltas applied to every Key rung off its base. */
  key: DuetAdjust;
  accentHue: string;
  /** Lightness/chroma/alpha deltas applied to every Accent rung off its base. */
  accent: DuetAdjust;
  /** Title bar / active tab tint (writes --tugx-chrome-key-surface where present). */
  titlebar?: DuetTreatment;
  /** Filled buttons (filled-action surface + border). */
  filled?: DuetTreatment;
  /** Tinted badges (tinted-action surface + border). */
  tinted?: DuetTreatment;
  /**
   * Text-selection wash — the Key-hued fill behind selected text and the
   * editing caret (writes --tug7-surface-selection-primary-normal-plain-rest).
   * Its own lightness / chroma / alpha off the Key hue, independent of the rest
   * of the Key ramp.
   */
  textsel?: DuetTreatment;
}

/** The single token the text-selection treatment owns. */
const TEXTSEL_TOKEN = "--tug7-surface-selection-primary-normal-plain-rest";

/**
 * Which treatment a token belongs to (surface/border only — text/icon stay
 * neutral). Covers BOTH the control family (TugPushButton) and the badge family
 * (TugBadge) so buttons and badges driven by one treatment look identical at rest.
 */
function treatmentGroup(name: string): "filled" | "tinted" | null {
  const isSurfaceOrBorder =
    name.includes("surface-control") || name.includes("element-control-border") ||
    name.includes("surface-badge") || name.includes("element-badge-border");
  if (!isSurfaceOrBorder) return null;
  if (name.includes("filled-action")) return "filled";
  if (name.includes("tinted-action")) return "tinted";
  return null;
}

/** Tokens excluded from any re-hue (signals, neutral tint, on-fill text, incidental). */
function isExcluded(name: string): boolean {
  return (
    name.includes("selection-text") ||
    name.includes("plain-inactive") ||
    name.includes("demoted-danger") ||
    name.includes("demoted-data") ||
    name.includes("demoted-agent") ||
    name.includes("-atom-") ||
    name.includes("ansi") ||
    name.includes("-option-") ||
    name.includes("confirmed") ||
    name.includes("inspector") ||
    name.includes("preview") ||
    name.includes("snap") ||
    name.includes("findmatch")
  );
}

/** Key = the selection / primary-action axis. */
function isKey(name: string): boolean {
  if (
    name.includes("selection-primary-normal-plain-rest") ||
    name.includes("selection-primary-normal-selected-rest") ||
    name.includes("selection-primary-normal-selected-hover") ||
    name.includes("selection-primary-normal-quiet-rest") ||
    name.includes("selection-primary-normal-quiet-hover") ||
    name.includes("selection-primary-normal-quiet-strong") ||
    name.includes("selection-primary-demoted-action")
  ) return true;
  if (name.includes("-tone-") && name.includes("-active-rest")) return true;
  if (name.includes("text-normal-link-rest") || name.includes("text-normal-link-hover")) return true;
  if (name.includes("-action-")) return true;
  if (name.includes("toggle-") && (name.includes("-on-") || name.includes("-active-"))) return true;
  if (name.includes("-normal-highlighted") || name.includes("-normal-selected")) return true;
  if (name.includes("slider-fill-normal-range")) return true;
  if (name.includes("field-border-normal-plain-active")) return true;
  if (name.includes("-drop") && !name.includes("stroke")) return true;
  return false;
}

/** Accent = the affordance axis. */
function isAccent(name: string): boolean {
  if (name.includes("-accent")) return true;
  if (name.includes("highlight-stroke-normal-drop")) return true;
  if (name.includes("shadow-normal-flash")) return true;
  if (name.includes("highlight-primary-normal-flash")) return true;
  return false;
}

export type DuetRole = "key" | "accent" | null;

/** Classify a token name into its duet role (or null = leave alone). */
export function classifyRole(name: string): DuetRole {
  if (isExcluded(name)) return null;
  if (isKey(name)) return "key";
  if (isAccent(name)) return "accent";
  return null;
}

interface Parsed { l: number; c: number; a: number | null; }

/** Parse the inner of `--tug-color(...)`; returns null for achromatic / unknown hues. */
function parseTugColor(inner: string): Parsed | null {
  const parts = inner.split(",").map((s) => s.trim());
  const [name, adjacent] = parts[0].split("-");
  if (!CHROMATIC.has(name)) return null;
  // Collect raw authored ints first — chroma is absolute but gamut-clamped, so its
  // resolve still needs lightness known (args may arrive in any order).
  let lRaw: number | undefined;
  let cRaw = 0;
  let aRaw: number | undefined;
  for (const p of parts.slice(1)) {
    const m = p.match(/^([lca])\s*:\s*([\d.]+)$/);
    if (!m) continue;
    const v = parseFloat(m[2]);
    if (m[1] === "l") lRaw = v;
    else if (m[1] === "c") cRaw = v;
    else aRaw = v;
  }
  const l = lRaw === undefined ? 0.5 : fracFromAuthored(lRaw);
  const angle = resolveHueAngle(name, adjacent);
  const c = angle === undefined ? 0 : chromaFromAuthored(cRaw, l, angle);
  const a = aRaw === undefined ? null : fracFromAuthored(aRaw);
  return { l, c, a };
}

/** Format the inner of `--tug-color(...)` — `hue, l: X, c: Y[, a: Z]` on the 0–1000 scale. */
function formatInner(hue: string, l: number, c: number, a: number | null): string {
  // Clamp every axis to its valid oklch range (treatment deltas and chroma scaling
  // can otherwise overshoot), then emit authored 0–1000 units. Chroma is absolute
  // (a fraction of MAX_CHROMA), gamut-clamped against the hue angle at this L.
  const clamp = (n: number, hi: number): number => Math.max(0, Math.min(hi, n));
  const L = clamp(l, 1);
  const [name, adjacent] = hue.split("-");
  const angle = resolveHueAngle(name, adjacent);
  const cAuthored = angle === undefined ? 0 : authoredFromChroma(clamp(c, MAX_CHROMA), L, angle);
  const parts = [`l: ${authoredFromFrac(L)}`, `c: ${cAuthored}`];
  if (a !== null) parts.push(`a: ${authoredFromFrac(clamp(a, 1))}`);
  return `${hue}, ${parts.join(", ")}`;
}

function formatTugColor(hue: string, l: number, c: number, a: number | null): string {
  return `--tug-color(${formatInner(hue, l, c, a)})`;
}

/** The hue head of a `--tug-color(...)` inner (`blue-light, i: 50` -> `blue`). */
function hueOf(inner: string): string {
  return inner.split(",")[0].trim().split("-")[0];
}

/**
 * Extract the baseline recipe from a clean (pre-duet) theme CSS: tokenName ->
 * the original `--tug-color(...)` inner, for every duet-classified chromatic token.
 */
export function extractBaseline(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(--tug7-[\w-]+)\s*:\s*--tug-color\(([^)]*)\)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const name = m[1];
    if (classifyRole(name) === null) continue;
    if (parseTugColor(m[2]) === null) continue; // achromatic wash — not part of the duet
    out[name] = m[2].trim();
  }
  return out;
}

/**
 * Apply a duet to a theme's current CSS, computing every duet token absolutely
 * from the baseline recipe (so repeated applies never compound). Returns the new
 * CSS plus counts.
 */
export function applyDuet(
  currentCss: string,
  baseline: Record<string, string>,
  seed: DuetSeed,
): { css: string; keyCount: number; accentCount: number } {
  let css = currentCss;
  let keyCount = 0;
  let accentCount = 0;

  const replaceToken = (name: string, value: string): boolean => {
    const tokenRe = new RegExp(
      `(${name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s*:\\s*)--tug-color\\([^)]*\\)(\\s*;)`,
    );
    if (!tokenRe.test(css)) return false;
    css = css.replace(tokenRe, `$1${value}$2`);
    return true;
  };

  for (const [name, inner] of Object.entries(baseline)) {
    const role = classifyRole(name);
    if (!role) continue;
    const parsed = parseTugColor(inner);
    if (!parsed) continue;

    // Text-selection treatment owns the plain-rest wash directly: a TugColor of
    // the Key hue at its own l / c / a. Overrides the generic Key re-hue for this
    // one token.
    if (seed.textsel && name === TEXTSEL_TOKEN) {
      const a = seed.textsel.a !== undefined ? seed.textsel.a : parsed.a;
      if (replaceToken(name, formatTugColor(seed.keyHue, seed.textsel.l, seed.textsel.c, a))) {
        keyCount++;
      }
      continue;
    }

    // Chrome treatments override the Key re-hue for the filled/tinted surface +
    // border tokens: a TugColor of the Key hue at the treatment's own l/c, with
    // hover/active/disabled keeping their baseline lightness/chroma delta from rest
    // so the interaction ramp survives. Text/icon stay on the normal Key re-hue.
    const tg = treatmentGroup(name);
    const tr = tg ? seed[tg] : undefined;
    if (tg && tr) {
      const restName = name.replace(/-(hover|active|disabled)$/, "-rest");
      const baseThis = parsed;
      const baseRest = parseTugColor(baseline[restName] ?? inner);
      if (baseRest) {
        const dl = baseThis.l - baseRest.l;
        const dc = baseThis.c - baseRest.c;
        const l = tr.l + dl;
        const c = Math.max(0, tr.c + dc);
        // Tinted surface rest takes the treatment's alpha; everything else keeps
        // its own baseline alpha (so border/hover translucency is preserved).
        let alpha = baseThis.a;
        if (tg === "tinted" && name === restName && name.includes("surface")) {
          alpha = tr.a !== undefined ? tr.a : baseThis.a;
        }
        if (replaceToken(name, formatTugColor(seed.keyHue, l, c, alpha))) keyCount++;
        continue;
      }
    }

    const hue = role === "key" ? seed.keyHue : seed.accentHue;
    const adj = role === "key" ? seed.key : seed.accent;
    const l = parsed.l + adj.lDelta;
    const c = parsed.c + adj.cDelta;
    const a = parsed.a === null ? null : parsed.a + (adj.aDelta ?? 0);
    const rewritten = formatTugColor(hue, l, c, a);
    if (replaceToken(name, rewritten)) {
      if (role === "key") keyCount++;
      else accentCount++;
    }
  }

  // Title-bar treatment — a single token (--tugx-chrome-key-surface), present
  // only in the light themes. Written directly (no baseline; no states).
  if (seed.titlebar) {
    replaceToken(
      "--tugx-chrome-key-surface",
      formatTugColor(seed.keyHue, seed.titlebar.l, seed.titlebar.c, seed.titlebar.a ?? null),
    );
  }

  return { css, keyCount, accentCount };
}

/**
 * Recover the identity-space recipe inner for a single token from its current
 * (post-apply) value — the inverse of applyDuet's generic Key/Accent transform:
 * subtract the intensity / tone / alpha deltas, keep the token's own hue. Because
 * the transform is purely additive, this is EXACT (no rounding drift), so hand
 * edits always fold back losslessly regardless of the applied adjustment.
 *
 * Treatment-group tokens (filled/tinted/textsel/titlebar) are written by
 * applyDuet via a ramp-collapsing formula that is not cleanly invertible — they
 * are inverted here with the same generic deltas, which is exact when no
 * adjustment is applied (the normal hand-tuning state) and approximate otherwise.
 */
export function inverseSeed(inner: string, seed: DuetSeed, role: DuetRole): string {
  const parsed = parseTugColor(inner);
  if (!parsed || !role) return inner;
  const adj = role === "key" ? seed.key : seed.accent;
  const l = parsed.l - adj.lDelta;
  const c = parsed.c - adj.cDelta;
  const a = parsed.a === null ? null : parsed.a - (adj.aDelta ?? 0);
  return formatInner(hueOf(inner), l, c, a);
}

/**
 * Fold hand edits made directly to a theme's CSS back into the identity-space
 * baseline recipe, so the Theme Editor's Apply re-hues them instead of clobbering
 * them. Diff the live CSS against the editor's own last output (lastGenCss):
 * tokens it has not touched keep the exact stored recipe; tokens that differ are
 * hand edits, inverse-transformed by the seed that was applied to produce them.
 */
export function diffMergeBaseline(
  currentCss: string,
  lastGenCss: string,
  identityBaseline: Record<string, string>,
  appliedSeed: DuetSeed,
): Record<string, string> {
  const live = extractBaseline(currentCss);
  const lastGen = extractBaseline(lastGenCss);
  const merged: Record<string, string> = { ...identityBaseline };
  for (const [name, inner] of Object.entries(live)) {
    const handEdited = lastGen[name] !== inner;
    if (handEdited || !(name in merged)) {
      merged[name] = inverseSeed(inner, appliedSeed, classifyRole(name));
    }
  }
  return merged;
}

/** An identity seed — re-hue to the token's own hue with zero l/c/a deltas. */
export function identitySeed(): DuetSeed {
  const zero: DuetAdjust = { lDelta: 0, cDelta: 0, aDelta: 0 };
  return { keyHue: "blue", key: { ...zero }, accentHue: "blue", accent: { ...zero } };
}

// ---------------------------------------------------------------------------
// Re-hue — derive a theme family member from a base theme.
//
// Tokens carry absolute OKLCH lightness (l) and chroma (c) directly, so deriving
// a sibling is a pure hue rotation that keeps each token's own l/c — "ironclad at
// seafoam" reads the same as ironclad, just greener — the family-from-one-base model.
// ---------------------------------------------------------------------------

/** The dominant chromatic hue among an axis's tokens (the theme's brand hue). */
function dominantHue(counts: Record<string, number>): string | null {
  let best: string | null = null;
  let max = 0;
  for (const [hue, n] of Object.entries(counts)) {
    if (n > max) { max = n; best = hue; }
  }
  return best;
}

const angleOf = (hue: string): number | undefined => HUE_FAMILIES[hue];

/** Smallest unsigned angle between two hue angles (degrees, wrapping). */
function circularDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/** The named base hue nearest a given angle. */
function nearestHue(angle: number): string {
  const a = ((angle % 360) + 360) % 360;
  let best = "blue";
  let min = Infinity;
  for (const [hue, deg] of Object.entries(HUE_FAMILIES)) {
    const d = circularDist(a, deg);
    if (d < min) { min = d; best = hue; }
  }
  return best;
}

/** Two used hues are "linked" into the same brand cluster if within this many
 *  degrees — small enough that an isolated signal hue (red/amber/green, tens of
 *  degrees from the brand) never joins, large enough to bridge the gaps within a
 *  spread brand family (e.g. sloop's blue→sapphire→indigo→violet, ≤10° steps). */
const BRAND_LINK = 20;
/** Accent window stays tight so a warning amber next to an orange accent is left
 *  as a signal. */
const ACCENT_BRAND_WINDOW = 8;

/** Grow the brand cluster outward from a seed hue through the USED hues, linking
 *  any used hue within BRAND_LINK of one already in the cluster. */
function brandCluster(seed: string, used: Set<string>): Set<string> {
  const seedAngle = angleOf(seed);
  if (seedAngle === undefined) return new Set();
  const cluster = new Set<string>([seed]);
  const queue = [seed];
  while (queue.length) {
    const h = queue.pop()!;
    const ha = angleOf(h)!;
    for (const u of used) {
      const ua = angleOf(u);
      if (ua === undefined || cluster.has(u)) continue;
      if (circularDist(ua, ha) <= BRAND_LINK) {
        cluster.add(u);
        queue.push(u);
      }
    }
  }
  return cluster;
}

/** The representative Key token whose color the base editor sets explicitly —
 *  the filled-action fill (the vivid chip / toggle color seen in the chrome).
 *  Anchoring scales the whole Key ramp so this token lands on the chosen color. */
const ANCHOR_KEY_TOKEN = "--tug7-surface-control-primary-filled-action-rest";

/** An explicit target color for the Key ramp's anchor token, in absolute OKLCH.
 *  When supplied to {@link deriveTheme}, the whole Key cluster scales so the
 *  anchor token becomes exactly this chroma + lightness (its hue comes from
 *  `targetKeyHue`); the ramp keeps its shape. This is how the base editor's
 *  "set the key color" works — the rest of the ramp follows proportionally. */
export interface KeyAnchor {
  /** Absolute OKLCH chroma the anchor token should take. */
  c: number;
  /** Absolute OKLCH lightness the anchor token should take. */
  l: number;
}

export interface DeriveResult {
  css: string;
  count: number;
  /** The base theme's detected Key / Accent brand hues that were rotated. */
  baseKeyHue: string | null;
  baseAccentHue: string | null;
}

/**
 * Derive a theme from a base theme's CSS by rotating its brand hues to new ones,
 * preserving each token's perceived chroma + lightness.
 *
 * Auto-detects the base's dominant Key and Accent brand hues, then rotates EVERY
 * chromatic token near those hues — the selection/action ramp, the treatments,
 * AND the surface/chrome tints (a near-Key hue), so the whole theme picks up the
 * new hue like the Xcode accent themes — by the SAME angle delta as the Key (so a
 * surface offset from the Key is preserved), at the i/t that hold the same
 * absolute C / L. Far-off hues (red/amber/green signals, syntax, data-viz) and
 * grays are left untouched. `targetAccentHue` defaults to the base accent.
 */
export function deriveTheme(
  baseCss: string,
  targetKeyHue: string,
  targetAccentHue?: string,
  keyAnchor?: KeyAnchor,
): DeriveResult {
  // Set the key color explicitly (base editor): scale the Key ramp so its anchor
  // token lands on the chosen C / L, keeping the ramp's shape. cScale/lScale are
  // 1.0 (identity) when no anchor is given — so deriving a sibling holds the base
  // ramp untouched and only rotates hue.
  let cScale = 1;
  let lScale = 1;
  if (keyAnchor) {
    const am = new RegExp(`${ANCHOR_KEY_TOKEN}\\s*:\\s*--tug-color\\(([^)]*)\\)`).exec(baseCss);
    const ap = am ? parseTugColor(am[1]) : null;
    if (ap) {
      if (ap.c > 0) cScale = keyAnchor.c / ap.c;
      if (ap.l > 0) lScale = keyAnchor.l / ap.l;
    }
  }
  // 1. Detect the base's Key / Accent brand hues from the duet-classified tokens,
  //    and collect every chromatic hue the theme uses.
  const keyHues: Record<string, number> = {};
  const accentHues: Record<string, number> = {};
  const usedHues = new Set<string>();
  const scan = /(--tug7-[\w-]+)\s*:\s*--tug-color\(([^)]*)\)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(baseCss)) !== null) {
    if (parseTugColor(m[2]) === null) continue;
    const hue = hueOf(m[2]);
    usedHues.add(hue);
    const role = classifyRole(m[1]);
    if (role === "key") keyHues[hue] = (keyHues[hue] ?? 0) + 1;
    else if (role === "accent") accentHues[hue] = (accentHues[hue] ?? 0) + 1;
  }
  const baseKeyHue = dominantHue(keyHues);
  const baseAccentHue = dominantHue(accentHues);
  const accentTarget = targetAccentHue ?? baseAccentHue ?? targetKeyHue;

  // The Key brand is the whole cluster of related hues around the Key (so a
  // spread blue→indigo→violet identity rotates together); the Accent stays a
  // tight single hue (so an adjacent warning signal is not swept in).
  const keyCluster = baseKeyHue ? brandCluster(baseKeyHue, usedHues) : new Set<string>();
  const keyAngle = baseKeyHue ? angleOf(baseKeyHue) : undefined;
  const accentAngle = baseAccentHue ? angleOf(baseAccentHue) : undefined;
  const keyDelta = keyAngle !== undefined ? (angleOf(targetKeyHue) ?? keyAngle) - keyAngle : 0;
  const accentDelta = accentAngle !== undefined ? (angleOf(accentTarget) ?? accentAngle) - accentAngle : 0;

  // 2. Rotate every brand-family chromatic token by its axis's angle delta,
  //    holding C / L. The token's own hue is rotated (not snapped to the target),
  //    so a surface's offset from the Key survives the rotation.
  let count = 0;
  const css = baseCss.replace(
    /(--tug7-[\w-]+)(\s*:\s*)--tug-color\(([^)]*)\)(\s*;)/g,
    (full, name, sep, inner, semi) => {
      const parsed = parseTugColor(inner);
      if (!parsed) return full; // achromatic / unknown hue — keep
      const hue = hueOf(inner);
      const deg = angleOf(hue);
      if (deg === undefined) return full;
      let target: string | null = null;
      let isKey = false;
      if (keyCluster.has(hue)) {
        target = nearestHue(deg + keyDelta);
        isKey = true;
      } else if (accentAngle !== undefined && circularDist(deg, accentAngle) <= ACCENT_BRAND_WINDOW) {
        target = nearestHue(deg + accentDelta);
      }
      if (!target) return full; // signal / syntax / far hue — keep
      const c = parsed.c * (isKey ? cScale : 1);
      const l = parsed.l * (isKey ? lScale : 1);
      count++;
      return `${name}${sep}${formatTugColor(target, l, c, parsed.a)}${semi}`;
    },
  );

  return { css, count, baseKeyHue, baseAccentHue };
}

/** Validate a hue name is a known TugColor hue. */
export function isKnownHue(hue: string): boolean {
  return CHROMATIC.has(hue);
}
