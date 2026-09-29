/**
 * `serialize-selection.ts` — turn a live DOM `Selection` into markdown.
 *
 * Governing principle: **the copy is the selected text, decorated with
 * the styling those characters carry — built from the selection, clipped
 * to the selection.** Never the source sliced to whole-construct
 * boundaries; never a plain-text bail when styling is hard.
 *
 * How: walk the **text nodes inside the range** in document order,
 * clipping the first/last to the selection's offsets, so the text is
 * exactly what's selected. For each run, read its inline styling from its
 * ancestors (`<strong>`→`**`, `<em>`→`*`, `<del>`→`~~`, `<code>`→`` ` ``,
 * `<a>`→`[…](href)`) and its **ancestor chain** — every container between
 * the `.tugx-md-block` wrapper and the leaf the text sits in: a blockquote,
 * a list with its type, `start` and tightness, an item with its index, a
 * table with its rows and cells, down to the paragraph, heading, code block
 * or cell. The chains are assembled into a tree and the tree is emitted
 * recursively by CommonMark's container rules, so markdown wraps **only**
 * the selected text: a partial bold selection → `**old**`; a heading →
 * `## …`; a range that starts at the fourth item → `4.`. Markers aren't
 * text, so the rendered result equals the selection exactly.
 *
 * Because only text nodes and atom chips produce output, structural/empty
 * nodes the selection merely grazed — a bare `<hr>`, an empty heading clone at
 * a boundary — contribute nothing: overshoot is impossible by construction.
 * The block chrome the enhancers draw — a fence's language label, a table's
 * row count — is text too, but it is the wrapper's and never the prose's,
 * so the walk skips it.
 *
 * **Atoms are characters, not text.** A chip is one indivisible thing the user
 * put there, so a selection that crosses one yields a `U+FFFC` and the atom
 * beside it — the same `(text, atoms)` substrate the prompt that submitted it
 * carried. That is why this returns a substrate rather than a string: the
 * readable text and the clipboard sidecar that rebuilds the chips are two
 * readings of it, and a copy owes both.
 *
 * Math comes from KaTeX's embedded TeX annotation (`$tex$` / `$$tex$$`),
 * emitted once per `.katex` (skipping its duplicated MathML/visual text);
 * fenced code from the `<pre>` text.
 *
 * Laws: [L07] reads the live selection inside the copy gesture; no state.
 *
 * @module lib/markdown/serialize-selection
 */

import { formatAtomTextForCopy } from "@/lib/atom-text";
import { TUG_ATOM_CHAR, type AtomSegment } from "@/lib/tug-atom-img";

export interface Marks {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
}

/** A column's alignment, as the header row declares it. */
export type Align = "none" | "left" | "center" | "right";

/**
 * One container or leaf on a run's path from the `.tugx-md-block` wrapper
 * down to the element its text sits in. `el` is the DOM element the node
 * stands for; two runs whose chains share an `el` at the same depth sit in
 * the same node of the tree the emitter walks.
 */
export type ChainNode =
  | { kind: "quote"; el: Element }
  | { kind: "list"; el: Element; ordered: boolean; start: number; tight: boolean }
  | { kind: "item"; el: Element; index: number; task: "checked" | "unchecked" | null }
  | { kind: "table"; el: Element; aligns: readonly Align[] }
  | { kind: "row"; el: Element; header: boolean }
  | { kind: "cell"; el: Element; index: number }
  | { kind: "footnote"; el: Element; label: string }
  | { kind: "paragraph"; el: Element }
  | { kind: "heading"; el: Element; level: number }
  | { kind: "code"; el: Element; lang: string | null };

export interface BlockInfo {
  /** The leaf element — runs sharing it group into one leaf. */
  el: Element;
  /** Wrapper-to-leaf ancestor chain; the last node is the leaf. */
  chain: readonly ChainNode[];
}

export interface Run {
  text: string;
  block: BlockInfo;
  marks: Marks;
  /** Pre-formatted (KaTeX TeX, an atom's U+FFFC) — verbatim, no inline marks. */
  raw: boolean;
  /**
   * The atom this run stands for, when the run is a chip's `U+FFFC` rather
   * than text. What makes the selection a substrate instead of a string.
   */
  atom?: AtomSegment;
}

