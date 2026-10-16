/**
 * card-dom.ts — finding the test calls that reach into a card's DOM through
 * the shell.
 *
 * A card that is a body keeps its DOM in its own page, so an expression the
 * shell's page evaluates finds nothing of it; `App.body(cardId)` is the only
 * way a test reaches it. This module reads a test file's source and lists
 * each call that still evaluates a card selector in the shell — the census
 * (`card-dom-census.ts`) prints those per file and kind, and the codemod
 * (`card-dom-codemod.ts`) rewrites the ones whose shape proves the rewrite
 * right.
 *
 * It reads source text, not a syntax tree: comments are blanked, strings,
 * template literals and regex literals are skipped as units, and a call's
 * argument is read to its matching parenthesis. A call's text is its
 * argument with every file-local `const` and `function` it names written in
 * beside it, three names deep, so a selector held in a constant still counts.
 */

/** The page-evaluating verbs a test calls on `App` (and on `BodyApp`). */
export const EVALUATORS = [
  "evalJS",
  "waitForCondition",
  "getElementScreenBounds",
  "getElementState",
  "getComputedStyleValue",
  "getSelection",
  "screenshot",
] as const;

/** Selectors that enter a card's DOM whatever the card's kind. */
export const CARD_SELECTORS = [
  "[data-card-host]",
  "cardHost(",
  "keyboardIsInCard(",
  "keyboardInCardHost(",
  "ROUTE_CHOICE",
  '[data-slot="tug-choice-group"][aria-label="Route"]',
  ".cm-editor",
  ".cm-content",
  '[data-slot="tug-prompt-entry"]',
] as const;

/** Selectors only a Session card's DOM holds, so a reach with no named card is the Session card's. */
const SESSION_SELECTORS = ["ROUTE_CHOICE", '[data-slot="tug-choice-group"][aria-label="Route"]', '[data-slot="tug-prompt-entry"]'];

/** A kind's root selector, as `body-grounding/_kinds.ts` lists it. */
export interface KindRoot {
  readonly componentId: string;
  readonly root: string;
}

/** What the scan matches besides {@link CARD_SELECTORS}. */
export interface CensusVocabulary {
  readonly kindRoots: readonly KindRoot[];
  /** Further selectors (and the names they are exported under) that enter a card. */
  readonly extraSelectors: readonly string[];
  /**
   * A kind for a file whose cards say nothing of theirs: the first entry
   * whose path fragment one of the file's `@covers` lines holds.
   */
  readonly coversKinds: ReadonlyArray<readonly [fragment: string, componentId: string]>;
}

/** What one file's scan reads beyond its own source. */
export interface FileContext {
  /** The bindings the file imports from the corpus's own modules, by local name. */
  readonly imported: Map<string, string>;
}

/** One shell-evaluated call that reaches into a card. */
export interface CensusEntry {
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  readonly method: string;
  readonly receiver: string;
  /** The card the call names, when exactly one is named as a literal (or a `const` bound to one). */
  readonly cardId: string | null;
  /** That card's kind, or the kind its selectors belong to; `unknown` when neither says. */
  readonly kind: string;
  /** The card selectors its text holds. */
  readonly selectors: readonly string[];
  /** The source of the argument list, as written. */
  readonly args: string;
  /** Offsets in the file: the receiver's start and end, and the argument list's close. */
  readonly receiverStart: number;
  readonly receiverEnd: number;
  readonly argsEnd: number;
  /** Every card id the text names, resolved or not (`?` for one it could not resolve). */
  readonly cardIds: readonly string[];
  /** The id as written in source (`"A"`, or a const's name), when exactly one is named. */
  readonly cardIdSource: string | null;
  /** The text reads the shell's deck surfaces (`window.__tug`, `window.tugdeck`). */
  readonly readsShell: boolean;
}

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "\n", "", "+", "-", "*", "%", "<", ">", "~", "^"]);

function prevSignificant(src: string, i: number): string {
  for (let j = i - 1; j >= 0; j--) {
    const c = src[j];
    if (c !== " " && c !== "\t" && c !== "\r") return c;
  }
  return "";
}

/** The index past a quoted string starting at `i` (a `'` or `"`). */
function skipString(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === "\\") j++;
    else if (src[j] === "\n") break;
    j++;
  }
  return j + 1;
}

