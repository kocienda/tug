/**
 * face-draw — a card's stand-in read into a short display list the host can
 * draw.
 *
 * On a workspace switch the host hides a departing card's view in the same
 * transaction that stands a face for each arriving card whose page has not
 * painted: it cannot learn when the shell's own frame, with the stand-ins in
 * it, has reached the screen, so the faces that must be there when the view
 * goes are the host's. It draws each from the list read here, off the
 * rendered stand-in (`components/chrome/body-stand-in.tsx`), so the face
 * follows the pane's chrome and the theme with no second implementation of
 * either.
 *
 * The list holds the boxes that paint a fill or a border, the runs of text,
 * and the icons, each with its rect within the card's view. An icon goes as
 * its own SVG markup with every element's paint written in as computed, so
 * the host draws it with no stylesheet; the title bar's icons are a quarter
 * of its ink, and a face without them reads as a different bar.
 *
 * @module lib/face-draw
 */

import type { Rect } from "./card-plan";

/** A painted box: its rect within the view, points; fill and border as `rgba()`; corner radius, points. */
export interface FaceBox {
  readonly rect: Rect;
  readonly fill: string | null;
  readonly border: { readonly width: number; readonly color: string } | null;
  readonly radius: number;
}

/** A run of text: its rect within the view, points; the string; the font as computed; its colour as `rgba()`. */
export interface FaceText {
  readonly rect: Rect;
  readonly text: string;
  readonly font: { readonly family: string; readonly size: number; readonly weight: number };
  readonly color: string;
}

/** An icon: its rect within the view, points; standalone SVG markup, every paint written in. */
export interface FaceImage {
  readonly rect: Rect;
  readonly svg: string;
}

/** What a card's face draws: its boxes, then its text, each in paint order. */
export interface FaceDraw {
  readonly boxes: readonly FaceBox[];
  readonly texts: readonly FaceText[];
  readonly images: readonly FaceImage[];
}

/** The most elements a face is read from. */
export const FACE_DRAW_ELEMENT_CAP = 128;

/**
 * An `rgb()`/`rgba()` colour, as computed style serializes one, written
 * `rgba(r, g, b, a)`; null for anything else, and for a colour with no
 * alpha at all, which paints nothing.
 */
export function rgbaOf(css: string): string | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(css.trim());
  if (m === null) return null;
  const alphaText = m[4];
  const alpha = alphaText === undefined ? 1 : alphaText.endsWith("%") ? parseFloat(alphaText) / 100 : parseFloat(alphaText);
  if (!(alpha > 0)) return null;
  const channel = (s: string) => Math.max(0, Math.min(255, Math.round(parseFloat(s))));
  return `rgba(${channel(m[1])}, ${channel(m[2])}, ${channel(m[3])}, ${+alpha.toFixed(3)})`;
}

