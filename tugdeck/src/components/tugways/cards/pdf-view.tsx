/**
 * pdf-view.tsx — the viewer card's PDF surface, rendered by pdf.js.
 *
 * WebKit's built-in PDF plugin renders well but exposes no control surface:
 * it takes no DOM focus, fires no key or context-menu events, and ignores
 * `#page=` / `#zoom=` open parameters. A card that cannot take focus is an
 * outlier in a keyboard-first deck, so the deck renders PDFs itself.
 *
 * Bytes come from `/api/fs/blob`, the same route the image branch uses;
 * pdf.js fetches by URL and the route's `206` support is what its ranged
 * reads want.
 *
 * Only the pages the viewport can see are mounted, so a long document costs
 * a screenful of canvases rather than one per page. That is safe because the
 * geometry is exact: `pdf-layout` computes every page's box from the size the
 * document states, so the scroll extent is right before anything has
 * rendered and nothing shifts under the reader as canvases fill in.
 *
 * The surface is a responder and declares itself the card's primary focus
 * target, which is what puts it on the first-responder walk when the card
 * activates. Its keys are registered bindings rather than a `keydown`
 * listener, so the chain arbitrates them. Only the navigation keys are
 * bound — arrows, PageUp/Down, Home/End — and the deck binds those nowhere
 * else, so the surface takes a chord away from nothing.
 *
 * The page modes deliberately have **no** chord. Preview puts them on ⌘1-3,
 * which the deck already spends on `move-to-slot`; a chain-scoped binding
 * could shadow that while a PDF held focus, but a viewer is not the place to
 * redefine a deck-wide navigation command. The context menu is their door,
 * and it shows each command's live chord rather than an authored string.
 *
 * Zoom additionally answers the host's View menu, and that part is not a
 * choice. ⌘+ / ⌘- / ⌘0 are AppKit key equivalents, resolved before the web
 * view receives a keydown — a deck-side binding for those chords can never
 * fire, and there is no `preventDefault` to reach. The surface publishes a
 * `menuState.document` block claiming them, and the host routes its zoom
 * commands into the deck while the claim stands. That is what makes the zoom
 * scale the document rather than the whole app.
 *
 * Laws:
 *  - [L03] the responder and its keybindings register in layout effects — a
 *    key can arrive on the tick after mount.
 *  - [L06] load / error appearance rides `data-pdf-view-status` and
 *    `data-pdf-page-status` rather than a swapped tree.
 *  - [L11] keys and menu items become typed actions the surface's responder
 *    handles; nothing is wired through callback props.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot` on the root.
 *  - [L20] the surface owns the `--tugx-pdf-*` token family.
 *  - [L23] the mode and zoom the reader chose ride the card's bag, so a
 *    reload restores the document as they left it.
 *
 * @module components/tugways/cards/pdf-view
 */

import "./pdf-text-layer.css";
import "./pdf-view.css";

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { blobUrl } from "@/lib/file-kinds";
import {
  clearDocumentMenuState,
  publishDocumentMenuState,
} from "@/lib/host-menu-state";
import {
  destroyPdfDocument,
  loadPdfDocument,
  loadPdfRuntime,
  type PdfDocument,
  type PdfRuntime,
} from "@/lib/pdf-runtime";
import {
  clampScale,
  fitScale,
  layoutSpread,
  pageAnchorAt,
  PDF_SPACING,
  scrollTopForPageAnchor,
  spreadIndexOfPage,
  spreadsFor,
  steppedScale,
  visiblePages,
  type PdfLayout,
  type PdfPageAnchor,
  type PdfPageBox,
  type PdfPageMode,
  type PdfPageSize,
} from "@/lib/pdf-layout";
import {
  PRESERVE_SCROLLER_ATTR,
  RESIZE_PRESERVE_BEGIN,
  RESIZE_PRESERVE_END,
} from "@/lib/resize-episode";
import { usePageZoom } from "@/lib/page-zoom-store";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import { Check } from "lucide-react";
import {
  TugContextMenu,
  type TugContextMenuEntry,
} from "@/components/tugways/tug-context-menu";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { commandShortcut, keymapRegistry } from "@/components/tugways/keymap-registry";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { useKeybindings } from "@/components/tugways/use-keybindings";
import { useResponder } from "@/components/tugways/use-responder";

/** Lifecycle of the document load, painted through the DOM ([L06]). */
export type PdfViewStatus = "loading" | "ready" | "error";

