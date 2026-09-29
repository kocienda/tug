/**
 * Shared DOMPurify instance + sanitize config for the tugmark pipeline.
 *
 * Used by `parseMarkdownToSanitizedBlocks` and `TugMarkdownView` /
 * `TugMarkdownBlock` so a single set of `ALLOWED_TAGS` / `FORBID_TAGS`
 * decisions governs every rendered markdown block in the app. Mirrors
 * the strategy used by `lib/markdown.ts` (the conversation-prose path)
 * — same allowlist / blocklist, same jsdom fallback in Bun/Node test
 * environments so DOMPurify's `ALLOWED_TAGS + FORBID_TAGS` interaction
 * runs against a standards-compliant DOM.
 *
 * The instance is cached at module scope and lazily initialized on
 * first `getDOMPurify()` call.
 */

import DOMPurifyModule from "dompurify";

/**
 * DOMPurify configuration shared across the markdown rendering paths.
 * Identical to `lib/markdown.ts`'s config; both lists must move
 * together (a tag added here without a corresponding update there
 * leaves the conversation-prose path stricter than the block path or
 * vice versa).
 */
export const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "strong", "em", "del", "sup", "sub",
    "a", "code", "pre",
    "ul", "ol", "li",
    "blockquote",
    "table", "thead", "tbody", "tr", "th", "td",
    "img",
    // `div` survives so pulldown-cmark's `<div class="footnote-definition"
    // id="N">` wrapper can keep its `id` for fragment back-references from
    // the matching `<sup class="footnote-reference"><a href="#N">…</a></sup>`.
    "div",
    // `input` survives only as the task-list checkbox pulldown-cmark emits
    // (`<input disabled type="checkbox" checked>`); `restrictInputs` below
    // drops every other input and pins the survivor disabled, so the item's
    // done/undone state is in the DOM without a control that can be typed in.
    "input",
  ],
  // `start` survives so an ordered list that begins above one renders — and
  // copies — with the ordinal its author gave it.
  ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "id", "start", "type", "checked", "disabled"],
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "style", "link", "meta", "base", "svg", "math"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"],
};

let _dompurify: ReturnType<typeof DOMPurifyModule> | null = null;

/**
 * Confine `<input>` to the task-list checkbox: any other input is removed,
 * and the checkbox is always disabled. Hooks are per-instance, so this runs
 * for every config the instance sanitizes; a config that does not allow
 * `input` at all never reaches it.
 */
function restrictInputs(instance: ReturnType<typeof DOMPurifyModule>): void {
  instance.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName !== "input") return;
    const el = node as Element;
    if (el.getAttribute("type") !== "checkbox") {
      el.parentNode?.removeChild(el);
    }
  });
  instance.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "INPUT") {
      (node as Element).setAttribute("disabled", "");
    }
  });
}

/**
 * Return a DOMPurify instance bound to a standards-compliant DOM.
 *
 * In a real browser the native `window` is used. In Bun/Node test
 * environments a `jsdom` Window is created so DOMPurify's tree-mutation
 * logic matches the WHATWG spec. jsdom is already a `devDependency` of
 * tugdeck, so this fallback adds no new supply-chain surface.
 */
export function getDOMPurify(): ReturnType<typeof DOMPurifyModule> {
  if (_dompurify && _dompurify.isSupported) return _dompurify;

  const isBunOrNode =
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
    || (typeof process !== "undefined"
        && process.versions != null
        && !process.versions.bun
        && process.versions.node != null);

  if (isBunOrNode) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { JSDOM } = require("jsdom") as typeof import("jsdom");
      const dom = new JSDOM("<!DOCTYPE html>");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _dompurify = DOMPurifyModule(dom.window as any);
      restrictInputs(_dompurify);
      if (_dompurify.isSupported) return _dompurify;
    } catch {
      // jsdom not available — fall through to window fallback.
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win: any = typeof window !== "undefined" ? window : (global as any).window;
  _dompurify = DOMPurifyModule(win);
  restrictInputs(_dompurify);
  return _dompurify;
}
