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

/**
 * The page-evaluating verbs a test calls on `App` (and on `BodyApp`): the
 * evaluators, and the gestures and element reads that take a selector and
 * resolve it in the page they are sent to.
 */
export const EVALUATORS = [
  "evalJS",
  "waitForCondition",
  "getElementScreenBounds",
  "getElementState",
  "getComputedStyleValue",
  "getSelection",
  "screenshot",
  "click",
  "type",
  "focusElement",
  "getElementText",
  "getElementValue",
  "getElementAttribute",
  "getElementBounds",
  "nativeClickAtElement",
  "nativeRightClickAtElement",
  "nativeDoubleClickAtElement",
] as const;

/** Selectors that enter a card's DOM whatever the card's kind. */
export const CARD_SELECTORS = [
  "[data-card-host]",
  "cardHost(",
  "keyboardIsInCard(",
  "inputSelectorFor(",
  "__tug.getCaretState(",
  "__tug.getFormControlValue(",
  "__tug.getEmCardState(",
  "__tug.isEngineReady(",
  "__tug.sessionSettled(",
  "__tug.inkRestoreFacts(",
  "__tug.refreshInkRestore(",
  "__tug.lastSentUserMessage(",
  "__tug.ingestSessionMetadata(",
  "__tug.getSessionPerf(",
  "__tug.getCardStateBag(",
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
  /** The expression each unresolved `?` was written as (`cardId`, `arc.cardId`). */
  unresolved: string[];
}