/**
 * The selection as the `(text, atoms)` substrate every atom-bearing surface
 * speaks: markdown with a `U+FFFC` where each chip stood, and the atoms that
 * stand there, in document order.
 */
export interface SelectionSubstrate {
  text: string;
  atoms: AtomSegment[];
}

const BLOCK_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "PRE",
  "BLOCKQUOTE",
  "TD",
  "TH",
]);

function isBlockBoundary(el: Element): boolean {
  return BLOCK_TAGS.has(el.tagName) || el.classList.contains("tugx-md-block");
}

/** The enhancers' chrome — a label, a button — whose text is never prose. */
function inChrome(el: Element | null): boolean {
  return el !== null && (
    el.closest(".tugx-md-chrome-header") !== null
    || el.closest(".footnote-definition-label") !== null
  );
}

/**
 * The atom a chip element stands for, or `null` when the element is not one.
 *
 * Every chip — the transcript's `<svg>`, the editor's `<img>`, a session
 * citation — carries its identity in the same `data-atom-*` attributes,
 * which is what lets one serializer read every surface's chips without knowing
 * which component drew them. `atomIdentityAttrs` is where they are authored.
 *
 * The id is read back where a chip has one, because an atom's bytes are found
 * by it: a sidecar entry written without an id can carry no payload, so an
 * image chip copied out of a transcript pasted as a chip with nothing behind
 * it while the same row's COPY button carried the bytes.
 */
function atomOf(el: Element): AtomSegment | null {
  const type = el.getAttribute("data-atom-type");
  const label = el.getAttribute("data-atom-label");
  const value = el.getAttribute("data-atom-value");
  if (type === null || label === null || value === null) return null;
  const id = el.getAttribute("data-atom-id");
  // The session pair, recovered beside the id: `atomIdentityAttrs` writes both
  // attributes or neither, so one without the other is a chip some other
  // renderer built by hand and is not trusted as a reference.
  const sessionId = el.getAttribute("data-atom-session-id");
  const sessionDir = el.getAttribute("data-atom-session-project-dir");
  return {
    kind: "atom",
    type,
    label,
    value,
    ...(id !== null && id !== "" ? { id } : {}),
    ...(sessionId !== null && sessionId !== "" && sessionDir !== null
      && sessionDir !== ""
      ? { session: { id: sessionId, projectDir: sessionDir } }
      : {}),
  };
}

/** The chip element at or above `node`, or `null` when there is none. */
function closestAtomChip(node: Node): Element | null {
  let el = node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
  while (el !== null) {
    if (el.hasAttribute("data-atom-type")) return el;
    el = el.parentElement;
  }
  return null;
}

