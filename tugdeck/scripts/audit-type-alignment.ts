#!/usr/bin/env bun
/**
 * audit-type-alignment.ts — the vertical-type-rhythm tripwire.
 *
 * `tuglaws/type-alignment.md` says text sharing a row shares a baseline by a
 * mechanism and never by a nudge. This script is that law's static half: it
 * reads the stylesheet text and refuses the three shapes that are provable
 * from it. The law's other half is a probe that reads the rendered DOM, and
 * neither half is sufficient alone — see "What this cannot see" below, which
 * is here so a green run is never read as "the app is aligned".
 *
 * The corpus this was written against was fifteen hand-tuned offsets across
 * nine stylesheets, and the corpus argued with itself: in one file two
 * adjacent rules carried the same `top: 1px`, one explaining that the sans
 * name "centers a hair high against the mono detail" and the other that the
 * mono detail "centers a hair high against the bold sans name". Both cannot
 * be true. Neither was falsifiable, because neither was ever measured. That
 * is the failure mode this guard is against — not any individual pixel, but
 * the absence of anywhere for a pixel to be *wrong*.
 *
 * **Rule 1 — no nudge on a text-carrying rule.**
 *
 * A micro `top` / `bottom`, a small `translateY`, or a length
 * `vertical-align`, in a rule that also carries text. Those are corrections
 * layered over whatever the layout actually did, and the layout is what
 * should be fixed: two font sizes in one row, or two line-box numbers that
 * disagree.
 *
 * "Carries text" is proven from the rule's own declarations — it declares a
 * `font-*`, `line-height`, `letter-spacing`, `text-transform` or `color` —
 * because that is the one thing a static read can be sure of. A magnitude
 * bound comes with it: this fires on offsets small enough to be an optical
 * correction (`<= 3px`, or `<= 0.3em`) and not on a rule moving a box
 * somewhere. Both halves are calibration against a real false-positive set,
 * and the set is in the arc's plan as Table T02: resize-handle hit areas,
 * a sliding indicator, a sparkline rest bar, dotted leaders. None of those
 * declares a type property, and a guard that fired on them is a guard
 * somebody turns off.
 *
 * Keyword `vertical-align` (`top`, `middle`, `baseline`, `text-bottom`) is
 * untouched: it selects a box's alignment mode, which is a mechanism. A
 * length is a correction layered over one.
 *
 * **Rule 2 — no re-derived line box.**
 *
 * `display: inline-flex` + `align-items: center` + a `min-height` /
 * `block-size` / `height` reading a `*-line` token is the `.tug-line-box`
 * stanza, and it was hand-rolled three times before the primitive existed.
 * Each re-derivation is a chance to drift a pixel, and a drifted pixel is
 * what an optical nudge then gets invented to correct.
 *
 * The rule has one exemption, and it is not a loophole: a rule that also
 * *sets* `--tugx-line-box` is the primitive's sanctioned CSS form, for a
 * site whose markup this project does not own. `.tool-call-header
 * .tug-option-group` is that site — a descendant selector against
 * `TugOptionGroup`'s own class, which cannot be given a class from here
 * ([L20]) — so an exemption-free rule 2 would be unsatisfiable. It also uses
 * `block-size` rather than `min-height`, which is why the matcher reads all
 * three properties: a `min-height`-only test would miss the very rule the
 * exemption exists for, and would then never have to honour it.
 *
 * **Rule 3 — a centred tracked legend hands its trailing track back.**
 *
 * CSS puts a `letter-spacing` track after *every* glyph including the last,
 * with nothing after it to absorb one. A tracked run's box is therefore a
 * track wider than its glyphs, and a container centring that box seats the
 * glyphs half a track to the left. Measured on the Z2 endcap legend: a
 * 1.62px track at 9px, so 0.81px of displacement, closed to 0.00px by a
 * trailing negative margin of exactly one track.
 *
 * **The trigger is the track's weight, not centring, and that is the
 * calibration this rule turns on.** The endcap legend declares no
 * `text-align: center` at all — its centring is the flex container's, and no
 * static read of one rule can see a container's decision. A rule keyed on
 * centring would never fire on the very case it exists for. Keyed on
 * `text-transform: uppercase` plus a track at or above
 * {@link HEAVY_TRACK_EM} it fires on the instrument-legend signature and
 * nothing else: that legend is the heaviest track in the tree by a wide
 * margin, and every other tracked label sits at `0.14em` or below — and the
 * only `0.14em` one is not uppercase — where half a track is a fifth of a
 * pixel.
 *
 * Compensation is a negative `margin-inline-end` / `margin-right`, or a
 * `text-indent`. A site on the signature that genuinely needs none — a
 * left-aligned copy, where the trailing track falls into slack and displaces
 * nothing — says so with an `@tug-track-uncompensated:` comment.
 *
 * **The escape comments, and what they are for.**
 *
 * `@tug-optical-nudge: <reason>` excuses rules 1 and 3;
 * `@tug-track-uncompensated: <reason>` excuses rule 3. Either may sit on the
 * rule or in the comment block immediately above it, and an empty reason
 * does not count. The point is not permission — an ornamental glyph whose
 * ink sits low in its own em box is a genuine correction and the law says
 * so. The point is that every remaining correction in the tree is then
 * greppable, countable, and readable as a claim somebody made, rather than
 * invisible among the mechanisms. The convention follows two live ones in
 * this tree: `@tug-renders-on` (read by `scripts/verify-pairings.ts`) and
 * the `@tug-pairings` file header.
 *
 * **What this cannot see.**
 *
 * It reads CSS text, so its reach ends where the text stops proving things:
 *
 *  - A text nudge on a rule that declares no type property escapes rule 1
 *    entirely. Text-carrying-ness in general is not statically decidable —
 *    a selector this script cannot resolve to a text slot is outside it.
 *  - Centring that happens in a parent container escapes any read of the
 *    child's rule, which is why rule 3 is keyed the way it is rather than on
 *    `text-align`.
 *  - A track declared through a custom property (`letter-spacing:
 *    var(--tugx-badge-label-tracking)`) has no magnitude this script can
 *    read, so rule 3 does not weigh it. Every tokenised track in the tree
 *    today is `0.08em` or lighter, well under rule 3's trigger; a heavy one
 *    declared that way would pass unweighed.
 *  - Two rules that separately say sensible things and together misalign a
 *    row are invisible here. So is a row nobody has measured.
 *  - Not one pixel of what actually rendered.
 *
 * All of that is the probe's half: `tests/app-test/baseline-probes.ts`,
 * driven by `at0625-type-baseline.test.ts`, which seats a zero-height strut
 * in each run's inline context and reports the baseline it lands on. The
 * division is not a shortcoming to be engineered away — the static half is
 * cheap, runs on every lint, and catches the shape; the runtime half is
 * expensive, runs on named surfaces, and catches the result.
 *
 * **Why this one exports.** `audit-settle-motion.ts` is the shape this
 * follows in every other respect, but it calls `main()` at module scope, so
 * importing it runs the audit and exits the importing process. This script
 * exports {@link scanCss} and guards its entry with `import.meta.main`, so
 * `scripts/__tests__/audit-type-alignment.test.ts` can feed the matcher
 * fixture strings and prove it catches what it claims and ignores what it
 * claims to ignore. A guard that silently does nothing and a corpus that is
 * genuinely clean produce the same green.
 *
 * Usage:
 *   bun run scripts/audit-type-alignment.ts   (or: bun run audit:type-alignment)
 */

