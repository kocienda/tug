/**
 * Shared DOMPurify instance + sanitize config for the tugmark pipeline.
 *
 * Used by `parseMarkdownToSanitizedBlocks` and `TugMarkdownView` /
 * `TugMarkdownBlock` so a single set of `ALLOWED_TAGS` / `FORBID_TAGS`
 * decisions governs every rendered markdown block in the app. In Bun/Node
 * test environments a jsdom window stands in, so DOMPurify's
 * `ALLOWED_TAGS + FORBID_TAGS` interaction runs against a
 * standards-compliant DOM.
 *
 * The instance is cached at module scope and lazily initialized on
 * first `getDOMPurify()` call.
 */

import DOMPurifyModule from "dompurify";

import SANITIZE_ALLOWLIST from "./sanitize-allowlist.json";

/**
 * DOMPurify configuration shared across the markdown rendering paths.
 *
 * The four lists live in `sanitize-allowlist.json`, the one allow-list
 * file: tugcast's native sanitizer (`tugmark`'s `ammonia` builder) reads
 * the same file, so the page and tugcast sanitize to one policy by
 * construction. Edit the lists there, never here.
 *
 * What the lists hold, and why:
 *
 * - `div` survives so pulldown-cmark's `<div class="footnote-definition"
 *   id="N">` wrapper can keep its `id` for fragment back-references from
 *   the matching `<sup class="footnote-reference"><a href="#N">…</a></sup>`.
 * - `class` and `id` are held to shapes the file also states:
 *   `CLASS_PREFIXES` is pulldown-cmark's vocabulary (`language-*`,
 *   `footnote-*`), so the `tugx-*` and `tug-syn-*` classes the transformers
 *   and highlighter write cannot arrive from the model; `ID_SHAPE` admits an
 *   `id` only on the footnote definition and moves it, and every
 *   `href="#…"`, under a prefix the page owns (`restrictIdsAndClasses`).
 * - `input` survives only as the task-list checkbox pulldown-cmark emits
 *   (`<input disabled type="checkbox" checked>`); `restrictInputs` below
 *   drops every other input and pins the survivor disabled, so the item's
 *   done/undone state is in the DOM without a control that can be typed in.
 *   tugmark reproduces both rules after ammonia runs.
 * - `start` survives so an ordered list that begins above one renders — and
 *   copies — with the ordinal its author gave it.
 * - `ALLOW_DATA_ATTR` / `ALLOW_ARIA_ATTR` are off, so the attribute list is
 *   the whole of what survives: a raw `data-tugx-*` attribute from the model
 *   could otherwise forge the placeholders the enhancers look for.
 *
 * Two knobs are not in the file, because they make DOMPurify parse the way
 * ammonia does rather than state policy:
 *
 * - `FORCE_BODY` parses a block as content of `<body>`, which is how it is
 *   inserted. Without it DOMPurify parses a whole document, so a block that
 *   opens with `<script>`, `<style>` or a comment is hoisted into `<head>`
 *   along with its trailing newline, and a stray `</p>` is ignored instead
 *   of opening an empty paragraph.
 * - `SANITIZE_DOM` is off. Its only effect under this allow-list is to drop
 *   an `id` whose value names a `document` or `<form>` property, and none of
 *   the allowed elements can shadow a `document` property by `id` (only a
 *   named `img`, `form`, `embed`, `object` or `iframe` can, and `name` is
 *   not allowed). What it did do was break footnotes labelled like a
 *   property: `[^title]`'s definition lost `id="title"`.
 */
export const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [...SANITIZE_ALLOWLIST.ALLOWED_TAGS],
  ALLOWED_ATTR: [...SANITIZE_ALLOWLIST.ALLOWED_ATTR],
  FORBID_TAGS: [...SANITIZE_ALLOWLIST.FORBID_TAGS],
  FORBID_ATTR: [...SANITIZE_ALLOWLIST.FORBID_ATTR],
  ALLOW_DATA_ATTR: SANITIZE_ALLOWLIST.ALLOW_DATA_ATTR,
  ALLOW_ARIA_ATTR: SANITIZE_ALLOWLIST.ALLOW_ARIA_ATTR,
  FORCE_BODY: true,
  SANITIZE_DOM: false,
};

type DOMPurify = ReturnType<typeof DOMPurifyModule>;

let _dompurify: DOMPurify | null = null;
let _plainDompurify: DOMPurify | null = null;

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

/** A URL's scheme as the WHATWG parser finds it, once whitespace it ignores is gone. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Drop an `href` or `src` that names a scheme but does not parse as a URL
 * (`http://exa%20mple/`, a port past 65535). Nothing can load or follow
 * one, and tugcast's sanitizer (ammonia) refuses the same values, so the
 * two render the same block. A scheme-less value is relative and kept.
 */