/**
 * The zoom the reader chose: an explicit scale, or a fit that recomputes as
 * the card resizes. A fit is a *choice*, not a scale, which is why it
 * survives a resize rather than freezing at whatever it measured once.
 */
export type PdfZoom = number | "fit-width" | "fit-page";

/** What the surface remembers across a reload, carried in the card's bag. */
export interface PdfViewState {
  pageMode: PdfPageMode;
  zoom: PdfZoom;
}

export const PDF_VIEW_DEFAULT_STATE: PdfViewState = {
  pageMode: "continuous",
  zoom: "fit-width",
};

export interface PdfViewProps {
  /** Absolute path of the PDF, resolved to bytes through the blob route. */
  path: string;
  /** The hosting card, so the surface can claim the host's zoom commands. */
  cardId: string;
  /** Mode and zoom to open with — the card's restored bag, or the default. */
  initialState?: PdfViewState;
  /** Mirrors mode and zoom back to the card so the bag can persist them. */
  onStateChange?: (state: PdfViewState) => void;
  /**
   * Pixels between adjacent pages, and around the content box. A reader's
   * preference rather than a reading position, so it arrives as a prop and
   * changes under an open document rather than only at open time. Defaults to
   * the surface's own spacing.
   */
  pageGap?: number;
  /**
   * Render pages inverted while a DARK theme is in force — dark paper, light
   * ink. The prop carries only the PREFERENCE; whether a dark theme is
   * actually in force is `<html data-theme-mode>`, which the stylesheet reads
   * directly ([L06]), so a theme switch re-paints without this surface
   * subscribing to anything.
   */
  invertInDark?: boolean;
  /**
   * What the loaded document turned out to be. Reported once per binding,
   * after the document resolves — the card's masthead says how many pages it
   * is holding, and this surface is the only thing that knows.
   */
  onDocumentInfo?: (info: { pages: number }) => void;
}

/** Pages kept mounted beyond the viewport, so a scroll lands on drawn ink. */
const RENDER_MARGIN_PX = 400;

/** How far an arrow key moves a continuously-scrolled document. */
const LINE_STEP_PX = 60;

/** An empty layout — the shape the surface holds before a document loads. */
const NO_LAYOUT: PdfLayout = { boxes: [], width: 0, height: 0 };

/** How far a scroller can still travel before it is against its stop. */
const EDGE_SLACK_PX = 2;

/**
 * One page: a canvas at device resolution with pdf.js's text layer over it.
 * Mounting is what triggers the render, so the windowing above decides what
 * gets drawn simply by deciding what exists.
 */