import fs from "fs";
import path from "path";

const TUGDECK = path.resolve(import.meta.dir, "..");

/** Every stylesheet the app ships, source-local and shared alike. */
const SCAN_ROOTS = [path.join(TUGDECK, "src"), path.join(TUGDECK, "styles")];

/**
 * Exploratory surfaces, outside the law's subject and this scan.
 *
 * Matched as path segments rather than as substrings, so a component
 * legitimately named `…-fixtures.css` is not silently excused.
 */
const EXCLUDED_DIRS = new Set(["spikes", "fixtures", "__tests__", "node_modules"]);

/** The file that owns the line-box stanza, and so is exempt from rule 2. */
const LINE_BOX_FILE = "tug-line-box.css";

/**
 * Declaring any of these is what proves, from the CSS text alone, that a
 * rule carries text. `[P07]`: everything a static read cannot prove belongs
 * to the probe, and the docstring says so rather than guessing.
 */
const TYPE_PROPERTIES = new Set([
  "font",
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-transform",
  "color",
]);

/** Above this, an offset is moving a box rather than correcting an optic. */
const MICRO_PX = 3;
const MICRO_EM = 0.3;

/**
 * The track weight at which half a track becomes visible, and so rule 3's
 * trigger. The instrument legend sits at `0.18em`; every other tracked label
 * in the tree sits at `0.14em` or below, and the heaviest of those is not
 * uppercase.
 */
