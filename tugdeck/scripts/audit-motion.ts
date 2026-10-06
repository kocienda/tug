#!/usr/bin/env bun
/**
 * audit-motion.ts — the deck's stylesheet motion tripwire.
 *
 * Six rules: two about the settle window, two about every loop that runs for
 * as long as the deck is up, one about who makes the deck's motion at all, and
 * one about which motion is allowed to run on layout.
 * The first four share a scanner because they ask the same question of the
 * same text: what does this declaration put on the main thread, and for how
 * long.
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
 * **The rule is scoped by SELECTOR, not by file.** A class declared in
 * `tug-pane.css` may be `position: fixed` and correct, when the canvas
 * appends its element to the frames CONTAINER rather than to a frame: it is a
 * sibling of every frame and nothing promotes it. A file-scoped rule would
 * fail on it and the rule would be loosened to make the noise stop.
 *
 * What the rule can and cannot prove is worth stating plainly. A selector that
 * names a frame root as an ancestor — `.tug-pane .x`, `.tug-pane-chrome > .y`
 * — provably matches a descendant of a frame, and that is what this catches.
 * A bare `.tug-key-sink { position: fixed }` may or may not render inside a
 * frame depending on who mounts it, and no static read of the CSS can say
 * which. That half is the sampler's: `settle-frame-probe.ts` counts elements
 * computing `position: fixed` under a shown frame on a live deck, and
 * the settle app-tests report it. Neither half is sufficient alone.
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
 * `transition: height`, which is correct, and which
 * `.tug-pane[data-imposer-settling] { transition: none }` turns off for
 * exactly this window — two clocks on one height being the fold bug that
 * stand-down was written for. So the scan collects the selectors stood down
 * under the settling mark and excuses them, and a hit is a property that
 * really is live while frames move.
 *
 * The mark reads BOTH ways round: `.tug-pane[data-imposer-settling]` and
 * `[data-imposer-settling] .tug-pane` both excuse `.tug-pane`, because both
 * win the cascade over the bare selector, and the compound form is the one to
 * prefer for the invalidation reason `settleStandDownSubject` gives.
 *
 * Either way the excuse is by EXACT selector, deliberately: it excuses
 * `.tug-pane` and nothing else — not `.tug-pane-chrome`, not `.tug-pane .x`.
 * A near-miss stand-down that would not actually win the cascade against the
 * offending rule would otherwise excuse it anyway, which is a guard reporting
 * success over a stylesheet that still animates `height`.
 *
 * **Rule 3 — a long-running loop stays resident on the compositor.**
 *
 * `tuglaws/animation-doctrine.md`: an animation that runs for as long as the
 * deck is up must be one WebKit can hand to Core Animation, because the
 * alternative is a per-frame style commit, and a per-frame style commit drags
 * the whole page's compositing walk into the frame loop — a cost paid by every
 * surface on the deck, not by the glyph that caused it. A loop is checked on
 * five clauses, each of them a way `KeyframeEffect::canBeAccelerated()` says
 * no:
 *
 *   1. every property its `@keyframes` animates is `transform`, `opacity`, or
 *      one of the individual transform properties `translate` / `rotate` /
 *      `scale` — which are accelerated on exactly the same terms as
 *      `transform`, and which rule 2's narrower [D9] set deliberately omits;
 *   2. nothing in the corpus declares a `transition` on the loop's own
 *      subject. Acceleration is decided over an element's WHOLE effect stack,
 *      so one retained `CSSTransition` sharing a box with a loop demotes the
 *      loop — the defect the pulsing dot's well split was written to make
 *      impossible;
 *   3. the easing is a keyword or a single `cubic-bezier()`. `steps()` and a
 *      multi-stop `linear()` are not expressible as one Core Animation
 *      segment;
 *   4. `animation-composition` is absent or `replace`;
 *   5. the iteration count is written `var(--tug-loop-iterations, infinite)`,
 *      which is the contract the motion circuit breaker demotes through. A
 *      loop that writes a bare `infinite` is invisible to the breaker.
 *
 * **What the compound means in clause 2.** The subject compound is the
 * selector's last compound INCLUDING its pseudo-element: `.tug-skeleton::after`
 * and `.tug-skeleton` name two different boxes, and a transition on the
 * element is not on the same effect stack as a loop on its `::after`. Two
 * compounds collide when they share a class and carry the same pseudo-element.
 *
 * **What a loop's `@keyframes` name is read from.** The name and the iteration
 * count need not share a block — the pulsing dot declares the count on one
 * selector and the name on the same selector further down the file. So the
 * names for a block are resolved from that block AND from every block in the
 * corpus declaring the same selector, or that selector plus a trailing
 * pseudo-class or attribute (`…-bar` and `…-bar:nth-child(1)`, which is how
 * the wave stripes their names). A name declared on a selector this cannot
 * reach resolves to no keyframes and clause 1 passes vacuously; the runtime
 * census is the other half of that.
 *
 * **Rule 4 — every long-running loop has a hold owner.**
 *
 * The motion registry (`src/lib/motion-guard/registry.ts`) is the deck's
 * event clock for motion: a loop owner takes a hold when its loop starts and
 * drops it when the loop stops, and the hold count's edges are what arm the
 * render-cost probe and what the census and the bisect read. A loop nobody
 * registers runs where no instrument is looking — the caret blink was one
 * for as long as the registry existed. So a file declaring a long-running
 * loop names its owner with an `@tug-motion-hold <path>` annotation, in a
 * comment, and the rule checks two things: that the annotation is there, and
 * that the file it names is in the corpus and calls `useMotionHold(` or
 * `acquireMotionHold(`. A path starting `./` or `../` resolves against the
 * annotated file's directory; any other path is repository-relative. A file
 * may name itself.
 *
 * The annotation is a declaration rather than an inference because the
 * owner is not derivable from the stylesheet: the six progress glyphs'
 * loops live in six files under `internal/` and the one owner that holds
 * for five of them is `tug-progress-indicator.tsx`, a level up. A rule that
 * guessed by basename would pass the wrong file and fail the right one.
 *
 * **Rule 5 — motion goes through the animator.**
 *
 * TugAnimator is where the deck's programmatic motion is timed, scaled,
 * stilled and recorded, so motion made beside it is motion none of those reach.
 * The rule has two halves. In TypeScript, a `.animate(` call is a hit unless
 * its receiver is one of the animator's groups — an identifier the same file
 * binds with `= group(` — because `g.animate(` is how the animator makes a
 * tween and `element.animate(` is how code goes around it. In a stylesheet, an
 * entrance `@keyframes` is a hit: one whose name says it brings something in
 * (`enter`, `in`, `arrive`, `appear` as a hyphenated word), or whose opening
 * stop starts from `opacity: 0` without its closing stop ending there. A
 * keyframes a long-running loop plays is a loop, not an entrance, and is
 * exempt by name.
 *
 * Everything else that animates outside the animator is declared in
 * {@link MOTION_CARVE_OUTS}, by file, with its reason: the animator itself,
 * the instruments, the Radix-bound stylesheets [L14] gives to Presence, and the
 * standing CSS entrances not yet moved. A clock that animates nothing is the
 * animator's too — `timelineMark()` — so the settle's beat markers are not an
 * exception to carve out.
 *
 * **Rule 6 — motion on a layout property is declared.**
 *
 * A tween or a transition on `width`, `height`, an inset, a margin, a padding,
 * a flex or grid track, or `all` re-lays-out its box on every frame it runs.
 * The settle's own crossings carry that cost by decision ([D9]), and the
 * runtime rows name them. Motion elsewhere on the deck pays the same cost, and
 * neither rule 2 (which reads only selectors under a frame) nor the sampler
 * (which reads only the settle window) sees it. So every such site is declared
 * in {@link LAYOUT_MOTION_CARVE_OUTS}, by file, with the properties it may
 * animate and the ending it was given. The two endings it can carry are
 * "main-thread by design", with the reason, and "moves to transform/opacity",
 * which leaves the list once it has moved. A third ending, removal, never
 * appears here at all. A new site, or a new property on a declared file, is a
 * hit, so the inventory cannot grow without somebody writing its reason down.
 *
 * Two halves. In a stylesheet, a `transition` or `transition-property` naming
 * a layout property. In TypeScript, a call to TugAnimator's `animate` (by
 * whatever name the file imports it) or to a group's `.animate(` whose
 * argument text carries a layout property as an object key. The TypeScript
 * half reads keyframes written in the call, and only those: keyframes built in
 * a variable first are not followed. That is how the settle's height crossing
 * is written, and it is the settle-frames rows that name that crossing.
 *
 * **What rule 3 cannot see, and who sees it instead.** The census flags an
 * animation whose target is an SVG element as never accelerated; this cannot,
 * because a selector does not say what it matches — `tugx-icon-twinkle` on
 * `.tug-icon-spark` is an infinite loop on an SVG element that rule 3 passes
 * and the census fails. `animationCensus()` in `src/lib/perf-monitor.ts` and
 * `tugtool deck motion list` are that half. The same holds for a loop authored
 * in a template literal, which the TypeScript read below deliberately declines.
 *
 * **The TypeScript read.** [F09]'s keyframes are CodeMirror base themes —
 * JavaScript objects, not stylesheets — so a CSS-only audit is blind to the
 * caret blink and the pending-atom pulse. {@link scanTs} reads object literals
 * of the `"selector": { prop: "value" }` shape, including `"@keyframes name"`
 * blocks, converts camelCase keys to kebab-case, and runs the same rules.
 * Template literals are not read.
 *
 * **Why this exports.** A guard that silently does nothing and a corpus that
 * is genuinely clean produce the same green, so the corpus cannot be what
 * proves the guard works. {@link scanCss} and {@link scanTs} are pure over
 * source strings, `main()` is the only reader of the filesystem, and the entry
 * is guarded with `import.meta.main` — so `scripts/__tests__/audit-motion.test.ts`
 * can feed fixtures and prove each clause catches what it claims and ignores
 * what it claims to ignore.
 *
 * Usage:
 *   bun run scripts/audit-motion.ts   (or: bun run audit:motion)
 */