function closestKatex(node: Node): Element | null {
  let el = node.parentElement;
  while (el !== null) {
    if (el.classList.contains("katex") || el.classList.contains("katex-display")) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/** `$tex$` / `$$tex$$` from a KaTeX render's embedded TeX annotation. */
function serializeKatex(el: Element): string {
  const ann = el.querySelector('annotation[encoding="application/x-tex"]');
  const tex = (ann?.textContent ?? "").trim();
  const display =
    el.classList.contains("katex-display") || el.closest(".katex-display") !== null;
  if (tex === "") return (el.textContent ?? "").trim();
  return display ? `$$${tex}$$` : `$${tex}$`;
}

/** Whether the leaf a run sits in is a paragraph, heading, cell or code. */
function isLeaf(node: ChainNode): boolean {
  return (
    node.kind === "paragraph"
    || node.kind === "heading"
    || node.kind === "cell"
    || node.kind === "code"
  );
}

function elementIndex(el: Element): number {
  const parent = el.parentElement;
  if (parent === null) return 0;
  let i = 0;
  for (const sibling of parent.children) {
    if (sibling === el) return i;
    if (sibling.tagName === el.tagName) i += 1;
  }
  return i;
}

/** A list is tight when no item wraps its text in a `<p>` (CommonMark 5.3). */
function listIsTight(list: Element): boolean {
  for (const item of list.children) {
    if (item.tagName !== "LI") continue;
    for (const child of item.children) {
      if (child.tagName === "P") return false;
    }
  }
  return true;
}

/** The item's checkbox: directly under a tight item, inside the `<p>` of a loose one. */
function taskStateOf(item: Element): "checked" | "unchecked" | null {
  const box = item.querySelector(
    ':scope > input[type="checkbox"], :scope > p:first-of-type > input[type="checkbox"]',
  );
  if (box === null) return null;
  return box.hasAttribute("checked") ? "checked" : "unchecked";
}

function alignOf(cell: Element): Align {
  const declared = (
    (cell as HTMLElement).style?.textAlign
    || cell.getAttribute("align")
    || ""
  ).toLowerCase();
  return declared === "left" || declared === "center" || declared === "right"
    ? declared
    : "none";
}

function tableAligns(table: Element): Align[] {
  const header = table.querySelector("thead tr") ?? table.querySelector("tr");
  if (header === null) return [];
  return Array.from(header.children).map(alignOf);
}

/** The fence's language: the enhancer's `data-lang`, else the `<code>` class. */
function langOf(pre: Element): string | null {
  const wrapper = pre.closest(".tugx-md-fenced-code") as HTMLElement | null;
  const fromWrapper = wrapper?.dataset.lang;
  if (fromWrapper !== undefined && fromWrapper !== "") return fromWrapper;
  const code = pre.querySelector(":scope > code");
  if (code !== null) {
    for (const cls of code.classList) {
      if (cls.startsWith("language-")) {
        const lang = cls.slice("language-".length).trim();
        if (lang !== "") return lang;
      }
    }
  }
  return null;
}

/** The chain node one ancestor stands for, or `null` for a transparent one. */
function chainNodeOf(el: Element): ChainNode | null {
  const tag = el.tagName;
  if (tag === "BLOCKQUOTE") return { kind: "quote", el };
  if (tag === "UL" || tag === "OL") {
    const start = Number(el.getAttribute("start") ?? "1");
    return {
      kind: "list",
      el,
      ordered: tag === "OL",
      start: Number.isFinite(start) ? start : 1,
      tight: listIsTight(el),
    };
  }
  if (tag === "LI") {
    return { kind: "item", el, index: elementIndex(el), task: taskStateOf(el) };
  }
  if (tag === "TABLE") return { kind: "table", el, aligns: tableAligns(el) };
  if (tag === "TR") return { kind: "row", el, header: el.closest("thead") !== null };
  if (tag === "TD" || tag === "TH") return { kind: "cell", el, index: elementIndex(el) };
  if (tag === "P") return { kind: "paragraph", el };
  if (/^H[1-6]$/.test(tag)) return { kind: "heading", el, level: Number(tag[1]) };
  if (tag === "PRE") return { kind: "code", el, lang: langOf(el) };
  if (tag === "DIV" && el.classList.contains("footnote-definition")) {
    return { kind: "footnote", el, label: el.getAttribute("id") ?? "" };
  }
  return null;
}

/**
 * The block context of a node: its ancestor chain from the `.tugx-md-block`
 * wrapper down to the leaf its text sits in. Text with no leaf element of
 * its own — a tight item's, or a bare wrapper's — gets a paragraph leaf
 * standing on the innermost *container* it sits in — the item, the quote, or
 * the wrapper itself.
 *
 * The container, never the nearest ancestor element: an inline ancestor is
 * transparent to the chain, so a tight item's `<strong>` would otherwise give
 * its text a leaf of its own and the item would come apart into one line per
 * styled span.
 */
function blockInfoOf(node: Node): BlockInfo {
  const ancestors: Element[] = [];
  let el = node.nodeType === Node.ELEMENT_NODE
    ? (node as Element).parentElement
    : node.parentElement;
  while (el !== null && !el.classList.contains("tugx-md-block")) {
    ancestors.push(el);
    el = el.parentElement;
  }
  const chain: ChainNode[] = [];
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const cn = chainNodeOf(ancestors[i]!);
    if (cn !== null) chain.push(cn);
  }
  const last = chain[chain.length - 1];
  if (last === undefined || !isLeaf(last)) {
    const container = last?.el ?? el ?? node.parentElement ?? (node as Element);
    chain.push({ kind: "paragraph", el: container });
  }
  return { el: chain[chain.length - 1]!.el, chain };
}

function isCodeLeaf(block: BlockInfo): boolean {
  return block.chain[block.chain.length - 1]?.kind === "code";
}

/** `![alt](src "title")` for a rendered image. */
function imageMarkdown(img: Element): string {
  const alt = img.getAttribute("alt") ?? "";
  const src = img.getAttribute("src") ?? "";
  const title = img.getAttribute("title");
  const dest = title !== null && title !== "" ? `${src} "${title.replace(/"/g, '\\"')}"` : src;
  return `![${alt}](${dest})`;
}

/** Whether `range` holds the whole of `el`, not merely a boundary on it. */
function rangeContains(range: Range, el: Element): boolean {
  const doc = el.ownerDocument;
  if (doc === null) return false;
  const own = doc.createRange();
  own.selectNode(el);
  // START_TO_START = 0, END_TO_END = 2.
  return range.compareBoundaryPoints(0, own) <= 0 && range.compareBoundaryPoints(2, own) >= 0;
}

/** The `[^label]` of a footnote reference, from the link it back-references. */
function footnoteLabel(ref: Element): string {
  const href = ref.querySelector("a")?.getAttribute("href") ?? "";
  const fromHref = href.replace(/^#/, "");
  return fromHref !== "" ? fromHref : (ref.textContent ?? "").trim();
}

/** Inline styling of a text node, from its ancestors up to the block. */
function marksOf(node: Node): Marks {
  const marks: Marks = {};
  let el = node.parentElement;
  while (el !== null && !isBlockBoundary(el)) {
    switch (el.tagName) {
      case "STRONG":
      case "B":
        marks.bold = true;
        break;
      case "EM":
      case "I":
        marks.italic = true;
        break;
      case "DEL":
      case "S":
        marks.strike = true;
        break;
      case "CODE":
        marks.code = true;
        break;
      case "A":
        if (marks.href === undefined) {
          marks.href = el.getAttribute("href") ?? undefined;
        }
        break;
      default:
        break;
    }
    el = el.parentElement;
  }
  return marks;
}

/** Walk the text runs inside `range`, clipped to the selection. */
function collectRuns(range: Range): Run[] {
  const root =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;
  if (root === null) return [];

  const doc = root.ownerDocument;
  if (doc === null) return [];
  // A selection that landed entirely INSIDE one chip — its drawn label is text,
  // so WebKit will let a drag select part of it. The chip is indivisible: the
  // whole atom is what was selected.
  const inChip = closestAtomChip(root);
  if (inChip !== null) {
    const atom = atomOf(inChip);
    return atom === null
      ? []
      : [{ text: TUG_ATOM_CHAR, block: blockInfoOf(inChip), marks: {}, raw: true, atom }];
  }
  // Elements as well as text: a chip is an element with no text of its own to
  // walk (the editor's `<img>`), or with text that is its own drawn label and
  // must not be copied as prose (the transcript's `<svg>`).
  const walker = doc.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  const runs: Run[] = [];
  const seenKatex = new Set<Element>();
  const seenAtoms = new Set<Element>();
  const seenFootnotes = new Set<Element>();

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      const atom = atomOf(el);
      if (atom === null) {
        // Elements with no text of their own that still stand for something
        // in the markdown. An image is inline, so it keeps its marks (a
        // linked image is `[![…](src)](href)`); a rule is a block, emitted
        // only when the range holds all of it AND selected text on both
        // sides of it — `trimRules` below drops one at either edge, because
        // a drag that ends at the start of the next block's text holds the
        // rule between without the reader having selected anything of it.
        if (el.tagName === "IMG" && closestAtomChip(el) === null && range.intersectsNode(el)) {
          runs.push({ text: imageMarkdown(el), block: blockInfoOf(el), marks: marksOf(el), raw: false });
        } else if (el.tagName === "HR" && rangeContains(range, el)) {
          runs.push({ text: "---", block: blockInfoOf(el), marks: {}, raw: true });
        }
        continue;
      }
      if (seenAtoms.has(el) || !range.intersectsNode(el)) continue;
      seenAtoms.add(el);
      // The chip is one character in the substrate — the same U+FFFC the
      // prompt that submitted it carried — with the atom recorded beside it.
      runs.push({
        text: TUG_ATOM_CHAR,
        block: blockInfoOf(el),
        marks: {},
        raw: true,
        atom,
      });
      continue;
    }
    const textNode = node as Text;
    if (!range.intersectsNode(textNode)) continue;

    // Text INSIDE a chip is the chip's own drawn label (its `<text>`, its
    // `<title>`, a citation's title) — already accounted for by the atom run
    // above, and never prose.
    if (closestAtomChip(textNode) !== null) continue;

    // Chrome the enhancers drew around a block — a fence's language label, a
    // table's row count, a footnote's number — is the wrapper's, not the
    // prose's. A range spanning the block contains it all the same.
    if (inChrome(textNode.parentElement)) continue;

    // A footnote reference's number is a link to its definition; the
    // markdown for it is `[^label]`, once per reference.
    const footnote = textNode.parentElement?.closest("sup.footnote-reference") ?? null;
    if (footnote !== null) {
      if (!seenFootnotes.has(footnote)) {
        seenFootnotes.add(footnote);
        runs.push({
          text: `[^${footnoteLabel(footnote)}]`,
          block: blockInfoOf(footnote),
          marks: {},
          raw: true,
        });
      }
      continue;
    }

    // KaTeX: emit the TeX once for the whole `.katex`, skip its text.
    const katex = closestKatex(textNode);
    if (katex !== null) {
      if (!seenKatex.has(katex)) {
        seenKatex.add(katex);
        runs.push({
          text: serializeKatex(katex),
          block: blockInfoOf(katex),
          marks: {},
          raw: true,
        });
      }
      continue;
    }

    let text = textNode.data;
    const start = textNode === range.startContainer ? range.startOffset : 0;
    const end = textNode === range.endContainer ? range.endOffset : text.length;
    text = text.slice(start, end);
    if (text === "") continue;

    const block = blockInfoOf(textNode);
    const code = isCodeLeaf(block);
    runs.push({
      text,
      block,
      marks: code ? {} : marksOf(textNode),
      raw: code,
    });
  }
  return trimRules(runs);
}

