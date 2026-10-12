/**
 * `enhanceFencedCode` — DOM-walks a markdown block container after its
 * `innerHTML` is set, finds every `<pre>` element produced by
 * pulldown-cmark, and wraps it in the shared markdown block chrome: a
 * sticky header bar showing the code's language plus a copy button and a
 * fold cue (see {@link buildBlockHeader}).
 *
 * Why this lives outside `parseMarkdownToSanitizedBlocks`:
 *  - The buttons + SVG icons must be live elements with event listeners
 *    attached, not strings spliced into HTML.
 *  - Both `TugMarkdownBlock` (per-cell renderer) and `TugMarkdownView`
 *    (windowed renderer) call this from the same code path right after
 *    they assign `innerHTML`, so the enhancement is invariant across
 *    both primitives.
 *
 * The header strip + Copy + fold cue are the shared `enhance-block-
 * chrome` primitives, so a fenced code block and a markdown table wear
 * the exact same chrome (sticky pin-stack header, ghost-action icon
 * buttons, `data-collapsed` fold). The only fence-specific pieces here
 * are the frame class, the language label, and the `<pre>` body.
 *
 * Idempotent: if a `<pre>` already lives inside a `.tugx-md-fenced-code`
 * wrapper (e.g., the same block is re-walked during an incremental
 * update), the function is a no-op for that `<pre>`.
 *
 * No event-listener cleanup is needed — when a parent block element is
 * replaced (`replaceChildren`, the same `el.innerHTML = ...` write, or
 * the windowing engine's prune step), the buttons are detached and
 * garbage-collected along with their listeners.
 *
 * Laws: [L06] appearance via DOM, not React state.
 *
 * @module lib/markdown/enhance-fenced-code
 */

import {
  buildBlockHeader,
  buildCopyButton,
  buildFoldButton,
} from "./enhance-block-chrome";
import { highlightFragmentToHtml } from "@/lib/language-registry";

/** Parses the language tag off a `<code class="language-X">` element.
 *  Returns `null` for unspecified-language fenced blocks. */
function readLanguage(codeEl: HTMLElement): string | null {
  for (const cls of codeEl.classList) {
    if (cls.startsWith("language-")) {
      const lang = cls.slice("language-".length).trim().toLowerCase();
      return lang === "" ? null : lang;
    }
  }
  return null;
}

/**
 * Walk `container` for `<pre>` elements emitted by pulldown-cmark and
 * wrap each one with the shared block chrome (sticky header with the
 * language label + a Copy button + a fold cue). Idempotent.
 *
 * A `<code>` tugcast already highlighted (stamped `data-tug-highlighted`)
 * keeps its spans. Any other fence in a known language is highlighted here:
 * at once by default, or, with `options.fenceHighlight` set to
 * `"idle-unless-streaming"` (a row drawn from tugcast's render), from an idle
 * callback and only once the row has stopped streaming.
 */
export function enhanceFencedCode(container: HTMLElement, options?: FenceHighlightOptions): void {
  const preEls = container.querySelectorAll("pre");
  for (const pre of preEls) {
    // Already enhanced — skip. The wrapper `.tugx-md-fenced-code` is
    // an immediate parent for an enhanced `<pre>`.
    const parent = pre.parentElement;
    if (parent !== null && parent.classList.contains("tugx-md-fenced-code")) {
      continue;
    }

    const codeEl = pre.querySelector(":scope > code") as HTMLElement | null;
    const lang = codeEl !== null ? readLanguage(codeEl) : null;

    const wrapper = document.createElement("div");
    wrapper.className = "tugx-md-fenced-code";
    if (lang !== null) wrapper.dataset.lang = lang;

    // Language label is the fence's identity, styled like a tool name.
    const langEl = document.createElement("span");
    langEl.className = "tugx-md-fenced-code-lang";
    langEl.textContent = lang ?? "code";

    const header = buildBlockHeader({
      identity: langEl,
      actions: [
        buildCopyButton(() => codeEl?.textContent ?? "", "Copy code"),
        buildFoldButton(wrapper, {
          ariaExpand: "Expand code",
          ariaCollapse: "Collapse code",
        }),
      ],
    });

    // The `<pre>` is the collapsible body the fold cue hides.
    pre.classList.add("tugx-md-chrome-body");

    // Replace the `<pre>` with the wrapper. Insert the wrapper at the
    // `<pre>`'s slot first, then move `<pre>` into it, so the document
    // layout never briefly loses the block.
    pre.replaceWith(wrapper);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);

    // Lezer syntax coloring — the same grammar the Text card editor uses,
    // in the `tug-syn-*` classes tugcast's highlighter shares. Fire-and-
    // forget: the grammar chunk lazy-loads, so we patch the `<code>` on
    // resolve (see `highlightFencedCode` for the prune/re-render guard).
    if (lang !== null && codeEl !== null) highlightFence(codeEl, lang, options);
  }
}

