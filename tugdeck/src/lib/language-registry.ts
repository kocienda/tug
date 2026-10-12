/**
 * language-registry.ts — file-extension → CodeMirror 6 language support,
 * lazy-loaded, with a Tug-token-driven highlight style.
 *
 * Lezer (CM6's native grammar system) is the highlighting engine: it
 * parses incrementally at keystroke latency, which is what a live
 * editing surface needs (Shiki, also in this repo, is a static
 * tokenizer used for markdown/diff blocks — the wrong regime here).
 *
 * Grammar modules are heavy, so each language loads through a dynamic
 * `import()` on first use — Vite splits them into separate chunks and
 * the base bundle carries none of them. `TugTextCardEditor` swaps the
 * resolved extension into its language Compartment when the load
 * settles; plain text renders in the meantime.
 *
 * Four grammars are the exception and import statically: markdown, HTML,
 * CSS and JavaScript. `lib/markdown-text-style-grammar.ts` needs
 * `markdown()` and `html()` synchronously to build the one parser
 * configuration every markdown-styled editing surface shares, and
 * `lang-html` in turn pulls `lang-css` and `lang-javascript`. All four
 * are therefore in the base chunk unconditionally, and a dynamic
 * `import()` of them would split nothing — Rollup says so, loudly, at
 * build time. Loading them statically states the truth; the lazy table
 * below keeps the grammars that genuinely do split.
 *
 * The highlight style maps Lezer's standard tags to the EXISTING
 * theme-aware syntax palette (`--tug-syntax-*` + `--tugx-syntax-comment`,
 * declared in `tug-code.css` with dark/light variants) — the same
 * palette Shiki-rendered code blocks use, so editor highlighting and
 * transcript highlighting read as one vocabulary and theme switches
 * recolor live with no remount.
 *
 * Shared by design: `TugCodeView` / `FileBlock` can adopt the same
 * registry later to highlight read-only transcript files.
 *
 * @module lib/language-registry
 */

import { EditorState, type Extension } from "@codemirror/state";
import {
  syntaxHighlighting,
  HighlightStyle,
  ensureSyntaxTree,
  syntaxTree,
  StreamLanguage,
  type StreamParser,
} from "@codemirror/language";
// Aliased: the loader table below keys entries by extension, so bare
// `css` / `html` / `markdown` would read as the table's own keys.
import { javascript as javascriptLang } from "@codemirror/lang-javascript";
import { css as cssLang } from "@codemirror/lang-css";
import { html as htmlLang } from "@codemirror/lang-html";
import { markdown as markdownLang } from "@codemirror/lang-markdown";
import { highlightTree, tagHighlighter, tags, Tag, type Highlighter } from "@lezer/highlight";
import type { Tree } from "@lezer/common";
import { StyleModule } from "style-mod";

// ---------------------------------------------------------------------------
// Highlight style — Lezer tags → Tug token slots
// ---------------------------------------------------------------------------

/**
 * Raw token-driven highlight style — the single source of truth for the
 * Lezer-tag → Tug-token-slot mapping. Every color reads a CSS variable
 * so the six themes restyle highlighted code live.
 *
 * Used two ways from one definition, so the live editor and every static
 * transcript surface color identically: wrapped in `syntaxHighlighting`
 * for the editor ({@link tugHighlightStyle}), and passed directly to
 * `highlightTree` for static fragment tokenization ({@link
 * tokenizeFragment}). The tag map is deliberately broad — operators,
 * punctuation, constants, tags, and attributes each land in their own
 * slot — so diffs and read/write snippets read as richly as the editor.
 */
/**
 * A Tug-owned tag for markdown's `HardBreak` node — the two trailing spaces
 * that end a line with a line break.
 *
 * The construct is documented, meaningful, and has no glyphs, so a foreground
 * color paints nothing; the tint below is the one place in the markdown text
 * styling scheme where appearance is not carried by the characters themselves.
 * Declared here beside the spec that styles it, which also keeps the grammar
 * module's import direction one-way.
 */
export const tugHardBreakTag = Tag.define();