/** The index past a template literal starting at `i`, its `${…}` holes read as code. */
function skipTemplate(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length && src[j] !== "`") {
    if (src[j] === "\\") j += 2;
    else if (src[j] === "$" && src[j + 1] === "{") j = skipBalanced(src, j + 1, "{", "}");
    else j++;
  }
  return j + 1;
}

function skipRegex(src: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < src.length && src[j] !== "\n") {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) break;
    j++;
  }
  j++;
  while (j < src.length && /[a-z]/.test(src[j])) j++;
  return j;
}

/**
 * The index past a balanced `open … close` starting at `i` (which holds
 * `open`), skipping strings, templates, regexes and comments inside.
 */
export function skipBalanced(src: string, i: number, open: string, close: string): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"') {
      j = skipString(src, j);
      continue;
    }
    if (c === "`") {
      j = skipTemplate(src, j);
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      while (j < src.length && src[j] !== "\n") j++;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      const end = src.indexOf("*/", j + 2);
      j = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "/" && REGEX_PRECEDERS.has(prevSignificant(src, j))) {
      j = skipRegex(src, j);
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return src.length;
}

/** `src` with every comment's characters blanked (newlines kept), so offsets and lines still match. */
export function maskComments(src: string): string {
  const out = src.split("");
  let j = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"') j = skipString(src, j);
    else if (c === "`") j = skipTemplate(src, j);
    else if (c === "/" && src[j + 1] === "/") {
      const end = src.indexOf("\n", j);
      const to = end === -1 ? src.length : end;
      blank(j, to);
      j = to;
    } else if (c === "/" && src[j + 1] === "*") {
      const end = src.indexOf("*/", j + 2);
      const to = end === -1 ? src.length : end + 2;
      blank(j, to);
      j = to;
    } else if (c === "/" && REGEX_PRECEDERS.has(prevSignificant(src, j))) j = skipRegex(src, j);
    else j++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Names a file binds
// ---------------------------------------------------------------------------

/** Every file-local `const`/`let` initialiser and `function` body, by name. */
export function fileBindings(src: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*/g;
  for (const m of src.matchAll(decl)) {
    const start = (m.index ?? 0) + m[0].length;
    bindings.set(m[1], src.slice(start, initialiserEnd(src, start)));
  }
  const fn = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of src.matchAll(fn)) {
    // To the first line that closes a block at the function's own indent:
    // parameters and a return type may hold braces of their own.
    const start = m.index ?? 0;
    const indent = /[^\S\n]*$/.exec(src.slice(src.lastIndexOf("\n", start) + 1, start))?.[0] ?? "";
    const close = src.indexOf(`\n${indent}}`, skipBalanced(src, start + m[0].length - 1, "(", ")"));
    bindings.set(m[1], src.slice(start, close === -1 ? src.length : close + indent.length + 2));
  }
  return bindings;
}

/** Where a `const` initialiser starting at `i` ends: its `;`, or a newline at depth zero. */
function initialiserEnd(src: string, i: number): number {
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === ";") return j;
    if (c === "\n" && !/[=+\-*/?:,(.&|]\s*$/.test(src.slice(Math.max(i, j - 4), j)) && !/^\s*[.?:+\-&|]/.test(src.slice(j + 1, j + 6))) return j;
    if (c === "(") j = skipBalanced(src, j, "(", ")");
    else if (c === "[") j = skipBalanced(src, j, "[", "]");
    else if (c === "{") j = skipBalanced(src, j, "{", "}");
    else if (c === "'" || c === '"') j = skipString(src, j);
    else if (c === "`") j = skipTemplate(src, j);
    else j++;
  }
  return src.length;
}

