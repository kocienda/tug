#!/usr/bin/env bun
/**
 * audit-settle-motion.ts — the settle pipeline's stylesheet tripwire.
 *
 * The deck's promise is that activating a card in another slot is a translate
 * the compositor performs over layers that already exist. Two stylesheet
 * shapes can break that promise silently, and this script is what keeps a
 * third from being added by someone who did not read the rule.
 *
 * **Rule 1 — no `position: fixed` on anything inside a pane frame.**
 *
 * Every frame carries a standing promoting declaration, which makes it a
 * containing block for its `position: fixed` descendants. A surface that
 * positions from viewport coordinates then positions from the FRAME's corner
 * instead, and it does so silently: nothing throws, nothing logs, the element
 * simply appears in the wrong place — and only on a deck whose frames have
 * moved, which is exactly the state a test fixture is least likely to be in.
 * So the rule is absolute, and the answer for such a surface is to portal it
 * to the canvas overlay root (`canvas-overlay-root.tsx`) or, where it
 * genuinely belongs to the frame and should travel with it, to make it
 * `absolute` — an absolutely positioned descendant follows a transformed
 * ancestor correctly, which is why `TugSheet` stays in the frame.
 *
 * **The rule is scoped by SELECTOR, not by file.** `.tug-pane-exit-ghost` is
 * declared in `tug-pane.css` and is `position: fixed`, and it is correct:
 * the canvas appends it to the frames CONTAINER rather than to a frame, so it
 * is a sibling of every frame and nothing promotes it. A file-scoped rule
 * would fail on it and the rule would be loosened to make the noise stop.
 *
 * What the rule can and cannot prove is worth stating plainly. A selector that
 * names a frame root as an ancestor — `.tug-pane .x`, `.tug-pane-chrome > .y`
 * — provably matches a descendant of a frame, and that is what this catches.
 * A bare `.tug-key-sink { position: fixed }` may or may not render inside a
 * frame depending on who mounts it, and no static read of the CSS can say
 * which. That half is the sampler's: `settle-frame-probe.ts` counts elements
 * computing `position: fixed` under a shown frame on a live deck, and
 * `at0622` reports it. Neither half is sufficient alone.
 *
 * **Rule 2 — nothing but `transform` and `opacity` animates on a frame.**
 *
 * [D9]: the settle window is compositor-only. A `transition` or an `animation`
 * naming any other property, on a selector that can match `.tug-pane` or
 * anything inside one, is a main-thread property on the deck's critical path
 * for the length of a gesture whose frame budget the deck does not control.
 *
 * Two things make this rule readable rather than approximate.
 *
 * An `animation` names `@keyframes`, and the properties are in the keyframes
 * rather than in the rule — so the scan collects every `@keyframes` block's
 * declared properties first and resolves the name through that. A rule that
 * only read the shorthand would pass `animation: tug-pane-border-flash`
 * whatever its keyframes walked, which is exactly the hole [F05] fell into.
 *
 * And a declaration that STANDS DOWN for the settle is not a violation of a
 * law about the settle window. `.tug-pane` carries the [D07] window-shade
 * `transition: height`, which is correct, and which `[data-imposer-settling]
 * .tug-pane { transition: none }` turns off for exactly this window — two
 * clocks on one height being the fold bug that stand-down was written for. So
 * the scan collects the selectors stood down under the settling mark and
 * excuses them, and a hit is a property that really is live while frames move.
 *
 * The excuse is by EXACT selector, deliberately. `[data-imposer-settling]
 * .tug-pane` excuses `.tug-pane` and nothing else — not `.tug-pane-chrome`,
 * not `.tug-pane .x`. A near-miss stand-down that would not actually win the
 * cascade against the offending rule would otherwise excuse it anyway, which
 * is a guard reporting success over a stylesheet that still animates `height`.
 *
 * Usage:
 *   bun run scripts/audit-settle-motion.ts   (or: bun run audit:settle-motion)
 */

import fs from "fs";
import path from "path";

const TUGDECK = path.resolve(import.meta.dir, "..");

/** Every stylesheet the app ships, source-local and shared alike. */
const SCAN_ROOTS = [path.join(TUGDECK, "src"), path.join(TUGDECK, "styles")];

/**
 * The class roots that ARE a pane frame or live inside one.
 *
 * `.tug-pane` is the frame itself. `.tug-pane-chrome` and `.tug-pane-content`
 * are its own interior — a `fixed` descendant of either is as trapped as one
 * directly under the frame, and naming them here means a selector cannot get
 * out from under the rule by starting one level down.
 *
 * A class whose name merely BEGINS with one of these is a different class and
 * is not matched: `.tug-pane-exit-ghost` is not `.tug-pane`, which is the
 * whole reason this is a set of exact class names rather than a prefix test.
 */
const FRAME_ROOTS = new Set(["tug-pane", "tug-pane-chrome", "tug-pane-content"]);

/** [D9]'s complete list. Everything else is a rule-2 hit. */
const COMPOSITOR_PROPERTIES = new Set(["transform", "opacity"]);