/** The style properties a syntax slot may set. */
export interface TugSyntaxStyle {
  color?: string;
  fontStyle?: string;
  fontWeight?: string;
  fontFamily?: string;
  textDecoration?: string;
  backgroundColor?: string;
}

/** One syntax slot: its stable name, the Lezer tags it covers, its style. */
export interface TugSyntaxSlot {
  /** The class suffix: a run in this slot wears `tug-syn-<slot>`. */
  slot: string;
  tags: Tag | Tag[];
  style: TugSyntaxStyle;
}

/**
 * Every syntax slot, with every style property its spec sets. The one table
 * the editor's `HighlightStyle`s, the fence class highlighter and
 * `tug-syntax-classes.css` are all read from.
 *
 * The slot names are a contract with tugcast, which highlights fenced code
 * natively (tugmark's `highlight.rs`) into the code slots — `keyword` through
 * `punctuation` — and stamps the `<code>` `data-tug-highlighted`. The
 * markdown slots after them are the page's alone: a `md` fence goes through
 * {@link highlightFragmentToHtml}, and dropping them would leave its
 * headings, emphasis and links plain.
 */
export const TUG_SYNTAX_SLOTS: readonly TugSyntaxSlot[] = [
  { slot: "keyword", tags: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.self], style: { color: "var(--tug-syntax-keyword)" } },
  { slot: "string", tags: [tags.string, tags.special(tags.string), tags.regexp, tags.character], style: { color: "var(--tug-syntax-string)" } },
  { slot: "string-expression", tags: tags.escape, style: { color: "var(--tug-syntax-string-expression)" } },
  { slot: "number", tags: [tags.number, tags.bool, tags.null, tags.atom], style: { color: "var(--tug-syntax-number)" } },
  { slot: "comment", tags: [tags.comment, tags.blockComment, tags.lineComment, tags.docComment], style: { color: "var(--tugx-syntax-comment)", fontStyle: "italic" } },
  { slot: "function", tags: [tags.function(tags.variableName), tags.function(tags.propertyName)], style: { color: "var(--tug-syntax-function)" } },
  { slot: "type", tags: [tags.typeName, tags.className, tags.namespace], style: { color: "var(--tug-syntax-type)" } },
  { slot: "property", tags: tags.propertyName, style: { color: "var(--tug-syntax-property)" } },
  { slot: "variable", tags: [tags.definition(tags.variableName), tags.local(tags.variableName)], style: { color: "var(--tug-syntax-variable)" } },
  { slot: "constant", tags: [tags.constant(tags.variableName), tags.standard(tags.name), tags.labelName], style: { color: "var(--tug-syntax-constant)" } },
  { slot: "decorator", tags: [tags.meta, tags.processingInstruction, tags.annotation], style: { color: "var(--tug-syntax-decorator)" } },
  { slot: "tag", tags: tags.tagName, style: { color: "var(--tug-syntax-tag)" } },
  { slot: "attribute", tags: tags.attributeName, style: { color: "var(--tug-syntax-attribute)" } },
  { slot: "operator", tags: [tags.operator, tags.compareOperator, tags.logicOperator, tags.arithmeticOperator, tags.bitwiseOperator, tags.updateOperator, tags.definitionOperator, tags.typeOperator, tags.derefOperator], style: { color: "var(--tugx-syntax-operator)" } },
  { slot: "punctuation", tags: [tags.punctuation, tags.separator, tags.bracket, tags.angleBracket, tags.squareBracket, tags.paren, tags.brace], style: { color: "var(--tugx-syntax-punctuation)" } },
  { slot: "heading", tags: tags.heading, style: { color: "var(--tug-syntax-keyword)", fontWeight: "bold" } },
  { slot: "emphasis", tags: tags.emphasis, style: { fontStyle: "italic" } },
  { slot: "strong", tags: tags.strong, style: { fontWeight: "bold" } },
  // Code takes a code face as well as a code tone: on a proportional host —
  // a prompt entry under a sans face, a commit body at the host's prose face
  // — a color alone leaves `foo` reading as prose. Family only, never size:
  // a uniform line box is what makes these surfaces read as text.
  { slot: "monospace", tags: tags.monospace, style: { color: "var(--tug-syntax-code)", fontFamily: "var(--tug-font-family-mono)" } },
  // Markdown block constructs. A blockquote body takes a muted tone so the
  // one block element whose purpose is "set apart" reads as set apart; a
  // horizontal rule takes the marker tone every other markup character has,
  // since `---` is markup that happens to fill a line. Strikethrough is the
  // rare construct where the styling IS the meaning, so it takes the
  // decoration and no color. None of these remove a character: the `>`, the
  // `---`, and the `~~` all stay on screen.
  { slot: "quote", tags: tags.quote, style: { color: "var(--tugx-syntax-quote)" } },
  { slot: "content-separator", tags: tags.contentSeparator, style: { color: "var(--tug-syntax-decorator)" } },
  { slot: "strikethrough", tags: tags.strikethrough, style: { textDecoration: "line-through" } },
  // A hard break has no glyphs to color, so it takes a background tint —
  // making visible something already in the buffer rather than adding or
  // hiding a character. The override replaces the node's marker tag, so this
  // spec is the whole treatment; there is no foreground to set.
  { slot: "hard-break", tags: tugHardBreakTag, style: { backgroundColor: "var(--tug-syntax-hard-break-bg)" } },
  // The read-only link style; the editing variant below drops the underline.
  { slot: "link", tags: [tags.link, tags.url], style: { color: "var(--tug-syntax-string)", textDecoration: "underline" } },
];

