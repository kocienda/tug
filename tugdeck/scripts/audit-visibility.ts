#!/usr/bin/env bun
/**
 * audit-visibility.ts — the [L32] tripwire.
 *
 * [L32] says a mechanism that decides visibility fails toward visible: one
 * owner writes both states, a deferred reveal carries a deadline, and a
 * refusal to measure re-arms. A cross-workspace card move unmounts the card's
 * React subtree and rebuilds it inside a space layer that is `display: none`,
 * so a mount-time one-shot that hides an element and waits for something else
 * to un-hide it strands the card invisible forever — `commitStyles()` throws
 * for an element with no box, and nothing re-runs the effect. This script is
 * what keeps a ninth such mechanism from being added by someone who did not
 * read the law.
 *
 * Two rules, over the body of every `useEffect` / `useLayoutEffect` under
 * `tugdeck/src/components/`:
 *
 *   Rule 1 — a mount-once effect (an empty dependency array) must not contain
 *            a hide write or an animation open unless it also contains an
 *            end-state shape.
 *   Rule 2 — any effect must not contain an opacity or visibility hide write
 *            unless it also contains an end-state shape.
 *
 * A hide write is `.style.opacity = "0"`, `.style.visibility = "hidden"`, or
 * `.style.display = "none"`; rule 2 covers the first two. An animation open is
 * a call to `animate(` or `group(`. An end-state shape is `.then(x, x)` (both
 * arms restore), a `return () =>` cleanup, a `setTimeout(` deadline, or
 * `inlineRestorer(`.
 *
 * A hit outside the audited class is a finding to read, not a reason to loosen
 * the rule.
 *
 * Usage:
 *   bun run scripts/audit-visibility.ts     (or: bun run audit:visibility)
 */

import fs from "fs";
import path from "path";

const TUGDECK = path.resolve(import.meta.dir, "..");
const CHECKOUT = path.resolve(TUGDECK, "..");
const SCAN_ROOT = path.join(TUGDECK, "src/components");

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** Every .ts/.tsx under src/components/, less tests, spikes and galleries. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\./.test(entry.name)) continue;
    if (/^(spike|gallery)-/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Enough of a scanner to find an effect body's bounds
// ---------------------------------------------------------------------------

/**
 * The index of the closing quote of the string literal opening at `start`, or
 * -1 if it never closes. Template literals recurse through their `${…}` holes.
 */
function skipString(src: string, start: number): number {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === quote) return i;
    if (quote === "`" && c === "$" && src[i + 1] === "{") {
      const close = matchBrace(src, i + 1);
      if (close === null) return -1;
      i = close - 1;
    }
  }
  return -1;
}

/** Is the `/` at `i` opening a regex literal rather than a division? */
function isRegexStart(src: string, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const c = src[j];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
    if ("(,=:[!&|?{};+*%~^".includes(c)) return true;
    return /\breturn$|\btypeof$|\bcase$|\bin$|\bof$/.test(src.slice(Math.max(0, j - 7), j + 1));
  }
  return true;
}

/** The index of the closing `/` of the regex literal opening at `start`. */
function skipRegex(src: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "\n") return -1;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i;
  }
  return -1;
}

/**
 * The index just past the `}` that closes the `{` at `open`, skipping strings,
 * template holes, comments and regex literals. `null` when it never closes.
 */
function matchBrace(src: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return null;
      i = nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (c === "/" && isRegexStart(src, i)) {
      const end = skipRegex(src, i);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(src, i);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/**
 * The dependency array's text, reading from the `,` that follows an effect
 * body, or `null` when the call takes no second argument.
 */
function dependencyArray(src: string, afterBody: number): string | null {
  let i = afterBody;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== ",") return null;
  i++;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== "[") return null;
  const open = i;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(src, i);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const EFFECT_OPEN = /(?:React\s*\.\s*)?(useEffect|useLayoutEffect)\s*\(\s*(?:async\s+)?\([^()]*\)\s*=>\s*\{/g;

const HIDE_WRITES: ReadonlyArray<readonly [RegExp, string, boolean]> = [
  [/\.\s*style\s*\.\s*opacity\s*=\s*["']0["']/, 'a `.style.opacity = "0"` hide write', true],
  [/\.\s*style\s*\.\s*visibility\s*=\s*["']hidden["']/, 'a `.style.visibility = "hidden"` hide write', true],
  [/\.\s*style\s*\.\s*display\s*=\s*["']none["']/, 'a `.style.display = "none"` hide write', false],
];

const ANIMATION_OPENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\banimate\s*\(/, "an `animate(` call"],
  [/\bgroup\s*\(/, "a `group(` call"],
];

const END_STATE_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.\s*then\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\1\s*\)/, ".then(x, x)"],
  [/return\s*\(\s*\)\s*=>/, "return () =>"],
  [/\bsetTimeout\s*\(/, "setTimeout("],
  [/\binlineRestorer\s*\(/, "inlineRestorer("],
];

interface Hit {
  path: string;
  line: number;
  rule: 1 | 2;
  what: string;
}

function found(body: string, table: ReadonlyArray<readonly [RegExp, string, ...unknown[]]>): string[] {
  return table.filter(([re]) => re.test(body)).map(([, label]) => label);
}

function scan(file: string): { hits: Hit[]; effects: number } {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(CHECKOUT, file);
  const hits: Hit[] = [];
  let effects = 0;

  EFFECT_OPEN.lastIndex = 0;
  for (let m = EFFECT_OPEN.exec(src); m !== null; m = EFFECT_OPEN.exec(src)) {
    const bodyOpen = m.index + m[0].length - 1;
    const bodyEnd = matchBrace(src, bodyOpen);
    if (bodyEnd === null) continue;
    effects++;

    const body = src.slice(bodyOpen, bodyEnd);
    const deps = dependencyArray(src, bodyEnd);
    const mountOnce = deps !== null && deps.replace(/\s/g, "") === "[]";
    const line = src.slice(0, m.index).split("\n").length;
    const endStates = found(body, END_STATE_SHAPES);

    const hides = found(body, HIDE_WRITES);
    const opacityHides = found(
      body,
      HIDE_WRITES.filter(([, , isOpacityOrVisibility]) => isOpacityOrVisibility),
    );
    const animations = found(body, ANIMATION_OPENS);

    if (endStates.length > 0) continue;

    // Rule 1 is read first where both would fire, because it is the finding
    // with more in it: a mount-once effect names the animation open as well as
    // the hide write, and that pair is the defect class the law was written for.
    if (mountOnce && (hides.length > 0 || animations.length > 0)) {
      hits.push({
        path: rel,
        line,
        rule: 1,
        what: `a mount-once effect with ${[...hides, ...animations].join(" and ")} and no end-state shape`,
      });
      continue;
    }
    if (opacityHides.length > 0) {
      hits.push({ path: rel, line, rule: 2, what: `${opacityHides.join(" and ")} with no end-state shape` });
    }
  }

  return { hits, effects };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const files = sourceFiles(SCAN_ROOT);
  const hits: Hit[] = [];
  let effects = 0;

  for (const file of files) {
    const result = scan(file);
    hits.push(...result.hits);
    effects += result.effects;
  }

  if (hits.length > 0) {
    for (const hit of hits) {
      console.log(`${hit.path}:${hit.line} rule=${hit.rule} ${hit.what}`);
    }
    console.log(
      `\naudit:visibility FAILED — ${hits.length} mechanism(s) decide visibility and own no end state. [L32]`,
    );
    process.exit(1);
  }

  console.log(`audit:visibility ok (${effects} effects scanned in ${files.length} files)`);
}

main();
