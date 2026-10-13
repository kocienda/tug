/**
 * rendered-barrier — the page's own sanitize pass over tugcast's renders.
 *
 * tugcast renders streaming assistant text to HTML itself and sanitizes it
 * with tugmark (ammonia over html5ever). The page writes that HTML through
 * `innerHTML`, so a block that survives tugmark but parses differently in
 * WebKit — a parser differential, not a provenance question — would reach the
 * DOM with nothing else in the way. This pass is the second barrier: every
 * block's HTML new in an emission goes through DOMPurify, with the shared
 * allow-list, before the store holds it. Emissions carry HTML only for hashes
 * the message has not had before, so a delta is typically one small block.
 *
 * The allow-list is `SANITIZE_CONFIG` plus the vocabulary tugmark writes
 * after its own sanitize, which the page's pipeline writes after DOMPurify in
 * the same way: highlighted code (`<span class="tug-syn-*">` runs under a
 * `data-tug-highlighted` code element) and the math and mermaid placeholders
 * the enhancers look for. Those are inert attributes; nothing here admits a
 * handler, a script-bearing element, or a URL scheme the shared list refuses.
 * Each is held to the one shape that writes it, after DOMPurify has read the
 * whole fragment: a `span` that is not a `tug-syn-*` run is unwrapped, and a
 * placeholder attribute on any other element is dropped.
 * `class` and `id` are held to the shared list's shapes, with the
 * post-sanitize classes admitted only on their own elements; tugcast's
 * footnote ids arrive already under the page's prefix and pass unchanged.
 *
 * It stays until tugmark has been fuzzed against WebKit and a decision to
 * remove it is recorded under [B01] in `briefs/tugcast-renders-brief.md`,
 * which carries the reversal that put it here.
 *
 * The counters are diagnostics read imperatively (the streaming arm's
 * reading, through the test surface), never rendered.
 */

import { bindDOMPurify, restrictIdsAndClasses, SANITIZE_CONFIG } from "./dompurify-instance";

/** The markup tugmark adds after its sanitize, and the page after DOMPurify. */
const POST_SANITIZE_TAGS = ["span"] as const;
const POST_SANITIZE_ATTRS = [
  "data-tug-highlighted",
  "data-tugx-math",
  "data-tugx-math-pending",
  "data-tugx-mermaid-pending",
] as const;

/** The barrier's DOMPurify config: the shared list plus the post-sanitize vocabulary. */
export const RENDERED_BARRIER_CONFIG = {
  ...SANITIZE_CONFIG,
  ALLOWED_TAGS: [...SANITIZE_CONFIG.ALLOWED_TAGS, ...POST_SANITIZE_TAGS],
  ALLOWED_ATTR: [...SANITIZE_CONFIG.ALLOWED_ATTR, ...POST_SANITIZE_ATTRS],
};

function hasClassPrefix(el: Element, prefix: string): boolean {
  return Array.from(el.classList).some((c) => c.startsWith(prefix));
}

/**
 * The classes tugmark writes after its sanitize, each on the one element
 * that carries it: `tug-syn-*` on a highlight run's `span`, `tugx-katex*`
 * and `tugx-mermaid` on a placeholder's `div`. Beyond these the barrier
 * holds `class` to the shared list's `CLASS_PREFIXES`, as the page's own
 * parse does.
 */
function postSanitizeClass(tag: string, token: string): boolean {
  if (tag === "span") return token.startsWith("tug-syn-");
  if (tag === "div") return token.startsWith("tugx-katex") || token === "tugx-mermaid";
  return false;
}

let barrierPurify: ReturnType<typeof bindDOMPurify> | null = null;

/** The barrier's own instance, so its class allowance never reaches the page's parse. */
function getBarrierDOMPurify(): ReturnType<typeof bindDOMPurify> {
  if (barrierPurify === null || !barrierPurify.isSupported) {
    barrierPurify = bindDOMPurify();
    restrictIdsAndClasses(barrierPurify, postSanitizeClass);
  }
  return barrierPurify;
}

/** Whether `attr` stands on `el` in the shape tugmark writes it. */
function postSanitizeAttrFits(el: Element, attr: string): boolean {
  switch (attr) {
    case "data-tug-highlighted":
      return el.localName === "code";
    case "data-tugx-math":
    case "data-tugx-math-pending":
      return el.localName === "div" && hasClassPrefix(el, "tugx-katex");
    case "data-tugx-mermaid-pending":
      return el.localName === "div" && hasClassPrefix(el, "tugx-mermaid");
    default:
      return true;
  }
}

/**
 * Hold the post-sanitize vocabulary to its shapes in a fragment DOMPurify
 * has already sanitized, so every node here was read before it moves.
 */
function restrictPostSanitizeVocabulary(fragment: DocumentFragment): void {
  for (const span of Array.from(fragment.querySelectorAll("span"))) {
    if (!hasClassPrefix(span, "tug-syn-")) span.replaceWith(...Array.from(span.childNodes));
  }
  for (const attr of POST_SANITIZE_ATTRS) {
    for (const el of Array.from(fragment.querySelectorAll(`[${attr}]`))) {
      if (!postSanitizeAttrFits(el, attr)) el.removeAttribute(attr);
    }
  }
}

export interface RenderedBarrierSnapshot {
  /** Emissions that carried at least one block's HTML. */
  deltas: number;
  /** Blocks sanitized across those emissions. */
  blocks: number;
  /** Time spent sanitizing, in milliseconds. */
  totalMs: number;
  /** The slowest single emission, in milliseconds. */
  maxMs: number;
}

let deltas = 0;
let blocks = 0;
let totalMs = 0;
let maxMs = 0;

/** Every entry of `html` through DOMPurify; the keys are kept. */
export function sanitizeRenderedHtml(html: Readonly<Record<string, string>>): Record<string, string> {
  const keys = Object.keys(html);
  if (keys.length === 0) return {};
  const t0 = performance.now();
  const sanitizer = getBarrierDOMPurify();
  const out: Record<string, string> = {};
  for (const key of keys) {
    const fragment = sanitizer.sanitize(html[key], { ...RENDERED_BARRIER_CONFIG, RETURN_DOM_FRAGMENT: true });
    // DOMPurify answers null where the string path answers "": no body to read.
    if (fragment === null) {
      out[key] = "";
      continue;
    }
    restrictPostSanitizeVocabulary(fragment);
    const box = fragment.ownerDocument.createElement("div");
    box.appendChild(fragment);
    out[key] = box.innerHTML;
  }
  const ms = performance.now() - t0;
  deltas += 1;
  blocks += keys.length;
  totalMs += ms;
  if (ms > maxMs) maxMs = ms;
  return out;
}

/** Point-in-time snapshot of the barrier's counters. */
export function snapshotRenderedBarrier(): RenderedBarrierSnapshot {
  return { deltas, blocks, totalMs, maxMs };
}

/** Zero the counters (tests). */
export function resetRenderedBarrier(): void {
  deltas = 0;
  blocks = 0;
  totalMs = 0;
  maxMs = 0;
}