/** The string literal a binding is, or null. */
function literalOf(bindings: Map<string, string>, name: string): string | null {
  const init = bindings.get(name);
  if (init === undefined) return null;
  const m = /^\s*(["'`])([^"'`$\\]*)\1\s*(?:as const)?\s*$/.exec(init);
  return m === null ? null : m[2];
}

/** `text` with the bindings of every name it uses written in beside it, `depth` names deep. */
export function expandText(text: string, bindings: Map<string, string>, depth = 3): string {
  let out = text;
  const seen = new Set<string>();
  let frontier = text;
  for (let d = 0; d < depth; d++) {
    let added = "";
    for (const m of frontier.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = m[0];
      if (seen.has(name)) continue;
      seen.add(name);
      const init = bindings.get(name);
      if (init !== undefined) added += `\n${init}`;
    }
    if (added === "") break;
    out += added;
    frontier = added;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cards named, and their kinds
// ---------------------------------------------------------------------------

interface NamedCards {
  /** Resolved ids, and `?` for a named card the scan could not resolve. */
  ids: string[];
  /** As written, for each resolved id. */
  sources: Map<string, string>;
}

/** The card ids `text` names, through `cardHost(…)`, the keyboard helpers and `data-card-id=`. */
export function cardsNamed(text: string, bindings: Map<string, string>): NamedCards {
  const ids: string[] = [];
  const sources = new Map<string, string>();
  const add = (id: string | null, source: string): void => {
    if (id === null) {
      ids.push("?");
      return;
    }
    ids.push(id);
    if (!sources.has(id)) sources.set(id, source);
  };
  const helper = /\b(?:cardHost|keyboardIsInCard|keyboardInCardHost)\(\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?(["'`][^"'`$]*["'`]|[A-Za-z_$][\w$.]*)\s*[,)]/g;
  for (const m of text.matchAll(helper)) {
    const arg = m[1];
    if (/^["'`]/.test(arg)) add(arg.slice(1, -1), JSON.stringify(arg.slice(1, -1)));
    else add(literalOf(bindings, arg), arg);
  }
  const attr = /data-card-id=\\*["']?(\$\{\s*([^}]*?)\s*\}|[^"'\\\]\s]+)/g;
  for (const m of text.matchAll(attr)) {
    if (m[2] !== undefined) {
      const inner = m[2];
      const call = /^JSON\.stringify\(\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(inner);
      const name = call !== null ? call[1] : /^[A-Za-z_$][\w$]*$/.test(inner) ? inner : null;
      add(name === null ? null : literalOf(bindings, name), name ?? inner);
    } else {
      add(m[1], JSON.stringify(m[1]));
    }
  }
  return { ids, sources };
}

/** The kind of each card the file seeds as `{ id: …, componentId: "…" }`. */
export function seededKinds(src: string, bindings: Map<string, string>): Map<string, string> {
  const kinds = new Map<string, string>();
  const idValue = (raw: string): string | null => {
    const v = raw.trim();
    const lit = /^(["'`])([^"'`$]*)\1$/.exec(v);
    if (lit !== null) return lit[2];
    return /^[A-Za-z_$][\w$]*$/.test(v) ? literalOf(bindings, v) : null;
  };
  const forward = /\bid:\s*([^,{}\n]+?)\s*,[^{}]*?\bcomponentId:\s*["']([\w-]+)["']/g;
  for (const m of src.matchAll(forward)) {
    const id = idValue(m[1]);
    if (id !== null) kinds.set(id, m[2]);
  }
  const backward = /\bcomponentId:\s*["']([\w-]+)["']\s*,[^{}]*?\bid:\s*([^,{}\n]+?)\s*[,}]/g;
  for (const m of src.matchAll(backward)) {
    const id = idValue(m[2]);
    if (id !== null && !kinds.has(id)) kinds.set(id, m[1]);
  }
  return kinds;
}

/** Every kind the file seeds a card of. */
function kindsSeeded(src: string): Set<string> {
  return new Set([...src.matchAll(/\bcomponentId:\s*["']([\w-]+)["']/g)].map((m) => m[1]));
}

// ---------------------------------------------------------------------------
// The census of one file
// ---------------------------------------------------------------------------

/** The receiver of the member call whose `.` is at `dot`: its start offset. */
function receiverStart(src: string, dot: number): number {
  let j = dot - 1;
  if (src[j] === "?") j--;
  while (j >= 0 && /\s/.test(src[j])) j--;
  while (j >= 0) {
    const c = src[j];
    if (c === ")" || c === "]") {
      const open = c === ")" ? "(" : "[";
      let depth = 0;
      for (; j >= 0; j--) {
        if (src[j] === c) depth++;
        else if (src[j] === open) {
          depth--;
          if (depth === 0) break;
        }
      }
      j--;
      continue;
    }
    if (/[\w$.]/.test(c)) {
      j--;
      continue;
    }
    break;
  }
  return j + 1;
}

/** Names the file binds to a body: `x = ….body(…)` or one of the harness's body finders, or a parameter typed `BodyApp`. */
function bodyNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:await\s+)?[^;\n]*(?:\.body\(|\bbodyOfKind\(|\bstandUpKind\(|\bcardPage\()/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*BodyApp\b/g)) names.add(m[1]);
  return names;
}

const SHELL_READ = /window\.__tug\b|window\.tugdeck\b|\b__tug\./;

/**
 * The mark that says a call reads the shell's page on purpose — a check that
 * the shell's document did not take what a body did — on the call's line or
 * the line above it.
 */
export const SHELL_ON_PURPOSE = "card-dom: shell";

/** Every call in `src` that evaluates a card selector in the shell's page. */
export function censusOfSource(
  file: string,
  src: string,
  vocabulary: CensusVocabulary,
  context: FileContext = { imported: new Map() },
): CensusEntry[] {
  const masked = maskComments(src);
  const bindings = new Map([...context.imported, ...fileBindings(masked)]);
  const seeding = [masked, ...context.imported.values()].join("\n");
  const seeded = seededKinds(seeding, bindings);
  const fileKinds = kindsSeeded(seeding);
  const covered = coveredKind(src, vocabulary.coversKinds);
  const onBody = bodyNames(masked);
  const lines = src.split("\n");
  const selectors = [...CARD_SELECTORS, ...vocabulary.extraSelectors, ...vocabulary.kindRoots.map((k) => k.root)];
  const entries: CensusEntry[] = [];
  const call = new RegExp(`\\??\\.\\s*(${EVALUATORS.join("|")})\\s*(?:<(?:[^<>()]|<[^<>]*>)*>)?\\s*\\(`, "g");
  for (const m of masked.matchAll(call)) {
    const dot = (m.index ?? 0) + (m[0].startsWith("?") ? 1 : 0);
    const open = (m.index ?? 0) + m[0].length - 1;
    const start = receiverStart(masked, dot);
    const receiver = masked.slice(start, dot).trim().replace(/\?$/, "");
    // A body, or the page a card lives in (`cardPage` answers its body when it has one).
    // `x.body` is a helper's answer carrying the body beside the card's id.
    if (receiver === "" || receiver.includes(".body(") || receiver.endsWith(".body") || receiver.includes("cardPage(")) continue;
    if (onBody.has(receiver)) continue;
    const close = skipBalanced(masked, open, "(", ")");
    const line = masked.slice(0, dot).split("\n").length;
    if ((lines[line - 1] ?? "").includes(SHELL_ON_PURPOSE) || (lines[line - 2] ?? "").includes(SHELL_ON_PURPOSE)) continue;
    const args = masked.slice(open + 1, close - 1);
    const text = expandText(args, bindings);
    const found = selectors.filter((s) => text.includes(s));
    if (found.length === 0) continue;
    const named = cardsNamed(text, bindings);
    const resolved = [...new Set(named.ids.filter((id) => id !== "?"))];
    const cardId = resolved.length === 1 && !named.ids.includes("?") ? resolved[0] : null;
    const kind = kindOf(cardId, resolved, found, seeded, fileKinds, vocabulary.kindRoots, covered);
    entries.push({
      file,
      line,
      method: m[1],
      receiver,
      cardId,
      kind,
      selectors: found,
      args: src.slice(open + 1, close - 1),
      receiverStart: start,
      receiverEnd: dot,
      argsEnd: close,
      cardIds: named.ids,
      cardIdSource: cardId === null ? null : (named.sources.get(cardId) ?? null),
      readsShell: SHELL_READ.test(text),
    });
  }
  return entries;
}

function kindOf(
  cardId: string | null,
  resolved: readonly string[],
  found: readonly string[],
  seeded: Map<string, string>,
  fileKinds: Set<string>,
  kindRoots: readonly KindRoot[],
  covered: string | null,
): string {
  if (cardId !== null && seeded.has(cardId)) return seeded.get(cardId) as string;
  const named = new Set(resolved.map((id) => seeded.get(id)).filter((k): k is string => k !== undefined));
  if (named.size === 1) return [...named][0];
  const rooted = kindRoots.filter((k) => found.includes(k.root));
  if (rooted.length === 1) return rooted[0].componentId;
  if (found.some((s) => SESSION_SELECTORS.includes(s))) return "session";
  if (fileKinds.size === 1) return [...fileKinds][0];
  if (covered !== null) return covered;
  return "unknown";
}

/** The kind the file's `@covers` lines name, by the first fragment one of them holds. */
function coveredKind(src: string, coversKinds: CensusVocabulary["coversKinds"]): string | null {
  const covers = [...src.matchAll(/^\s*\*?\s*@covers\s+(\S+)/gm)].map((m) => m[1]);
  for (const [fragment, kind] of coversKinds) if (covers.some((c) => c.includes(fragment))) return kind;
  return null;
}

/**
 * The named imports a file takes from relative modules, each bound to the
 * text the module gives it (`const` initialiser or `function`), read through
 * `readModule(specifier)`, which answers null for a module it cannot read.
 */
export function importedBindings(src: string, readModule: (specifier: string) => string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'](\.[^"']*)["']/g)) {
    const moduleSrc = readModule(m[2]);
    if (moduleSrc === null) continue;
    const theirs = fileBindings(maskComments(moduleSrc));
    for (const part of m[1].split(",")) {
      const spec = part.trim().replace(/^type\s+/, "");
      if (spec === "") continue;
      const [name, local] = spec.split(/\s+as\s+/);
      const text = theirs.get(name.trim());
      if (text !== undefined) out.set((local ?? name).trim(), text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------

/** One `{file, kind}` pair not yet migrated. */
export interface AllowedPair {
  readonly file: string;
  readonly kind: string;
}

/** The entries no allowed pair covers. */
export function unallowed(entries: readonly CensusEntry[], allowed: readonly AllowedPair[]): CensusEntry[] {
  const keys = new Set(allowed.map((p) => `${p.file}\u0000${p.kind}`));
  return entries.filter((e) => !keys.has(`${e.file}\u0000${e.kind}`));
}

/** The allowed pairs no entry needs any more. */
export function stalePairs(entries: readonly CensusEntry[], allowed: readonly AllowedPair[]): AllowedPair[] {
  const used = new Set(entries.map((e) => `${e.file}\u0000${e.kind}`));
  return allowed.filter((p) => !used.has(`${p.file}\u0000${p.kind}`));
}

/** The distinct `{file, kind}` pairs of `entries`, sorted. */
export function pairsOf(entries: readonly CensusEntry[]): AllowedPair[] {
  const seen = new Map<string, AllowedPair>();
  for (const e of entries) seen.set(`${e.file}\u0000${e.kind}`, { file: e.file, kind: e.kind });
  return [...seen.values()].sort((a, b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------
// The codemod's provable shape
// ---------------------------------------------------------------------------

/** Why an entry is left for a hand to rewrite. */
export type ManualReason = "no single card" | "card id not a literal" | "reads the shell's deck" | "receiver not a name";

/** Whether `entry` is in the provable shape, and why not when it is not. */
export function provable(entry: CensusEntry): ManualReason | null {
  if (entry.readsShell) return "reads the shell's deck";
  if (entry.cardIds.includes("?")) return "card id not a literal";
  if (entry.cardId === null || entry.cardIdSource === null) return "no single card";
  if (!/^[A-Za-z_$][\w$]*$/.test(entry.receiver)) return "receiver not a name";
  return null;
}

/**
 * The codemod over one file: its new source, and the entries it rewrote and
 * left. With `into`, an entry that names no card but is otherwise provable —
 * it reads nothing of the shell's deck, on a plain receiver — moves onto the
 * body handle `into` names: a card the file opens rather than seeds, whose
 * id it never spells.
 */
export function rewriteSource(
  src: string,
  entries: readonly CensusEntry[],
  into: string | null = null,
): { source: string; rewritten: CensusEntry[]; manual: Array<{ entry: CensusEntry; reason: ManualReason }> } {
  const rewritten: CensusEntry[] = [];
  const manual: Array<{ entry: CensusEntry; reason: ManualReason }> = [];
  let out = src;
  for (const entry of [...entries].sort((a, b) => b.receiverEnd - a.receiverEnd)) {
    const reason = provable(entry);
    if (reason === "no single card" && into !== null && /^[A-Za-z_$][\w$]*$/.test(entry.receiver)) {
      out = `${out.slice(0, entry.receiverStart)}${into}${out.slice(entry.receiverEnd)}`;
      rewritten.push(entry);
      continue;
    }
    if (reason !== null) {
      manual.push({ entry, reason });
      continue;
    }
    out = `${out.slice(0, entry.receiverEnd)}.body(${entry.cardIdSource})${out.slice(entry.receiverEnd)}`;
    rewritten.push(entry);
  }
  return { source: out, rewritten: rewritten.reverse(), manual: manual.reverse() };
}