import fs from "fs";
import path from "path";

const TUGDECK = path.resolve(import.meta.dir, "..");

/** Every stylesheet the app ships, source-local and shared alike. */
const SCAN_ROOTS = [path.join(TUGDECK, "src"), path.join(TUGDECK, "styles")];

/** Where the TypeScript read looks for JS-authored keyframes. */
const TS_ROOT = path.join(TUGDECK, "src");

/**
 * The class roots that ARE a pane frame or live inside one.
 *
 * `.tug-pane` is the frame itself. `.tug-pane-chrome` and `.tug-pane-content`
 * are its own interior — a `fixed` descendant of either is as trapped as one
 * directly under the frame, and naming them here means a selector cannot get
 * out from under the rule by starting one level down.
 *
 * A class whose name merely BEGINS with one of these is a different class and
 * is not matched: `.tug-pane-sibling` is not `.tug-pane`, which is the
 * whole reason this is a set of exact class names rather than a prefix test.
 */
const FRAME_ROOTS = new Set(["tug-pane", "tug-pane-chrome", "tug-pane-content"]);

/** [D9]'s complete list. Everything else is a rule-2 hit. */
const COMPOSITOR_PROPERTIES = new Set(["transform", "opacity"]);

/**
 * Rule 3's list, which is [D9]'s plus the individual transform properties.
 *
 * `translate`, `rotate` and `scale` are separate properties that compose into
 * the same matrix, and WebKit accelerates them on the same terms as
 * `transform` — `@keyframes tug-petals-scale` in `internal/tug-button.css`
 * animates `scale` and is compositor-resident. Rule 2 keeps the narrower set,
 * which is [D9]'s and not this rule's.
 */
const LOOP_COMPOSITOR_PROPERTIES = new Set([
  "transform",
  "opacity",
  "translate",
  "rotate",
  "scale",
]);

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

/** Easings Core Animation expresses as one segment without a bezier. */
const EASING_KEYWORDS = new Set([
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
]);

const SETTLING_MARK = "[data-imposer-settling]";

/**
 * The selector a settle stand-down excuses, or `null` if the rule is not one.
 *
 * Both placements of the mark count. `.tug-pane[data-imposer-settling]` is the
 * compound form and the one to prefer — an attribute on the element it styles
 * invalidates that element alone — and `[data-imposer-settling] .tug-pane` is
 * the descendant form, which makes the engine walk the canvas on every toggle
 * of the attribute. Either wins the cascade over the bare selector, so either
 * is a real stand-down.
 */
function settleStandDownSubject(selector: string): string | null {
  if (selector.startsWith(`${SETTLING_MARK} `)) {
    return selector.slice(SETTLING_MARK.length + 1).trim();
  }
  if (selector.endsWith(SETTLING_MARK)) {
    const subject = selector.slice(0, -SETTLING_MARK.length).trim();
    return subject === "" ? null : subject;
  }
  return null;
}

/** The breaker's one variable ([P06]); the contract form every loop writes. */
const LOOP_ITERATIONS_VAR = "--tug-loop-iterations";
const LOOP_ITERATIONS_FORM = `var(${LOOP_ITERATIONS_VAR}, infinite)`;

/** Rule 4's annotation: a loop file naming the file that holds for it. */
const HOLD_ANNOTATION = "@tug-motion-hold";

/**
 * What makes a TypeScript file a hold owner: a call to the registry. The
 * negative lookbehind keeps the registry's own definitions out of the set —
 * `export function acquireMotionHold(` declares the hold, it does not take
 * one — and the motion guard's directory is excluded below for the same
 * reason.
 */