/** How {@link enhanceFencedCode} highlights a fence tugcast did not. */
export interface FenceHighlightOptions {
  /** `"now"`: highlight at once. `"idle-unless-streaming"`: from an idle
   *  callback, and not while `isStreaming()` says the row is live. */
  fenceHighlight: "now" | "idle-unless-streaming";
  /** Whether the fence's row is still streaming, read when the idle
   *  callback runs. */
  isStreaming: () => boolean;
}

/** Marks a fence an idle pass held back because its row was streaming. */
const PENDING_ATTR = "data-tug-highlight-pending";

function highlightFence(codeEl: HTMLElement, lang: string, options: FenceHighlightOptions | undefined): void {
  if (codeEl.hasAttribute("data-tug-highlighted")) return;
  if (options === undefined || options.fenceHighlight === "now") {
    highlightFencedCode(codeEl, lang);
    return;
  }
  codeEl.setAttribute(PENDING_ATTR, "");
  scheduleHighlightWhenSettled(codeEl, lang, options.isStreaming);
}

/**
 * Schedule, for an idle moment, every fence in `container` an idle pass held
 * back because its row was streaming. A row drawn from tugcast's render calls
 * this when its record settles: a block whose hash did not change is never
 * rebuilt, so nothing else would revisit its fence.
 */
export function highlightPendingFences(container: HTMLElement, isStreaming: () => boolean): void {
  for (const codeEl of container.querySelectorAll<HTMLElement>(`code[${PENDING_ATTR}]`)) {
    const lang = readLanguage(codeEl);
    if (lang !== null) scheduleHighlightWhenSettled(codeEl, lang, isStreaming);
  }
}

function scheduleHighlightWhenSettled(codeEl: HTMLElement, lang: string, isStreaming: () => boolean): void {
  const source = codeEl.textContent ?? "";
  whenIdle(() => {
    if (!codeEl.hasAttribute(PENDING_ATTR)) return;
    if (!codeEl.isConnected || codeEl.textContent !== source) return;
    // Still live: stay pending; the row's settle schedules it again.
    if (isStreaming()) return;
    codeEl.removeAttribute(PENDING_ATTR);
    highlightFencedCode(codeEl, lang);
  });
}

/** `requestIdleCallback` where the engine has it, else the next macrotask. */
function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => run());
    return;
  }
  setTimeout(run, 0);
}

/**
 * Syntax-color one fenced `<code>` element's body through the shared
 * Lezer tokenizer, replacing its text with class-per-token spans.
 *
 * Async: the per-language grammar chunk loads lazily, so by the time the
 * HTML is ready the block may have been pruned or re-rendered by the
 * windowing engine. We patch only a still-connected node whose text is
 * byte-identical to what we tokenized — otherwise a stale paint would
 * land over new content (or throw on a detached node). Failure is
 * silent: the plain-text body is a fine fallback.
 *
 * The registry itself imports statically: every markdown-styled editing
 * surface already pulls it into the base chunk, so deferring it here
 * bought no split. The laziness that matters — one chunk per grammar —
 * lives inside the registry's loader table.
 */
function highlightFencedCode(codeEl: HTMLElement, lang: string): void {
  const source = codeEl.textContent ?? "";
  if (source === "") return;
  void highlightFragmentToHtml(source, lang)
    .then((html) => {
      if (html === "") return;
      if (!codeEl.isConnected) return;
      if (codeEl.textContent !== source) return;
      codeEl.innerHTML = html;
    })
    .catch(() => {
      // Highlighting is a polish layer; leave the plain-text body.
    });
}