/** A slot as a `HighlightStyle` spec. */
function slotSpec(slot: TugSyntaxSlot): { tag: Tag | Tag[] } & TugSyntaxStyle {
  return { tag: slot.tags, ...slot.style };
}

// Every rule but the link/url pair, which the two variants below style
// differently (default underline vs none) while sharing this base.
const tugHighlightSpecsBase = TUG_SYNTAX_SLOTS.filter((s) => s.slot !== "link").map(slotSpec);

export const tugHighlightStyleInner = HighlightStyle.define(TUG_SYNTAX_SLOTS.map(slotSpec));

/**
 * The fence highlighter: the same tags as {@link tugHighlightStyleInner},
 * emitting the stable `tug-syn-<slot>` classes `tug-syntax-classes.css`
 * styles, which tugcast's native highlighter emits too. A fence the page
 * highlights and a fence tugcast highlighted therefore read alike.
 */
export const tugClassHighlighter: Highlighter = tagHighlighter(
  TUG_SYNTAX_SLOTS.map((s) => ({ tag: s.tags, class: `tug-syn-${s.slot}` })),
);

/** Editor-extension form of {@link tugHighlightStyleInner}. */
export const tugHighlightStyle: Extension = syntaxHighlighting(tugHighlightStyleInner);

// Editable write-surface variant: markdown links carry NO default
// underline. Shared by the Text card editor and the TugTextEditor markdown
// styling bundle. In the Text card the underline is reserved as the ⌘-hover
// "linkify" affordance (see `tug-text-card-editor/anchor-links.ts`) — an
// always-on underline would blunt that signal; on other write surfaces it is
// simply visual noise on a composer. Color is retained so a reference still
// reads as distinct. The read-only code view and diff snippets keep
// {@link tugHighlightStyle} (underlined links).
const tugEditingHighlightStyleInner = HighlightStyle.define([
  ...tugHighlightSpecsBase,
  { tag: [tags.link, tags.url], color: "var(--tug-syntax-string)" },
]);

/** Editor-extension form for editable write surfaces (no default link underline). */
export const tugEditingHighlightStyle: Extension = syntaxHighlighting(
  tugEditingHighlightStyleInner,
);

// ---------------------------------------------------------------------------
// Extension → lazy grammar
// ---------------------------------------------------------------------------

type LanguageLoader = () => Promise<Extension>;

/** Wrap a legacy (CM5) stream parser mode as a CM6 extension. */
function legacy(
  load: () => Promise<{ mode: StreamParser<unknown> }>,
): LanguageLoader {
  return async () => {
    const { mode } = await load();
    return StreamLanguage.define(mode);
  };
}