/** A run the reader actually selected: text that is not only whitespace, or a chip. */
function isSubstantive(run: Run): boolean {
  return run.atom !== undefined || run.text.trim() !== "";
}

function isRule(run: Run): boolean {
  return run.raw && run.text === "---" && run.atom === undefined;
}

/**
 * Drop a rule that has no selected content on one side of it. Only text and
 * chips are what the reader chose; a rule is carried between them, never
 * as the first or last thing a selection says.
 */
function trimRules(runs: Run[]): Run[] {
  const first = runs.findIndex((r) => isSubstantive(r) && !isRule(r));
  if (first === -1) return runs.filter((r) => !isRule(r));
  let last = runs.length - 1;
  while (last > first && !(isSubstantive(runs[last]!) && !isRule(runs[last]!))) last -= 1;
  return runs.filter((r, i) => !isRule(r) || (i > first && i < last));
}

/** Whether two runs carry the same inline marks, field for field. */
function sameMarks(a: Marks, b: Marks): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strike === b.strike &&
    a.code === b.code &&
    a.href === b.href
  );
}

/**
 * Join runs that a marked element split, before any marker is written.
 *
 * A run is one DOM text node, and {@link applyMarks} wraps each one on its
 * own. So a `<code>` holding two text nodes earned two pairs of backticks —
 * which is what a confirmed commit mention produced, its pill's word and its
 * hash being separate text nodes inside the mention's own `<code>`. The
 * mention no longer splits that way, but the defect was never the commit's:
 * any inline element the annotator, a portal, or a future inline component
 * divides into several text nodes hits it, and a reader who selects across one
 * gets markup with the marks stuttering through it.
 *
 * So the join happens here, once, on the runs — where "the same styled span"
 * is exactly what the predicate says: the same block element, the same marks.
 * A `raw` run is never merged and never absorbs one, because raw is what
 * carries an atom's `U+FFFC` and KaTeX's verbatim TeX: an atom must stay its
 * own run or its `atom` would have nowhere to ride, and pre-formatted text
 * that gained a neighbour's characters would no longer be verbatim.
 *
 * The one-text-node case is byte-identical: with nothing to merge, every run
 * comes out as it went in.
 */