const HOLD_CALL = /(?<!function\s)\b(?:useMotionHold|acquireMotionHold)\s*\(/;

export interface Hit {
  readonly path: string;
  readonly line: number;
  readonly selector: string;
  readonly rule: 1 | 2 | 3 | 4 | 5 | 6;
  readonly detail: string;
}

/** One source file's text, and how to read it. */
export interface Source {
  readonly path: string;
  readonly text: string;
  readonly kind: "css" | "ts";
}

/**
 * One declaration block: the text that introduced it, its declarations, and
 * where each of those declarations stands in the file it came from.
 */
interface Block {
  readonly prelude: string;
  readonly body: string;
  /** Enclosing preludes, outermost first — `@keyframes x`, `@media …`. */
  readonly ancestors: readonly string[];
  /** The line a declaration matching `search` stands on, 1-based. */
  lineOf(search: RegExp): number;
}

// ---------------------------------------------------------------------------
// Reading blocks out of a file
// ---------------------------------------------------------------------------

/** Strip `/* … *​/` comments, so a rule quoted in prose is not read as code. */
function stripComments(css: string): string {
  // Replaced with equal-length whitespace rather than removed, so every byte
  // offset below still maps to the line it came from in the original file.
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/** The 1-based line `offset` stands on. */
function lineAt(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split("\n").length;
}

/**
 * Every innermost declaration block in a stylesheet, with its ancestry.
 *
 * A brace walk rather than a regex, because the ancestry is the point: a
 * `@keyframes` wrapper's name is two levels up from the declarations inside a
 * step, and a single-level regex reads the step's `0%` as the whole prelude —
 * which is how the name went missing and rule 2's animation half resolved
 * nothing at all.
 */
function cssBlocks(css: string): Block[] {
  const out: Block[] = [];
  const stack: {
    prelude: string;
    bodyStart: number;
    hadChild: boolean;
  }[] = [];
  let mark = 0;

  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") {
      const frame = stack[stack.length - 1];
      if (frame !== undefined) frame.hadChild = true;
      stack.push({ prelude: css.slice(mark, i), bodyStart: i + 1, hadChild: false });
      mark = i + 1;
      continue;
    }
    if (ch !== "}") continue;

    const frame = stack.pop();
    mark = i + 1;
    if (frame === undefined || frame.hadChild) continue;

    const body = css.slice(frame.bodyStart, i);
    const bodyStart = frame.bodyStart;
    out.push({
      prelude: frame.prelude,
      body,
      ancestors: stack.map((f) => f.prelude.replace(/\s+/g, " ").trim()),
      lineOf: (search) => {
        const found = body.search(search);
        return lineAt(css, bodyStart + (found < 0 ? 0 : found));
      },
    });
  }

  return out;
}

/**
 * Every object-literal style block in a `.ts`/`.tsx` file.
 *
 * The shape read is the CodeMirror base theme's: `"selector": { prop: "value" }`,
 * nested one level under `"@keyframes name"` for a loop's stops. Keys may be
 * quoted (a selector) or bare (a camelCase property); values must be string
 * literals, which is what makes this readable at all — a template literal
 * carries interpolation this declines to guess at.
 */
function tsBlocks(source: string): Block[] {
  const out: Block[] = [];
  const stack: {
    prelude: string;
    bodyStart: number;
    hadChild: boolean;
  }[] = [];
  let mark = 0;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    // Skip string and template literals whole: a brace inside one is data.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }

    if (ch === "{") {
      const frame = stack[stack.length - 1];
      if (frame !== undefined) frame.hadChild = true;
      stack.push({
        prelude: source.slice(mark, i),
        bodyStart: i + 1,
        hadChild: false,
      });
      mark = i + 1;
      continue;
    }
    if (ch !== "}") continue;

    const frame = stack.pop();
    mark = i + 1;
    if (frame === undefined || frame.hadChild) continue;

    const declarations = readTsDeclarations(source, frame.bodyStart, i);
    if (declarations.text.length === 0) continue;
    out.push({
      prelude: keyOf(frame.prelude),
      body: declarations.text,
      ancestors: stack.map((f) => keyOf(f.prelude)),
      lineOf: (search) => {
        const found = declarations.text.search(search);
        return lineAt(source, declarations.offsetFor(found < 0 ? 0 : found));
      },
    });
  }

  return out;
}

/**
 * The quoted key a block hangs off, as a CSS prelude.
 *
 * `,\n  "@keyframes tug-x": ` is the prelude a brace walk hands back; the key
 * is the last quoted string in it. A block introduced by anything else —
 * `EditorView.baseTheme(` — has no key and is not a selector.
 */
function keyOf(prelude: string): string {
  const keys = Array.from(prelude.matchAll(/"([^"]*)"\s*:\s*$/g));
  const last = keys[keys.length - 1];
  return last === undefined ? "" : last[1].replace(/\s+/g, " ").trim();
}

/**
 * Whether a selector declares tokens for the whole document.
 *
 * `:root` is the canonical spelling; the theme files in `styles/themes/` use a
 * bare `body`, which inherits to every element just the same. Anything
 * narrower — a class, a combinator, an attribute — is a scoped declaration
 * that this audit cannot say applies to the element the loop runs on.
 */
function isRootSelector(selector: string): boolean {
  return /^(:root|html|body)$/.test(selector.trim());
}

/** camelCase → kebab-case, so `animationIterationCount` reads as CSS. */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * The `prop: "value"` pairs between two offsets, rendered as CSS declarations.
 *
 * The rendered text is what the rules read, so the mapping back to source
 * lines is kept alongside it — a hit that cannot name its line is a hit
 * nobody can act on.
 */
function readTsDeclarations(
  source: string,
  start: number,
  end: number,
): { text: string; offsetFor: (offsetInText: number) => number } {
  const region = source.slice(start, end);
  const marks: { at: number; offset: number }[] = [];
  let text = "";

  const pair = /(?:"([^"]+)"|([A-Za-z][A-Za-z0-9]*))\s*:\s*"([^"]*)"/g;
  for (const match of region.matchAll(pair)) {
    const name = kebab(match[1] ?? match[2] ?? "");
    if (name.length === 0) continue;
    marks.push({ at: text.length, offset: start + (match.index ?? 0) });
    text += `${name}: ${match[3]};\n`;
  }

  return {
    text,
    offsetFor: (offsetInText) => {
      let best = start;
      for (const mark of marks) {
        if (mark.at > offsetInText) break;
        best = mark.offset;
      }
      return best;
    },
  };
}

function blocksOf(source: Source): Block[] {
  return source.kind === "css"
    ? cssBlocks(stripComments(source.text))
    : tsBlocks(source.text);
}

// ---------------------------------------------------------------------------
// Reading declarations
// ---------------------------------------------------------------------------

/** The selectors a block's prelude names, normalized and `@rule`-free. */
function selectorsOf(block: Block): string[] {
  return block.prelude
    .split(",")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0 && !s.startsWith("@"));
}