/** Pixel bytes as `rgba()`, unpremultiplied as a canvas reads them; null when transparent. */
export function rgbaOfBytes(r: number, g: number, b: number, a: number): string | null {
  if (a === 0) return null;
  return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`;
}

/** `r` as a rect within `view`, both viewport points. */
export function withinView(r: { x: number; y: number; width: number; height: number }, view: Rect): Rect {
  return { x: r.x - view.x, y: r.y - view.y, width: r.width, height: r.height };
}

/** The first family a computed `font-family` names, unquoted. */
export function firstFamily(fontFamily: string): string {
  const first = fontFamily.split(",")[0]?.trim() ?? "";
  return first.replace(/^["']|["']$/g, "");
}

/** A computed length in px as a number, 0 for anything unreadable. */
function px(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

const colorCache = new Map<string, string | null>();
let colorContext: CanvasRenderingContext2D | null | undefined;

/**
 * Any computed colour as `rgba()`: `rgb()` read directly, and every other
 * space (the themes' `oklch()`) by painting it into a 1 × 1 canvas and
 * reading the pixel back. Cached by the string.
 */
function cssColorToRgba(css: string): string | null {
  const direct = rgbaOf(css);
  if (direct !== null || /^rgba?\(/.test(css.trim())) return direct;
  const cached = colorCache.get(css);
  if (cached !== undefined) return cached;
  if (colorContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    colorContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  let out: string | null = null;
  if (colorContext !== null) {
    colorContext.clearRect(0, 0, 1, 1);
    colorContext.fillStyle = "rgba(0, 0, 0, 0)";
    colorContext.fillStyle = css;
    colorContext.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data;
    out = rgbaOfBytes(r, g, b, a);
  }
  colorCache.set(css, out);
  return out;
}

/**
 * Read `standIn`'s rendered elements, at most {@link FACE_DRAW_ELEMENT_CAP},
 * into a face's display list, each rect within `view` (the card's view rect,
 * viewport points). A box is kept for every element that paints a
 * background colour or a border; a text run for every element whose own
 * text is not blank, its rect the extent of that text. Elements not
 * rendered, invisible, or fully transparent are skipped with what they hold.
 * `zoom` is the deck's View › Zoom factor: computed lengths are the deck's
 * own, and the face draws them in viewport points, as its rects are.
 */
export function faceDrawOf(standIn: Element, view: Rect, zoom = 1): FaceDraw {
  const boxes: FaceBox[] = [];
  const texts: FaceText[] = [];
  const images: FaceImage[] = [];
  const elements = [standIn, ...standIn.querySelectorAll("*")].slice(0, FACE_DRAW_ELEMENT_CAP);
  const skipped: Element[] = [];
  for (const el of elements) {
    if (skipped.some((s) => s.contains(el))) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.opacity === "0") {
      skipped.push(el);
      continue;
    }
    if (style.visibility === "hidden") continue;
    if (el instanceof SVGSVGElement) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) images.push({ rect: withinView(r, view), svg: svgMarkupOf(el, r.width * zoom, r.height * zoom) });
      skipped.push(el);
      continue;
    }
    if (el instanceof SVGElement) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const fill = cssColorToRgba(style.backgroundColor);
    const borderWidth = px(style.borderTopWidth);
    const uniformBorder =
      borderWidth > 0 &&
      px(style.borderRightWidth) === borderWidth &&
      px(style.borderBottomWidth) === borderWidth &&
      px(style.borderLeftWidth) === borderWidth &&
      style.borderTopStyle !== "none";
    const borderColor = uniformBorder ? cssColorToRgba(style.borderTopColor) : null;
    if (fill !== null || borderColor !== null) {
      boxes.push({
        rect: withinView(r, view),
        fill,
        border: borderColor === null ? null : { width: borderWidth * zoom, color: borderColor },
        radius: px(style.borderTopLeftRadius) * zoom,
      });
    }
    const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
    if (own.length === 0) continue;
    const color = cssColorToRgba(style.color);
    if (color === null) continue;
    const range = document.createRange();
    range.setStartBefore(own[0]);
    range.setEndAfter(own[own.length - 1]);
    const t = range.getBoundingClientRect();
    if (t.width <= 0 || t.height <= 0) continue;
    const text = own.map((n) => n.textContent ?? "").join("").replace(/\s+/g, " ").trim();
    texts.push({
      rect: withinView(t, view),
      text: style.textTransform === "uppercase" ? text.toUpperCase() : text,
      font: { family: firstFamily(style.fontFamily), size: px(style.fontSize) * zoom, weight: parseInt(style.fontWeight, 10) || 400 },
      color,
    });
  }
  return { boxes, texts, images };
}

/** The paint properties an icon's elements take from the stylesheet, written onto its copy. */
const SVG_PAINT = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity"] as const;

/**
 * `svg` as standalone markup `width` × `height` points: each element's
 * computed paint written in as attributes, so it draws the same with no
 * stylesheet and no `currentColor` to resolve. A colour goes as `rgb()`
 * with its alpha folded into the paint's opacity: AppKit's SVG reader
 * paints nothing for an `rgba()` paint.
 */
function svgMarkupOf(svg: SVGSVGElement, width: number, height: number): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(width));
  copy.setAttribute("height", String(height));
  copy.removeAttribute("class");
  copy.removeAttribute("style");
  const sources = [svg, ...svg.querySelectorAll("*")];
  const copies = [copy, ...copy.querySelectorAll("*")];
  sources.forEach((source, i) => {
    const target = copies[i];
    if (target === undefined) return;
    const style = getComputedStyle(source);
    const opacityOf = (name: string) => {
      const n = parseFloat(style.getPropertyValue(name));
      return Number.isFinite(n) ? n : 1;
    };
    const opacity = { fill: opacityOf("fill-opacity"), stroke: opacityOf("stroke-opacity") };
    for (const name of SVG_PAINT) {
      let value = style.getPropertyValue(name).trim();
      if (value === "") continue;
      if (name === "fill-opacity" || name === "stroke-opacity") continue;
      if ((name === "fill" || name === "stroke") && value !== "none" && !value.startsWith("url(")) {
        const paint = svgPaintOf(cssColorToRgba(value));
        value = paint.color;
        opacity[name] *= paint.alpha;
      }
      target.setAttribute(name, value);
    }
    target.setAttribute("fill-opacity", String(+opacity.fill.toFixed(3)));
    target.setAttribute("stroke-opacity", String(+opacity.stroke.toFixed(3)));
    if (style.display === "none") target.setAttribute("display", "none");
  });
  return new XMLSerializer().serializeToString(copy);
}

/** An `rgba()` colour as an SVG paint AppKit reads: `rgb()` and its alpha apart; `none` for no colour. */
export function svgPaintOf(rgba: string | null): { color: string; alpha: number } {
  const m = rgba === null ? null : /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(rgba);
  if (m === null) return { color: "none", alpha: 1 };
  return { color: `rgb(${m[1]}, ${m[2]}, ${m[3]})`, alpha: parseFloat(m[4]) };
}
