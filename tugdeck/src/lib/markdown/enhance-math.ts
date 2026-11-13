/**
 * `enhance-math.ts` — post-`innerHTML` math typesetter for markdown
 * blocks. Companion of {@link enhanceFencedCode}; called from
 * {@link renderIncremental} immediately after a block element's
 * content has been written.
 *
 * **Two passes per block.**
 *
 *  1. {@link walkInlineMath} promotes `$...$` and `$$...$$` text
 *     ranges into pending `.tugx-katex` placeholder spans. The
 *     transformer-emitted display placeholders (` ```math ` fences
 *     promoted to `<div class="tugx-katex">`) are already in the DOM.
 *
 *  2. {@link enhanceMath} walks every pending placeholder, reads the
 *     LaTeX source out of `el.textContent`, and asks the lazy KaTeX
 *     engine to render into the element. If KaTeX hasn't loaded yet,
 *     the first call kicks off the load; subsequent calls (within
 *     the same paint frame for streaming) share the same promise.
 *
 * **Failure mode** (per [R04]). Any KaTeX parse error keeps the
 * placeholder element on the page with its raw LaTeX source visible
 * (the fallback content the transformer / walker already put there)
 * and stamps `data-tugx-math-error="true"` for CSS styling. The
 * parent block is not torn down — the error is contained to the
 * offending placeholder. A toast surface is left to the caller via
 * the optional `onError` callback so the markdown primitive doesn't
 * have to know about toast plumbing.
 *
 * **Idempotency.** Each placeholder carries
 * `data-tugx-math-pending="true"` until rendered; after a successful
 * render the attribute is removed and `data-tugx-math-rendered="true"`
 * is set, so a re-enhance pass on the same DOM (e.g. after an
 * unrelated incremental update) is a no-op for already-typeset
 * placeholders. Streaming updates rewrite the parent's `innerHTML`,
 * which removes every placeholder; the next enhance pass starts
 * fresh.
 *
 * @module lib/markdown/enhance-math
 */

import {
  getKaTeXSync,
  loadKaTeX,
  type KaTeXEngine,
} from "@/lib/lazy/load-katex";

import { walkInlineMath } from "./block-transformers/inline-math-walker";
import { trackEnhancement } from "./pending-enhancements";

/** Selector for pending KaTeX placeholders (both inline + display). */
const PENDING_SELECTOR = '.tugx-katex[data-tugx-math-pending="true"]';

/**
 * Render one placeholder element via the supplied engine. The
 * placeholder's existing `textContent` is the LaTeX source; on
 * success KaTeX rewrites the element's inner DOM. On failure the
 * raw source survives (we restore it explicitly because KaTeX may
 * have written partial content before throwing) and an
 * `data-tugx-math-error` flag is set for CSS surfacing.
 */
function renderPlaceholder(
  el: HTMLElement,
  engine: KaTeXEngine,
  onError?: (message: string, source: string) => void,
): void {
  // Read the source before any KaTeX write — successful renders
  // replace the inner DOM, and any failure path needs the original
  // text to restore.
  const source = el.textContent ?? "";
  const displayMode = el.dataset.tugxMath === "display";
  try {
    engine.render(source, el, {
      displayMode,
      throwOnError: true,
    });
    delete el.dataset.tugxMathPending;
    el.dataset.tugxMathRendered = "true";
  } catch (err) {
    el.textContent = source;
    delete el.dataset.tugxMathPending;
    el.dataset.tugxMathError = "true";
    if (onError !== undefined) {
      const message = err instanceof Error ? err.message : String(err);
      onError(message, source);
    }
  }
}

/**
 * Optional knobs for {@link enhanceMath}. Kept tiny on purpose —
 * heavier configuration belongs on the caller surface, not here.
 */
export interface EnhanceMathOptions {
  /** Invoked once per failing placeholder, after fallback content
   *  has been restored. The markdown primitives ignore the callback
   *  by default; surfaces that want a toast supply one. */
  onError?: (message: string, source: string) => void;
}

/**
 * Walk `container` for unfenced `$...$` / `$$...$$` text, then
 * typeset every pending KaTeX placeholder in the subtree. Lazy-loads
 * KaTeX on first encounter; subsequent calls within the same session
 * use the cached engine and render synchronously.
 *
 * Returns the {@link Promise} the lazy load resolves to so callers
 * that need to await first-paint can. Callers that don't care can
 * fire-and-forget.
 */
export function enhanceMath(
  container: HTMLElement,
  options?: EnhanceMathOptions,
): Promise<void> {
  walkInlineMath(container);

  // Snapshot pending placeholders before the engine load so the
  // post-load query doesn't pick up an unrelated re-render that
  // happened while we were awaiting.
  const pending = Array.from(
    container.querySelectorAll<HTMLElement>(PENDING_SELECTOR),
  );
  if (pending.length === 0) return Promise.resolve();

  const sync = getKaTeXSync();
  if (sync !== null) {
    for (const el of pending) renderPlaceholder(el, sync, options?.onError);
    return Promise.resolve();
  }

  return trackEnhancement(loadKaTeX()).then(
    (engine) => {
      // Re-query: by the time the promise resolves the DOM may have
      // been mutated again (a fresh streaming delta wiping out our
      // earlier placeholders). The snapshot is still safe to walk
      // — any detached element is harmless to render into — but
      // re-querying picks up new placeholders the original snapshot
      // missed.
      const live = Array.from(
        container.querySelectorAll<HTMLElement>(PENDING_SELECTOR),
      );
      for (const el of live) renderPlaceholder(el, engine, options?.onError);
    },
    () => {
      // Load failed — leave the pending placeholders alone so the
      // raw LaTeX source remains visible as the fallback.
    },
  );
}

/**
 * Render exactly one element through the lazy engine. Used by the
 * `KaTeXBlock` React body kind so it doesn't duplicate the
 * load + render plumbing of {@link enhanceMath}. Returns a promise
 * that resolves once the element has been typeset (or had its
 * error path taken).
 */
export function renderMathInto(
  el: HTMLElement,
  source: string,
  displayMode: boolean,
  options?: EnhanceMathOptions,
): Promise<void> {
  // Stamp the source as fallback text and the metadata that
  // `renderPlaceholder` reads. Idempotent — repeat calls overwrite.
  el.classList.add("tugx-katex");
  el.classList.add(displayMode ? "tugx-katex--display" : "tugx-katex--inline");
  el.dataset.tugxMath = displayMode ? "display" : "inline";
  el.dataset.tugxMathPending = "true";
  delete el.dataset.tugxMathRendered;
  delete el.dataset.tugxMathError;
  el.textContent = source;

  const sync = getKaTeXSync();
  if (sync !== null) {
    renderPlaceholder(el, sync, options?.onError);
    return Promise.resolve();
  }
  return trackEnhancement(loadKaTeX()).then(
    (engine) => {
      // The element may have been detached between scheduling and
      // resolution; rendering into a detached node is harmless.
      if (el.dataset.tugxMathPending === "true") {
        renderPlaceholder(el, engine, options?.onError);
      }
    },
    () => {
      // Loader failed — leave the raw LaTeX visible.
    },
  );
}