/**
 * Loader table keyed by lowercase file extension (no dot). Kept as
 * data so adding a language is one line.
 */
const LOADERS: Record<string, LanguageLoader> = {
  // Lezer grammars. The four base-chunk grammars (see the module header)
  // resolve from their static imports; the rest split into own chunks.
  js: async () => javascriptLang(),
  jsx: async () => javascriptLang({ jsx: true }),
  ts: async () => javascriptLang({ typescript: true }),
  tsx: async () => javascriptLang({ typescript: true, jsx: true }),
  mjs: async () => javascriptLang(),
  cjs: async () => javascriptLang(),
  rs: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  css: async () => cssLang(),
  html: async () => htmlLang(),
  htm: async () => htmlLang(),
  // Frontmatter TypeScript over an HTML template, composed from the two
  // grammars above; see the module.
  astro: () => import("./astro-language").then((m) => m.astro()),
  // `addKeymap: false` on the same grounds as `markdownTextStyleSupport`: the
  // markdown keymap binds Enter to `insertNewlineContinueMarkup`, which writes
  // a bullet the writer did not type, and Backspace to `deleteMarkupBackward`.
  // Both are editing behaviors; a grammar loaded here only tokenizes.
  md: async () => markdownLang({ addKeymap: false }),
  markdown: async () => markdownLang({ addKeymap: false }),
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  java: () => import("@codemirror/lang-java").then((m) => m.java()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  // Legacy stream modes for languages without a maintained Lezer port.
  dockerfile: legacy(async () => {
    const m = await import("@codemirror/legacy-modes/mode/dockerfile");
    return { mode: m.dockerFile };
  }),
  swift: legacy(async () => {
    const m = await import("@codemirror/legacy-modes/mode/swift");
    return { mode: m.swift };
  }),
  sh: legacy(async () => {
    const m = await import("@codemirror/legacy-modes/mode/shell");
    return { mode: m.shell };
  }),
  bash: legacy(async () => {
    const m = await import("@codemirror/legacy-modes/mode/shell");
    return { mode: m.shell };
  }),
  zsh: legacy(async () => {
    const m = await import("@codemirror/legacy-modes/mode/shell");
    return { mode: m.shell };
  }),
  toml: legacy(async () => {
    const m = await import("@codemirror/legacy-modes/mode/toml");
    return { mode: m.toml };
  }),
  yaml: legacy(async () => {
    const m = await import("@codemirror/legacy-modes/mode/yaml");
    return { mode: m.yaml };
  }),
  yml: legacy(async () => {
    const m = await import("@codemirror/legacy-modes/mode/yaml");
    return { mode: m.yaml };
  }),
  c: legacy(async () => {
    const m = await import("@codemirror/legacy-modes/mode/clike");
    return { mode: m.c };
  }),
  h: legacy(async () => {
    const m = await import("@codemirror/legacy-modes/mode/clike");
    return { mode: m.c };
  }),
  cpp: legacy(async () => {
    const m = await import("@codemirror/legacy-modes/mode/clike");
    return { mode: m.cpp };
  }),
};

/**
 * Display names for the status bar, keyed by lowercase extension. Kept
 * beside {@link LOADERS} so a language's label and grammar stay in sync.
 * Unmapped extensions fall back to "Plain Text".
 */
const LANGUAGE_LABELS: Record<string, string> = {
  js: "JavaScript",
  jsx: "JavaScript (JSX)",
  ts: "TypeScript",
  tsx: "TypeScript (TSX)",
  mjs: "JavaScript",
  cjs: "JavaScript",
  rs: "Rust",
  py: "Python",
  json: "JSON",
  css: "CSS",
  html: "HTML",
  htm: "HTML",
  astro: "Astro",
  md: "Markdown",
  markdown: "Markdown",
  go: "Go",
  java: "Java",
  sql: "SQL",
  dockerfile: "Dockerfile",
  swift: "Swift",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
  c: "C",
  h: "C",
  cpp: "C++",
};

/** The file type a new, untitled Text File card starts on. */
export const UNTITLED_LANGUAGE_ID = "md";

/** Human-readable language name for the status bar (or "Plain Text"). */
export function languageLabelFor(path: string | null): string {
  if (path === null) return LANGUAGE_LABELS[UNTITLED_LANGUAGE_ID];
  const ext = fileExtension(path);
  if (ext === null) return "Plain Text";
  return LANGUAGE_LABELS[ext] ?? "Plain Text";
}

/** A user-pickable language for the status-bar file-type popup. */
export interface SelectableLanguage {
  /** Stable id (also the popup value); `"text"` for plain text. */
  id: string;
  /** Display name. */
  label: string;
  /** Representative extension whose grammar to load; null for plain text. */
  ext: string | null;
}

/**
 * The languages offered in the file-type popup, in menu order. One entry
 * per distinct grammar (aliases like js/mjs collapse to one), plus a
 * leading "Plain Text" that clears the grammar.
 */
export const SELECTABLE_LANGUAGES: readonly SelectableLanguage[] = [
  { id: "text", label: "Plain Text", ext: null },
  { id: "md", label: "Markdown", ext: "md" },
  { id: "js", label: "JavaScript", ext: "js" },
  { id: "jsx", label: "JavaScript (JSX)", ext: "jsx" },
  { id: "ts", label: "TypeScript", ext: "ts" },
  { id: "tsx", label: "TypeScript (TSX)", ext: "tsx" },
  { id: "py", label: "Python", ext: "py" },
  { id: "rs", label: "Rust", ext: "rs" },
  { id: "json", label: "JSON", ext: "json" },
  { id: "css", label: "CSS", ext: "css" },
  { id: "html", label: "HTML", ext: "html" },
  { id: "astro", label: "Astro", ext: "astro" },
  { id: "go", label: "Go", ext: "go" },
  { id: "java", label: "Java", ext: "java" },
  { id: "sql", label: "SQL", ext: "sql" },
  { id: "dockerfile", label: "Dockerfile", ext: "dockerfile" },
  { id: "swift", label: "Swift", ext: "swift" },
  { id: "sh", label: "Shell", ext: "sh" },
  { id: "toml", label: "TOML", ext: "toml" },
  { id: "yaml", label: "YAML", ext: "yaml" },
  { id: "c", label: "C", ext: "c" },
  { id: "cpp", label: "C++", ext: "cpp" },
];

/**
 * The selectable-language id that matches `path`'s extension, else "text".
 * An untitled buffer (no path yet) starts on Markdown.
 */
export function languageIdForPath(path: string | null): string {
  if (path === null) return UNTITLED_LANGUAGE_ID;
  const ext = fileExtension(path);
  if (ext === null) return "text";
  const match = SELECTABLE_LANGUAGES.find((l) => l.ext === ext);
  if (match !== undefined) return match.id;
  // A grammar exists for the ext but it aliases another entry's label
  // (e.g. mjs → JavaScript); map through the label.
  const label = LANGUAGE_LABELS[ext];
  const byLabel = SELECTABLE_LANGUAGES.find((l) => l.label === label);
  return byLabel?.id ?? "text";
}

/** The representative extension for a selectable-language id (null = plain). */
export function extensionForLanguageId(id: string): string | null {
  return SELECTABLE_LANGUAGES.find((l) => l.id === id)?.ext ?? null;
}

/** Resolved-extension cache so each grammar loads once per session. */
const cache = new Map<string, Promise<Extension>>();

/** Lowercase extension of `path` (no dot), or null when it has none. */
export function fileExtension(path: string): string | null {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return base.slice(dot + 1).toLowerCase();
}

/** Whether `path` has a registered language. */
export function hasLanguageFor(path: string): boolean {
  const ext = fileExtension(path);
  return ext !== null && ext in LOADERS;
}

/**
 * Resolve the language support extension for `path`, loading the
 * grammar chunk on first use. Resolves `null` for unregistered
 * extensions and on load failure (the editor stays plain text).
 */
export function languageFor(path: string): Promise<Extension | null> {
  return languageForExtension(fileExtension(path));
}

/**
 * Resolve the language support extension for a bare file extension
 * (no dot; null for plain text). Same lazy-load + cache as
 * {@link languageFor}; used when the file type is chosen explicitly
 * (the status-bar file-type popup) rather than derived from a path.
 */
export function languageForExtension(ext: string | null): Promise<Extension | null> {
  if (ext === null) return Promise.resolve(null);
  const loader = LOADERS[ext];
  if (loader === undefined) return Promise.resolve(null);
  let pending = cache.get(ext);
  if (pending === undefined) {
    pending = loader();
    cache.set(ext, pending);
  }
  return pending.catch(() => null);
}

// ---------------------------------------------------------------------------
// Language-id aliasing (markdown fences / diff language labels)
// ---------------------------------------------------------------------------

/**
 * Map a free-form language id (as it appears in a markdown fence
 * `language-X` class or a diff's detected language) to the registry's
 * extension key. Only ids that don't already match an extension need an
 * entry; everything else falls through to the id itself (so `"ts"`,
 * `"py"`, … work unchanged). Unknown ids resolve to plain text.
 */
const LANG_ID_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  golang: "go",
  shell: "sh",
  shellscript: "sh",
  bash: "sh",
  zsh: "sh",
  "c++": "cpp",
  cxx: "cpp",
  yml: "yaml",
  markdown: "md",
  docker: "dockerfile",
  htm: "html",
};