/** The card ids `text` names, through `cardHost(…)`, `inputSelectorFor(…)`, the keyboard helpers and `data-card-id=`. */
export function cardsNamed(text: string, bindings: Map<string, string>): NamedCards {
  const ids: string[] = [];
  const sources = new Map<string, string>();
  const unresolved: string[] = [];
  const add = (id: string | null, source: string): void => {
    if (id === null) {
      ids.push("?");
      unresolved.push(source);
      return;
    }
    ids.push(id);
    if (!sources.has(id)) sources.set(id, source);
  };
  const helper = /\b(?:cardHost|inputSelectorFor|keyboardIsInCard|keyboardInCardHost|__tug\.(?:getCaretState|getFormControlValue|getEmCardState|isEngineReady|sessionSettled|inkRestoreFacts|refreshInkRestore|lastSentUserMessage|ingestSessionMetadata|getSessionPerf|getCardStateBag))\(\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?(["'`][^"'`$]*["'`]|["'`]?\$\{[^}]*\}["'`]?|[A-Za-z_$][\w$.]*)\s*[,)]/g;
  let helperNamed = 0;
  for (const m of text.matchAll(helper)) {
    const arg = m[1];
    // `${JSON.stringify(CARD)}` or `"${CARD}"`, written inside an evaluated string.
    const interp = /^["'`]?\$\{\s*(?:JSON\.stringify\(\s*)?([A-Za-z_$][\w$]*)\s*\)?\s*\}["'`]?$/.exec(arg);
    if (interp !== null) add(literalOf(bindings, interp[1]), interp[1]);
    else if (/^["'`]/.test(arg)) add(arg.slice(1, -1), JSON.stringify(arg.slice(1, -1)));
    else add(literalOf(bindings, arg), arg);
    helperNamed++;
  }
  // A function the file binds (or imports) whose body scopes a selector by
  // its first parameter — `function xFor(cardId) { return \`[data-card-id="${cardId}"] …\` }`
  // — is a card-selector builder like `cardHost`: its call names its card.
  for (const name of selectorBuilders(bindings)) {
    for (const m of text.matchAll(new RegExp(`\\b${name}\\(\\s*(["'\`][^"'\`$]*["'\`]|[A-Za-z_$][\\w$.]*)\\s*[,)]`, "g"))) {
      const arg = m[1];
      if (/^["'`]/.test(arg)) add(arg.slice(1, -1), JSON.stringify(arg.slice(1, -1)));
      else add(literalOf(bindings, arg), arg);
      helperNamed++;
    }
  }
  const attr = /data-card-id=\\*["']?(\$\{\s*([^}]*?)\s*\}|[^"'\\\]\s]+)/g;
  for (const m of text.matchAll(attr)) {
    if (m[2] !== undefined) {
      const inner = m[2];
      const call = /^JSON\.stringify\(\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(inner);
      const name = call !== null ? call[1] : /^[A-Za-z_$][\w$]*$/.test(inner) ? inner : null;
      const id = name === null ? null : literalOf(bindings, name);
      // An interpolation nothing binds, in text that already named its card
      // through a helper call, is that helper's own body written in beside
      // the call: its parameter is the card the call named, not another.
      if (id === null && helperNamed > 0) continue;
      add(id, name ?? inner);
    } else {
      add(m[1], JSON.stringify(m[1]));
    }
  }
  return { ids, sources, unresolved };
}

/** A selector scoped by a card's `data-card-id` with something inside it (not the shell's placeholder). */
const SCOPED_IN_CARD = /(?<!\[data-body-placeholder\])\[data-card-id=[^\]]*\]\s+[[.#A-Za-z]/;

/** Whether `text` composes `${NAME} <descendant>` where `NAME` is bound to a bare card scope, `[data-card-id="…"]`. */
function scopedThroughConst(text: string, bindings: Map<string, string>): boolean {
  for (const m of text.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}\s+[[.#A-Za-z]/g)) {
    const value = (bindings.get(m[1]) ?? "").trim().replace(/^["'`]|["'`]$/g, "");
    if (/^\[data-card-id=[^\]]*\]$/.test(value)) return true;
  }
  // The same scope built by a call — `${CARD("B")} input`, with
  // `CARD = (id) => \`[data-card-id="${id}"]\`` — is the same reach.
  for (const name of selectorBuilders(bindings)) {
    const body = /=>\s*`([^`]*)`\s*;?$/.exec((bindings.get(name) ?? "").trim());
    if (body === null || !/^\[data-card-id=[^\]]*\]$/.test(body[1])) continue;
    if (new RegExp(`\\$\\{\\s*${name}\\([^()]*\\)\\s*\\}\\s+[[.#A-Za-z]`).test(text)) return true;
  }
  return false;
}

/** The bound functions whose body writes `data-card-id="${<first parameter>}"`. */
function selectorBuilders(bindings: Map<string, string>): string[] {
  const names: string[] = [];
  for (const [name, value] of bindings) {
    const param = /^(?:function\b[^(]*|(?:async\s+)?)\(\s*([A-Za-z_$][\w$]*)/.exec(value.trim());
    if (param === null) continue;
    if (new RegExp(`data-card-id=\\\\*["']?\\$\\{\\s*(?:JSON\\.stringify\\(\\s*)?${param[1]}\\b`).test(value)) names.push(name);
  }
  return names;
}

/** One card the file seeds: its kind, and its id as the source spells it (a literal, or the const's name). */
export interface SeededCard {
  readonly kind: string;
  readonly source: string;
}

/** Each card the file seeds as `{ id: …, componentId: "…" }`, by id. */
export function seededCards(src: string, bindings: Map<string, string>): Map<string, SeededCard> {
  const cards = new Map<string, SeededCard>();
  const idValue = (raw: string): { id: string; source: string } | null => {
    const v = raw.trim();
    const lit = /^(["'`])([^"'`$]*)\1$/.exec(v);
    if (lit !== null) return { id: lit[2], source: JSON.stringify(lit[2]) };
    if (!/^[A-Za-z_$][\w$]*$/.test(v)) return null;
    const id = literalOf(bindings, v);
    return id === null ? null : { id, source: v };
  };
  const forward = /\bid:\s*([^,{}\n]+?)\s*,[^{}]*?\bcomponentId:\s*["']([\w-]+)["']/g;
  for (const m of src.matchAll(forward)) {
    const v = idValue(m[1]);
    if (v !== null) cards.set(v.id, { kind: m[2], source: v.source });
  }
  const backward = /\bcomponentId:\s*["']([\w-]+)["']\s*,[^{}]*?\bid:\s*([^,{}\n]+?)\s*[,}]/g;
  for (const m of src.matchAll(backward)) {
    const v = idValue(m[2]);
    if (v !== null && !cards.has(v.id)) cards.set(v.id, { kind: m[1], source: v.source });
  }
  return cards;
}

/** The kind of each card the file seeds as `{ id: …, componentId: "…" }`. */
export function seededKinds(src: string, bindings: Map<string, string>): Map<string, string> {
  return new Map([...seededCards(src, bindings)].map(([id, c]) => [id, c.kind]));
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

/**
 * Names the file binds to a body: `x = ….body(…)` or one of the harness's
 * body finders (an arrow returning one, too, called as `x(app)`), or a
 * parameter typed `BodyApp`.
 */
function bodyNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:await\s+)?[^;\n]*(?:\.body\(|\bbodyOfKind\(|\bkindBody\(|\bstandUpKind\(|\bcardPage\(|\bwaitForBodyReady\(|\bwaitForBodyPainted\()/g)) names.add(m[1]);
  // `BodyApp`, or a page the caller chooses (`App | BodyApp`, either order),
  // or the picker fixture's `PickerDriver`, which is the picker's body.
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*(?:BodyApp\b|PickerDriver\b|App\s*\|\s*BodyApp\b)/g)) names.add(m[1]);
  return names;
}

/**
 * The `window.__tug` verbs a body's page answers too — the view methods
 * (`createViewSurfaceMethods` in `tugdeck/src/test-surface.ts`) and the
 * Overview store's — so a call to one of them moves onto a body with the
 * rest of its reach. Any other `__tug` verb, and `window.tugdeck`, is the
 * shell's deck.
 */
const BODY_TUG_VERBS = new Set([
  "getFirstResponderId", "getKeyCardId", "ringFollowsPointer", "click", "type", "focusElement",
  "enableDeckTrace", "getElementText", "getElementValue", "getElementAttribute", "getElementBounds",
  "getElementState", "getActiveElement", "getEmCardState", "isEngineReady", "getCaretState",
  "getFormControlValue", "assertHostRootRegistered", "sessionSettled", "driveSession",
  "publishOverviewPost", "publishOverviewPostsPage", "overviewPosts",
  "getDeckTrace", "markDeckTrace", "clearDeckTrace",
  "inkRestoreFacts", "refreshInkRestore", "lastSentUserMessage", "ingestSessionMetadata", "getSessionPerf",
  "getCardStateBag", "rowParsesByIdentity", "setTranscriptEvictionDisabled",
]);

/** The calls that make a page a card's DOM is read in. */
const PAGE_MAKERS = /\.body\(|\bbodyOfKind\(|\bkindBody\(|\bcardPage\(|\bwaitForBodyReady\(|\bwaitForBodyPainted\(/;

/** Whether `text` reads the shell's deck: `window.tugdeck`, a bare `__tug` reference, or a `__tug` verb only the shell answers. */
function readsShellDeck(text: string): boolean {
  if (/window\.tugdeck\b/.test(text)) return true;
  for (const m of text.matchAll(/\b__tug\b(\.([A-Za-z_$][\w$]*))?/g)) {
    const verb = m[2];
    if (verb === undefined) {
      // `typeof window.__tug !== "undefined"` guards a read; it reads nothing itself.
      const before = text.slice(Math.max(0, m.index! - 14), m.index!);
      if (/typeof\s+(window\.)?$/.test(before)) continue;
      return true;
    }
    if (!BODY_TUG_VERBS.has(verb)) return true;
  }
  return false;
}

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
  const cards = seededCards(seeding, bindings);
  const seeded = new Map([...cards].map(([id, c]) => [id, c.kind]));
  const fileKinds = kindsSeeded(seeding);
  const covered = coveredKind(src, vocabulary.coversKinds);
  const onBody = bodyNames(masked);
  // A name bound to a call of a helper the file binds whose signature says it
  // answers a body (`async function seeded(app): Promise<BodyApp>`) is a body.
  for (const m of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\(/g)) {
    if (/\)\s*:\s*(?:Promise<\s*)?BodyApp\s*>?\s*(?:=>|\{)/.test(bindings.get(m[2]) ?? "")) onBody.add(m[1]);
  }
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
    // `x.body` is a helper's answer carrying the body beside the card's id;
    // `kindBody(app, "…")` is the body of the deck's card of a kind.
    if (receiver === "" || receiver.includes(".body(") || receiver.endsWith(".body") || receiver.includes("cardPage(") || receiver.includes("kindBody(") || receiver.includes("waitForBodyReady(") || receiver.includes("waitForBodyPainted(")) continue;
    // `window.__tug.type(…)` inside a script string is the page's own call,
    // made in whatever page evaluates the string; that evaluation is the entry.
    if (receiver.startsWith("window.") || receiver.startsWith("document.")) continue;
    if (onBody.has(receiver) || onBody.has(receiver.replace(/\([^()]*\)$/, ""))) continue;
    // A call to a function the file binds whose own text makes a page
    // (`layoutPage(app)`, `await contentPage(app, id, …)`) is that page.
    const callee = /^\(?\s*(?:await\s+)?([A-Za-z_$][\w$]*)\(/.exec(receiver);
    if (callee !== null && PAGE_MAKERS.test(bindings.get(callee[1]) ?? "")) continue;
    const close = skipBalanced(masked, open, "(", ")");
    const line = masked.slice(0, dot).split("\n").length;
    if ((lines[line - 1] ?? "").includes(SHELL_ON_PURPOSE) || (lines[line - 2] ?? "").includes(SHELL_ON_PURPOSE)) continue;
    const args = masked.slice(open + 1, close - 1);
    const text = expandText(args, bindings);
    const found: string[] = selectors.filter((s) => text.includes(s));
    // `[data-card-id="…"] <descendant>` can only be card content: in the
    // shell's page that attribute is on a body card's empty placeholder.
    // The same scope composed through a constant — `${CARD} [data-testid=…]`
    // with `CARD = '[data-card-id="A"]'` — is the same reach.
    if (SCOPED_IN_CARD.test(text) || scopedThroughConst(text, bindings)) found.push("[data-card-id] …");
    if (found.length === 0) continue;
    const named = cardsNamed(text, bindings);
    const resolved = [...new Set(named.ids.filter((id) => id !== "?"))];
    let cardId = resolved.length === 1 && !named.ids.includes("?") ? resolved[0] : null;
    const kind = kindOf(cardId, resolved, found, seeded, fileKinds, vocabulary.kindRoots, covered);
    // A reach that names no card, in a file seeding exactly one card of its
    // kind, is that card's: the kind came from the selectors or the file,
    // and there is no other card of it the reach could mean.
    let cardIdSource = cardId === null ? null : (named.sources.get(cardId) ?? null);
    if (cardId === null && named.ids.length === 0 && kind !== "unknown") {
      const ofKind = [...cards].filter(([, c]) => c.kind === kind);
      if (ofKind.length === 1) {
        cardId = ofKind[0][0];
        cardIdSource = ofKind[0][1].source;
      }
    }
    // A reach naming its card through one plain variable in scope at the
    // call (`data-card-id="${cardId}"` in a helper) is that variable's card:
    // the body handle takes the same expression.
    if (cardId === null && resolved.length === 0 && named.ids.length > 0) {
      const names = [...new Set(named.unresolved)];
      // The name has to be written in the call itself: one reached through a
      // constant's initialiser may belong to another scope.
      if (names.length === 1 && /^[A-Za-z_$][\w$]*$/.test(names[0]) && new RegExp(`\\b${names[0]}\\b`).test(args)) cardIdSource = names[0];
    }
    // The full expansion can drag in a literal from a helper's other call
    // sites. Read the call's own text first, then one and two levels of its
    // constants: at the first depth that names a card, a card named only
    // through one plain variable is that variable's, and nothing else is.
    if (cardId === null && cardIdSource === null) {
      const inScope = (name: string): boolean => {
        if (new RegExp(`\\b${name}\\b`).test(args)) return true;
        // Written in a constant the call names: that constant's scope is the call's, so its free names are too; a function's body is not.
        for (const m of args.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
          const value = bindings.get(m[1]);
          if (value !== undefined && !/^(?:async\s+)?(?:function\b|\()/.test(value.trim()) && new RegExp(`\\b${name}\\b`).test(value)) return true;
        }
        return false;
      };
      for (const depth of [0, 1, 2]) {
        const shallow = cardsNamed(depth === 0 ? args : expandText(args, bindings, depth), bindings);
        if (shallow.ids.length === 0) continue;
        const names = [...new Set(shallow.unresolved)];
        if (shallow.ids.every((id) => id === "?") && names.length === 1 && /^[A-Za-z_$][\w$]*$/.test(names[0]) && inScope(names[0])) cardIdSource = names[0];
        break;
      }
    }
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
      cardIdSource,
      // Read on the call's own text and the constants it names, one level
      // down: a deeper expansion reaches the harness's own source through
      // `app`, and every call would read as the shell's.
      readsShell: readsShellDeck(expandText(args, bindings, 1)),
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
  if (entry.cardIdSource === null) return entry.cardIds.includes("?") ? "card id not a literal" : "no single card";
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
  into: string | ((entry: CensusEntry) => string | null) | null = null,
): { source: string; rewritten: CensusEntry[]; manual: Array<{ entry: CensusEntry; reason: ManualReason }> } {
  const rewritten: CensusEntry[] = [];
  const manual: Array<{ entry: CensusEntry; reason: ManualReason }> = [];
  let out = src;
  for (const entry of [...entries].sort((a, b) => b.receiverEnd - a.receiverEnd)) {
    const reason = provable(entry);
    if (reason === "no single card" && into !== null && /^[A-Za-z_$][\w$]*$/.test(entry.receiver)) {
      const handle = typeof into === "function" ? into(entry) : into;
      if (handle !== null) {
        out = `${out.slice(0, entry.receiverStart)}${handle}${out.slice(entry.receiverEnd)}`;
        rewritten.push(entry);
        continue;
      }
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
