/**
 * markdown-text-style-grammar.ts — the one parser configuration behind the
 * `markdownTextStyle` scheme.
 *
 * The scheme's rule: markdown is styled *visually* and **never stops being a
 * text document**. Every syntax character — `#`, `*`, `` ` ``, `>`, `~~`, the
 * fence delimiters, the two trailing spaces of a hard break — stays in the
 * buffer and stays on screen, taking a marker tone rather than disappearing
 * into a rendered heading or a rendered rule. Nothing is folded, concealed,
 * or substituted.
 *
 * The scheme has two forms, and they must paint the same source identically:
 *
 *  - the one-shot filter, `applyMarkdownTextStyle` in `lib/markdown-text-styling.ts`,
 *    which backs the read-only `TugMarkdownText`;
 *  - the CM6 extension bundle, `loadMarkdownTextStyling` in
 *    `components/tugways/tug-text-editor/markdown-text-styling.ts`, which backs
 *    every markdown-styled editing surface.
 *
 * They used to configure a parser each, and drifted — the filter parsed GFM
 * while the editor parsed strict CommonMark, so a task list styled in a receipt
 * and not in the composer that wrote it. This module is the single parser both
 * now use, which makes their agreement structural instead of a matter of
 * remembering.
 *
 * The dialect is GFM: `markdownLanguage` is CommonMark plus tables, task
 * lists, strikethrough, and bare autolinks — what people actually write in
 * commit messages and prompts.
 *
 * Four options turn *editing* behaviors off, because this capability styles
 * and does not edit:
 *  - `addKeymap: false` — the markdown keymap would take Enter and Backspace
 *    on list lines, breaking submit-on-Return in the prompt entry.
 *  - `pasteURLAsLink: false` — would fight the substrate's clipboard extension.
 *  - `completeHTMLTags: false` — the substrate runs its own typeahead.
 *  - `autoCloseTags: false` on the HTML sub-language — `html()`'s support array
 *    carries an `EditorView.inputHandler` that inserts `</div>` when you type
 *    `<div>`. It reaches the editor through `markdown()`'s `htmlTagLanguage`
 *    default, so it arrived as a default rather than as a decision. It is an
 *    editing behavior and it is excluded on the same grounds as the keymap.
 *    The HTML *language* stays, which is what sub-parses inline and block HTML.
 *
 * @module lib/markdown-text-style-grammar
 */

import { createSubscribable } from "@/lib/subscribable";
import { html } from "@codemirror/lang-html";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription, LanguageSupport } from "@codemirror/language";
import type { Language } from "@codemirror/language";
import { styleTags } from "@lezer/highlight";
import type { BlockContext, Line } from "@lezer/markdown";

import {
  extForLangId,
  languageForExtension,
  tugHardBreakTag,
} from "@/lib/language-registry";

// --- Fenced-code grammars -------------------------------------------------
//
// A fence that declares ```ts should be tokenized by the TypeScript grammar,
// and the app already owns a full lazy language registry, so the resolver
// below is a bridge rather than new machinery. It must be the FUNCTION form
// of `codeLanguages`: the registry's key space is extensions plus aliases,
// which matching over a static array of descriptions would not reproduce
// without duplicating the alias table.

/** Listeners for {@link subscribeMarkdownGrammars}. */
const grammarListeners = createSubscribable();

/** Monotonic; changes only when a fence grammar finishes loading. */
let grammarRevision = 0;

function bumpGrammarRevision(): void {
  grammarRevision++;
  grammarListeners.notify();
}

/**
 * Subscribe to fenced-grammar arrivals, for `useSyncExternalStore` ([L02]).
 *
 * The editor re-parses natively when a grammar chunk lands, but the one-shot
 * filter has already returned by then, so its output is stale until something
 * calls it again. This store is that nudge.
 */
export function subscribeMarkdownGrammars(callback: () => void): () => void {
  return grammarListeners.subscribe(callback);
}

/** Current grammar revision — stable between arrivals, as `getSnapshot` requires. */
export function getMarkdownGrammarRevision(): number {
  return grammarRevision;
}

/** One `LanguageDescription` per registry extension key. */
const fenceDescriptions = new Map<string, LanguageDescription>();

function fenceDescription(ext: string): LanguageDescription {
  let desc = fenceDescriptions.get(ext);
  if (desc === undefined) {
    desc = LanguageDescription.of({
      name: ext,
      load: async () => {
        const value = await languageForExtension(ext);
        if (value === null) throw new Error(`no grammar for "${ext}"`);
        // The registry resolves to an `Extension`; a description must resolve
        // to a `LanguageSupport`. The modern loaders already return one; the
        // legacy stream-mode loaders return a bare `StreamLanguage`.
        return value instanceof LanguageSupport
          ? value
          : new LanguageSupport(value as Language);
      },
    });
    fenceDescriptions.set(ext, desc);
  }
  return desc;
}