const HEAVY_TRACK_EM = 0.15;

/** The one `vertical-align` length rule 1 sanctions — that token, by name. */
const GLYPH_OFFSET_TOKEN = "--tug-glyph-cap-offset";

/** The line-box slot a sanctioned re-derivation must set. */
const LINE_BOX_TOKEN = "--tugx-line-box";

/**
 * Whether a length value reads a row-height token — the third leg of the
 * line-box stanza.
 *
 * The name must *end* in `-line` or `-line-box`, and that anchoring is the
 * whole precision of rule 2. A mid-string test matches
 * `--tug-line-height-md`, which is a line-HEIGHT token rather than a
 * line-box one, and convicted `.tug-list-row-check` — a fixed-height glyph
 * column pinned with `align-self: flex-start`, which re-derives nothing.
 */
function readsLineBoxToken(value: string): boolean {
  for (const name of value.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    if (/-line(-box)?$/.test(name[1])) return true;
  }
  return false;
}

export interface Hit {
  readonly path: string;
  readonly line: number;
  readonly selector: string;
  readonly rule: 1 | 2 | 3;
  readonly detail: string;
}

/** Every `.css` under `dir`, recursively, in a stable order. */
function styleFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...styleFiles(full));
      continue;
    }
    if (entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

/**
 * Blank out `/* … *​/` comments, preserving every byte offset.
 *
 * Whitespace of equal length rather than deletion, so a declaration's offset
 * still maps to the line it came from — and so a rule quoted inside a
 * docstring (this file's own precedent does the same) is never read as code.
 */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/**
 * Whether an escape comment with a non-empty reason covers the rule whose
 * prelude begins at `preludeStart` in the ORIGINAL (un-blanked) text.
 *
 * "Covers" means the comment sits inside the rule's body or in the run of
 * comment and whitespace immediately above its selector — the two places a
 * reader would look. The reason must be non-empty: an `@tug-optical-nudge:`
 * with nothing after the colon is the annotation without the claim, which is
 * the thing the convention exists to prevent.
 */
function hasEscape(
  raw: string,
  preludeStart: number,
  bodyEnd: number,
  tags: readonly string[],
): boolean {
  // The comment block immediately above the selector: walk back over
  // whitespace and whole comments, and stop at the first thing that is
  // neither. A comment separated from the rule by another declaration is not
  // "immediately above" it.
  let cursor = preludeStart;
  let aboveStart = preludeStart;
  for (;;) {
    let scan = cursor;
    while (scan > 0 && /\s/.test(raw[scan - 1])) scan -= 1;
    if (scan < 2 || raw.slice(scan - 2, scan) !== "*/") break;
    const open = raw.lastIndexOf("/*", scan - 2);
    if (open < 0) break;
    cursor = open;
    aboveStart = open;
  }

  const region = raw.slice(aboveStart, bodyEnd);
  // Read only INSIDE comment spans. A tag matched against the raw region
  // would find its "reason" in whatever followed the colon — including the
  // comment's own `*/`, which made `@tug-optical-nudge: */` read as a
  // non-empty reason and excused the rule it was supposed to convict.
  for (const comment of region.matchAll(/\/\*([\s\S]*?)\*\//g)) {
    for (const tag of tags) {
      const found = new RegExp(`${tag}\\s*:([\\s\\S]*)`).exec(comment[1]);
      if (found !== null && found[1].trim().length > 0) return true;
    }
  }
  return false;
}

/** Every declaration in one block body, as `[property, value]` pairs. */
function declarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  for (const decl of body.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    const name = decl.slice(0, colon).trim().toLowerCase();
    if (name.length === 0) continue;
    out.push([name, decl.slice(colon + 1).trim()]);
  }
  return out;
}

/** One declaration's value by property name, or `null`. */
function valueOf(body: string, property: string): string | null {
  for (const [name, value] of declarations(body)) {
    if (name === property) return value;
  }
  return null;
}

/**
 * A length's magnitude in its own unit, or `null` if it is not a plain
 * length. `0` and `0px` return `0`, which is below every threshold — a rule
 * zeroing an offset is removing a nudge rather than adding one.
 */
function lengthOf(value: string): { magnitude: number; unit: string } | null {
  const match = /^([+-]?[\d.]+)(px|em|rem)?$/.exec(value.trim());
  if (match === null) return null;
  const n = parseFloat(match[1]);
  if (!isFinite(n)) return null;
  return { magnitude: Math.abs(n), unit: match[2] ?? "px" };
}

/**
 * Whether a margin value actually pulls back — the only thing that hands a
 * trailing track to the box beside it.
 *
 * Custom-property NAMES are full of hyphens, so a bare "does it contain a
 * minus sign" read counts `margin-inline-end: var(--tug-space-xs)` — a
 * POSITIVE margin — as compensation, and rule 3 then excuses every tracked
 * legend that happens to carry a trailing gap. Blank the property names
 * before looking for the sign.
 */
function isNegativeLength(value: string): boolean {
  const bare = value.replace(/var\(\s*--[a-z0-9-]+/gi, "var(");
  return /-\s*(?:[\d.]|var\()/.test(bare);
}

/** Whether a length is small enough to be an optical correction. */
function isMicro(value: string): boolean {
  const length = lengthOf(value);
  if (length === null || length.magnitude === 0) return false;
  if (length.unit === "px") return length.magnitude <= MICRO_PX;
  return length.magnitude <= MICRO_EM;
}

/** The `translateY(…)` argument of a `transform`, or `null`. */
function translateYArg(value: string): string | null {
  const match = /translateY\(\s*([^)]*)\)/i.exec(value);
  return match === null ? null : match[1].trim();
}

/**
 * Scan one stylesheet's text for the three rules.
 *
 * Exported so the self-check can feed it fixture strings — the divergence
 * from `audit-settle-motion.ts` that the docstring explains. `rel` is only
 * ever reported back, so a fixture may name itself anything.
 *
 * Deliberately a scanner over the text rather than a parse: every question
 * here is about the declarations of one rule and the selector introducing
 * it, which does not need a CSS object model to answer, and a
 * dependency-free audit is one that cannot fall out of step with the
 * stylesheets it reads.
 */
export function scanCss(raw: string, rel: string): Hit[] {
  const css = blankComments(raw);
  const base = path.basename(rel);
  const hits: Hit[] = [];

  for (const block of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const prelude = block[1];
    const body = block[2];
    const preludeStart = block.index ?? 0;
    const bodyEnd = preludeStart + block[0].length;

    const selectors = prelude
      .split(",")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 0 && !s.startsWith("@"));
    if (selectors.length === 0) continue;
    const subject = selectors[0];

    const lineAt = (search: RegExp): number => {
      const found = search.exec(body);
      let at = 0;
      if (found !== null) {
        // Every property pattern below opens with `(^|;)\s*`, so the match
        // starts at the PREVIOUS declaration's semicolon — a line or more
        // above the thing to delete. Step over the separator so the report
        // lands a reader on the declaration itself.
        at = found.index + (/^[;\s]*/.exec(found[0])?.[0].length ?? 0);
      }
      const offset = preludeStart + prelude.length + 1 + at;
      return css.slice(0, offset).split("\n").length;
    };

    const declared = new Set(declarations(body).map(([name]) => name));
    const carriesText = [...declared].some((name) => TYPE_PROPERTIES.has(name));
    const excused = (tags: readonly string[]): boolean =>
      hasEscape(raw, preludeStart, bodyEnd, tags);

    // ---- Rule 1: a micro offset on a rule that carries text. ---------
    if (carriesText && !excused(["@tug-optical-nudge"])) {
      for (const property of ["top", "bottom"]) {
        const value = valueOf(body, property);
        if (value === null || !isMicro(value)) continue;
        hits.push({
          path: rel,
          line: lineAt(new RegExp(`(^|;)\\s*${property}\\s*:`)),
          selector: subject,
          rule: 1,
          detail: `\`${property}: ${value}\` nudges text`,
        });
      }

      const transform = valueOf(body, "transform");
      const translated = transform === null ? null : translateYArg(transform);
      if (translated !== null && isMicro(translated)) {
        hits.push({
          path: rel,
          line: lineAt(/(^|;)\s*transform\s*:/),
          selector: subject,
          rule: 1,
          detail: `\`translateY(${translated})\` nudges text`,
        });
      }

      const align = valueOf(body, "vertical-align");
      // The one sanctioned length, by token name. Any other `var()` is a
      // length this script cannot resolve, and an unresolvable offset is
      // exactly the thing rule (iv) exists to stop being invented.
      if (
        align !== null &&
        !align.includes(GLYPH_OFFSET_TOKEN) &&
        (lengthOf(align) !== null || align.includes("var("))
      ) {
        hits.push({
          path: rel,
          line: lineAt(/(^|;)\s*vertical-align\s*:/),
          selector: subject,
          rule: 1,
          detail: `\`vertical-align: ${align}\` is a length, not a keyword`,
        });
      }
    }

    // ---- Rule 2: the line-box stanza, re-derived. --------------------
    if (base !== LINE_BOX_FILE) {
      const box = ["min-height", "block-size", "height"]
        .map((p) => valueOf(body, p))
        .find((v) => v !== null && readsLineBoxToken(v));
      if (
        box !== undefined &&
        box !== null &&
        valueOf(body, "display") === "inline-flex" &&
        valueOf(body, "align-items") === "center" &&
        !declared.has(LINE_BOX_TOKEN)
      ) {
        hits.push({
          path: rel,
          line: lineAt(/(^|;)\s*display\s*:/),
          selector: subject,
          rule: 2,
          detail: "re-derives the `.tug-line-box` stanza",
        });
      }
    }

    // ---- Rule 3: a heavy track with nothing handing it back. ---------
    const track = valueOf(body, "letter-spacing");
    const trackLength = track === null ? null : lengthOf(track);
    const heavy =
      trackLength !== null &&
      trackLength.unit !== "px" &&
      trackLength.magnitude >= HEAVY_TRACK_EM;
    if (
      heavy &&
      valueOf(body, "text-transform") === "uppercase" &&
      !excused(["@tug-optical-nudge", "@tug-track-uncompensated"])
    ) {
      // The inline-END axis only: a block-axis margin cannot hand back a
      // horizontal track, and the value has to be negative to hand back
      // anything at all.
      const compensated = ["margin-inline-end", "margin-right"]
        .map((p) => valueOf(body, p))
        .some((v) => v !== null && isNegativeLength(v));
      const indented = valueOf(body, "text-indent") !== null;
      if (!compensated && !indented) {
        hits.push({
          path: rel,
          line: lineAt(/(^|;)\s*letter-spacing\s*:/),
          selector: subject,
          rule: 3,
          detail: `\`letter-spacing: ${track}\` puts a track after the last glyph with nothing handing it back`,
        });
      }
    }
  }

  return hits;
}

function main(): void {
  const files = SCAN_ROOTS.flatMap(styleFiles);
  const repoRoot = path.resolve(TUGDECK, "..");
  const hits = files.flatMap((file) =>
    scanCss(fs.readFileSync(file, "utf8"), path.relative(repoRoot, file)),
  );

  if (hits.length > 0) {
    for (const hit of hits) {
      console.log(
        `${hit.path}:${hit.line} rule=${hit.rule} ${hit.detail} — \`${hit.selector}\``,
      );
    }
    console.log(
      `\naudit:type-alignment FAILED — ${hits.length} finding(s).\n` +
        `  rule 1: a nudge is not an alignment mechanism. Text sharing a row shares one ` +
        `\`font-size\` and one line box, and that is already one baseline — fix the number ` +
        `the row disagrees on. A genuine optical correction on an ornamental glyph carries ` +
        `\`/* @tug-optical-nudge: <what it corrects> */\`.\n` +
        `  rule 2: the line-box stanza lives in \`styles/tug-line-box.css\`. Wear ` +
        `\`.tug-line-box\` and set \`${LINE_BOX_TOKEN}\` to the row's height; a site whose ` +
        `markup this project does not own sets that token and re-declares the stanza.\n` +
        `  rule 3: \`letter-spacing\` puts a track after the LAST glyph too, so a centred ` +
        `tracked legend sits half a track left of centre. Hand the track back with ` +
        `\`margin-inline-end: calc(-1 * <the track>)\`, or say why none is needed with ` +
        `\`/* @tug-track-uncompensated: <reason> */\`.\n` +
        `  The law is \`tuglaws/type-alignment.md\`; the runtime half is ` +
        `\`at0625-type-baseline.test.ts\`.\n` +
        `  A hit is a finding to read, not a reason to loosen the rule.`,
    );
    process.exit(1);
  }

  console.log(`audit:type-alignment ok (${files.length} stylesheets scanned)`);
}

if (import.meta.main) {
  main();
}
