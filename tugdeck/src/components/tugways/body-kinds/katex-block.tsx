/**
 * `KaTeXBlock` — Layer-1 body kind for a typeset math expression.
 *
 * Per [D08] KaTeX (not MathJax) is the engine; per [D10] it loads on
 * first encounter. The component is a thin React surface over the
 * shared `renderMathInto` helper that powers the markdown-prose math
 * pipeline ([D07] block-transformer pass + post-`innerHTML`
 * inline-math walker) — keeping one path through KaTeX so a fenced
 * ` ```math ` block and a `<KaTeXBlock>` mount produce visually
 * identical typeset output.
 *
 * Conformance ([#bk-conformance]): scope note — this is a
 * display-only inline block (no identity header, no actions row, no
 * fold affordance). Only items 1–2 and 6–7 apply:
 *  - **Item 1** (text engine): N/A — this block has no editor surface;
 *    the LaTeX source is a prop, never an in-block text-entry.
 *  - **Item 2** (single text-entry surface): satisfied by construction
 *    — the block carries no input UI of its own.
 *  - **Item 6** (tokens): owns `--tugx-katex-*` (declared in both
 *    `ironclad.css` and `sloop.css`); the surface composes
 *    `--tugx-block-*` via the shared `tugx-block.css` family.
 *  - **Item 7** (state preservation): the typeset output is a pure
 *    function of `(source, displayMode)` — no scroll, no collapse, no
 *    component state to preserve across reload.
 *
 * Error handling ([R04]). Any KaTeX parse error is contained to this
 * instance: `renderMathInto` rewrites the element's `textContent`
 * back to the raw source and stamps `data-tugx-math-error="true"` so
 * the CSS can paint a caution surface. The parent block continues
 * rendering; the host can hook the `onError` callback for a toast.
 *
 * Laws:
 *  - [L06] no React state for visual state — KaTeX's render writes
 *    DOM directly; React owns only the mount/effect plumbing.
 *  - [L19] file pair (`.tsx` + `.css`), module docstring, exported
 *    props interface, `data-slot="katex-body"` on the root.
 *  - [L20] component-token sovereignty — owns `--tugx-katex-*`;
 *    consumes `--tugx-block-*` for the shared block scaffold.
 *
 * @module components/tugways/body-kinds/katex-block
 */

import "./katex-block.css";

import React from "react";

import { renderMathInto } from "@/lib/markdown/enhance-math";

/**
 * Props for `KaTeXBlock`. The pair `(source, displayMode)` is the
 * full surface: anything the consumer wants to change about the
 * rendered output is a function of these two values, plus the
 * optional error hook.
 */
export interface KaTeXBlockProps {
  /** LaTeX source. Re-renders when this changes. */
  source: string;
  /**
   * `true` for block-level (`$$...$$`), `false` for inline
   * (`$...$`). Default `false`.
   */
  displayMode?: boolean;
  /**
   * Called once per failed render with KaTeX's error message and the
   * source that produced it. The component already paints a caution
   * surface via `data-tugx-math-error`; this callback lets the host
   * surface a toast or telemetry counter on top.
   */
  onError?: (message: string, source: string) => void;
  /**
   * Forwarded class name. Cascade-scoped customization happens here
   * — consumers tune `--tugx-katex-*` for their instance via a
   * wrapping selector, not by reaching into the primitive's CSS
   * ([L20]).
   */
  className?: string;
}

export const KaTeXBlock: React.FC<KaTeXBlockProps> = ({
  source,
  displayMode = false,
  onError,
  className,
}) => {
  const ref = React.useRef<HTMLElement | null>(null);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    void renderMathInto(el, source, displayMode, { onError });
  }, [source, displayMode, onError]);

  const baseClass = `tugx-katex ${displayMode ? "tugx-katex--display" : "tugx-katex--inline"}`;
  const composed = className === undefined ? baseClass : `${baseClass} ${className}`;

  // The element shape mirrors what the inline-math walker and the
  // mathTransformer-emitted placeholder use, so the KaTeX engine
  // sees the same target whether the math came from prose or from a
  // React mount. Display blocks render as a div (block-level flow);
  // inline expressions render as a span so they sit inline with the
  // surrounding prose.
  return displayMode
    ? <div
        ref={ref as React.RefObject<HTMLDivElement>}
        data-slot="katex-body"
        className={composed}
      />
    : <span
        ref={ref as React.RefObject<HTMLSpanElement>}
        data-slot="katex-body"
        className={composed}
      />;
};