/** The `@keyframes` name this block's declarations belong to, if any. */
function keyframesOwner(block: Block): string | null {
  for (const ancestor of block.ancestors) {
    const named = /@keyframes\s+"?([A-Za-z0-9_-]+)"?/.exec(ancestor);
    if (named !== null) return named[1];
  }
  return null;
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
  const parts = compounds(selector);
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

/** A selector's compound parts, split on every combinator. */
function compounds(selector: string): string[] {
  return selector
    .replace(/\s*[>+~]\s*/g, " ")
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
}

/**
 * The element a selector acts on, as `class|class|…::pseudo`.
 *
 * Two rules collide when they can style the same box, and a pseudo-element is
 * a different box: `.tug-skeleton::after` carries the shimmer and `.tug-skeleton`
 * carries whatever the element itself transitions, and those two effects never
 * share a stack. So the pseudo-element rides along with the classes, and a
 * compound with no class at all names nothing this rule can compare.
 */
function subjectKeys(selector: string): string[] {
  const parts = compounds(selector);
  const subject = parts[parts.length - 1];
  if (subject === undefined) return [];
  const pseudo = /(::[a-z-]+)/.exec(subject);
  const suffix = pseudo === null ? "" : pseudo[1];
  const out: string[] = [];
  for (const cls of subject.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
    out.push(`${cls[1]}${suffix}`);
  }
  return out;
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
  const match = new RegExp(`(?:^|[;{])\\s*${property}\\s*:([^;}]*)`, "i").exec(
    body,
  );
  return match === null ? null : match[1].replace(/\s+/g, " ").trim();
}

/**
 * Split a value on a separator that is not inside a function call.
 *
 * `animation-timing-function: linear(0, 0.3, 1)` is ONE easing, and a naive
 * comma split reads it as three — two of which are numbers no clause can
 * account for.
 */
function splitTopLevel(value: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === separator) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * Split a value into top-level tokens, keeping each function call whole.
 *
 * `calc(600ms * var(--tug-timing, 1))` is one token, not three: reading its
 * inner `var()` as the declaration's easing is how a duration would be
 * convicted of being a `steps()`.
 */
function topLevelTokens(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === " " || ch === "\n" || ch === "\t")) {
      if (current.length > 0) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0) out.push(current);
  return out;
}

// ---------------------------------------------------------------------------
// The corpus-wide context
// ---------------------------------------------------------------------------

/**
 * What the rules need to know about the corpus as a whole rather than about
 * one file.
 *
 * All of it is corpus-wide on purpose. A component's keyframes and the rule
 * that plays them usually share a file, but `chrome.css` stands down a rule
 * that `tug-pane.css` could just as easily have declared — and a per-file read
 * would call that a violation.
 */
export interface MotionContext {
  /** `@keyframes` name → the properties its steps animate. */
  readonly keyframeProperties: Map<string, Set<string>>;
  /** `@keyframes` name → every `animation-timing-function` its steps declare. */
  readonly keyframeEasings: Map<string, Set<string>>;
  /** Selectors stood down under the settling mark, by exact text. */
  readonly stoodDown: Set<string>;
  /** Subject key ({@link subjectKeys}) → a selector that transitions it. */
  readonly transitioned: Map<string, string>;
  /** `:root` custom properties, for one level of easing resolution. */
  readonly variables: Map<string, string>;
  /** Selector → the `animation-name` / `animation` values declared on it. */
  readonly animationsBySelector: Map<string, string[]>;
  /** Every TypeScript file that takes a motion hold, by corpus path. */
  readonly holdOwners: Set<string>;
  /** Every `@keyframes` name a long-running loop plays (rule 5's exemption). */
  readonly loopKeyframes: Set<string>;
}

export function collectMotionContext(
  sources: readonly Source[],
): MotionContext {
  const keyframeProperties = new Map<string, Set<string>>();
  const keyframeEasings = new Map<string, Set<string>>();
  const stoodDown = new Set<string>();
  const transitioned = new Map<string, string>();
  const variables = new Map<string, string>();
  const animationsBySelector = new Map<string, string[]>();
  const holdOwners = new Set<string>();

  for (const source of sources) {
    if (
      source.kind === "ts" &&
      !source.path.includes("lib/motion-guard/") &&
      HOLD_CALL.test(source.text)
    ) {
      holdOwners.add(source.path);
    }
    for (const block of blocksOf(source)) {
      const body = block.body;
      const owner = keyframesOwner(block);

      if (owner !== null) {
        const properties =
          keyframeProperties.get(owner) ?? new Set<string>();
        for (const property of declaredProperties(body)) {
          if (property === "animation-timing-function") continue;
          properties.add(property);
        }
        keyframeProperties.set(owner, properties);

        const easing = valueOf(body, "animation-timing-function");
        if (easing !== null) {
          const easings = keyframeEasings.get(owner) ?? new Set<string>();
          easings.add(easing);
          keyframeEasings.set(owner, easings);
        }
        continue;
      }

      const selectors = selectorsOf(block);

      // Root variables, for the one level of easing resolution clause 3 does.
      // `:root` is the canonical spelling and the themes use `body`, which is
      // the same declaration for this purpose: a token every element inherits.
      if (selectors.some(isRootSelector)) {
        for (const decl of body.split(";")) {
          const colon = decl.indexOf(":");
          if (colon < 0) continue;
          const name = decl.slice(0, colon).trim();
          if (!name.startsWith("--")) continue;
          if (!variables.has(name)) {
            variables.set(name, decl.slice(colon + 1).replace(/\s+/g, " ").trim());
          }
        }
      }

      // Which selectors carry an animation, so a loop whose iteration count
      // and whose name live in two blocks can still be resolved.
      for (const property of ["animation-name", "animation"]) {
        const value = valueOf(body, property);
        if (value === null || value === "none") continue;
        for (const selector of selectors) {
          const seen = animationsBySelector.get(selector) ?? [];
          seen.push(value);
          animationsBySelector.set(selector, seen);
        }
      }

      // Which boxes carry a transition — clause 2's whole question.
      for (const property of ["transition", "transition-property"]) {
        const value = valueOf(body, property);
        if (value === null || value === "none") continue;
        for (const selector of selectors) {
          for (const key of subjectKeys(selector)) {
            if (!transitioned.has(key)) transitioned.set(key, selector);
          }
        }
      }

      // Stand-downs, for rule 2's excuse.
      if (
        valueOf(body, "transition") === "none" ||
        valueOf(body, "animation") === "none"
      ) {
        for (const selector of selectors) {
          const subject = settleStandDownSubject(selector);
          if (subject !== null) stoodDown.add(subject);
        }
      }
    }
  }

  // The keyframes the loops play, read once every selector's animations are
  // known — a loop's name and its count may live in two blocks.
  const loopKeyframes = new Set<string>();
  const context: MotionContext = {
    keyframeProperties,
    keyframeEasings,
    stoodDown,
    transitioned,
    variables,
    animationsBySelector,
    holdOwners,
    loopKeyframes,
  };
  for (const source of sources) {
    for (const block of blocksOf(source)) {
      if (keyframesOwner(block) !== null || !isLongRunning(block.body)) continue;
      for (const name of animationNames(block, selectorsOf(block), context)) {
        loopKeyframes.add(name);
      }
    }
  }
  return context;
}

/**
 * The hold owners a file declares, resolved to corpus paths.
 *
 * Read from the raw text rather than the stripped one, because the
 * annotation lives in a comment by design: it is a fact about the file, not
 * a declaration the engine reads.
 */
export function declaredHoldOwners(raw: string, rel: string): string[] {
  const owners: string[] = [];
  const pattern = new RegExp(`${HOLD_ANNOTATION}\\s+(\\S+)`, "g");
  for (const match of raw.matchAll(pattern)) {
    const value = match[1].replace(/\*\/$/, "");
    owners.push(
      value.startsWith("./") || value.startsWith("../")
        ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), value))
        : value,
    );
  }
  return owners;
}

// ---------------------------------------------------------------------------
// Rule 3
// ---------------------------------------------------------------------------