export function mergeAdjacentRuns(runs: readonly Run[]): Run[] {
  const merged: Run[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (
      prev !== undefined &&
      !prev.raw &&
      !run.raw &&
      prev.atom === undefined &&
      run.atom === undefined &&
      prev.block.el === run.block.el &&
      sameMarks(prev.marks, run.marks)
    ) {
      // A copy rather than a mutation: `collectRuns`' objects are the caller's,
      // and a merge that wrote through them would be a side effect on an input.
      merged[merged.length - 1] = { ...prev, text: prev.text + run.text };
      continue;
    }
    merged.push(run);
  }
  return merged;
}

/** Wrap a run's text in its inline markers, keeping whitespace outside. */
function applyMarks(text: string, marks: Marks): string {
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  const trail = /\s*$/.exec(text)?.[0] ?? "";
  let core = text.slice(lead.length, text.length - trail.length);
  if (core === "") return text;
  if (marks.code === true) core = "`" + core + "`";
  if (marks.strike === true) core = "~~" + core + "~~";
  if (marks.italic === true) core = "*" + core + "*";
  if (marks.bold === true) core = "**" + core + "**";
  if (marks.href !== undefined && marks.href !== "") {
    core = "[" + core + "](" + marks.href + ")";
  }
  return lead + core + trail;
}

