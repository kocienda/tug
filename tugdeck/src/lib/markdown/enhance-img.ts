/**
 * `enhanceImg` — DOM-walks a markdown block container after its
 * `innerHTML` is set, finds every `<img>` produced by
 * pulldown-cmark / DOMPurify, and applies the project's
 * inline-image affordances:
 *
 *  1. `loading="lazy"` (browser-native lazy-load — defers the fetch
 *     until the image scrolls near the viewport).
 *  2. `decoding="async"` so decode doesn't block paint.
 *  3. `cursor: zoom-in` + a click handler that opens a portal-mounted
 *     fullscreen overlay (a thin imperative twin of the `ImageBlock`
 *     React component's overlay — it can't host React inside the
 *     imperative-DOM markdown pipeline, but the affordance is
 *     identical and dismisses on Escape / backdrop click).
 *
 * Why this lives outside `parseMarkdownToSanitizedBlocks`:
 *  - The click handler must be a live element with an event listener,
 *    not a string spliced into HTML.
 *  - Both `TugMarkdownBlock` (per-cell renderer) and `TugMarkdownView`
 *    (windowed renderer) call this from the same code path right
 *    after they assign `innerHTML`, so the enhancement is invariant
 *    across both primitives.
 *
 * Idempotent: an `<img>` already marked with
 * `data-tugx-img-enhanced="true"` is skipped on re-walks.
 *
 * No listener cleanup is needed — when a parent block element is
 * replaced (the same `el.innerHTML = ...` write, or the windowing
 * engine's prune step), the images and their listeners are detached
 * and garbage-collected together.
 *
 * Laws: [L06] appearance via DOM, not React state. The overlay's
 *       open/closed visual flows through `display:flex` / removal of
 *       the overlay element from the deck root, not via a render.
 *
 * @module lib/markdown/enhance-img
 */

import { isCancelChordEvent } from "@/components/tugways/keymap-registry";
import { deckRootElement } from "@/lib/page-zoom-store";

const ENHANCED_ATTR = "data-tugx-img-enhanced";

/**
 * Walk every `<img>` in `container` and apply the inline-image
 * affordances described in the module docstring. Skips images that
 * have already been enhanced.
 */
export function enhanceImg(container: HTMLElement): void {
  const images = container.querySelectorAll<HTMLImageElement>(
    `img:not([${ENHANCED_ATTR}])`,
  );
  for (const img of images) {
    img.setAttribute(ENHANCED_ATTR, "true");
    // Browser-native lazy-load + async decode. Already-set attributes
    // are honored (e.g. an `<img loading="eager">` written by a host
    // that wants eager loading stays eager).
    if (!img.hasAttribute("loading")) {
      img.setAttribute("loading", "lazy");
    }
    if (!img.hasAttribute("decoding")) {
      img.setAttribute("decoding", "async");
    }
    img.classList.add("tugx-md-img");
    img.addEventListener("click", openImgOverlay);
  }
}

/**
 * Click handler — opens a portal-style fullscreen overlay built
 * imperatively under `document.body`. The overlay:
 *  - paints a high-contrast scrim so the image foregrounds against
 *    the page,
 *  - dismisses on Escape / backdrop click / close-button click,
 *  - removes itself from the DOM on dismiss (no leaked nodes).
 *
 * Exported for tests.
 */
export function openImgOverlay(event: Event): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLImageElement)) return;
  const src = target.currentSrc !== "" ? target.currentSrc : target.src;
  const alt = target.alt;
  buildOverlay(src, alt);
}

function buildOverlay(src: string, alt: string): void {
  const overlay = document.createElement("div");
  overlay.className = "tugx-md-img-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute(
    "aria-label",
    alt.length > 0 ? alt : "Image preview",
  );

  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" || isCancelChordEvent(e)) close();
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "tugx-md-img-overlay-close";
  button.setAttribute("aria-label", "Close image preview");
  button.textContent = "×";
  button.addEventListener("click", close);

  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  img.className = "tugx-md-img-overlay-img";

  overlay.appendChild(button);
  overlay.appendChild(img);
  // Inside the deck root, so it scales with View › Zoom and its `fixed`
  // inset covers the deck's box rather than the bare window.
  deckRootElement().appendChild(overlay);
}
