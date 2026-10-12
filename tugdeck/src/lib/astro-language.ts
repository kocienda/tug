/**
 * astro-language.ts — a CodeMirror 6 language for Astro components (`.astro`).
 *
 * No maintained Lezer grammar for Astro exists, but an Astro file is two
 * languages Tug already loads, laid end to end: an optional frontmatter
 * fence of TypeScript between `---` lines, then an HTML template. So the
 * grammar here does no tokenizing of its own. A trivial outer parser cuts
 * the document into `FrontmatterFence` / `Frontmatter` / `Template` nodes,
 * and `parseMixed` mounts the TypeScript and HTML parsers on the two
 * bodies, which keeps both of those incremental. HTML's own nesting still
 * applies inside the template, so `<script>` and `<style>` highlight too.
 *
 * What it does not do: `{expression}` holes in the template read as HTML
 * text, not as JSX. That is the honest limit of composing existing grammars.
 *
 * @module lib/astro-language
 */

import {
  Language,
  LanguageSupport,
  defineLanguageFacet,
  languageDataProp,
} from "@codemirror/language";
import { typescriptLanguage } from "@codemirror/lang-javascript";
import { htmlLanguage } from "@codemirror/lang-html";
import {
  NodeSet,
  NodeType,
  Parser,
  Tree,
  parseMixed,
  type Input,
  type PartialParse,
  type TreeFragment,
} from "@lezer/common";
import { styleTags, tags } from "@lezer/highlight";

const astroData = defineLanguageFacet({
  commentTokens: { block: { open: "<!--", close: "-->" } },
});

const DOCUMENT = 0;
const FENCE = 1;
const FRONTMATTER = 2;
const TEMPLATE = 3;

const nodeSet = new NodeSet([
  NodeType.define({ id: DOCUMENT, name: "Document", top: true, props: [[languageDataProp, astroData]] }),
  NodeType.define({ id: FENCE, name: "FrontmatterFence" }),
  NodeType.define({ id: FRONTMATTER, name: "Frontmatter" }),
  NodeType.define({ id: TEMPLATE, name: "Template" }),
]).extend(styleTags({ FrontmatterFence: tags.processingInstruction }));

/** A `---` line: the fence, with trailing whitespace allowed. */
const FENCE_LINE = /^---[ \t]*$/;

/**
 * Cut `text` into the top-level nodes. Frontmatter exists only when the
 * very first line is a fence and a later line closes it; anything else is
 * all template.
 */
export function astroRegions(text: string): {
  fences: Array<[number, number]>;
  frontmatter: [number, number] | null;
  template: [number, number];
} {
  const firstEnd = text.indexOf("\n");
  const firstLine = firstEnd < 0 ? text : text.slice(0, firstEnd);
  if (firstEnd >= 0 && FENCE_LINE.test(firstLine)) {
    let lineStart = firstEnd + 1;
    while (lineStart <= text.length) {
      const nl = text.indexOf("\n", lineStart);
      const lineEnd = nl < 0 ? text.length : nl;
      if (FENCE_LINE.test(text.slice(lineStart, lineEnd))) {
        return {
          fences: [[0, firstLine.length], [lineStart, lineEnd]],
          frontmatter: [firstEnd + 1, lineStart],
          template: [lineEnd, text.length],
        };
      }
      if (nl < 0) break;
      lineStart = nl + 1;
    }
  }
  return { fences: [], frontmatter: null, template: [0, text.length] };
}

/** The outer parse: one pass, finished on its first `advance`. */
class AstroOuterParse implements PartialParse {
  parsedPos = 0;
  stoppedAt: number | null = null;

  constructor(private readonly input: Input) {}

  advance(): Tree {
    const length = this.input.length;
    const { fences, frontmatter, template } = astroRegions(this.input.read(0, length));
    const children: Tree[] = [];
    const positions: number[] = [];
    const leaf = (id: number, from: number, to: number) => {
      children.push(new Tree(nodeSet.types[id], [], [], to - from));
      positions.push(from);
    };
    if (frontmatter !== null) {
      leaf(FENCE, fences[0][0], fences[0][1]);
      leaf(FRONTMATTER, frontmatter[0], frontmatter[1]);
      leaf(FENCE, fences[1][0], fences[1][1]);
    }
    leaf(TEMPLATE, template[0], template[1]);
    this.parsedPos = length;
    return new Tree(nodeSet.types[DOCUMENT], children, positions, length);
  }

  stopAt(pos: number): void {
    this.stoppedAt = pos;
  }
}

const mountBodies = parseMixed((node) => {
  if (node.type.id === FRONTMATTER) return { parser: typescriptLanguage.parser };
  if (node.type.id === TEMPLATE) return { parser: htmlLanguage.parser };
  return null;
});

class AstroParser extends Parser {
  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    return mountBodies(new AstroOuterParse(input), input, fragments, ranges);
  }
}

export const astroLanguage = new Language(astroData, new AstroParser(), [], "astro");

/** Astro language support, for the registry's `.astro` loader. */
export function astro(): LanguageSupport {
  return new LanguageSupport(astroLanguage);
}
