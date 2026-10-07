/**
 * `ImageBlock` — Layer-1 body kind for an inline image with lazy-load
 * + click-to-fullscreen.
 *
 * Per [Spec S02] and [#bk-conformance]'s scope note, ImageBlock is a
 * display-only inline body kind (no identity header, no actions row,
 * no fold affordance — items 1–2 and 6–7 of the conformance contract
 * apply, the rest are explicitly N/A). Three things drive the
 * component's design:
 *
 *  1. **Lazy-load.** The browser's native `loading="lazy"` defers the
 *     fetch until the image scrolls near the viewport — appropriate for
 *     long transcripts where many images may be far off-screen. While
 *     the bytes are still loading, the component paints a placeholder
 *     surface so the row reserves its slot (no layout shift when the
 *     image finishes decoding).
 *  2. **EXIF orientation.** `image-orientation: from-image` is the CSS
 *     opt-in (Safari / Firefox honor it by default; Chrome respects it
 *     when set explicitly). The wrapper sets it so photos with an EXIF
 *     orientation tag rotate correctly without needing a re-encode.
 *  3. **Click-to-fullscreen.** A click on the image opens a full-window
 *     overlay rendered via a portal into the deck root
 *     (`deckRootElement()`), so it scales with View › Zoom. The overlay
 *     dismisses on Escape, on backdrop click, or via the close button.
 *     The portal is the minimum amount of DOM-imperative work needed to
 *     escape the surrounding card's clipping context — anything less
 *     would clip the fullscreen view.
 *
 * Markdown delegation (`atoms-attachments.md`): `TugMarkdownBlock`
 * already routes images through `enhanceImg`, an imperative DOM walker
 * that finds every `<img>` in the rendered markdown and applies the
 * same lazy-load + click-to-fullscreen treatment. The React component
 * is for callers (tool blocks, gallery cards) that mount an image
 * directly without going through markdown. The two paths share zero
 * code by design — the imperative path can't host React, and the React
 * path doesn't want to fight the markdown render's existing DOM —
 * but they converge on the same affordances.
 *
 * Failed loads paint a small caution-toned `<figcaption>`-style row
 * with the (alt-text-or-URL) so a broken image doesn't render as a
 * blank rectangle.
 *
 * Conformance ([#bk-conformance]):
 *  - **Item 1** (text engine) — N/A; no editor surface.
 *  - **Item 2** (single text-entry surface) — satisfied by construction;
 *    no input UI.
 *  - **Item 3-5** — N/A per the scope note (display-only inline block).
 *  - **Item 6** (tokens) — owns `--tugx-image-*`; composes
 *    `--tugx-block-*` for the shared block scaffold.
 *  - **Item 7** (state preservation) — the rendered output is a pure
 *    function of `src`; the fullscreen overlay is local DOM state that
 *    doesn't need to survive reload.
 *
 * Laws:
 *  - [L02] no external state subscriptions — the open/closed flag is
 *    local component data, not a card-store value.
 *  - [L06] appearance via DOM / CSS — the placeholder vs loaded vs
 *    error states flow through `data-tugx-image-status` attribute
 *    swaps, not via React state for visuals beyond the open/closed
 *    boolean.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="image-body"` on the root.
 *  - [L20] component-token sovereignty — owns the `--tugx-image-*`
 *    slot family; consumes `--tugx-block-*` for the shared scaffold.
 *
 * Decisions:
 *  - [D05] body kind — wrappers compose around (Layer 2); this is the
 *    primitive (Layer 1).
 *
 * @module components/tugways/body-kinds/image-block
 */

import "./image-block.css";

import React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { deckRootElement } from "@/lib/page-zoom-store";
import { isCancelChordEvent } from "@/components/tugways/keymap-registry";

/**
 * Lifecycle status for the embedded `<img>`. Driven imperatively
 * via the load/error handlers; rendered as the
 * `data-tugx-image-status` attribute so CSS can paint the
 * placeholder vs loaded vs error state without re-mounting.
 */
export type ImageBlockStatus = "loading" | "loaded" | "error";

/**
 * How the image is sized in the space its host gives it. Absent — the value
 * every transcript and gallery caller wants — leaves the block's natural
 * inline sizing alone; a viewer card passes the reader's choice.
 */
export type ImageBlockFit = "fit" | "fill" | "actual";

/**
 * What is painted behind the image. `"frame"` is the block's own scaffold
 * tone, the inline default; the other three are the grounds a reader picks
 * when the question is what the alpha channel is hiding.
 */
export type ImageBlockGround = "frame" | "checker" | "surface" | "black" | "white";

