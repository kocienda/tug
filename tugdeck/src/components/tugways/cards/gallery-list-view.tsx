/**
 * GalleryListView — visual showcase + smoke test for `TugListView`.
 *
 * Mounts a single `TugListView` against a synthetic data source that
 * mixes five cell kinds across ~50 items so every shape the primitive
 * supports is reviewable in isolation:
 *
 *   - "short"             — 40px-estimated single-line plain text.
 *   - "tall"              — 200px-estimated multi-line plain content
 *                           (exercises the windowing and the height
 *                           index across heterogeneous kinds).
 *   - "streaming-text"    — observes a shared `PropertyStore` via
 *                           `useSyncExternalStore`; text grows on a
 *                           setInterval cycle so `ResizeObserver`
 *                           picks up new heights and SmartScroll's
 *                           auto-follow-bottom kicks in.
 *   - "markdown-static"   — `<TugMarkdownBlock initialText={...} />`
 *                           with mock markdown content; renders once
 *                           on mount per [#md-block-api].
 *   - "markdown-streaming"— `<TugMarkdownBlock streamingStore={...}
 *                           streamingPath={...} />` driven by the same
 *                           shared `PropertyStore`; demonstrates the
 *                           per-cell streaming binding pattern the
 *                           transcript's unified `code` cell uses
 *                           ([D06], [L22]).
 *
 * A header bar exposes four data-source mutators — insert at top,
 * insert at bottom, remove last, reset — for live mutation review,
 * plus a "Scroll to bottom" control that drives the inner
 * `TugListView`'s imperative `scrollToBottom()` handle (the same
 * jump-to-latest method the session-card transcript host calls on
 * submit). The list view's `delegate` logs `willDisplay` /
 * `didEndDisplaying` / `onSelect` to the console so the lifecycle
 * model can be observed visually during scroll and click.
 *
 * The data is mock; live transcript wiring is the consumer's concern
 * (Phase B, Steps 9–11). This card validates the primitive against
 * synthetic content end-to-end, in tugdeck's normal card-host
 * lifecycle, before any `CodeSession`-driven code touches it.
 *
 * Laws:
 *  - [L02] data source enters React via `useSyncExternalStore`
 *    (TugListView's contract); the streaming-text cell also uses
 *    `useSyncExternalStore` to bind to the shared `PropertyStore`.
 *  - [L06] no React state for cell content of streaming kinds —
 *    `TugMarkdownBlock` writes the DOM imperatively.
 *  - [L19] gallery-card authoring (module docstring, exported
 *    component, registered in `gallery-registrations.tsx`).
 *  - [L22] streaming cells observe the shared store directly
 *    (markdown-streaming via `TugMarkdownBlock`'s internal observer;
 *    streaming-text via `useSyncExternalStore`).
 *
 * Decisions:
 *  - [D02] single-section flat list — items are heterogeneous via
 *    `kindForIndex`, not via sectioning.
 *  - [D04] item-stable React keys via `dataSource.idForIndex`.
 *  - [D06] streaming cells observe their own source.
 *  - [D07] SmartScroll owns scroll-position writes; `followBottom`
 *    is on so the streaming demo auto-pins (the user can scroll up
 *    to disengage).
 */

import "./gallery.css";

import React from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { PropertyStore } from "@/components/tugways/property-store";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
  type TugListViewDelegate,
  type TugListViewHandle,
} from "@/components/tugways/tug-list-view";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import { TugPushButton } from "@/components/tugways/tug-push-button";

// ---------------------------------------------------------------------------
// Synthetic data source
// ---------------------------------------------------------------------------

/** Streaming `PropertyStore` path for the demo. */
const STREAMING_PATH = "demo-stream";

/** Cycle bounds for the streaming setInterval (200ms × 50 = 10 seconds). */
const STREAM_TICK_MS = 200;
const STREAM_TICKS_PER_CYCLE = 50;

type DemoKind =
  | "short"
  | "tall"
  | "streaming-text"
  | "markdown-static"
  | "markdown-streaming";