/** Resolve a language id/alias to a registered extension key, or null. */
export function extForLangId(langId: string): string | null {
  const id = langId.toLowerCase().trim();
  if (id === "") return null;
  const aliased = LANG_ID_ALIASES[id] ?? id;
  return aliased in LOADERS ? aliased : null;
}

/**
 * Resolve the language support extension for a free-form language id
 * (a markdown fence tag, a `TugCodeView` `language` prop), lazy-loading
 * the grammar chunk. Resolves `null` for unknown ids / load failure so
 * the surface stays plain text.
 */
export function languageForLangId(langId: string): Promise<Extension | null> {
  return languageForExtension(extForLangId(langId));
}

// ---------------------------------------------------------------------------
// Static fragment tokenization (diff hunks, read/write snippets, fences)
// ---------------------------------------------------------------------------

/** One syntax run within a single line of a fragment (line-relative). */
export interface FragmentToken {
  /** Start column in the line (inclusive). */
  start: number;
  /** End column in the line (exclusive). */
  end: number;
  /** The highlighter's class(es) for the run: {@link tugHighlightStyleInner}'s
   *  generated names, or {@link tugClassHighlighter}'s `tug-syn-<slot>`. */
  className: string;
}

/** Cap on the forced parse of one fragment; on timeout we fall back to
 *  whatever the incremental tree already covers (plain text at worst). */
