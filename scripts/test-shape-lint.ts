#!/usr/bin/env bun
/**
 * test-shape-lint — no test measures the machine it runs on. Every red CI and
 * `just ci` run of 2026-10-21 to 2026-10-23 was a test comparing an elapsed
 * time to a number, or a test spawning the developer's interactive login shell
 * and blocking on their history file. A rule that lives in a document drifts
 * back the way the tuned constants did; this is the rule as a lint.
 *
 * It refuses, in test code only: a clock difference compared to a bound (TS
 * `expect`, Rust `assert!`); a per-file or per-test timeout (the one hang guard
 * is the recipe's `--timeout {{BUN_HANG_GUARD_MS}}` and nextest's
 * `slow-timeout`); a login or interactive shell; a shell spawned with the
 * environment it inherited; a call to one of the product's login-shell doors;
 * `SHELL` pointed at a real shell; and a Justfile `bun test` without the guard.
 *
 * A line may be exempted by the comment line directly above it,
 * `// shape-lint: <reason> — <why>`, which exempts it from the rules that reason
 * names and nothing else (see EXEMPTIONS).
 *
 * Decision: briefs/test-lanes-reform-brief.md, [B01], [B02] and [B04].
 *
 *   bun scripts/test-shape-lint.ts [--root <dir>] [--only T1,S2,…]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

export interface Finding {
  path: string;
  line: number;
  rule: string;
  text: string;
}

/** A hit before exemption: the 0-based offset into the text it anchors at. */
interface Hit {
  at: number;
}

type Lang = "ts" | "rust";

interface Rule {
  id: string;
  name: string;
  lang: Lang;
  why: string;
  /** Hits over the text, given the spans of it that are test code. */
  check(text: string, regions: Span[], ctx: Context): Hit[];
}

interface Span {
  start: number;
  end: number;
}

interface Context {
  /** TS only: identifiers whose value derives from a clock difference. */
  clockDerived: Set<string>;
  /** Rust only: identifiers bound to `std::env::var("SHELL")`. */
  shellVars: Set<string>;
}

/** Reason → the rules a `// shape-lint: <reason> —` comment exempts. */
export const EXEMPTIONS: Record<string, string[]> = {
  // tokio's virtual clock under `start_paused = true` advances only when the
  // test says so, so a difference of its instants is not the machine's time.
  "paused-clock": ["R1", "R2"],
  // A door call that is refused before any shell is spawned.
  "no-spawn": ["S3"],
};

// ---------------------------------------------------------------------------
// Scanning: matching brackets past strings and comments.

/**
 * The index of the bracket that closes the one at `open`, skipping strings,
 * comments and (Rust) char literals; -1 when it never closes.
 */
export function matchClose(text: string, open: number, lang: Lang): number {
  const opener = text[open];
  const closer = opener === "(" ? ")" : opener === "{" ? "}" : "]";
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      const endc = text.indexOf("*/", i + 2);
      i = endc === -1 ? text.length : endc + 2;
      continue;
    }
    if (lang === "rust") {
      if (c === "r" && !/[A-Za-z0-9_]/.test(text[i - 1] ?? " ") || (c === "r" && text[i - 1] === "b")) {
        const raw = /r(#*)"/y;
        raw.lastIndex = i;
        const m = raw.exec(text);
        if (m) {
          const term = `"${m[1]}`;
          const endr = text.indexOf(term, i + m[0].length);
          i = endr === -1 ? text.length : endr + term.length;
          continue;
        }
      }
      if (c === "'") {
        const ch = /'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'\n])'/y;
        ch.lastIndex = i;
        const m = ch.exec(text);
        i += m ? m[0].length : 1; // no match: a lifetime
        continue;
      }
      if (c === '"') {
        i = skipQuoted(text, i, '"');
        continue;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      i = skipQuoted(text, i, c);
      continue;
    }
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function skipQuoted(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === quote) return i + 1;
    else i++;
  }
  return text.length;
}

function inRegions(at: number, regions: Span[]): boolean {
  return regions.some((r) => at >= r.start && at <= r.end);
}