function PdfPageView({
  runtime,
  document: doc,
  box,
  scale,
}: {
  runtime: PdfRuntime;
  document: PdfDocument;
  box: PdfPageBox;
  scale: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [rendered, setRendered] = useState(false);
  // View › Zoom scales the deck root by a transform, which presents this
  // canvas at the factor without moving `devicePixelRatio`; the backing store
  // is drawn at the product so a 200 % page is not upsampled soft. Read
  // through the store ([L02]) so a zoom step re-renders the page.
  const zoomFactor = usePageZoom().factor;

  useEffect(() => {
    let cancelled = false;
    // pdf.js refuses to start a second render on a canvas that is still
    // drawing, so an outstanding task must be cancelled rather than merely
    // ignored: the effect re-runs on every zoom change, and the initial
    // fit-to-width measurement guarantees at least one such re-run.
    let task: { cancel: () => void } | null = null;
    setRendered(false);

    void (async () => {
      try {
        const page = await doc.getPage(box.page);
        if (cancelled) return;
        const canvas = canvasRef.current;
        const textContainer = textRef.current;
        if (canvas === null || textContainer === null) return;

        // The canvas is drawn at device resolution and displayed at CSS size,
        // so text stays crisp on a Retina display without the layout knowing
        // anything about pixel ratios. Device resolution is the display's
        // scale times the zoom the root's transform applies.
        const dpr = (window.devicePixelRatio || 1) * zoomFactor;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.round(viewport.width * dpr);
        canvas.height = Math.round(viewport.height * dpr);

        const render = page.render({
          canvas,
          viewport: page.getViewport({ scale: scale * dpr }),
        });
        task = render;
        await render.promise;
        task = null;
        if (cancelled) return;

        // pdf.js positions each text run from this custom property; without
        // it every span lands at the origin.
        textContainer.style.setProperty("--total-scale-factor", String(scale));
        textContainer.replaceChildren();
        const textLayer = new runtime.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textContainer,
          viewport,
        });
        await textLayer.render();
        if (cancelled) return;
        setRendered(true);
      } catch (error) {
        // A superseded render rejects by design; only a real failure is news.
        if (cancelled) return;
        tugDevLogStore.error(
          "pdf-view",
          `page render failed: ${String(error)}`,
          {
            page: box.page,
          },
        );
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [runtime, doc, box.page, scale, zoomFactor]);

  return (
    <div
      className="pdf-view-page"
      data-slot="pdf-page"
      data-pdf-page={box.page}
      data-pdf-page-status={rendered ? "rendered" : "drawing"}
      style={{
        left: `${box.x}px`,
        top: `${box.y}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      }}
    >
      <canvas ref={canvasRef} className="pdf-view-canvas" />
      <div ref={textRef} className="textLayer" />
    </div>
  );
}

/** Narrow the `scroll-document` payload, which arrives as `unknown` ([L11]). */
function coerceScrollRequest(value: unknown): {
  axis: "horizontal" | "vertical";
  amount: "line" | "page" | "document";
  direction: -1 | 1;
} | null {
  if (value === null || typeof value !== "object") return null;
  const { axis, amount, direction } = value as Record<string, unknown>;
  if (axis !== "horizontal" && axis !== "vertical") return null;
  if (amount !== "line" && amount !== "page" && amount !== "document") {
    return null;
  }
  if (direction !== -1 && direction !== 1) return null;
  return { axis, amount, direction };
}

/** Narrow the `set-page-mode` payload. */
function coercePageMode(value: unknown): PdfPageMode | null {
  return value === "continuous" || value === "single" || value === "two"
    ? value
    : null;
}

export function PdfView({
  path,
  cardId,
  initialState,
  onStateChange,
  onDocumentInfo,
  pageGap,
  invertInDark = false,
}: PdfViewProps) {
  // The spacing every layout call reads. Memoized because it is an argument to
  // pure layout functions on every render, and a fresh object each time would
  // defeat nothing here but would invite a `useMemo` downstream to lie.
  const spacing = useMemo(
    () =>
      pageGap === undefined
        ? PDF_SPACING
        : { gap: pageGap, padding: PDF_SPACING.padding },
    [pageGap],
  );
  // Read through a ref at report time [L07]: the load effect is keyed on the
  // path, and a fresh callback identity must not re-fetch the document.
  const onDocumentInfoRef = useRef(onDocumentInfo);
  onDocumentInfoRef.current = onDocumentInfo;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [runtime, setRuntime] = useState<PdfRuntime | null>(null);
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [pageSizes, setPageSizes] = useState<readonly PdfPageSize[]>([]);
  const [status, setStatus] = useState<PdfViewStatus>("loading");
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [pageMode, setPageMode] = useState<PdfPageMode>(
    initialState?.pageMode ?? PDF_VIEW_DEFAULT_STATE.pageMode,
  );
  const [zoom, setZoom] = useState<PdfZoom>(
    initialState?.zoom ?? PDF_VIEW_DEFAULT_STATE.zoom,
  );
  const [spreadIndex, setSpreadIndex] = useState(0);

  // The menu's zoom hints read the keymap registry at render time, so it is
  // a subscription ([L02]) — a live rebind repaints the hints.
  useSyncExternalStore(keymapRegistry.subscribe, keymapRegistry.getSnapshot, () => 0);

  const responderId = useId();

  // ---- Document load ----

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocument | null = null;

    setStatus("loading");
    setDocument(null);
    setPageSizes([]);

    void (async () => {
      try {
        const [pdfjs, doc] = await Promise.all([
          loadPdfRuntime(),
          loadPdfDocument(blobUrl(path)),
        ]);
        loaded = doc;
        if (cancelled) return;

        // Every page's real size, read once. This is what lets the layout be
        // exact rather than estimated, so it is worth the round trip.
        const sizes = await Promise.all(
          Array.from({ length: doc.numPages }, async (_, i) => {
            const { width, height } = (await doc.getPage(i + 1)).getViewport({
              scale: 1,
            });
            return { width, height };
          }),
        );
        if (cancelled) return;

        setRuntime(pdfjs);
        setDocument(doc);
        setPageSizes(sizes);
        setStatus("ready");
        onDocumentInfoRef.current?.({ pages: doc.numPages });
      } catch (error) {
        tugDevLogStore.error("pdf-view", `load failed: ${String(error)}`, {
          path,
        });
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      if (loaded !== null) destroyPdfDocument(loaded);
    };
  }, [path]);

  // ---- The host's zoom commands ----
  //
  // AppKit resolves View ▸ Zoom In / Zoom Out / Actual Size before the web
  // view sees a keydown, so ⌘+ / ⌘- / ⌘0 cannot be claimed by a deck-side
  // keybinding at all. Publishing this block is how the surface tells the
  // host to route those commands into the deck while it is frontmost, which
  // is what makes the zoom scoped to the document rather than the whole app.

  useEffect(() => {
    publishDocumentMenuState(cardId, { cardId });
    return () => {
      clearDocumentMenuState(cardId);
    };
  }, [cardId]);

  // ---- Viewport and scroll tracking ----

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const observer = new ResizeObserver(() => {
      setViewport({
        width: scroller.clientWidth,
        height: scroller.clientHeight,
      });
    });
    observer.observe(scroller);
    setViewport({ width: scroller.clientWidth, height: scroller.clientHeight });
    return () => {
      observer.disconnect();
    };
  }, []);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller !== null) setScrollTop(scroller.scrollTop);
  }, []);

  // ---- Layout ----

  const spreads = spreadsFor(pageSizes.length, pageMode);
  const currentSpread =
    spreads[Math.min(spreadIndex, spreads.length - 1)] ?? [];
  const scale =
    typeof zoom === "number"
      ? clampScale(zoom)
      : viewport.width > 0
        ? fitScale(
            pageSizes,
            currentSpread,
            pageMode,
            viewport,
            zoom === "fit-width" ? "width" : "page",
            spacing,
          )
        : 1;
  const layout =
    currentSpread.length === 0
      ? NO_LAYOUT
      : layoutSpread(pageSizes, currentSpread, pageMode, scale, spacing);
  const mounted =
    viewport.height > 0
      ? visiblePages(layout, scrollTop, viewport.height, RENDER_MARGIN_PX)
      : layout.boxes.slice(0, 1).map((box) => box.page);

  // ---- Holding the reader's place across a card width change ----
  //
  // The generic element anchor the resize episode offers is wrong here. Every
  // number in this layout comes from a scale, and under `fit-width` the scale
  // is the card's width: narrowing the card renders every page smaller, so a
  // page's top edge is not a fixed point and holding one puts the reader
  // somewhere else on it. The page and the fraction of the way down it are
  // what survive, so this scroller claims the episode and answers in those.
  const layoutRef = useRef<PdfLayout>(layout);
  const pageAnchorRef = useRef<PdfPageAnchor | null>(null);

  const relandPageAnchor = useCallback(() => {
    const anchor = pageAnchorRef.current;
    const scroller = scrollerRef.current;
    if (anchor === null || scroller === null) return;
    const next = scrollTopForPageAnchor(layoutRef.current, anchor);
    if (next === null) return;
    if (Math.abs(scroller.scrollTop - next) > 0.5) {
      scroller.scrollTop = next;
      setScrollTop(next);
    }
  }, []);

  // [L03] the listeners must exist before any gesture can raise an episode.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    scroller.setAttribute(PRESERVE_SCROLLER_ATTR, "");
    const onPreserveBegin = (event: Event): void => {
      const anchor = pageAnchorAt(layoutRef.current, scroller.scrollTop);
      if (anchor === null) return;
      event.preventDefault();
      pageAnchorRef.current = anchor;
    };
    const onPreserveEnd = (): void => {
      relandPageAnchor();
      pageAnchorRef.current = null;
    };
    scroller.addEventListener(RESIZE_PRESERVE_BEGIN, onPreserveBegin);
    scroller.addEventListener(RESIZE_PRESERVE_END, onPreserveEnd);
    return () => {
      scroller.removeEventListener(RESIZE_PRESERVE_BEGIN, onPreserveBegin);
      scroller.removeEventListener(RESIZE_PRESERVE_END, onPreserveEnd);
      scroller.removeAttribute(PRESERVE_SCROLLER_ATTR);
    };
  }, [relandPageAnchor]);

  // The layout is derived per render, so the ref is how the listeners above
  // read the CURRENT one at fire time ([L07]); re-landing here is what makes
  // the anchor track each intermediate scale rather than snapping at the end.
  useLayoutEffect(() => {
    layoutRef.current = layout;
    relandPageAnchor();
  });

  // ---- Mode, zoom, and navigation ----

  const publish = useCallback(
    (next: PdfViewState) => {
      onStateChange?.(next);
    },
    [onStateChange],
  );

  /** The page at the top of the viewport — what a mode change keeps in view. */
  const topPage = (): number => {
    const box = layout.boxes.find((b) => b.y + b.height > scrollTop);
    return box?.page ?? currentSpread[0] ?? 1;
  };

  const applyPageMode = useCallback(
    (next: PdfPageMode) => {
      const anchor = topPage();
      setPageMode(next);
      setSpreadIndex(spreadIndexOfPage(anchor, pageSizes.length, next));
      if (scrollerRef.current !== null) scrollerRef.current.scrollTop = 0;
      publish({ pageMode: next, zoom });
    },
    // `topPage` closes over the current layout, which is what makes the
    // anchor correct; the deps below are what change that layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- these are what change the layout `topPage` reads, per the note above
    [layout, scrollTop, pageSizes.length, zoom, publish],
  );

  const applyZoom = useCallback(
    (next: PdfZoom) => {
      setZoom(next);
      publish({ pageMode, zoom: next });
    },
    [pageMode, publish],
  );

  const turnSpread = useCallback(
    (direction: -1 | 1) => {
      setSpreadIndex((index) =>
        Math.min(spreads.length - 1, Math.max(0, index + direction)),
      );
      if (scrollerRef.current !== null) scrollerRef.current.scrollTop = 0;
    },
    [spreads.length],
  );

  const scrollDocument = useCallback(
    (event: ActionEvent) => {
      const request = coerceScrollRequest(event.value);
      const scroller = scrollerRef.current;
      if (request === null || scroller === null) return;
      const { axis, amount, direction } = request;

      if (axis === "horizontal" && pageMode === "continuous") {
        scroller.scrollLeft +=
          direction * (amount === "line" ? LINE_STEP_PX : scroller.clientWidth);
        return;
      }

      if (pageMode === "continuous") {
        if (amount === "document") {
          scroller.scrollTop = direction === 1 ? scroller.scrollHeight : 0;
          return;
        }
        scroller.scrollTop +=
          direction *
          (amount === "line" ? LINE_STEP_PX : scroller.clientHeight);
        return;
      }

      // Paged: Home and End are the document's ends, and the other keys turn
      // the page — but only once the page in view has been read to its edge,
      // so a page taller than the card can still be scrolled through.
      if (amount === "document") {
        setSpreadIndex(direction === 1 ? spreads.length - 1 : 0);
        scroller.scrollTop = 0;
        return;
      }
      const room =
        direction === 1
          ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
          : scroller.scrollTop;
      if (axis === "vertical" && amount === "line" && room > EDGE_SLACK_PX) {
        scroller.scrollTop += direction * LINE_STEP_PX;
        return;
      }
      turnSpread(direction);
    },
    [pageMode, spreads.length, turnSpread],
  );

  const { ResponderScope, responderRef } = useResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.SCROLL_DOCUMENT]: scrollDocument,
      [TUG_ACTIONS.SET_PAGE_MODE]: (event: ActionEvent) => {
        const mode = coercePageMode(event.value);
        if (mode !== null) applyPageMode(mode);
      },
      [TUG_ACTIONS.ZOOM_IN]: () => applyZoom(steppedScale(scale, 1)),
      [TUG_ACTIONS.ZOOM_OUT]: () => applyZoom(steppedScale(scale, -1)),
      [TUG_ACTIONS.ZOOM_ACTUAL]: () => applyZoom(1),
      [TUG_ACTIONS.ZOOM_TO_FIT]: (event: ActionEvent) => {
        applyZoom(event.value === "width" ? "fit-width" : "fit-page");
      },
    },
  });

  // Registered rather than listened for, so the chain arbitrates them. These
  // are navigation keys the deck binds nowhere else; the surface consumes
  // them only while it is on the first-responder walk.
  //
  // Neither the page modes nor the zoom carry a chord here. The modes would
  // have to take ⌘1-3 from `move-to-slot`, and a viewer is not the place to
  // redefine a deck-wide navigation command. Zoom already has its chords, on
  // the commands the host's View menu drives.
  //
  // That second sentence used to end "and they never reach the web view at
  // all" — a shadowing analysis maintained by hand, in a comment, about a
  // chord declared somewhere else. `resolveChord` answers it now: ask it
  // about ⌘+ and it reports the native layer taking the chord above every JS
  // one, and the collision lint fails a binding that tried anyway.
  useKeybindings([
    scrollBinding("ArrowDown", "vertical", "line", 1),
    scrollBinding("ArrowUp", "vertical", "line", -1),
    scrollBinding("ArrowRight", "horizontal", "line", 1),
    scrollBinding("ArrowLeft", "horizontal", "line", -1),
    scrollBinding("PageDown", "vertical", "page", 1),
    scrollBinding("PageUp", "vertical", "page", -1),
    scrollBinding("End", "vertical", "document", 1),
    scrollBinding("Home", "vertical", "document", -1),
  ]);

  // The control surface the reader can reach with the mouse. Its items
  // dispatch the same actions the keys do, so the menu is a second door onto
  // one implementation rather than a parallel command path ([L11]). The
  // active mode and zoom are marked with the item's existing `icon` slot —
  // where a checkmark belongs, and where Preview puts it.
  const menuItems: TugContextMenuEntry<string>[] = [
    modeItem("continuous", "Continuous Scroll", pageMode),
    modeItem("single", "Single Page", pageMode),
    modeItem("two", "Two Pages", pageMode),
    { type: "separator" },
    // The chords come from the keymap, not from this file. They are the
    // host's View menu items in the shipped app — AppKit resolves them before
    // the web view sees a keydown — and both sides are swept from the same
    // registry entries, so a hint here and the menu bar cannot name different
    // gestures ([P11]).
    {
      action: TUG_ACTIONS.ZOOM_IN,
      label: "Zoom In",
      shortcut: commandShortcut(TUG_ACTIONS.ZOOM_IN),
    },
    {
      action: TUG_ACTIONS.ZOOM_OUT,
      label: "Zoom Out",
      shortcut: commandShortcut(TUG_ACTIONS.ZOOM_OUT),
    },
    {
      action: TUG_ACTIONS.ZOOM_ACTUAL,
      label: "Actual Size",
      shortcut: commandShortcut(TUG_ACTIONS.ZOOM_ACTUAL),
      icon: check(zoom === 1),
    },
    {
      action: TUG_ACTIONS.ZOOM_TO_FIT,
      value: "width",
      label: "Fit Width",
      icon: check(zoom === "fit-width"),
    },
    {
      action: TUG_ACTIONS.ZOOM_TO_FIT,
      value: "page",
      label: "Fit Page",
      icon: check(zoom === "fit-page"),
    },
  ];

  return (
    <ResponderScope>
      <TugContextMenu items={menuItems}>
        <div
          ref={(node) => {
            scrollerRef.current = node;
            responderRef(node);
          }}
          className="pdf-view"
          data-slot="file-view-pdf"
          data-pdf-view-status={status}
          data-pdf-page-mode={pageMode}
          data-pdf-zoom={typeof zoom === "number" ? zoom.toFixed(2) : zoom}
          data-pdf-invert-in-dark={invertInDark ? "on" : "off"}
          data-tug-focus-key="primary"
          onScroll={onScroll}
        >
          <div
            className="pdf-view-content"
            style={{ width: `${layout.width}px`, height: `${layout.height}px` }}
          >
            {runtime !== null && document !== null
              ? layout.boxes
                  .filter((box) => mounted.includes(box.page))
                  .map((box) => (
                    <PdfPageView
                      key={box.page}
                      runtime={runtime}
                      document={document}
                      box={box}
                      scale={scale}
                    />
                  ))
              : null}
          </div>
        </div>
      </TugContextMenu>
    </ResponderScope>
  );
}

/** The checkmark that marks an active choice, or nothing ([P04]). */
function check(active: boolean): React.ReactNode {
  return active ? <Check size={14} aria-hidden="true" /> : undefined;
}

/**
 * One page-mode row, marked when it is the mode in force. No `shortcut`: the
 * modes have no chord, and a hint for a key that does nothing is worse than
 * no hint.
 */
function modeItem(
  mode: PdfPageMode,
  label: string,
  active: PdfPageMode,
): TugContextMenuEntry<string> {
  return {
    action: TUG_ACTIONS.SET_PAGE_MODE,
    value: mode,
    label,
    icon: check(mode === active),
  };
}

/** One navigation key, as a binding carrying its distance and direction. */
function scrollBinding(
  key: string,
  axis: "horizontal" | "vertical",
  amount: "line" | "page" | "document",
  direction: -1 | 1,
) {
  return {
    key,
    action: TUG_ACTIONS.SCROLL_DOCUMENT,
    value: { axis, amount, direction },
  };
}