interface DemoItem {
  readonly id: string;
  readonly kind: DemoKind;
  /** Per-item text. Unused for streaming kinds (they read from the store). */
  readonly text: string;
}

/** Default heights per kind. Drives the height-index estimates. */
const KIND_HEIGHTS: Record<DemoKind, number> = {
  "short": 40,
  "tall": 200,
  "streaming-text": 60,
  "markdown-static": 140,
  "markdown-streaming": 140,
};

/** Static markdown samples cycled into the markdown-static rows. */
const STATIC_MARKDOWN_SAMPLES: ReadonlyArray<string> = [
  "## Static markdown\n\nA paragraph with **bold** and *italic*.",
  "### Code\n\n```ts\nconst answer = 42;\n```",
  "- List item one\n- List item two\n- List item three",
  "> Block quote with a single line.",
];

/**
 * Synthetic in-memory data source. Holds an `items` array, fires
 * listeners on each mutation, and bumps a numeric `version` token so
 * `useSyncExternalStore` can detect updates per the data-source
 * contract.
 *
 * The mutator methods (`insertAtTop`, `insertAtBottom`, `removeLast`,
 * `reset`) drive the header bar's buttons. Each mutation emits
 * synchronously after updating `items`.
 */
class GalleryListViewDataSource implements TugListViewDataSource {
  private items: DemoItem[];
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private nextInsertedId = 0;

  constructor() {
    this.items = this._buildInitialItems();
  }

  numberOfItems(): number {
    return this.items.length;
  }

  idForIndex(index: number): string {
    return this.items[index].id;
  }

  kindForIndex(index: number): string {
    return this.items[index].kind;
  }

  /** Cell-renderer accessor — reads the full demo item at `index`. */
  itemAt(index: number): DemoItem {
    return this.items[index];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): unknown {
    return this.version;
  }

  insertAtTop(): void {
    this.items = [this._makeInsertedItem(), ...this.items];
    this._emit();
  }

  insertAtBottom(): void {
    this.items = [...this.items, this._makeInsertedItem()];
    this._emit();
  }

  removeLast(): void {
    if (this.items.length === 0) return;
    this.items = this.items.slice(0, -1);
    this._emit();
  }

  reset(): void {
    this.nextInsertedId = 0;
    this.items = this._buildInitialItems();
    this._emit();
  }

  private _emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  private _makeInsertedItem(): DemoItem {
    const id = `inserted-${this.nextInsertedId}`;
    this.nextInsertedId += 1;
    return {
      id,
      kind: "short",
      text: `Inserted row ${id}`,
    };
  }

  private _buildInitialItems(): DemoItem[] {
    // 50 items: mostly "short", with a handful of every other kind
    // sprinkled in so the gallery shows all five shapes without
    // burying them in dozens of identical rows.
    const specials: ReadonlyMap<number, DemoKind> = new Map([
      [3, "tall"],
      [7, "streaming-text"],
      [12, "markdown-static"],
      [18, "markdown-streaming"],
      [24, "tall"],
      [30, "markdown-static"],
      [37, "streaming-text"],
      [42, "tall"],
      [47, "markdown-streaming"],
    ]);
    const items: DemoItem[] = [];
    for (let i = 0; i < 50; i += 1) {
      const kind: DemoKind = specials.get(i) ?? "short";
      const text =
        kind === "markdown-static"
          ? STATIC_MARKDOWN_SAMPLES[i % STATIC_MARKDOWN_SAMPLES.length]
          : `Row ${i} (${kind})`;
      items.push({ id: `seed-${i}`, kind, text });
    }
    return items;
  }
}

// ---------------------------------------------------------------------------
// Cell renderers
// ---------------------------------------------------------------------------

const SHORT_CELL_STYLE: React.CSSProperties = {
  padding: "var(--tug-space-2xs) var(--tug-space-sm)",
  fontFamily: "var(--tug-font-family-mono)",
  fontSize: "var(--tug-font-size-sm)",
  borderRadius: "var(--tug-radius-sm)",
  background: "var(--tug7-surface-global-primary-normal-default-rest)",
  color: "var(--tug7-element-global-text-normal-default-rest)",
};

