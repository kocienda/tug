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
 * `<a>`→`[…](href)`) and its block context (heading level, list item,
 * code fence, blockquote), and emit markdown that wraps **only** the
 * selected text. A partial bold selection → `**old**`; a heading → `## …`;
 * an unstyled run → plain. Markers aren't text, so the rendered result
 * equals the selection exactly.
 *
 * Because only text nodes and atom chips produce output, structural/empty
 * nodes the selection merely grazed — a bare `<hr>`, an empty heading clone at
 * a boundary — contribute nothing: overshoot is impossible by construction.
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

export interface BlockInfo {
  /** The block element — runs sharing it group into one block. */
  el: Element;
  /** "heading" | "li" | "pre" | "p" (default). */
  kind: string;
  /** Heading level (1..6) when kind === "heading"; 0 otherwise. */
  level: number;
  /** Inside a `<blockquote>` (prefix lines with `> `). */
  inQuote: boolean;
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

/** The block context of a text node: nearest block ancestor + flags. */
function blockInfoOf(node: Node): BlockInfo {
  let el = node.parentElement;
  let block: Element | null = null;
  let inPre = false;
  let inQuote = false;
  while (el !== null) {
    const tag = el.tagName;
    if (tag === "PRE") inPre = true;
    if (tag === "BLOCKQUOTE") inQuote = true;
    if (block === null && BLOCK_TAGS.has(tag)) block = el;
    if (el.classList.contains("tugx-md-block")) {
      if (block === null) block = el;
      break;
    }
    el = el.parentElement;
  }
  if (block === null) block = node.parentElement ?? (node as Element);
  const tag = block.tagName;
  const kind = inPre
    ? "pre"
    : /^H[1-6]$/.test(tag)
      ? "heading"
      : tag === "LI"
        ? "li"
        : "p";
  const level = /^H[1-6]$/.test(tag) ? Number(tag[1]) : 0;
  return { el: block, kind, level, inQuote };
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

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      const atom = atomOf(el);
      if (atom === null) continue;
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
    runs.push({
      text,
      block,
      marks: block.kind === "pre" ? {} : marksOf(textNode),
      raw: block.kind === "pre",
    });
  }
  return runs;
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

/** Emit one grouped block's markdown. */
function emitBlock(kind: string, level: number, inQuote: boolean, body: string): string {
  if (kind === "pre") {
    return "```\n" + body.replace(/\n+$/, "") + "\n```";
  }
  const text = body.replace(/^\s+/, "").replace(/\s+$/, "");
  if (text === "") return "";
  if (kind === "heading") return "#".repeat(level) + " " + text;
  if (kind === "li") return "- " + text;
  if (inQuote) {
    return text
      .split("\n")
      .map((l) => (l === "" ? ">" : "> " + l))
      .join("\n");
  }
  return text;
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

  // Group consecutive runs by their block element.
  const out: string[] = [];
  const atoms: AtomSegment[] = [];
  let curEl: Element | null = null;
  let curKind = "p";
  let curLevel = 0;
  let curQuote = false;
  let body = "";
  // The atoms of the block being built, held back until the block is emitted:
  // a block that trims away to nothing takes its chips with it, so the atoms
  // stay paired with the U+FFFC characters that actually survived.
  let bodyAtoms: AtomSegment[] = [];
  const flush = (): void => {
    if (curEl === null) return;
    const block = emitBlock(curKind, curLevel, curQuote, body);
    if (block.trim() !== "") {
      out.push(block);
      atoms.push(...bodyAtoms);
    }
    body = "";
    bodyAtoms = [];
  };
  for (const run of runs) {
    if (run.block.el !== curEl) {
      flush();
      curEl = run.block.el;
      curKind = run.block.kind;
      curLevel = run.block.level;
      curQuote = run.block.inQuote;
    }
    body += run.raw ? run.text : applyMarks(run.text, run.marks);
    if (run.atom !== undefined) bodyAtoms.push(run.atom);
  }
  flush();

  const md = out.join("\n\n").trim();
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