/**
 * Shorthand tokens that are never the property being animated.
 *
 * A `transition` shorthand may write its parts in any order, so the scan drops
 * every token it can name — times, easings, counts, fill and direction
 * keywords — and treats what is left as the property. `all` is deliberately
 * NOT here: it animates whatever changes, which is the broadest rule-2
 * violation there is rather than an absence of one.
 */
const TIMING_KEYWORDS = new Set([
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "linear",
  "step-start",
  "step-end",
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
  "forwards",
  "backwards",
  "both",
  "none",
  "running",
  "paused",
  "infinite",
  "allow-discrete",
]);

const SETTLING_MARK = "[data-imposer-settling]";

interface Hit {
  readonly path: string;
  readonly line: number;
  readonly selector: string;
  readonly rule: 1 | 2;
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
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...styleFiles(full));
      continue;
    }
    if (entry.name.endsWith(".css")) out.push(full);
  }
  return out;
}

/** Strip `/* … *​/` comments, so a rule quoted in prose is not read as code. */
function stripComments(css: string): string {
  // Replaced with equal-length whitespace rather than removed, so every byte
  // offset below still maps to the line it came from in the original file.
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/**
 * Whether one comma-separated selector names a frame root as an ANCESTOR.
 *
 * The test is on the selector's compound parts: split on the descendant and
 * child combinators, drop the last part (that is the subject, not an
 * ancestor), and ask whether any earlier part carries one of
 * {@link FRAME_ROOTS} as a class.
 *
 * Dropping the last part is what keeps `.foo .tug-pane { position: fixed }`
 * out of this rule — that declares the FRAME fixed, which is a different
 * claim about a different element, and reporting it here would say something
 * untrue about where the offending element sits.
 */
function namesFrameAncestor(selector: string): boolean {
  const parts = selector
    .replace(/\s*>\s*/g, " ")
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  if (parts.length < 2) return false;
  for (const part of parts.slice(0, -1)) {
    for (const cls of part.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
      if (FRAME_ROOTS.has(cls[1])) return true;
    }
  }
  return false;
}

/**
 * Whether one comma-separated selector can match a frame root or anything
 * inside one — rule 2's test, which is rule 1's without the last-part drop.
 *
 * Rule 1 asks "is the SUBJECT trapped inside a frame?", so it looks only at
 * ancestors. Rule 2 asks "does this animation run on a frame or in one?", and
 * `.tug-pane { transition: height }` is the plainest possible yes.
 */
function touchesFrame(selector: string): boolean {
  for (const cls of selector.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
    if (FRAME_ROOTS.has(cls[1])) return true;
  }
  return false;
}

/**
 * The first non-timing token of each comma-separated segment.
 *
 * That is the property for a `transition` and the `@keyframes` name for an
 * `animation` — the same read either way, because both shorthands put the one
 * identifier that is not a time, an easing or a keyword in the same place.
 * A `var()` or `cubic-bezier()` is blanked first: it carries commas and
 * spaces of its own, and a timing function reading as a property name would
 * make this rule fire on every correct declaration in the corpus.
 */
function leadingIdentifiers(value: string): string[] {
  const out: string[] = [];
  for (const segment of value.replace(/[a-z-]+\([^()]*\)/gi, " ").split(",")) {
    for (const token of segment.trim().split(/\s+/)) {
      if (token.length === 0) continue;
      if (/^-?[\d.]/.test(token)) continue;
      if (TIMING_KEYWORDS.has(token)) continue;
      out.push(token);
      break;
    }
  }
  return out;
}

/** Every declaration's property name in one block body. */
function declaredProperties(body: string): string[] {
  const out: string[] = [];
  for (const decl of body.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    const name = decl.slice(0, colon).trim();
    if (name.length === 0 || name.startsWith("--")) continue;
    out.push(name);
  }
  return out;
}

/** One declaration's value in a block body, by property name, or `null`. */
function valueOf(body: string, property: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;}]*)`, "i").exec(
    body,
  );
  return match === null ? null : match[1].trim();
}

/**
 * What every `@keyframes` in the corpus animates, and which selectors stand
 * their motion down for the settle.
 *
 * Both are corpus-wide rather than per-file on purpose. A component's
 * keyframes and the rule that plays them usually share a file, but
 * `chrome.css` stands down a rule that `tug-pane.css` could just as easily
 * have declared — and a per-file read would call that a violation.
 */
interface MotionContext {
  readonly keyframeProperties: Map<string, Set<string>>;
  readonly stoodDown: Set<string>;
}

function collectMotionContext(files: readonly string[]): MotionContext {
  const keyframeProperties = new Map<string, Set<string>>();
  const stoodDown = new Set<string>();
  // The innermost-block regex below sees a keyframe STEP (`0% { … }`) rather
  // than the `@keyframes` wrapper, so the wrapper's name arrives inside the
  // step's prelude — which is where this reads it from.
  const keyframesName = /@keyframes\s+([A-Za-z0-9_-]+)/;

  for (const file of files) {
    const css = stripComments(fs.readFileSync(file, "utf8"));
    for (const block of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const prelude = block[1];
      const body = block[2];

      const named = keyframesName.exec(prelude);
      if (named !== null) {
        const set = keyframeProperties.get(named[1]) ?? new Set<string>();
        for (const property of declaredProperties(body)) set.add(property);
        keyframeProperties.set(named[1], set);
        continue;
      }

      if (valueOf(body, "transition") !== "none" &&
        valueOf(body, "animation") !== "none") {
        continue;
      }
      for (const selector of prelude
        .split(",")
        .map((s) => s.replace(/\s+/g, " ").trim())) {
        if (!selector.startsWith(`${SETTLING_MARK} `)) continue;
        stoodDown.add(selector.slice(SETTLING_MARK.length + 1).trim());
      }
    }
  }

  return { keyframeProperties, stoodDown };
}

/**
 * Find every `position: fixed` whose enclosing rule is scoped under a frame.
 *
 * Deliberately a scanner over the text rather than a parse: the question is
 * about the selector immediately preceding a declaration block, which does not
 * need a CSS object model to answer, and a dependency-free audit is one that
 * cannot fall out of step with the stylesheets it reads.
 */
function scan(file: string, motion: MotionContext): Hit[] {
  const raw = fs.readFileSync(file, "utf8");
  const css = stripComments(raw);
  const rel = path.relative(path.resolve(TUGDECK, ".."), file);
  const hits: Hit[] = [];

  // Every declaration block, with the text that introduced it. The prelude is
  // whatever stands between the previous block's boundary and this `{`, which
  // for a plain rule is its selector list and for an at-rule is the at-rule.
  const blockOpen = /([^{}]*)\{([^{}]*)\}/g;
  for (const block of css.matchAll(blockOpen)) {
    const prelude = block[1];
    const body = block[2];
    const selectors = prelude
      .split(",")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 0 && !s.startsWith("@"));
    const lineAt = (search: RegExp): number => {
      const declOffset =
        (block.index ?? 0) + prelude.length + 1 + body.search(search);
      return css.slice(0, declOffset).split("\n").length;
    };

    // ---- Rule 1: `position: fixed` under a frame. --------------------
    if (/position\s*:\s*fixed/.test(body)) {
      const line = lineAt(/position\s*:\s*fixed/);
      for (const selector of selectors.filter(namesFrameAncestor)) {
        hits.push({
          path: rel,
          line,
          selector,
          rule: 1,
          detail: "`position: fixed` under a pane frame",
        });
      }
    }

    // ---- Rule 2: non-compositor motion on a frame ([D9]). ------------
    //
    // The subjects are collected per declaration so the report can name the
    // property rather than the rule — "`height`" is actionable where "this
    // block animates something" is a puzzle.
    const offendingProperties = new Set<string>();
    for (const property of ["transition-property", "transition"]) {
      const value = valueOf(body, property);
      if (value === null) continue;
      for (const name of leadingIdentifiers(value)) {
        if (COMPOSITOR_PROPERTIES.has(name)) continue;
        offendingProperties.add(name);
      }
    }
    for (const property of ["animation-name", "animation"]) {
      const value = valueOf(body, property);
      if (value === null) continue;
      for (const name of leadingIdentifiers(value)) {
        // An unknown name animates nothing, and a `@keyframes` this scan
        // never saw is a name that resolves to no rule at run time either.
        for (const animated of motion.keyframeProperties.get(name) ?? []) {
          if (COMPOSITOR_PROPERTIES.has(animated)) continue;
          offendingProperties.add(`${animated} (via ${name})`);
        }
      }
    }
    if (offendingProperties.size === 0) continue;

    const line = lineAt(/(transition|animation)(-property|-name)?\s*:/);
    for (const selector of selectors.filter(touchesFrame)) {
      if (motion.stoodDown.has(selector)) continue;
      for (const property of offendingProperties) {
        hits.push({
          path: rel,
          line,
          selector,
          rule: 2,
          detail: `animates \`${property}\` on a pane frame`,
        });
      }
    }
  }

  return hits;
}

function main(): void {
  const files = SCAN_ROOTS.flatMap(styleFiles);
  const motion = collectMotionContext(files);
  const hits = files.flatMap((file) => scan(file, motion));

  if (hits.length > 0) {
    for (const hit of hits) {
      console.log(
        `${hit.path}:${hit.line} rule=${hit.rule} ${hit.detail} — \`${hit.selector}\``,
      );
    }
    console.log(
      `\naudit:settle-motion FAILED — ${hits.length} finding(s).\n` +
        `  rule 1: the surface positions from the viewport inside a frame that is a containing ` +
        `block for it. Portal it to the canvas overlay root, or make it \`absolute\` if it ` +
        `should travel with the pane.\n` +
        `  rule 2: [D9] — the settle window is compositor-only. Animate \`transform\` or ` +
        `\`opacity\`, or stand the declaration down with ` +
        `\`${SETTLING_MARK} <the same selector> { transition: none }\`.\n` +
        `  A hit is a finding to read, not a reason to loosen the rule.`,
    );
    process.exit(1);
  }

  console.log(`audit:settle-motion ok (${files.length} stylesheets scanned)`);
}

main();