const TALL_CELL_STYLE: React.CSSProperties = {
  ...SHORT_CELL_STYLE,
  minHeight: 200,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  background: "var(--tug7-surface-global-primary-normal-raised-rest)",
};

const STREAMING_TEXT_CELL_STYLE: React.CSSProperties = {
  ...SHORT_CELL_STYLE,
  background: "var(--tug7-surface-global-primary-normal-sunken-rest)",
  whiteSpace: "pre-wrap",
};

const MARKDOWN_CELL_STYLE: React.CSSProperties = {
  padding: "var(--tug-space-2xs) var(--tug-space-sm)",
  border: "1px solid var(--tug7-element-global-border-normal-default-rest)",
  borderRadius: "var(--tug-radius-sm)",
};

const ShortCell: TugListViewCellRenderer<GalleryListViewDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<GalleryListViewDataSource>) => (
  <div style={SHORT_CELL_STYLE} data-testid="gallery-list-view-short">
    {dataSource.itemAt(index).text}
  </div>
);

const TallCell: TugListViewCellRenderer<GalleryListViewDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<GalleryListViewDataSource>) => {
  const item = dataSource.itemAt(index);
  return (
    <div style={TALL_CELL_STYLE} data-testid="gallery-list-view-tall">
      <strong>{item.text}</strong>
      <div>
        Tall rows exercise the height index against larger cell
        heights so the spacers and overscan stay correct as cells of
        different sizes interleave.
      </div>
    </div>
  );
};

const MarkdownStaticCell: TugListViewCellRenderer<GalleryListViewDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<GalleryListViewDataSource>) => (
  <div style={MARKDOWN_CELL_STYLE} data-testid="gallery-list-view-markdown-static">
    <TugMarkdownBlock initialText={dataSource.itemAt(index).text} />
  </div>
);

/**
 * Cell-renderer factories. The streaming kinds need a closure over
 * the gallery-scoped `PropertyStore`, so they're built inside
 * `GalleryListView` via `React.useMemo` rather than at module scope.
 */
function makeStreamingTextCell(
  streamingStore: PropertyStore,
): TugListViewCellRenderer<GalleryListViewDataSource> {
  return function StreamingTextCell(): React.ReactElement {
    // [L02] external state enters React via `useSyncExternalStore`.
    // For this demo cell we DO want the React render path (small text
    // is cheap to re-render). The markdown-streaming cell uses the
    // [L22] direct-DOM path via `TugMarkdownBlock`'s internal observer.
    const text = useSyncExternalStore(
      (cb) => streamingStore.observe(STREAMING_PATH, cb),
      () => (streamingStore.get(STREAMING_PATH) as string | undefined) ?? "",
    );
    return (
      <div
        style={STREAMING_TEXT_CELL_STYLE}
        data-testid="gallery-list-view-streaming-text"
      >
        {text === "" ? "(streaming…)" : text}
      </div>
    );
  };
}

function makeMarkdownStreamingCell(
  streamingStore: PropertyStore,
): TugListViewCellRenderer<GalleryListViewDataSource> {
  return function MarkdownStreamingCell(): React.ReactElement {
    return (
      <div
        style={MARKDOWN_CELL_STYLE}
        data-testid="gallery-list-view-markdown-streaming"
      >
        <TugMarkdownBlock
          streamingStore={streamingStore}
          streamingPath={STREAMING_PATH}
        />
      </div>
    );
  };
}

// ---------------------------------------------------------------------------
// GalleryListView
// ---------------------------------------------------------------------------

const HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--tug-space-sm)",
  padding: "var(--tug-space-sm) var(--tug-space-md)",
  borderBottom:
    "1px solid var(--tug7-element-global-border-normal-default-rest)",
  flexShrink: 0,
};

const LIST_VIEW_HOST_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: "relative",
};