// ---------------------------------------------------------------------------
// The tree — chains assembled, then emitted by CommonMark's container rules
// ---------------------------------------------------------------------------

interface TreeNode {
  node: ChainNode;
  children: TreeNode[];
  /** The runs of a leaf, in document order. Empty on a container. */
  runs: Run[];
}

/**
 * Consecutive runs sharing a leaf join into one leaf; leaves sharing a
 * container nest under it. Siblings are matched by element identity at
 * their own depth and only against the *last* sibling, so text that
 * returns to an item after its nested list starts a new leaf rather than
 * folding into the one before the list.
 */
function buildTree(runs: readonly Run[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const run of runs) {
    let siblings = root;
    let node: TreeNode | undefined;
    for (const cn of run.block.chain) {
      const last = siblings[siblings.length - 1];
      if (last !== undefined && last.node.el === cn.el && last.node.kind === cn.kind) {
        node = last;
      } else {
        node = { node: cn, children: [], runs: [] };
        siblings.push(node);
      }
      siblings = node.children;
    }
    node?.runs.push(run);
  }
  return root;
}

/**
 * A leaf's inline text: each run in its marks, joined, trimmed at the ends.
 * The leaf's atoms ride out only when its text does — a leaf that trims
 * away to nothing takes its chips with it, so the atoms stay paired with
 * the U+FFFC characters that actually survived.
 */
function emitInline(runs: readonly Run[], atoms: AtomSegment[]): string {
  let body = "";
  const own: AtomSegment[] = [];
  for (const run of runs) {
    body += run.raw ? run.text : applyMarks(run.text, run.marks);
    if (run.atom !== undefined) own.push(run.atom);
  }
  const text = body.replace(/^\s+/, "").replace(/\s+$/, "");
  if (text === "") return "";
  atoms.push(...own);
  return text;
}

function emitCode(node: TreeNode, atoms: AtomSegment[]): string {
  let body = "";
  for (const run of node.runs) {
    body += run.text;
    if (run.atom !== undefined) atoms.push(run.atom);
  }
  const lang = node.node.kind === "code" ? node.node.lang ?? "" : "";
  return "```" + lang + "\n" + body.replace(/\n+$/, "") + "\n```";
}

/** Every line prefixed, the way a container's content is carried. */
function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, i) => {
      const prefix = i === 0 ? first : rest;
      return line === "" ? prefix.replace(/\s+$/, "") : prefix + line;
    })
    .join("\n");
}

function emitQuote(node: TreeNode, atoms: AtomSegment[]): string {
  const inner = emitBlocks(node.children, atoms).join("\n\n");
  return inner === "" ? "" : prefixLines(inner, "> ", "> ");
}

function emitList(node: TreeNode, atoms: AtomSegment[]): string {
  if (node.node.kind !== "list") return "";
  const { ordered, start, tight } = node.node;
  const between = tight ? "\n" : "\n\n";
  const items: string[] = [];
  for (const child of node.children) {
    if (child.node.kind !== "item") continue;
    const marker = ordered ? `${start + child.node.index}.` : "-";
    const task =
      child.node.task === null ? "" : child.node.task === "checked" ? "[x] " : "[ ] ";
    const content = emitBlocks(child.children, atoms).join(between);
    if (content === "") continue;
    items.push(
      prefixLines(content, marker + " " + task, " ".repeat(marker.length + 1)),
    );
  }
  return items.join(between);
}

function emitCell(node: TreeNode, atoms: AtomSegment[]): string {
  return emitInline(node.runs, atoms).replace(/\n/g, " ").replace(/\|/g, "\\|");
}