/**
 * Resolve a fence info string to a grammar, or `null` when the language is
 * unknown — in which case the body simply stays flat, never an error.
 */
function resolveFenceLanguage(info: string): LanguageDescription | null {
  const ext = extForLangId(info);
  if (ext === null) return null;
  const desc = fenceDescription(ext);
  if (desc.support === undefined) {
    // Attaching to `load()`'s memoized promise is what orders this correctly:
    // it resolves AFTER the description assigns its own `.support`, so by the
    // time the revision bumps a re-run will find the grammar. Scheduling the
    // bump inside the loader would race that assignment. A failure must never
    // break styling, so rejections are swallowed.
    void desc.load().then(bumpGrammarRevision, () => {});
  }
  return desc;
}

// --- The lone-dash line ---------------------------------------------------
//
// A line holding nothing but `-` under a paragraph is, per CommonMark, a
// setext underline: the paragraph above it becomes a level-2 heading. That is
// exactly the keystroke that starts a list, so typing `- ` at the end of a
// paragraph repaints the whole paragraph above as a heading until the item's
// first character arrives.
//
// The grammar's own list check declines the line for the same reason: with
// `breaking` set, a bullet only interrupts a paragraph when content follows
// the marker. So the paragraph is ended here instead, by an `endLeaf` rule
// that fires before the leaf-block parsers get their look. The block parse
// that follows sees the bare marker with `breaking` unset and takes it as an
// empty list item.
//
// Only a single dash: `--` and longer stay setext underlines, as does `=`.

const DASH = 45;
const SPACE = 32;
const TAB = 9;

// `Line.depth` and `BlockContext.stack` are real at runtime but absent from
// @lezer/markdown's published types. The nesting check reads them through this
// shape rather than widening either type to `any`.
interface NestingDepth {
  depth: number;
}
interface NestingStack {
  stack: readonly unknown[];
}

function isLoneDashLine(cx: BlockContext, line: Line): boolean {
  const depth = (line as unknown as NestingDepth).depth;
  const stack = (cx as unknown as NestingStack).stack;
  if (line.next !== DASH || depth < stack.length) return false;
  for (let pos = line.pos + 1; pos < line.text.length; pos++) {
    const ch = line.text.charCodeAt(pos);
    if (ch !== SPACE && ch !== TAB) return false;
  }
  return true;
}

/**
 * The scheme's configured markdown support — the grammar plus the HTML and
 * fenced-code sub-parsing that `markdown()` wires in, with every editing
 * behavior switched off.
 */
export const markdownTextStyleSupport = markdown({
  base: markdownLanguage,
  addKeymap: false,
  pasteURLAsLink: false,
  completeHTMLTags: false,
  htmlTagLanguage: html({ matchClosingTags: false, autoCloseTags: false }),
  codeLanguages: resolveFenceLanguage,
  // Retag `HardBreak` so the two trailing spaces can take a background tint.
  // The grammar tags them as a marker, which is correct and invisible: a
  // foreground color on whitespace paints nothing. Note this REPLACES the
  // node's marker tag rather than adding to it, so the tint is the entire
  // treatment.
  extensions: [
    { props: [styleTags({ HardBreak: tugHardBreakTag })] },
    { parseBlock: [{ name: "TugLoneDashList", endLeaf: isLoneDashLine }] },
  ],
});

/**
 * The parser both forms walk. Obtained through `markdown()` rather than from
 * `markdownLanguage.parser` directly: only the configured support carries the
 * `parseCode` extension, which is what sub-parses HTML and fenced-code bodies.
 */
export const markdownTextStyleParser = markdownTextStyleSupport.language.parser;

/**
 * The list prefix: optional leading indent, a bullet (`-`/`*`/`+`) or an
 * ordered marker (`1.`/`1)`), then the run of spaces before the item's
 * content. Its length is the hanging-indent width, in monospace cells.
 */
const LIST_PREFIX = /^(\s*(?:[-*+]|\d+[.)])\s+)/;

/**
 * The hanging-indent width for a list line, in monospace cells: the width of
 * the marker plus its trailing space, so a wrapped continuation aligns under
 * the item's first content character.
 *
 * `lineFrom` and `markTo` are document offsets of the line start and the end
 * of its `ListMark` node. They drive the fallback for the cases the anchored
 * regex cannot see: a marker inside a blockquote (`> - item`, where the line
 * does not *start* with the marker) and a tab between the marker and the
 * content. Both forms of the scheme call this, so a list indents the same way
 * in a receipt and in a composer.
 */
export function markdownHangingIndent(
  lineText: string,
  lineFrom: number,
  markTo: number,
): number {
  const match = LIST_PREFIX.exec(lineText);
  return match !== null ? match[1].length : markTo - lineFrom + 1;
}