const DIAGNOSTIC_STYLE: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: "var(--tug-font-size-xs)",
  fontFamily: "var(--tug-font-family-mono)",
  color: "var(--tug7-element-global-text-normal-muted-rest)",
};

export interface GalleryListViewProps {
  /**
   * Optional region-scroll key. When set, the inner `TugListView`
   * stamps `data-tug-scroll-key="<scrollKey>"` on its scroll
   * container, opting the list view into the [A9] region-scroll
   * axis. Used by the region-scroll-anchor app-tests to prove
   * anchor-metadata capture / apply round-trips through the framework.
   */
  scrollKey?: string;

  /**
   * Forwarded to the inner `TugListView`. Set `true` to render
   * every cell (no windowing) — same shape the session-card
   * transcript uses. The region-scroll-anchor app-tests pass this
   * so the inline-rendering path is exercised under fixtures whose
   * cell count and heights are stable.
   */
  inline?: boolean;

  /**
   * Disable the demo streaming-text setInterval that continuously
   * appends to the streaming-cell text. Default `false` (streaming
   * active) preserves the gallery's live-mutation demo. The Phase
   * E.6 app-tests pass `true` so scrollHeight settles after the
   * initial layout pass — required for the settle-detection signal
   * used by anchor-based scroll restore.
   */
  disableStreaming?: boolean;
}