const PARSE_TIMEOUT_MS = 100;

/** Highlight styles whose generated CSS is already in the document. */
const mountedHighlightModules = new WeakSet<HighlightStyle>();

/**
 * Mount a highlight style's generated CSS, once per style. Static callers
 * need this so the classes `highlightTree` emits resolve to `--tug-syntax-*`
 * colors outside a live `EditorView` (which would mount it itself).
 */
export function mountHighlightStyle(style: HighlightStyle): void {
  if (typeof document === "undefined") return;
  if (mountedHighlightModules.has(style)) return;
  const mod = style.module;
  if (mod !== null) StyleModule.mount(document, mod);
  mountedHighlightModules.add(style);
}

/** Offsets of each line's first character in `text` (index 0 = line 0). */
export function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** Index of the line containing absolute offset `pos`. */
export function lineIndexAt(starts: number[], pos: number): number {
  // Linear from a hint would suffice, but a small binary search keeps
  // whole-file snippets cheap.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Tokenize `text` through a resolved CodeMirror language extension and
 * return per-line syntax runs. Line N of the input maps to result[N].
 *
 * Builds a headless `EditorState` over the fragment, forces a full parse
 * (`ensureSyntaxTree`), and walks `highlightTree` with the shared
 * {@link tugHighlightStyleInner} — the exact grammar + style the live
 * editor uses, so a fragment colors identically to the same file open in
 * a Text card. A styled run that spans a line break (e.g. a block
 * comment) is split at line boundaries so each line owns its own runs.
 */
async function tokenizeWithExtension(
  text: string,
  languageExt: Extension | null,
  highlighter: Highlighter,
): Promise<FragmentToken[][]> {
  if (languageExt === null || text.length === 0) {
    return lineStartOffsets(text).map(() => []);
  }
  const state = EditorState.create({ doc: text, extensions: [languageExt] });
  const tree = ensureSyntaxTree(state, text.length, PARSE_TIMEOUT_MS) ?? syntaxTree(state);
  return highlightRunsByLine(tree, text, highlighter);
}

/**
 * Walk `tree` with `highlighter` and return the emitted highlight runs split at
 * line boundaries — line N of `text` maps to result[N], with runs stated in
 * line-relative columns. A styled run that spans a line break (a block
 * comment, a fenced code block) contributes one run per line it covers.
 *
 * When `highlighter` is a `HighlightStyle`, mounts its generated CSS as a side
 * effect, so a caller rendering the runs into ordinary DOM gets the same
 * colors a live editor would paint. {@link tugClassHighlighter}'s classes are
 * styled by the static `tug-syntax-classes.css` instead.
 */
export function highlightRunsByLine(
  tree: Tree,
  text: string,
  highlighter: Highlighter,
): FragmentToken[][] {
  const starts = lineStartOffsets(text);
  const perLine: FragmentToken[][] = starts.map(() => []);
  if (text.length === 0) return perLine;
  if (highlighter instanceof HighlightStyle) mountHighlightStyle(highlighter);
  highlightTree(tree, highlighter, (from, to, className) => {
    const first = lineIndexAt(starts, from);
    for (let line = first; line < starts.length && starts[line] < to; line++) {
      // Line content excludes its trailing newline.
      const contentEnd = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
      const segStart = Math.max(from, starts[line]);
      const segEnd = Math.min(to, contentEnd);
      if (segEnd > segStart) {
        perLine[line].push({
          start: segStart - starts[line],
          end: segEnd - starts[line],
          className,
        });
      }
    }
  });
  return perLine;
}

/** Per-line syntax runs for `text`, keyed by lowercase file extension. */
export async function tokenizeFragment(
  text: string,
  ext: string | null,
): Promise<FragmentToken[][]> {
  return tokenizeWithExtension(text, await languageForExtension(ext), tugHighlightStyleInner);
}

/**
 * Per-line syntax runs for `text`, keyed by a language id/alias. Runs carry
 * `highlighter`'s classes: {@link tugHighlightStyleInner}'s generated ones
 * by default.
 */
export async function tokenizeFragmentByLangId(
  text: string,
  langId: string,
  highlighter: Highlighter = tugHighlightStyleInner,
): Promise<FragmentToken[][]> {
  return tokenizeWithExtension(text, await languageForExtension(extForLangId(langId)), highlighter);
}

/** Escape the five HTML-significant characters for safe innerHTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Highlight `text` to an HTML string (class-per-token `<span>`s, classes
 * only — no inline styles), suitable for a `<code>` element's innerHTML.
 * Lines are joined with `\n`; unstyled gaps are emitted as escaped text.
 * Unknown languages return the whole text escaped and uncolored.
 *
 * The fence path: the classes are {@link tugClassHighlighter}'s stable
 * `tug-syn-<slot>` names, the ones tugcast's native highlighter emits.
 */
export async function highlightFragmentToHtml(
  text: string,
  langId: string,
): Promise<string> {
  const perLine = await tokenizeFragmentByLangId(text, langId, tugClassHighlighter);
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const runs = perLine[i] ?? [];
    let col = 0;
    for (const run of runs) {
      if (run.start > col) out.push(escapeHtml(line.slice(col, run.start)));
      out.push(
        `<span class="${run.className}">${escapeHtml(line.slice(run.start, run.end))}</span>`,
      );
      col = run.end;
    }
    if (col < line.length) out.push(escapeHtml(line.slice(col)));
    if (i < lines.length - 1) out.push("\n");
  }
  return out.join("");
}