/** Every `(`-call of `pattern` (which must end at the open paren) with its argument text. */
function calls(text: string, pattern: RegExp, lang: Lang): { at: number; args: string; end: number }[] {
  const out: { at: number; args: string; end: number }[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = m.index + m[0].length - 1;
    if (text[open] !== "(") continue;
    const close = matchClose(text, open, lang);
    if (close === -1) continue;
    out.push({ at: m.index, args: text.slice(open + 1, close), end: close });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rust test regions.

const CFG_TEST = /^\s*#\[cfg\((?:test|all\(\s*test\b[^\]]*\))\)\]\s*(.*)$/;
const ATTRIBUTE = /^\s*#!?\[/;
const MOD_OPEN = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*\{/;
const MOD_DECL = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/;

/**
 * The spans of a Rust source file that are test code: each `mod <name> { … }`
 * under `#[cfg(test)]` or `#[cfg(all(test, …))]` (with any attributes between),
 * to its closing brace. A `#[cfg(test)]` on a lone item is not a region.
 * `outOfLine` collects the names of `#[cfg(test)] mod <name>;` declarations,
 * whose files are test code whole.
 */
export function rustTestRegions(text: string, outOfLine: string[] = []): Span[] {
  const regions: Span[] = [];
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    const cfg = CFG_TEST.exec(lines[i]);
    if (!cfg) continue;
    // The item the attribute applies to: the rest of this line, else the
    // next line that is neither blank nor another attribute.
    let j = i;
    let item = cfg[1];
    let itemStart = starts[i] + lines[i].length - cfg[1].length;
    while (item.trim() === "" || ATTRIBUTE.test(item)) {
      j++;
      if (j >= lines.length) break;
      item = lines[j];
      itemStart = starts[j];
    }
    const decl = MOD_DECL.exec(item);
    if (decl) {
      outOfLine.push(decl[1]);
      continue;
    }
    if (!MOD_OPEN.test(item)) continue;
    const brace = text.indexOf("{", itemStart);
    const close = matchClose(text, brace, "rust");
    regions.push({ start: starts[i], end: close === -1 ? text.length : close });
    // Resume after the region; nothing nested in it opens another.
    while (i + 1 < lines.length && starts[i + 1] <= (close === -1 ? text.length : close)) i++;
  }
  return regions;
}

// ---------------------------------------------------------------------------
// TypeScript rules.

/** A clock difference, or a clock reading that is only ever a difference. */
const CLOCK =
  /Date\.now\(\)\s*-|-\s*Date\.now\(\)|performance\.now\(\)\s*-|-\s*performance\.now\(\)|performance\.timeOrigin|Bun\.nanoseconds\(\)|process\.hrtime/;

const TS_ASSIGNMENTS = [
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=(?![=>])([^;]*)/g,
  /(?<![\w$.])([A-Za-z_$][\w$]*)\s*[-+*/]?=(?![=>])([^;]*)/g,
  /(?<![\w$.])([A-Za-z_$][\w$]*)\.push\(([^;]*)/g,
];

function namesAny(expr: string, names: Set<string>): boolean {
  for (const n of names) {
    // Not a property (`a.name`); a spread (`...name`) is the identifier itself.
    if (new RegExp(`(?<![\\w$])(?<![^.]\\.)(?<!^\\.)${n.replace(/\$/g, "\\$")}(?![\\w$])`).test(expr)) return true;
  }
  return false;
}

/**
 * Identifiers assigned, anywhere in the file, from an expression holding a
 * clock difference — or from one naming such an identifier, to a fixpoint.
 * Calls are not followed.
 */
function clockDerivedNames(text: string): Set<string> {
  const pairs: [string, string][] = [];
  for (const re of TS_ASSIGNMENTS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) pairs.push([m[1], m[2]]);
  }
  const derived = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, expr] of pairs) {
      if (derived.has(name)) continue;
      if (CLOCK.test(expr) || namesAny(expr, derived)) {
        derived.add(name);
        grew = true;
      }
    }
  }
  return derived;
}