/** The raw iteration-count text a block declares, from either spelling. */
function iterationText(body: string): string {
  return [
    valueOf(body, "animation-iteration-count"),
    valueOf(body, "animation"),
  ]
    .filter((v): v is string => v !== null)
    .join(" ");
}

/** Whether a block declares a loop that runs for as long as the deck is up. */
function isLongRunning(body: string): boolean {
  const text = iterationText(body);
  return /\binfinite\b/.test(text) || text.includes(LOOP_ITERATIONS_VAR);
}

/**
 * Resolve `var(--x, fallback)` one level, through `:root` first and the
 * declaration's own fallback second.
 *
 * Returns `null` when neither answers — which clause 3 treats as a failure
 * for an easing, because an easing nobody can read is an easing nobody can
 * vouch for.
 */
function resolveVar(token: string, context: MotionContext): string | null {
  const match = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([\s\S]*))?\)$/.exec(token);
  if (match === null) return null;
  const declared = context.variables.get(match[1]);
  if (declared !== undefined) return declared;
  const fallback = match[2];
  return fallback === undefined ? null : fallback.replace(/\s+/g, " ").trim();
}

/** Every `@keyframes` name a loop block plays. */
function animationNames(
  block: Block,
  selectors: readonly string[],
  context: MotionContext,
): string[] {
  const values: string[] = [];
  for (const property of ["animation-name", "animation"]) {
    const value = valueOf(block.body, property);
    if (value !== null && value !== "none") values.push(value);
  }
  // The name may be declared on the same selector in another block, or on
  // that selector plus a trailing pseudo-class or attribute.
  for (const [selector, declared] of context.animationsBySelector) {
    if (
      !selectors.some(
        (s) =>
          selector === s ||
          (selector.startsWith(s) && /^[:[]/.test(selector.slice(s.length))),
      )
    ) {
      continue;
    }
    values.push(...declared);
  }

  const names = new Set<string>();
  for (const value of values) {
    // A name written through a variable is still a name: substitute one level
    // before the shorthand read, which blanks every `var()` group whole.
    const substituted = value.replace(
      /var\(\s*--[A-Za-z0-9_-]+\s*(?:,([^()]*))?\)/g,
      (whole, fallback: string | undefined) =>
        resolveVar(whole.replace(/\s+/g, " "), context) ?? fallback ?? " ",
    );
    for (const name of leadingIdentifiers(substituted)) names.add(name);
  }
  return Array.from(names);
}

/**
 * Every easing a loop's effect stack resolves to: the block's own, and each
 * keyframe step's.
 *
 * A shorthand's easing is whichever of its top-level tokens reads as one. A
 * `var()` is resolved one level and taken as an easing only if what comes back
 * is one — `animation: x var(--tugx-breath-ms, 2000ms) ease-in-out infinite`
 * carries a duration through a variable, and convicting it of a bad easing
 * would be a guard reporting on the wrong token.
 */
function easingsOf(
  block: Block,
  names: readonly string[],
  context: MotionContext,
): { easings: string[]; unresolved: string[] } {
  const easings: string[] = [];
  const unresolved: string[] = [];

  const explicit = valueOf(block.body, "animation-timing-function");
  if (explicit !== null) {
    for (const segment of splitTopLevel(explicit, ",")) {
      const token = segment.trim();
      if (token.length === 0) continue;
      if (token.startsWith("var(")) {
        const resolved = resolveVar(token, context);
        if (resolved === null) unresolved.push(token);
        else easings.push(resolved);
        continue;
      }
      easings.push(token);
    }
  }

  const shorthand = valueOf(block.body, "animation");
  if (shorthand !== null) {
    for (const segment of splitTopLevel(shorthand, ",")) {
      for (const token of topLevelTokens(segment)) {
        if (token.startsWith("var(")) {
          const resolved = resolveVar(token, context);
          // A shorthand token does not say which part it is. One that
          // resolves to an easing is checked; one that resolves to a
          // duration, a delay or a count is not this clause's business, and
          // one that resolves to nothing could be any of them — convicting it
          // of being an unreadable easing would be a guard reporting on the
          // wrong token. An easing written where it is unambiguous — in
          // `animation-timing-function` above — still fails unresolved.
          if (resolved !== null && looksLikeEasing(resolved)) {
            easings.push(resolved);
          }
          continue;
        }
        if (looksLikeEasing(token)) easings.push(token);
      }
    }
  }

  for (const name of names) {
    for (const stepEasing of context.keyframeEasings.get(name) ?? []) {
      for (const segment of splitTopLevel(stepEasing, ",")) {
        const token = segment.trim();
        if (token.length === 0) continue;
        if (token.startsWith("var(")) {
          const resolved = resolveVar(token, context);
          if (resolved === null) unresolved.push(token);
          else easings.push(resolved);
          continue;
        }
        easings.push(token);
      }
    }
  }

  return { easings, unresolved };
}

function looksLikeEasing(token: string): boolean {
  if (EASING_KEYWORDS.has(token)) return true;
  return /^(cubic-bezier|steps|linear)\(/.test(token);
}

/** Whether one easing is a single Core Animation segment. */
function easingIsAccelerable(easing: string): boolean {
  if (EASING_KEYWORDS.has(easing)) return true;
  if (/^cubic-bezier\([^()]*\)$/.test(easing)) return true;
  if (/^linear\(([^()]*)\)$/.test(easing)) {
    const stops = easing.slice(7, -1).split(",").filter((s) => s.trim().length > 0);
    return stops.length <= 2;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

function scanBlocks(
  blocks: readonly Block[],
  rel: string,
  context: MotionContext,
  holdOwners: readonly string[],
): Hit[] {
  const hits: Hit[] = [];

  for (const block of blocks) {
    const body = block.body;
    if (keyframesOwner(block) !== null) continue;
    const selectors = selectorsOf(block);
    const at = (search: RegExp): number => block.lineOf(search);

    // ---- Rule 1: `position: fixed` under a frame. --------------------
    if (/position\s*:\s*fixed/.test(body)) {
      const line = at(/position\s*:\s*fixed/);
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
        for (const animated of context.keyframeProperties.get(name) ?? []) {
          if (COMPOSITOR_PROPERTIES.has(animated)) continue;
          offendingProperties.add(`${animated} (via ${name})`);
        }
      }
    }
    if (offendingProperties.size > 0) {
      const line = at(/(transition|animation)(-property|-name)?\s*:/);
      for (const selector of selectors.filter(touchesFrame)) {
        if (context.stoodDown.has(selector)) continue;
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

    // ---- Rule 3: a long-running loop stays on the compositor. --------
    if (!isLongRunning(body) || selectors.length === 0) continue;
    const line = at(/animation(-iteration-count)?\s*:/);
    const names = animationNames(block, selectors, context);
    const details: string[] = [];

    // Clause 1 — what the keyframes animate.
    for (const name of names) {
      for (const animated of context.keyframeProperties.get(name) ?? []) {
        if (LOOP_COMPOSITOR_PROPERTIES.has(animated)) continue;
        details.push(
          `a long-running loop animates \`${animated}\` (via \`${name}\`), which is never accelerated`,
        );
      }
    }

    // Clause 2 — nothing transitions the same box.
    for (const selector of selectors) {
      for (const key of subjectKeys(selector)) {
        const transitioning = context.transitioned.get(key);
        if (transitioning === undefined) continue;
        details.push(
          `a long-running loop shares its subject with the \`transition\` on \`${transitioning}\` — acceleration is decided over the whole effect stack`,
        );
      }
    }

    // Clause 3 — the easing is one Core Animation segment.
    const { easings, unresolved } = easingsOf(block, names, context);
    for (const easing of easings) {
      if (easingIsAccelerable(easing)) continue;
      details.push(
        `a long-running loop eases with \`${easing}\`, which is not one bezier segment`,
      );
    }
    for (const token of unresolved) {
      details.push(
        `a long-running loop eases through \`${token}\`, which resolves to nothing this audit can read`,
      );
    }

    // Clause 4 — no blending with what is already there.
    const composition = valueOf(body, "animation-composition");
    if (composition !== null && composition !== "replace") {
      details.push(
        `a long-running loop declares \`animation-composition: ${composition}\``,
      );
    }

    // Clause 5 — the breaker's contract.
    const iterations = iterationText(body);
    if (/\binfinite\b/.test(iterations.split(LOOP_ITERATIONS_FORM).join(" "))) {
      details.push(
        `a long-running loop writes a bare \`infinite\`; the breaker demotes through \`${LOOP_ITERATIONS_FORM}\``,
      );
    }

    for (const detail of details) {
      for (const selector of selectors) {
        hits.push({ path: rel, line, selector, rule: 3, detail });
      }
    }

    // ---- Rule 4: the loop has a hold owner. ---------------------------
    const ownerDetails: string[] = [];
    if (holdOwners.length === 0) {
      ownerDetails.push(
        `a long-running loop declares no hold owner; name the file that takes its motion hold with \`${HOLD_ANNOTATION} <path>\``,
      );
    }
    for (const owner of holdOwners) {
      if (context.holdOwners.has(owner)) continue;
      ownerDetails.push(
        `a long-running loop names \`${owner}\` as its hold owner, which is not in the corpus or takes no motion hold`,
      );
    }
    for (const detail of ownerDetails) {
      for (const selector of selectors) {
        hits.push({ path: rel, line, selector, rule: 4, detail });
      }
    }
  }

  return hits;
}

/** Scan one stylesheet. Pure over its text; `context` is the corpus. */
export function scanCss(
  raw: string,
  rel: string,
  context: MotionContext,
): Hit[] {
  return scanBlocks(
    cssBlocks(stripComments(raw)),
    rel,
    context,
    declaredHoldOwners(raw, rel),
  );
}

/** Scan one `.ts`/`.tsx` file's JS-authored styles. */
export function scanTs(
  raw: string,
  rel: string,
  context: MotionContext,
): Hit[] {
  return scanBlocks(tsBlocks(raw), rel, context, declaredHoldOwners(raw, rel));
}

// ---------------------------------------------------------------------------
// Rule 5
// ---------------------------------------------------------------------------

/**
 * The files rule 5 does not read, each with the reason it may animate outside
 * the animator. Repository-relative, exact.
 *
 * A path here is a declaration, not a convenience: adding one says the file's
 * motion has an owner other than TugAnimator and names it. Registered loops
 * are not listed — a `@keyframes` a long-running loop plays is exempt by name,
 * so a loop file's other keyframes are still read.
 */
export const MOTION_CARVE_OUTS: ReadonlyMap<string, string> = new Map([
  [
    "tugdeck/src/components/tugways/tug-animator.ts",
    "the animator: the one owner of `element.animate()`",
  ],
  [
    "tugdeck/src/lib/settle-frame-probe.ts",
    "an instrument: it reads the settle's motion and makes none",
  ],
  // [L14]: Radix Presence owns enter and exit for these surfaces through CSS
  // `@keyframes` and `data-state`, because it waits on `animationend`, which
  // WAAPI does not fire.
  // The accordion's keyframes run on `height`, which rule 6 does not read (it
  // reads transitions and tweens), so its layout ending is recorded here:
  // main-thread by design, a section's open and close where the content below
  // has to move and only layout moves it, one-shot on the user's toggle.
  [
    "tugdeck/src/components/tugways/tug-accordion.css",
    "[L14] Radix Accordion; its height keyframes are main-thread by design",
  ],
  ["tugdeck/src/components/tugways/tug-alert.css", "[L14] Radix AlertDialog"],
  ["tugdeck/src/components/tugways/tug-menu.css", "[L14] Radix menus"],
  ["tugdeck/src/components/tugways/tug-popover.css", "[L14] Radix Popover"],
  ["tugdeck/src/components/tugways/tug-tooltip.css", "[L14] Radix Tooltip"],
  ["tugdeck/src/components/tugways/update-tug.css", "[L14] Radix AlertDialog"],
  // Entrances React mounts with a CSS animation and no exit to coordinate.
  // They predate this rule and are declared here rather than moved: each is a
  // one-shot on an element whose insertion the code controls, which is the
  // animator's side of [L14]'s line, and moving one is its own change.
  [
    "tugdeck/src/components/chrome/update-pill.css",
    "the update pill's zoom-in on appearance",
  ],
  [
    "tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.css",
    "the Z2 occupant's arrival on a fold handoff",
  ],
  [
    "tugdeck/src/components/tugways/cards/session-card.css",
    "the restoring panel's fade-in",
  ],
  [
    "tugdeck/src/components/tugways/tug-control-bar.css",
    "the control bar's locking scrim fade-in",
  ],
  [
    "tugdeck/src/components/tugways/tug-editor-context-menu.css",
    "the editor context menu's grow from the click point (not Radix)",
  ],
  [
    "tugdeck/src/components/tugways/tug-placard.css",
    "the placard's rise into the status strip",
  ],
]);

/** A receiver bound to the animator's group: `const g = group(…)`. */
const GROUP_BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*group\s*\(/g;

/** `<receiver>.animate(`, where the receiver is an identifier or a call's end. */
const ANIMATE_CALL = /([A-Za-z_$][\w$]*|[)\]])\s*\??\.\s*animate\s*\(/g;

/** A `@keyframes` name that says it brings something in. */
const ENTRANCE_NAME = /(?:^|-)(?:enter|in|arrive|appear)(?:-|$)/;

/**
 * A source with its comments and string and template literals blanked to
 * spaces, so a call quoted in prose or carried as data is not read as one,
 * and every offset still maps to its line.
 */
function codeOnly(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    let end = -1;
    if (ch === '"' || ch === "'" || ch === "`") {
      end = i + 1;
      while (end < source.length && source[end] !== ch) {
        if (source[end] === "\\") end += 1;
        end += 1;
      }
    } else if (ch === "/" && source[i + 1] === "/") {
      end = source.indexOf("\n", i);
      if (end < 0) end = source.length;
      end -= 1;
    } else if (ch === "/" && source[i + 1] === "*") {
      end = source.indexOf("*/", i + 2);
      end = end < 0 ? source.length : end + 1;
    }
    if (end < 0) {
      out += ch;
      continue;
    }
    out += source.slice(i, end + 1).replace(/[^\n]/g, " ");
    i = end;
  }
  return out;
}

/**
 * Rule 5's TypeScript half: every `.animate(` call whose receiver is not one
 * of the animator's groups. Pure over the file's text.
 */
export function scanRawAnimate(
  raw: string,
  rel: string,
  carveOuts: ReadonlyMap<string, string> = MOTION_CARVE_OUTS,
): Hit[] {
  if (carveOuts.has(rel)) return [];
  const code = codeOnly(raw);
  const groups = new Set(
    Array.from(code.matchAll(GROUP_BINDING), (match) => match[1]),
  );
  const hits: Hit[] = [];
  for (const match of code.matchAll(ANIMATE_CALL)) {
    if (groups.has(match[1])) continue;
    hits.push({
      path: rel,
      line: lineAt(code, match.index ?? 0),
      selector: `${match[1]}.animate(`,
      rule: 5,
      detail: "`element.animate()` outside the animator",
    });
  }
  return hits;
}

/**
 * Rule 5's stylesheet half: every entrance `@keyframes` — one whose name says
 * it brings something in, or whose opening stop starts from `opacity: 0` and
 * whose closing stop does not end there (a flash both opens and closes
 * invisible, and is not an entrance) — that no long-running loop plays. Pure
 * over the file's text; `context` is the corpus.
 */
export function scanEntranceKeyframes(
  raw: string,
  rel: string,
  context: MotionContext,
  carveOuts: ReadonlyMap<string, string> = MOTION_CARVE_OUTS,
): Hit[] {
  if (carveOuts.has(rel)) return [];
  const css = stripComments(raw);
  const opensInvisible = new Set<string>();
  const closesInvisible = new Set<string>();
  for (const block of cssBlocks(css)) {
    const owner = keyframesOwner(block);
    if (owner === null) continue;
    const stops = block.prelude.split(",").map((stop) => stop.trim());
    if (valueOf(block.body, "opacity") !== "0") continue;
    if (stops.includes("from") || stops.includes("0%")) opensInvisible.add(owner);
    if (stops.includes("to") || stops.includes("100%")) closesInvisible.add(owner);
  }
  const hits: Hit[] = [];
  for (const match of css.matchAll(/@keyframes\s+"?([A-Za-z0-9_-]+)"?/g)) {
    const name = match[1];
    if (context.loopKeyframes.has(name)) continue;
    const fadesIn = opensInvisible.has(name) && !closesInvisible.has(name);
    if (!ENTRANCE_NAME.test(name) && !fadesIn) continue;
    hits.push({
      path: rel,
      line: lineAt(css, match.index ?? 0),
      selector: `@keyframes ${name}`,
      rule: 5,
      detail: "an entrance `@keyframes` outside the animator",
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Rule 6
// ---------------------------------------------------------------------------

/** The properties whose motion re-lays-out the box, in kebab-case. */
const LAYOUT_PROPERTIES =
  /^(?:width|height|min-width|max-width|min-height|max-height|top|left|right|bottom|inset(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|padding(?:-[a-z-]+)?|flex|flex-grow|flex-shrink|flex-basis|gap|row-gap|column-gap|grid-template-[a-z]+|all)$/;

/** One declared site of layout motion: what it may animate, and why. */
export interface LayoutMotionCarveOut {
  readonly properties: readonly string[];
  readonly ending: string;
}

/**
 * Every file whose motion runs on layout, the properties it may animate, and
 * the ending each was given. Repository-relative, exact.
 */
export const LAYOUT_MOTION_CARVE_OUTS: ReadonlyMap<string, LayoutMotionCarveOut> =
  new Map([
    [
      "tugdeck/src/components/chrome/rail-width-draft.ts",
      {
        properties: ["width", "left"],
        ending:
          "main-thread by design: the rail's spring back from an over-limit drag, one-shot on the hand's release and outside any settle; a rail's width is its layout, and a scale would distort the card in it",
      },
    ],
    [
      "tugdeck/src/components/jots/jots-card.tsx",
      {
        properties: ["height"],
        ending:
          "main-thread by design: a jot's well opening and closing in its list, where the rows below have to move and only layout moves them; one-shot, inside the Jots card alone",
      },
    ],
    [
      "tugdeck/src/components/tugways/tug-split-pane.tsx",
      {
        properties: ["flex-grow"],
        ending:
          "main-thread by design: a split panel's snap to a size, which the panel library lays out by flex-grow; one-shot, on the user's own gesture",
      },
    ],
    [
      "tugdeck/styles/chrome.css",
      {
        properties: ["height"],
        ending:
          "main-thread by design: [D07]'s window-shade collapse, stood down under a gesture, a pointer-owned frame, a settle and a workspace switch",
      },
    ],
    [
      "tugdeck/src/components/layout/layout-miniature.css",
      {
        properties: ["left", "width", "top", "bottom"],
        ending:
          "main-thread by design for now: the Layout card's miniature eases on the settle's own clock, so it runs inside every settle window; small absolute boxes, and the first place to look when a settle stalls with a Layout card on screen",
      },
    ],
    [
      "tugdeck/src/components/layout/layout-places.css",
      {
        properties: ["left", "width"],
        ending:
          "main-thread by design for now: the places strip's window, on the same settle clock as the miniature, and read with it",
      },
    ],
    [
      "tugdeck/src/components/tugways/tug-choice-group.css",
      {
        properties: ["width"],
        ending:
          "main-thread by design: the segment indicator's 160ms slide on a choice, one absolute pill",
      },
    ],
    [
      "tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.css",
      {
        properties: ["width", "height"],
        ending:
          "main-thread by design: the dot figure's presence settling in or out, a one-shot on its own small box and never on the breathing loop's",
      },
    ],
    [
      "tugdeck/src/components/tugways/internal/tug-progress-bar.css",
      {
        properties: ["width"],
        ending:
          "main-thread by design: a determinate fill following its value, absolute in a clipped track",
      },
    ],
    [
      "tugdeck/src/components/tugways/tug-linear-gauge.css",
      {
        properties: ["width"],
        ending: "main-thread by design: a gauge's fill following its value, 80ms",
      },
    ],
    [
      "tugdeck/src/components/tugways/chrome/session-thinking-block.css",
      {
        properties: ["grid-template-rows"],
        ending:
          "main-thread by design: a thinking block's collapse, where the transcript below has to move and only layout moves it; one-shot, on the user's toggle",
      },
    ],
    [
      "tugdeck/src/components/tugways/tug-tab-bar.css",
      {
        properties: ["left", "min-height"],
        ending:
          "main-thread by design: the insert indicator following a tab drag, and a single-tab accessory opening its drop zone under one",
      },
    ],
  ]);

/** The properties rule 6 reports in one declared file, or every one in an undeclared file. */
function undeclaredLayout(
  rel: string,
  properties: readonly string[],
  carveOuts: ReadonlyMap<string, LayoutMotionCarveOut>,
): string[] {
  const allowed = new Set(carveOuts.get(rel)?.properties ?? []);
  return [...new Set(properties)].filter(
    (property) => LAYOUT_PROPERTIES.test(property) && !allowed.has(property),
  );
}

/**
 * Rule 6's stylesheet half: every `transition` or `transition-property` that
 * names a layout property the file has not declared. Pure over the file's text.
 */
export function scanLayoutTransitions(
  raw: string,
  rel: string,
  carveOuts: ReadonlyMap<string, LayoutMotionCarveOut> = LAYOUT_MOTION_CARVE_OUTS,
): Hit[] {
  const hits: Hit[] = [];
  for (const block of cssBlocks(stripComments(raw))) {
    const shorthand = valueOf(block.body, "transition");
    const longhand = valueOf(block.body, "transition-property");
    const named = [
      ...(shorthand === null ? [] : leadingIdentifiers(shorthand)),
      ...(longhand === null
        ? []
        : splitTopLevel(longhand, ",").map((property) => property.trim())),
    ];
    const undeclared = undeclaredLayout(rel, named, carveOuts);
    if (undeclared.length === 0) continue;
    hits.push({
      path: rel,
      line: block.lineOf(/transition/),
      selector: block.prelude.replace(/\s+/g, " ").trim(),
      rule: 6,
      detail: `a transition on layout (${undeclared.join(", ")}) that is not declared`,
    });
  }
  return hits;
}

/** TugAnimator's `animate`, by every name a file imports it under. */
const ANIMATOR_IMPORT = /import\s*\{([^}]*)\}\s*from\s*"[^"]*tug-animator"/g;

/** An object key in a keyframe: a bare camelCase identifier and its colon. */
const KEYFRAME_KEY = /\b([a-z][A-Za-z]*)\s*:/g;

/**
 * Rule 6's TypeScript half: every TugAnimator tween whose keyframes, written
 * in the call, animate a layout property the file has not declared. Pure over
 * the file's text.
 */
export function scanLayoutTweens(
  raw: string,
  rel: string,
  carveOuts: ReadonlyMap<string, LayoutMotionCarveOut> = LAYOUT_MOTION_CARVE_OUTS,
): Hit[] {
  const code = codeOnly(raw);
  const verbs = new Set<string>();
  for (const match of raw.matchAll(ANIMATOR_IMPORT)) {
    for (const spec of match[1].split(",")) {
      const named = /^\s*animate(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(spec);
      if (named !== null) verbs.add(named[1] ?? "animate");
    }
  }
  const groups = new Set(
    Array.from(code.matchAll(GROUP_BINDING), (match) => match[1]),
  );
  if (verbs.size === 0 && groups.size === 0) return [];
  const hits: Hit[] = [];
  for (const match of code.matchAll(/(?:([A-Za-z_$][\w$]*)\s*\??\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const [, receiver, callee] = match;
    const tween =
      receiver === undefined
        ? verbs.has(callee)
        : callee === "animate" && groups.has(receiver);
    if (!tween) continue;
    let end = (match.index ?? 0) + match[0].length;
    for (let depth = 1; end < code.length && depth > 0; end += 1) {
      if (code[end] === "(") depth += 1;
      else if (code[end] === ")") depth -= 1;
    }
    const args = code.slice((match.index ?? 0) + match[0].length, end);
    const keys = Array.from(args.matchAll(KEYFRAME_KEY), (key) => kebab(key[1]));
    const undeclared = undeclaredLayout(rel, keys, carveOuts);
    if (undeclared.length === 0) continue;
    hits.push({
      path: rel,
      line: lineAt(code, match.index ?? 0),
      selector: `${receiver === undefined ? "" : `${receiver}.`}${callee}(`,
      rule: 6,
      detail: `a TugAnimator tween on layout (${undeclared.join(", ")}) that is not declared`,
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// The filesystem, which only `main()` reads
// ---------------------------------------------------------------------------

/** Every file under `dir` with one of `extensions`, recursively, in order. */
function filesUnder(dir: string, extensions: readonly string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...filesUnder(full, extensions));
      continue;
    }
    if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function main(): void {
  const repoRoot = path.resolve(TUGDECK, "..");
  const styleFiles = SCAN_ROOTS.flatMap((root) => filesUnder(root, [".css"]));
  const tsFiles = filesUnder(TS_ROOT, [".ts", ".tsx"]);

  const sources: Source[] = [
    ...styleFiles.map((file) => ({
      path: path.relative(repoRoot, file),
      text: fs.readFileSync(file, "utf8"),
      kind: "css" as const,
    })),
    ...tsFiles.map((file) => ({
      path: path.relative(repoRoot, file),
      text: fs.readFileSync(file, "utf8"),
      kind: "ts" as const,
    })),
  ];

  const context = collectMotionContext(sources);
  const hits = sources.flatMap((source) =>
    source.kind === "css"
      ? [
          ...scanCss(source.text, source.path, context),
          ...scanEntranceKeyframes(source.text, source.path, context),
          ...scanLayoutTransitions(source.text, source.path),
        ]
      : [
          ...scanTs(source.text, source.path, context),
          ...scanRawAnimate(source.text, source.path),
          ...scanLayoutTweens(source.text, source.path),
        ],
  );

  if (hits.length > 0) {
    for (const hit of hits) {
      console.log(
        `${hit.path}:${hit.line} rule=${hit.rule} ${hit.detail} — \`${hit.selector}\``,
      );
    }
    console.log(
      `\naudit:motion FAILED — ${hits.length} finding(s).\n` +
        `  rule 1: the surface positions from the viewport inside a frame that is a containing ` +
        `block for it. Portal it to the canvas overlay root, or make it \`absolute\` if it ` +
        `should travel with the pane.\n` +
        `  rule 2: [D9] — the settle window is compositor-only. Animate \`transform\` or ` +
        `\`opacity\`, or stand the declaration down with ` +
        `\`<the same selector>${SETTLING_MARK} { transition: none }\`.\n` +
        `  rule 3: \`tuglaws/animation-doctrine.md\` — a loop that runs for as long as the ` +
        `deck is up must be one Core Animation can hold. Animate only \`transform\`, ` +
        `\`opacity\`, \`translate\`, \`rotate\` or \`scale\`; keep every transition off the ` +
        `loop's own box; ease with a keyword or one \`cubic-bezier()\`; and write the count ` +
        `\`${LOOP_ITERATIONS_FORM}\` so the motion breaker can still it.\n` +
        `  rule 4: a loop that runs for as long as the deck is up is registered, or no ` +
        `instrument can see it. Name the file that takes its motion hold with ` +
        `\`${HOLD_ANNOTATION} <path>\` in a comment, and have that file call ` +
        `\`useMotionHold(\` or \`acquireMotionHold(\`.\n` +
        `  rule 5: motion goes through TugAnimator — \`animate()\`, a \`group()\`, a Beat, ` +
        `or \`timelineMark()\` for a clock. A surface whose motion genuinely belongs ` +
        `elsewhere is declared in \`MOTION_CARVE_OUTS\` with its reason.\n` +
        `  rule 6: motion on a layout property re-lays-out its box every frame. Move it to ` +
        `\`transform\` or \`opacity\`, remove it, or declare the file and the property in ` +
        `\`LAYOUT_MOTION_CARVE_OUTS\` with the ending it was given.\n` +
        `  A hit is a finding to read, not a reason to loosen the rule.`,
    );
    process.exit(1);
  }

  console.log(
    `audit:motion ok (${styleFiles.length} stylesheets, ${tsFiles.length} TypeScript files scanned)`,
  );
}

if (import.meta.main) {
  main();
}