export function GalleryListView(
  { scrollKey, inline, disableStreaming }: GalleryListViewProps = {},
): React.ReactElement {
  // Synthetic data source — instantiated once per mount, mutated via
  // the header buttons. Held in a ref so the same instance survives
  // every render.
  const dataSourceRef = React.useRef<GalleryListViewDataSource | null>(null);
  if (dataSourceRef.current === null) {
    dataSourceRef.current = new GalleryListViewDataSource();
  }
  const dataSource = dataSourceRef.current;

  // Shared streaming store — driven by the setInterval below; read by
  // the streaming-text cell (via `useSyncExternalStore`) and the
  // markdown-streaming cell (via `TugMarkdownBlock`'s internal
  // observer).
  const streamingStoreRef = React.useRef<PropertyStore | null>(null);
  if (streamingStoreRef.current === null) {
    streamingStoreRef.current = new PropertyStore({
      schema: [{ path: STREAMING_PATH, type: "string", label: "Demo stream" }],
      initialValues: { [STREAMING_PATH]: "" },
    });
  }
  const streamingStore = streamingStoreRef.current;

  // Streaming tick — appends a chunk every 200ms, resets after ~10s.
  // Cleared on unmount so a closed gallery card stops emitting.
  // Disabled when `disableStreaming` is set so app-tests that need
  // scrollHeight to settle don't compete with the demo's continuous
  // mutation.
  React.useEffect(() => {
    if (disableStreaming === true) return;
    let accumulated = "";
    let tickIndex = 0;
    const id = setInterval(() => {
      tickIndex += 1;
      if (tickIndex > STREAM_TICKS_PER_CYCLE) {
        accumulated = "";
        tickIndex = 0;
      }
      accumulated += `Chunk ${tickIndex}. `;
      streamingStore.set(STREAMING_PATH, accumulated, "gallery-list-view-tick");
    }, STREAM_TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, [streamingStore, disableStreaming]);

  // Cell renderer dispatch map. Built once per `streamingStore`
  // identity (which is stable for the gallery's lifetime).
  const cellRenderers = React.useMemo<
    Record<string, TugListViewCellRenderer<GalleryListViewDataSource>>
  >(() => {
    return {
      "short": ShortCell,
      "tall": TallCell,
      "streaming-text": makeStreamingTextCell(streamingStore),
      "markdown-static": MarkdownStaticCell,
      "markdown-streaming": makeMarkdownStreamingCell(streamingStore),
    };
  }, [streamingStore]);

  // Delegate — logs lifecycle / selection callbacks to the console
  // for visual inspection during scroll. `estimatedHeightForKind`
  // wires the kind-keyed defaults so unmeasured cells get plausible
  // initial heights before `ResizeObserver` reports their real ones.
  const delegate = React.useMemo<TugListViewDelegate>(
    () => ({
      estimatedHeightForKind: (kind) =>
        KIND_HEIGHTS[kind as DemoKind] ?? 60,
      willDisplay: (index) => {
        // eslint-disable-next-line no-console -- gallery diagnostic.
        console.log(`[gallery-list-view] willDisplay(${index})`);
      },
      didEndDisplaying: (index) => {
        // eslint-disable-next-line no-console -- gallery diagnostic.
        console.log(`[gallery-list-view] didEndDisplaying(${index})`);
      },
      onSelect: (index) => {
        // eslint-disable-next-line no-console -- gallery diagnostic.
        console.log(`[gallery-list-view] onSelect(${index})`);
      },
    }),
    [],
  );

  // Force-rerender on data-source ticks so the diagnostic count
  // tracks live mutations. The list view itself subscribes
  // independently via `useSyncExternalStore`; this hook is for the
  // header bar's read-out.
  const itemCount = useSyncExternalStore(
    (cb) => dataSource.subscribe(cb),
    () => dataSource.numberOfItems(),
  );

  const handleInsertTop = React.useCallback(() => {
    dataSource.insertAtTop();
  }, [dataSource]);

  const handleInsertBottom = React.useCallback(() => {
    dataSource.insertAtBottom();
  }, [dataSource]);

  const handleRemoveLast = React.useCallback(() => {
    dataSource.removeLast();
  }, [dataSource]);

  const handleReset = React.useCallback(() => {
    dataSource.reset();
  }, [dataSource]);

  // Imperative handle to the inner `TugListView`. The "Scroll to
  // bottom" button drives `scrollToBottom()` — the same imperative
  // method the session-card transcript host calls from its submit
  // handler ([D07]). Exposing it as a gallery control lets the
  // app-tests exercise the jump-to-latest gesture against the real
  // primitive (restore-anchor handling, follow-bottom re-engagement,
  // auto-pin) without standing up a full tugcode session.
  const listViewRef = React.useRef<TugListViewHandle | null>(null);
  const handleScrollToBottom = React.useCallback(() => {
    listViewRef.current?.scrollToBottom();
  }, []);

  return (
    <div
      className="cg-content"
      data-testid="gallery-list-view"
      style={{ padding: 0, gap: 0, overflow: "hidden", height: "100%" }}
    >
      <div style={HEADER_STYLE}>
        <TugPushButton
          emphasis="outlined"
          role="action"
          size="sm"
          onClick={handleInsertTop}
          data-testid="gallery-list-view-insert-top"
        >
          Insert top
        </TugPushButton>
        <TugPushButton
          emphasis="outlined"
          role="action"
          size="sm"
          onClick={handleInsertBottom}
          data-testid="gallery-list-view-insert-bottom"
        >
          Insert bottom
        </TugPushButton>
        <TugPushButton
          emphasis="outlined"
          role="action"
          size="sm"
          onClick={handleRemoveLast}
        >
          Remove last
        </TugPushButton>
        <TugPushButton
          emphasis="outlined"
          role="action"
          size="sm"
          onClick={handleReset}
        >
          Reset
        </TugPushButton>
        <TugPushButton
          emphasis="outlined"
          role="action"
          size="sm"
          onClick={handleScrollToBottom}
          data-testid="gallery-list-view-scroll-to-bottom"
        >
          Scroll to bottom
        </TugPushButton>
        <span style={DIAGNOSTIC_STYLE}>{itemCount} items</span>
      </div>
      <div style={LIST_VIEW_HOST_STYLE}>
        <TugListView<GalleryListViewDataSource>
          ref={listViewRef}
          dataSource={dataSource}
          delegate={delegate}
          cellRenderers={cellRenderers}
          followBottom
          scrollKey={scrollKey}
          inline={inline}
        />
      </div>
    </div>
  );
}