const ORDER_MATCHER = /^\s*\.\s*(toBeLessThan|toBeGreaterThan|toBeLessThanOrEqual|toBeGreaterThanOrEqual)\s*\(/;

const T1: Rule = {
  id: "T1",
  name: "duration comparison",
  lang: "ts",
  why: "an elapsed time compared to a bound measures the machine; assert the property the time stood in for",
  check(text, _regions, ctx) {
    const hits: Hit[] = [];
    for (const call of calls(text, /(?<![\w$.])expect\(/, "ts")) {
      const rest = text.slice(call.end + 1);
      const matcher = ORDER_MATCHER.exec(rest);
      if (!matcher) continue;
      const open = call.end + 1 + matcher[0].length - 1;
      const close = matchClose(text, open, "ts");
      if (close === -1) continue;
      const bound = text.slice(open + 1, close);
      const timed = (s: string) => CLOCK.test(s) || namesAny(s, ctx.clockDerived);
      if (timed(call.args) || timed(bound)) hits.push({ at: call.at });
    }
    return hits;
  },
};

const T2_OPENER = /^(\s*)(?:test|it|describe|beforeAll|afterAll|beforeEach|afterEach)(?:\.\w+(?:\([^)]*\))?)?\(/;
const T2_CLOSER = /^(\s*)\},\s*(?:[\w$]+(?:\s*[-+*/]\s*[\w$]+)*|\{\s*timeout\s*:.*\})\s*\);\s*$/;

