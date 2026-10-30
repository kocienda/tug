/**
 * sanitize-invariant-check.ts — the sanitizer's invariant on the page's side,
 * read by the app-test that holds WebKit's parse of tugcast's renders to it
 * (`at0732-tugcast-hostile-render.test.ts`).
 *
 * Every element is in `ALLOWED_TAGS`, every attribute in `ALLOWED_ATTR`,
 * every `href`/`src` relative or a safe scheme (`data:` only on `img src`),
 * and no `data-`/`aria-` attribute survives — except the vocabulary written
 * after the sanitizer, each in the one shape that writes it. Every `class`
 * token is pulldown-cmark's (`CLASS_PREFIXES`) or a post-sanitize class on
 * its own element; an `id` stands only on the footnote definition, under
 * the page's prefix, and every fragment `href` points under it. tugcast's
 * half is `tugrust/crates/tugcast/tests/tugmark_invariant.rs`.
 *
 * Not a test: no `describe` here.
 */

import ALLOWLIST from "../sanitize-allowlist.json";

const TAGS = new Set(ALLOWLIST.ALLOWED_TAGS);
const ATTRS = new Set(ALLOWLIST.ALLOWED_ATTR);
const ID_SHAPE = ALLOWLIST.ID_SHAPE;

/** The schemes DOMPurify's `IS_ALLOWED_URI` admits, which `SAFE_URI_SCHEMES` ports. */
export const SAFE_SCHEMES = new Set([
  "http",
  "https",
  "ftp",
  "ftps",
  "mailto",
  "tel",
  "callto",
  "sms",
  "cid",
  "xmpp",
  "matrix",
]);

export type Attr = [name: string, value: string];

/** One element, named in lowercase, with its attributes in source order. */
export interface ElementSeen {
  tag: string;
  attrs: Attr[];
}

/** The start tags of serialized HTML, where text is escaped and values quoted. */
export function startTags(html: string): ElementSeen[] {
  const out: ElementSeen[] = [];
  for (const m of html.matchAll(/<([a-zA-Z][^\s/>]*)((?:\s+[^\s=/>]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    const attrs = [...m[2].matchAll(/\s+([^\s=/>]+)(?:="([^"]*)")?/g)].map((a): Attr => [a[1], a[2] ?? ""]);
    out.push({ tag: m[1].toLowerCase(), attrs });
  }
  return out;
}

function classHas(attrs: Attr[], prefix: string): boolean {
  return attrs.some(([n, v]) => n === "class" && v.split(/\s+/).some((c) => c.startsWith(prefix)));
}

function classTokens(value: string): string[] {
  return value.split(/[\t\n\f\r ]+/).filter((t) => t !== "");
}

/** Whether every token of a `class` is pulldown-cmark's or a post-sanitize class on its own element. */
function classFits(tag: string, value: string): boolean {
  return classTokens(value).every(
    (t) =>
      ALLOWLIST.CLASS_PREFIXES.some((p) => t.startsWith(p))
      || (tag === "span" && t.startsWith("tug-syn-"))
      || (tag === "div" && (t.startsWith("tugx-katex") || t === "tugx-chart")),
  );
}

/** Whether an `id` stands in the footnote shape, under the page's prefix. */
function idFits(tag: string, attrs: Attr[], value: string): boolean {
  const cls = attrs.find(([n]) => n === "class")?.[1] ?? "";
  return tag === ID_SHAPE.tag && classTokens(cls).includes(ID_SHAPE.class) && value.startsWith(ID_SHAPE.prefix);
}

/** The vocabulary written after the sanitizer, admitted only in its own shape. */
function postSanitize(tag: string, attrs: Attr[], attr?: string): boolean {
  if (tag === "span") return attr === undefined ? classHas(attrs, "tug-syn-") : attr === "class";
  if (tag === "code") return attr === "data-tug-highlighted";
  if (tag === "div" && (attr === "data-tugx-math" || attr === "data-tugx-math-pending")) return classHas(attrs, "tugx-katex");
  if (tag === "div" && attr === "data-tugx-chart-pending") return classHas(attrs, "tugx-chart");
  return false;
}

/**
 * Whether a URL is relative or names a safe scheme, read as the URL parser
 * reads it: leading and trailing C0 controls and spaces stripped, tabs and
 * newlines removed, and a scheme only where the value opens with a letter
 * and scheme characters up to a colon. Anything else resolves relative.
 */
export function urlIsSafe(tag: string, name: string, value: string): boolean {
  const chars = Array.from(value.replace(/&amp;/g, "&"));
  while (chars.length > 0 && chars[0].charCodeAt(0) <= 0x20) chars.shift();
  while (chars.length > 0 && chars[chars.length - 1].charCodeAt(0) <= 0x20) chars.pop();
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(chars.join("").replace(/[\t\n\r]/g, ""));
  if (m === null) return true;
  const scheme = m[1].toLowerCase();
  if (scheme === "data") return tag === "img" && name === "src";
  return SAFE_SCHEMES.has(scheme);
}

/** Every violation among `elements`, as a readable line. */
export function violationsIn(elements: ElementSeen[]): string[] {
  const out: string[] = [];
  for (const { tag, attrs } of elements) {
    if (!TAGS.has(tag) && !postSanitize(tag, attrs)) out.push(`element <${tag}>`);
    for (const [name, value] of attrs) {
      const admitted = ATTRS.has(name) && !name.startsWith("data-") && !name.startsWith("aria-");
      if (!admitted && !postSanitize(tag, attrs, name)) out.push(`attribute ${name} on <${tag}>`);
      if ((name === "href" || name === "src") && !urlIsSafe(tag, name, value)) out.push(`url ${name}="${value}" on <${tag}>`);
      if (name === "class" && !classFits(tag, value)) out.push(`class "${value}" on <${tag}>`);
      if (name === "id" && !idFits(tag, attrs, value)) out.push(`id "${value}" on <${tag}>`);
      if (name === "href" && value.length > 1 && value.startsWith("#") && !value.startsWith(`#${ID_SHAPE.prefix}`)) {
        out.push(`fragment href="${value}" on <${tag}>`);
      }
    }
  }
  return out;
}

/** Every violation in serialized HTML. */
export function violations(html: string): string[] {
  return violationsIn(startTags(html));
}