export interface ImageBlockProps {
  /** Image source URL. Reset between renders triggers a fresh load. */
  src: string;
  /**
   * How the image is sized. Defaults to `"fit"`, which is the inline
   * behaviour this block always had: scaled down to the available width,
   * never up past its natural size.
   */
  fit?: ImageBlockFit;
  /** What is painted behind the image. Defaults to the block's own frame. */
  ground?: ImageBlockGround;
  /**
   * Smooth interpolation when the image is drawn at other than its natural
   * size. `false` selects nearest-neighbour (`image-rendering: pixelated`),
   * which is what icon and pixel-art work needs. Defaults to `true`.
   */
  smoothing?: boolean;
  /**
   * What the bytes turned out to be, reported once per successful load. The
   * `<img>` is the only thing that knows an image's natural size, so a host
   * that wants to say it has to be told ([D05]: the block reports, the host
   * decides what to do with it) — the same shape `PdfView.onDocumentInfo`
   * uses for a document's page count.
   */
  onNaturalSize?: (size: { width: number; height: number }) => void;
  /**
   * Accessible alt text. Used as both the `<img>` alt attribute and
   * the fallback caption when load fails. Defaults to empty string
   * (decorative).
   */
  alt?: string;
  /** Forwarded class name for cascade-scoped customization. */
  className?: string;
  /**
   * Disable the click-to-fullscreen affordance — useful for fixtures
   * or hosts that don't want to open a modal on click. Defaults to
   * `false` (fullscreen enabled).
   */
  fullscreenDisabled?: boolean;
}

/**
 * Compose the caption text shown beneath a failed-load image. Prefers
 * the alt text; falls back to the URL when alt is empty / whitespace.
 * Pure and exported for tests.
 */
export function composeImageErrorCaption(
  src: string,
  alt: string | undefined,
): string {
  if (alt !== undefined && alt.trim().length > 0) return alt;
  return src;
}

export const ImageBlock: React.FC<ImageBlockProps> = ({
  src,
  alt = "",
  className,
  fullscreenDisabled = false,
  fit = "fit",
  ground = "frame",
  smoothing = true,
  onNaturalSize,
}) => {
  const [status, setStatus] = React.useState<ImageBlockStatus>("loading");
  const [overlayOpen, setOverlayOpen] = React.useState(false);

  // Reset status whenever the source changes — a new src means a new
  // load cycle and we shouldn't carry a previous "error" forward.
  React.useEffect(() => {
    setStatus("loading");
  }, [src]);

  // Escape closes the overlay. Bound only while the overlay is open
  // so the listener doesn't fire during normal page reads.
  React.useEffect(() => {
    if (!overlayOpen) return;
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" || isCancelChordEvent(e)) setOverlayOpen(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
  }, [overlayOpen]);

  // Read through a ref at report time ([L07]): a fresh callback identity from
  // the host must not re-run anything about the load.
  const onNaturalSizeRef = React.useRef(onNaturalSize);
  onNaturalSizeRef.current = onNaturalSize;

  const onLoad = React.useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    setStatus("loaded");
    const img = event.currentTarget;
    onNaturalSizeRef.current?.({
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  }, []);
  const onError = React.useCallback(() => setStatus("error"), []);

  const onClick = React.useCallback(() => {
    if (fullscreenDisabled || status !== "loaded") return;
    setOverlayOpen(true);
  }, [fullscreenDisabled, status]);

  const onOverlayBackdropClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only dismiss on a backdrop click — not on a click that
      // bubbled up from the image or the close button.
      if (e.target === e.currentTarget) setOverlayOpen(false);
    },
    [],
  );

  const onOverlayCloseClick = React.useCallback(() => {
    setOverlayOpen(false);
  }, []);

  return (
    <figure
      data-slot="image-body"
      data-tugx-image-status={status}
      data-tugx-image-fit={fit}
      data-tugx-image-ground={ground}
      data-tugx-image-smoothing={smoothing ? "on" : "off"}
      className={cn("tugx-image", className)}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={onLoad}
        onError={onError}
        onClick={onClick}
        className="tugx-image-img"
        data-clickable={fullscreenDisabled || status !== "loaded" ? undefined : "true"}
      />
      {status === "loading" ? (
        <span
          className="tugx-image-placeholder"
          data-slot="image-placeholder"
          aria-hidden="true"
        />
      ) : null}
      {status === "error" ? (
        <figcaption className="tugx-image-error" data-slot="image-error">
          {composeImageErrorCaption(src, alt)}
        </figcaption>
      ) : null}
      {overlayOpen
        ? createPortal(
            <div
              className="tugx-image-overlay"
              data-slot="image-overlay"
              data-tugx-image-smoothing={smoothing ? "on" : "off"}
              role="dialog"
              aria-modal="true"
              aria-label={alt.length > 0 ? alt : "Image preview"}
              onClick={onOverlayBackdropClick}
            >
              <button
                type="button"
                className="tugx-image-overlay-close"
                onClick={onOverlayCloseClick}
                aria-label="Close image preview"
              >
                <X size={20} aria-hidden="true" />
              </button>
              <img
                src={src}
                alt={alt}
                className="tugx-image-overlay-img"
              />
            </div>,
            deckRootElement(),
          )
        : null}
    </figure>
  );
};