const T2: Rule = {
  id: "T2",
  name: "per-test timeout",
  lang: "ts",
  why: "a test file that sets its own timeout tunes a constant to one machine; the recipe's hang guard is the only timeout",
  check(text) {
    const hits: Hit[] = [];
    const re = /\bsetDefaultTimeout\(/g;
    for (let m = re.exec(text); m; m = re.exec(text)) hits.push({ at: m.index });
    const lines = text.split("\n");
    let offset = 0;
    const starts = lines.map((l) => {
      const s = offset;
      offset += l.length + 1;
      return s;
    });
    lines.forEach((line, i) => {
      const close = T2_CLOSER.exec(line);
      if (!close) return;
      const indent = close[1];
      // The block's opener is the nearest line above at the same indentation.
      for (let j = i - 1; j >= 0; j--) {
        const l = lines[j];
        if (l.trim() === "") continue;
        const lead = /^\s*/.exec(l)![0];
        if (lead.length > indent.length) continue;
        if (lead === indent && T2_OPENER.test(l)) hits.push({ at: starts[i] });
        break;
      }
    });
    return hits;
  },
};

const SHELL_PROGRAM_TS = /^\s*(?:["'`](?:\/bin\/)?(?:sh|bash|zsh)["'`]|process\.env\.SHELL\b)/;
const LOGIN_FLAG = String.raw`-(?:i|l|il|li)c?`;

const TS_SPAWN = /(?<![\w$])(?:Bun\.spawnSync|Bun\.spawn|spawnSync|spawn|execFileSync|execFile)\(/;

/** The program a TS spawn call runs: the first array element, `cmd:`'s first, or the first argument. */
function tsProgram(args: string): string {
  const a = args.trimStart();
  if (a.startsWith("[")) return a.slice(1);
  if (a.startsWith("{")) {
    const cmd = /\bcmd\s*:\s*\[/.exec(a);
    return cmd ? a.slice(cmd.index + cmd[0].length) : "";
  }
  return a;
}

const S1_TS: Rule = {
  id: "S1",
  name: "login or interactive shell",
  lang: "ts",
  why: "a login or interactive shell reads the developer's rc files and locks their history; a test spawns no such shell",
  check(text) {
    const hits: Hit[] = [];
    const re = new RegExp(
      String.raw`(?:["'\`](?:\/bin\/)?(?:sh|bash|zsh)["'\`]|process\.env\.SHELL!?)\s*,\s*\[?\s*["'\`]${LOGIN_FLAG}["'\`]`,
      "g",
    );
    for (let m = re.exec(text); m; m = re.exec(text)) hits.push({ at: m.index });
    return hits;
  },
};

const S2_TS: Rule = {
  id: "S2",
  name: "shell spawn without a scrubbed env",
  lang: "ts",
  why: "a shell spawned with the inherited environment reads the developer's HOME; give it an explicit env with a temp HOME",
  check(text) {
    const hits: Hit[] = [];
    for (const call of calls(text, TS_SPAWN, "ts")) {
      if (!SHELL_PROGRAM_TS.test(tsProgram(call.args))) continue;
      const hasEnv = /\benv\s*[:,}]/.test(call.args);
      if (!hasEnv || /\.\.\.\s*process\.env\b/.test(call.args)) hits.push({ at: call.at });
    }
    return hits;
  },
};

// ---------------------------------------------------------------------------
// Rust rules.

const ASSERT = /(?<![\w:])assert(?:_eq|_ne)?!\(/;

const R1: Rule = {
  id: "R1",
  name: "elapsed assert",
  lang: "rust",
  why: "an assert over `.elapsed()` measures the machine; assert the property the time stood in for",
  check(text, regions) {
    return calls(text, ASSERT, "rust")
      .filter((c) => inRegions(c.at, regions) && /\.elapsed\(\)/.test(c.args))
      .map((c) => ({ at: c.at }));
  },
};

const R2: Rule = {
  id: "R2",
  name: "duration-bound assert",
  lang: "rust",
  why: "a duration compared to a bound measures the machine; assert the property the time stood in for",
  check(text, regions) {
    const bound = /(?:^|[^-=<>])(?:<=|>=|<|>)\s*(?:[\w]+::)*Duration::from_/;
    return calls(text, ASSERT, "rust")
      .filter((c) => inRegions(c.at, regions) && bound.test(c.args))
      .map((c) => ({ at: c.at }));
  },
};

const S1_RUST: Rule = {
  id: "S1",
  name: "login or interactive shell",
  lang: "rust",
  why: "a login or interactive shell reads the developer's rc files and locks their history; a test spawns no such shell",
  check(text, regions) {
    const hits: Hit[] = [];
    const re = new RegExp(String.raw`\.args?\(\s*&?\[?\s*"${LOGIN_FLAG}"`, "g");
    for (let m = re.exec(text); m; m = re.exec(text)) if (inRegions(m.index, regions)) hits.push({ at: m.index });
    return hits;
  },
};

const SHELL_LITERAL_RUST = /^\s*"(?:\/bin\/)?(?:sh|bash|zsh)"\s*$/;
const BUILDER_END = /\.(?:spawn|output|status)\(/;

const S2_RUST: Rule = {
  id: "S2",
  name: "shell spawn without a scrubbed env",
  lang: "rust",
  why: "a shell spawned with the inherited environment reads the developer's HOME; `.env_clear()` it and set PATH and a temp HOME",
  check(text, regions, ctx) {
    const hits: Hit[] = [];
    for (const call of calls(text, /\bCommand::new\(/, "rust")) {
      if (!inRegions(call.at, regions)) continue;
      const arg = call.args.trim().replace(/^&/, "");
      const shell = SHELL_LITERAL_RUST.test(call.args) || ctx.shellVars.has(arg);
      if (!shell) continue;
      // The builder chain: from the constructor to the call that runs it.
      const after = text.slice(call.end);
      const end = BUILDER_END.exec(after);
      const chain = end ? after.slice(0, end.index) : after.split("\n").slice(0, 40).join("\n");
      if (!/\.env_clear\(\)/.test(chain)) hits.push({ at: call.at });
    }
    return hits;
  },
};

const DOORS = [
  "dump_shell_words",
  "fetch_function_body",
  "ensure_body_chain",
  "probe_login_path",
  "compute_path_commands",
  "spawn_session_shell",
  "shell_dispatcher_task",
];

const S3: Rule = {
  id: "S3",
  name: "login-shell door",
  lang: "rust",
  why: "this function spawns the user's login shell; a test drives the bare policy, or exempts a call refused before any spawn",
  check(text, regions) {
    const hits: Hit[] = [];
    const re = new RegExp(String.raw`(?<!fn\s+)(?<![\w])(?:${DOORS.join("|")})\(`, "g");
    for (let m = re.exec(text); m; m = re.exec(text)) if (inRegions(m.index, regions)) hits.push({ at: m.index });
    return hits;
  },
};

const S4: Rule = {
  id: "S4",
  name: "SHELL set to a real shell",
  lang: "rust",
  why: "pointing SHELL at a real shell is how a test reaches a login-shell door through a method the lint cannot see",
  check(text, regions) {
    const hits: Hit[] = [];
    const re = /\bset_var\(\s*"SHELL"\s*,\s*"([^"]*)"/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const last = m[1].split("/").pop() ?? "";
      if (["sh", "bash", "zsh"].includes(last) && inRegions(m.index, regions)) hits.push({ at: m.index });
    }
    return hits;
  },
};

export const RULES: Rule[] = [T1, T2, S1_TS, S2_TS, S1_RUST, S2_RUST, S3, S4, R1, R2];

export const J1 = {
  id: "J1",
  name: "bun run without the guard",
  why: "every `bun test` a recipe runs carries the one hang guard, `--timeout {{BUN_HANG_GUARD_MS}}`",
};

// ---------------------------------------------------------------------------
// Running the rules.

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], at: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const EXEMPT_COMMENT = /^\s*\/\/\s*shape-lint:\s*([\w-]+)\s*(?:—|--|-)\s*\S/;

/** 1-based line → the rules exempted on it, from the comment line above. */
function exemptions(lines: string[]): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  lines.forEach((l, i) => {
    const m = EXEMPT_COMMENT.exec(l);
    if (m && EXEMPTIONS[m[1]]) out.set(i + 2, new Set(EXEMPTIONS[m[1]]));
  });
  return out;
}

export interface LintOptions {
  /** Rust: the whole file is test code (a crate's `tests/`, an out-of-line test module). */
  wholeFile?: boolean;
  /** Restrict to these rule ids. */
  only?: Set<string>;
  /** Incremented once per finding an exemption comment suppressed. */
  exempted?: { count: number };
}

function isCrateTestsPath(path: string): boolean {
  return /(^|\/)crates\/[^/]+\/tests\//.test(path);
}

/** Findings in one TypeScript (`.ts`, `.tsx`) or Rust (`.rs`) file. */
export function lintText(path: string, text: string, opts: LintOptions = {}): Finding[] {
  const lang: Lang | null = path.endsWith(".rs") ? "rust" : /\.tsx?$/.test(path) ? "ts" : null;
  if (!lang) return [];
  const regions =
    lang === "ts" || opts.wholeFile || isCrateTestsPath(path) ? [{ start: 0, end: text.length }] : rustTestRegions(text);
  if (regions.length === 0) return [];
  const ctx: Context = {
    clockDerived: lang === "ts" ? clockDerivedNames(text) : new Set(),
    shellVars: new Set(),
  };
  if (lang === "rust") {
    const re = /\blet\s+(?:mut\s+)?([a-z_]\w*)\s*(?::[^=]+)?=\s*(?:std::)?env::var(?:_os)?\(\s*"SHELL"\s*\)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) ctx.shellVars.add(m[1]);
  }
  const lines = text.split("\n");
  const starts = lineStarts(text);
  const exempt = exemptions(lines);
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (rule.lang !== lang) continue;
    if (opts.only && !opts.only.has(rule.id)) continue;
    const seen = new Set<number>();
    for (const hit of rule.check(text, regions, ctx)) {
      const line = lineOf(starts, hit.at);
      if (seen.has(line)) continue;
      seen.add(line);
      if (exempt.get(line)?.has(rule.id)) {
        if (opts.exempted) opts.exempted.count++;
        continue;
      }
      findings.push({ path, line, rule: rule.id, text: `${rule.name}: ${lines[line - 1].trim().slice(0, 140)}` });
    }
  }
  return findings;
}

/** J1 over a Justfile: a `bun test` invocation without the hang-guard variable. */
export function lintJustfile(text: string, path = "Justfile"): Finding[] {
  const findings: Finding[] = [];
  text.split("\n").forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return;
    // Quoted text is a label or a needle, never the invocation.
    const line = raw.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
    if (!/\bbun test\b/.test(line)) return;
    if (/--timeout[ =]\{\{BUN_HANG_GUARD_MS\}\}/.test(line)) return;
    findings.push({ path, line: i + 1, rule: J1.id, text: `${J1.name}: ${raw.trim().slice(0, 140)}` });
  });
  return findings;
}