function restrictUrls(instance: ReturnType<typeof DOMPurifyModule>): void {
  instance.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName !== "href" && data.attrName !== "src") return;
    // eslint-disable-next-line no-control-regex -- the URL parser strips leading and trailing C0 controls and spaces, and this mirrors it
    const value = data.attrValue.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "").replace(/[\t\n\r]/g, "");
    if (!URL_SCHEME.test(value)) return;
    try {
      new URL(value);
    } catch {
      data.keepAttr = false;
    }
  });
}

/** HTML's ASCII whitespace, which `class` tokens are split on. */
const CLASS_SPACE = /[\t\n\f\r ]+/;

const ID_SHAPE = SANITIZE_ALLOWLIST.ID_SHAPE;

/**
 * `value` under the page's footnote prefix. A value already under it is
 * left as is, as tugmark's `IdShape::prefixed` leaves it.
 */
function underIdPrefix(value: string): string {
  return value.startsWith(ID_SHAPE.prefix) ? value : `${ID_SHAPE.prefix}${value}`;
}

/**
 * Hold `class` and `id` to the allow-list's shapes, as tugmark's
 * `filter_attribute` and `restrict_ids` do: a `class` keeps only tokens in
 * `CLASS_PREFIXES`, an `id` survives only on the footnote definition and
 * moves under the prefix, and a fragment `href` moves with it.
 */
function restrictIdsAndClasses(instance: DOMPurify): void {
  instance.addHook("uponSanitizeAttribute", (node, data) => {
    const tag = node.nodeName.toLowerCase();
    if (data.attrName === "class") {
      const kept = data.attrValue
        .split(CLASS_SPACE)
        .filter((t) => t !== "" && SANITIZE_ALLOWLIST.CLASS_PREFIXES.some((p) => t.startsWith(p)));
      if (kept.length === 0) data.keepAttr = false;
      else data.attrValue = kept.join(" ");
    } else if (data.attrName === "id") {
      if (tag !== ID_SHAPE.tag) data.keepAttr = false;
      else data.attrValue = underIdPrefix(data.attrValue);
    } else if (data.attrName === "href" && data.attrValue.length > 1 && data.attrValue.startsWith("#")) {
      data.attrValue = `#${underIdPrefix(data.attrValue.slice(1))}`;
    }
  });
  instance.addHook("afterSanitizeAttributes", (node) => {
    const el = node as Element;
    if (typeof el.hasAttribute !== "function" || !el.hasAttribute("id")) return;
    if (el.nodeName.toLowerCase() !== ID_SHAPE.tag || !el.classList.contains(ID_SHAPE.class)) el.removeAttribute("id");
  });
}

/**
 * A fresh DOMPurify instance bound to a standards-compliant DOM, with the
 * hooks every policy shares (`restrictInputs`, `restrictUrls`). In a real
 * browser the native `window` is used; in Bun/Node test environments a
 * `jsdom` Window stands in, so DOMPurify's tree-mutation logic matches the
 * WHATWG spec (jsdom is already a `devDependency`).
 */
function bindDOMPurify(): DOMPurify {
  const isBunOrNode =
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
    || (typeof process !== "undefined"
        && process.versions != null
        && !process.versions.bun
        && process.versions.node != null);

  if (isBunOrNode) {
    try {
      const { JSDOM } = require("jsdom") as typeof import("jsdom");
      const dom = new JSDOM("<!DOCTYPE html>");
      const instance = DOMPurifyModule(dom.window as any);
      if (instance.isSupported) {
        restrictInputs(instance);
        restrictUrls(instance);
        return instance;
      }
    } catch {
      // jsdom not available — fall through to window fallback.
    }
  }

  const win: any = typeof window !== "undefined" ? window : (global as any).window;
  const instance = DOMPurifyModule(win);
  restrictInputs(instance);
  restrictUrls(instance);
  return instance;
}

/**
 * The instance for markup that is not markdown (`ansi-to-html.ts`): the
 * shared hooks, without the markdown `class` and `id` shapes, whose
 * vocabulary is not its own.
 */
export function getPlainDOMPurify(): DOMPurify {
  if (_plainDompurify === null || !_plainDompurify.isSupported) _plainDompurify = bindDOMPurify();
  return _plainDompurify;
}

/**
 * The markdown instance: the shared hooks and the allow-list's `class` and
 * `id` shapes. Every markdown path sanitizes through it with
 * `SANITIZE_CONFIG`; markup that is not markdown gets
 * {@link getPlainDOMPurify}.
 */
export function getDOMPurify(): DOMPurify {
  if (_dompurify && _dompurify.isSupported) return _dompurify;
  _dompurify = bindDOMPurify();
  restrictIdsAndClasses(_dompurify);
  return _dompurify;
}