const ALIGN_ROW: Record<Align, string> = {
  none: "---",
  left: ":--",
  center: ":-:",
  right: "--:",
};

/**
 * Only the rows the selection touched, with the first of them as the header
 * — the header row when it is among them, else the first body row, which is
 * what makes a single copied row render as a table rather than as prose.
 */
function emitTable(node: TreeNode, atoms: AtomSegment[]): string {
  if (node.node.kind !== "table") return "";
  const aligns = node.node.aligns;
  const lines: string[] = [];
  for (const row of node.children) {
    if (row.node.kind !== "row") continue;
    const cells: string[] = [];
    const indexes: number[] = [];
    for (const cell of row.children) {
      if (cell.node.kind !== "cell") continue;
      cells.push(emitCell(cell, atoms));
      indexes.push(cell.node.index);
    }
    if (cells.length === 0) continue;
    lines.push("| " + cells.join(" | ") + " |");
    if (lines.length === 1) {
      const rule = indexes.map((i) => ALIGN_ROW[aligns[i] ?? "none"]);
      lines.push("| " + rule.join(" | ") + " |");
    }
  }
  return lines.join("\n");
}

function emitFootnote(node: TreeNode, atoms: AtomSegment[]): string {
  if (node.node.kind !== "footnote") return "";
  const inner = emitBlocks(node.children, atoms).join("\n\n");
  if (inner === "") return "";
  return prefixLines(inner, `[^${node.node.label}]: `, "    ");
}

/** One node's markdown, or `""` when it carries nothing selected. */
function emitNode(node: TreeNode, atoms: AtomSegment[]): string {
  switch (node.node.kind) {
    case "quote":
      return emitQuote(node, atoms);
    case "list":
      return emitList(node, atoms);
    case "table":
      return emitTable(node, atoms);
    case "footnote":
      return emitFootnote(node, atoms);
    case "code":
      return emitCode(node, atoms);
    case "heading": {
      const text = emitInline(node.runs, atoms);
      return text === "" ? "" : "#".repeat(node.node.level) + " " + text;
    }
    case "cell":
      return emitCell(node, atoms);
    case "paragraph":
      return emitInline(node.runs, atoms);
    case "item":
    case "row":
      // Only reached for an item outside a list or a row outside a table —
      // a shape the chain never produces. Carry the content plainly.
      return emitBlocks(node.children, atoms).join("\n\n");
    default:
      return "";
  }
}

/** The blocks of a sibling list, empties dropped. */
function emitBlocks(nodes: readonly TreeNode[], atoms: AtomSegment[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    const block = emitNode(node, atoms);
    if (block !== "") out.push(block);
  }
  return out;
}

/**
 * Reconstruct the current selection as the `(text, atoms)` substrate: markdown
 * for the prose, a `U+FFFC` for each chip it crossed, and the atoms those
 * chips stand for. Returns `null` when the selection is empty or produced
 * nothing. `bodyEl` is unused today (the runs come from the range); kept for
 * call-site stability and future per-cell scoping.
 *
 * The substrate rather than a string, because a copy has two readings to give
 * and they are the same substrate: the readable text an external app pastes
 * ({@link formatAtomTextForCopy}) and the sidecar that rebuilds the chips on
 * the way back into Tug.
 */
export function selectionToTranscriptSubstrate(
  selection: Selection,
  _bodyEl: HTMLElement,
): SelectionSubstrate | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;
  const runs = mergeAdjacentRuns(collectRuns(selection.getRangeAt(0)));
  if (runs.length === 0) return null;

  const atoms: AtomSegment[] = [];
  const md = emitBlocks(buildTree(runs), atoms).join("\n\n").trim();
  return md.length > 0 ? { text: md, atoms } : null;
}

/**
 * The selection as readable markdown — the substrate above, flattened, with
 * each chip written the way it is drawn. The `text/plain` flavor.
 */
export function selectionToTranscriptMarkdown(
  selection: Selection,
  bodyEl: HTMLElement,
): string | null {
  const substrate = selectionToTranscriptSubstrate(selection, bodyEl);
  if (substrate === null) return null;
  const text = formatAtomTextForCopy(substrate.text, substrate.atoms);
  return text.length > 0 ? text : null;
}
