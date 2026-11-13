/**
 * The share page's drawing as HTML a mail client can paste: the rich flavour
 * a PDF's Copy writes beside the Markdown.
 *
 * A pasteboard's HTML arrives without the page's stylesheets, so every
 * element's look has to travel on the element itself. `styledHtml` clones the
 * subtree and writes, per element, the computed value of an allowlist of
 * properties into its `style` attribute — the ones a mail composer honours
 * and a reader would miss: colour and ground, the font, spacing, borders and
 * line decoration. Everything else of the live page is dropped: `class` (its
 * rules are not coming), `data-*` (state for this page's scripts), `id`, and
 * every `on*` handler attribute. Inline SVG is kept as it is, with its own
 * computed colours inlined like any element's.
 *
 * What is not written is what the paste would get anyway, because an element's
 * every property written out is most of the document's size: a value equal to
 * the property's initial look (`0px`, `none`, `normal`, a transparent colour);
 * an inherited property equal to its parent's; a `display` that is the tag's
 * own. A subtree the page does not show (`display: none` — a hover control, a
 * closed tooltip) is not copied at all, and inside an SVG only the colour
 * travels, since its shapes carry their geometry as attributes.
 *
 * Colours are written as sRGB. The themes spell their tokens in `oklch()`, and
 * a computed colour keeps that spelling, which a mail client's renderer may
 * not read; a 2D canvas is the browser's own conversion, read back as bytes.
 *
 * @module share/share-html
 */

/** The properties inlined per element, as longhands: a shorthand's computed value is not always written. */
const STYLE_ALLOWLIST: readonly string[] = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "white-space",
  "display",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "text-decoration-line",
  "text-decoration-color",
];

/** Properties a child takes from its parent when it sets none of its own. */
const INHERITED: ReadonlySet<string> = new Set([
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "white-space",
]);

/** Tags whose own `display` is `block`; `li` is `list-item`; every other HTML tag is `inline`. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "dd", "dt", "fieldset",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav",
  "ol", "p", "pre", "section", "summary", "ul",
]);

/** The `display` a tag has with no stylesheet. */
function tagDisplay(tag: string): string {
  if (BLOCK_TAGS.has(tag)) return "block";
  if (tag === "li") return "list-item";
  return "inline";
}

/** Values that look the same as the property left unset, so they are not written. */
const INITIAL_LOOKS: ReadonlySet<string> = new Set(["0px", "none", "normal", "rgba(0, 0, 0, 0)", "transparent"]);

/** Properties whose value is a colour. */
function isColorProperty(property: string): boolean {
  return property === "color" || property.endsWith("-color");
}

/**
 * A colour converter backed by a 1×1 canvas, or the identity where there is
 * no canvas to draw on. Results are cached by the computed string.
 */
function makeColorToSrgb(): (value: string) => string {
  const ctx =
    typeof document !== "undefined"
      ? document.createElement("canvas").getContext("2d", { willReadFrequently: true })
      : null;
  const cache = new Map<string, string>();
  return (value: string): string => {
    if (ctx === null || value.startsWith("rgb")) return value;
    const known = cache.get(value);
    if (known !== undefined) return known;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const srgb = a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round((a! / 255) * 1000) / 1000})`;
    cache.set(value, srgb);
    return srgb;
  };
}

/** Whether an attribute is page state the paste does not carry. */
function isDroppedAttribute(name: string): boolean {
  return name === "class" || name === "id" || name === "style" || name.startsWith("data-") || name.startsWith("on");
}

/** The nearest opaque ground at or above `el`, so the paste keeps the page's ground. */
function groundOf(el: Element, toSrgb: (value: string) => string): string | null {
  for (let at: Element | null = el; at !== null; at = at.parentElement) {
    const bg = toSrgb(getComputedStyle(at).backgroundColor);
    if (!INITIAL_LOOKS.has(bg) && !bg.startsWith("rgba(")) return bg;
  }
  return null;
}

/**
 * `root` and everything under it as standalone HTML, each element carrying
 * its look in its `style` attribute. The root also carries the page's ground
 * when its own background is transparent.
 */
export function styledHtml(root: HTMLElement): string {
  const toSrgb = makeColorToSrgb();
  const clone = root.cloneNode(true) as HTMLElement;
  const originals = [root, ...Array.from(root.querySelectorAll("*"))];
  const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];
  const computedOf = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (el: Element): CSSStyleDeclaration => {
    let style = computedOf.get(el);
    if (style === undefined) {
      style = getComputedStyle(el);
      computedOf.set(el, style);
    }
    return style;
  };
  const removed = new Set<Element>();
  for (let i = 0; i < originals.length; i += 1) {
    const original = originals[i]!;
    const copy = copies[i]!;
    // Under a subtree already dropped: its copy went with it.
    if (original.parentElement !== null && removed.has(original.parentElement)) {
      removed.add(original);
      continue;
    }
    const computed = styleOf(original);
    if (i > 0 && computed.display === "none") {
      removed.add(original);
      copy.remove();
      continue;
    }
    for (const name of copy.getAttributeNames()) {
      if (isDroppedAttribute(name)) copy.removeAttribute(name);
    }
    const inSvg = original instanceof SVGElement && original.tagName.toLowerCase() !== "svg";
    const parent = i > 0 ? original.parentElement : null;
    const parentStyle = parent === null ? null : styleOf(parent);
    const tag = original.tagName.toLowerCase();
    const declarations: string[] = [];
    for (const property of STYLE_ALLOWLIST) {
      if (inSvg && property !== "color") continue;
      const raw = computed.getPropertyValue(property).trim();
      if (raw === "") continue;
      if (parentStyle !== null && INHERITED.has(property) && parentStyle.getPropertyValue(property).trim() === raw) continue;
      if (property === "display" && raw === tagDisplay(tag)) continue;
      const value = isColorProperty(property) ? toSrgb(raw) : raw;
      if (INITIAL_LOOKS.has(value)) continue;
      // A font stack's quoted family names, single-quoted, read cleanly
      // inside the attribute rather than as `&quot;` entities.
      declarations.push(`${property}: ${value.replace(/"/g, "'")}`);
    }
    if (i === 0) {
      const ground = groundOf(original, toSrgb);
      if (ground !== null && !declarations.some((d) => d.startsWith("background-color:"))) {
        declarations.push(`background-color: ${ground}`);
      }
    }
    if (declarations.length > 0) copy.setAttribute("style", declarations.join("; "));
  }
  return clone.outerHTML;
}