// ---------------------------------------------------------------------------
// The tree.

/** Where TypeScript test files are read from, relative to the root. */
export const TS_ROOTS = [
  "tugdeck/src",
  "tugdeck/scripts",
  "tugdeck/full-lane",
  "tugcode/src",
  "tugproto",
  "tests/app-test/scripts",
  "tests/app-test/_harness",
  "tugplug",
  "scripts",
];

/** Files the lint does not read, each with its reason. */
const SKIPPED = new Map<string, string>([
  ["scripts/__tests__/test-shape-lint.test.ts", "this lint's own fixtures, which spell every shape it refuses"],
]);

function walk(dir: string, accept: (rel: string, name: string) => boolean, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "target" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, accept, out);
    else if (accept(p, entry)) out.push(p);
  }
}

function excludedData(rel: string): boolean {
  return /\/(corpus|fixtures)\//.test(`/${rel}`);
}

export interface TreeResult {
  findings: Finding[];
  files: number;
  exempted: number;
}

export function lintTree(root = ROOT, only?: Set<string>): TreeResult {
  const exempted = { count: 0 };
  const findings: Finding[] = [];
  let files = 0;

  const ts: string[] = [];
  for (const r of TS_ROOTS) {
    walk(join(root, r), (p, name) => /\.tsx?$/.test(name) && (/\.test\.tsx?$/.test(name) || /\/__tests__\//.test(p)), ts);
  }
  for (const file of [...new Set(ts)].sort()) {
    const rel = relative(root, file);
    if (SKIPPED.has(rel) || excludedData(rel)) continue;
    files++;
    findings.push(...lintText(rel, readFileSync(file, "utf8"), { only, exempted }));
  }

  const crates = join(root, "tugrust", "crates");
  const rust: string[] = [];
  if (existsSync(crates)) {
    for (const crate of readdirSync(crates).sort()) {
      walk(join(crates, crate, "src"), (_p, name) => name.endsWith(".rs"), rust);
      walk(join(crates, crate, "tests"), (_p, name) => name.endsWith(".rs"), rust);
    }
  }
  // Out-of-line `#[cfg(test)] mod x;` files are test code whole.
  const texts = new Map<string, string>();
  const whole = new Set<string>();
  for (const file of rust) {
    const text = readFileSync(file, "utf8");
    texts.set(file, text);
    const names: string[] = [];
    rustTestRegions(text, names);
    const stem = basename(file, ".rs");
    const childDir = ["mod", "lib", "main"].includes(stem) ? dirname(file) : join(dirname(file), stem);
    for (const n of names) {
      whole.add(join(childDir, `${n}.rs`));
      whole.add(join(childDir, n, "mod.rs"));
    }
  }
  for (const file of rust.sort()) {
    const rel = relative(root, file);
    if (excludedData(rel)) continue;
    files++;
    findings.push(...lintText(rel, texts.get(file)!, { only, exempted, wholeFile: whole.has(file) }));
  }

  const justfile = join(root, "Justfile");
  if (existsSync(justfile) && (!only || only.has(J1.id))) {
    files++;
    findings.push(...lintJustfile(readFileSync(justfile, "utf8")));
  }
  return { findings, files, exempted: exempted.count };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let root = ROOT;
  let only: Set<string> | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = argv[++i];
    else if (argv[i] === "--only") only = new Set(argv[++i].split(",").map((s) => s.trim()));
    else {
      console.error(`test-shape-lint: unknown argument ${argv[i]}`);
      process.exit(2);
    }
  }
  const { findings, files, exempted } = lintTree(root, only);
  const why = new Map<string, string>([...RULES.map((r) => [r.id, r.why] as [string, string]), [J1.id, J1.why]]);
  if (findings.length > 0) {
    for (const f of findings) console.error(`${f.path}:${f.line}: ${f.rule} — ${f.text}`);
    const rules = [...new Set(findings.map((f) => f.rule))].sort();
    console.error("");
    for (const r of rules) console.error(`  ${r}: ${why.get(r)}`);
    console.error(`\ntest-shape-lint: ${findings.length} finding(s) in ${files} file(s) read; ${exempted} exempted`);
    process.exit(1);
  }
  console.log(`test-shape-lint: ${files} file(s) read, no test measures its machine; ${exempted} exempted`);
}
