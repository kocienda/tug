/**
 * The share page: a page the host loads in a hidden view to render shared
 * turns, or one figure, to a file, and nothing else.
 *
 * It loads as `/?share=<id>`. It has no connection, joins no bus, and reads
 * nothing from tugcast: everything it draws arrives in one host message, so
 * it can show nothing the requester did not put in the document, and it
 * needs nothing of the session's ledger. The boot:
 *
 *  1. the stylesheets and the markdown WASM, as a body page loads them;
 *  2. `onShareDocument` claimed, then `shareHello { id }` posted;
 *  3. on the document — when its `id` is this page's — decode it, apply its
 *     theme by name, build a connectionless `CodeSessionStore` and a
 *     `SessionMetadataStore` over an inert frame channel, seed the store with
 *     the turns, and mount once ([L01]);
 *  4. wait for what a reader would see to have landed, then post
 *     `shareRenderReady { id, width, height }` with the document's full size;
 *  5. for a PDF, answer the host's `onShareHtmlRequest` with
 *     `shareRenderHtml { id, html }`: the page as inline-styled HTML
 *     (`share-html.ts`), the rich flavour a PDF's Copy writes.
 *
 * **A figure document is one figure and no transcript.** It mounts no store
 * and no React root: `renderChartInto` draws the spec as a picture, which is
 * the card's own renderer, so the image has the card's faces, theme and
 * layout by construction. The column's 720 pixels are not the figure's: the
 * page takes the width the figure drew at, with a margin on the block's
 * ground, and reports it. A figure that does not draw posts nothing, as a
 * document that does not decode does. The host's HTML request is answered
 * empty, since a picture has no rich-text flavour.
 *
 * **What the cells defer past their first commit.** A `TugMarkdownBlock`
 * renders its seeded text synchronously in its layout effect — the G1 pass,
 * which runs inside the mount's commit — and coalesces only *later* text
 * changes through a frame, which a seeded store never makes. Four passes do
 * outlive the commit: a fenced block's syntax colouring, whose grammar chunk
 * loads lazily, math, whose KaTeX engine does, a chart or diagram, in prose
 * or under a tool block, whose graphics engine does, and a diff computed
 * from two texts, whose diff engine does. Each registers its
 * promise with `lib/markdown/pending-enhancements`, and readiness awaits
 * `enhancementsSettled()` — their own completion — then each font face the
 * laid-out page asked for, loaded by name, under one horizon that bounds
 * the wait and is not expected to be met (`facesLoaded`).
 * Nothing here waits on `requestAnimationFrame`, which WebKit suspends while
 * the window is covered: the host's one render deadline bounds everything,
 * and a readiness gated on a frame could stall until it fired. The
 * idle-scheduled fence colouring is only for rows drawn from tugcast's own
 * render, which this page never has.
 *
 * A document that does not decode posts nothing, and the host's deadline
 * answers the render `failed`. A cell that throws here reaches `tugapp.log`
 * through the page-fault forwarder the host injects into every page it makes.
 *
 * Nothing here imports `main.tsx` or `body-main.ts`: `entry.ts` loads this
 * module for `?share=`.
 *
 * @module share/share-main
 */

import "../css-imports";
import "../../styles/tugx-md.css";
import "../components/tugways/cards/session-card.css";
import "./share-page.css";

import React from "react";
import { createRoot } from "react-dom/client";
import initTugmark from "../../crates/tugmark-wasm/pkg/tugmark_wasm.js";
import wasmUrl from "../../crates/tugmark-wasm/pkg/tugmark_wasm_bg.wasm?url";
import type { TugConnection } from "../connection";
import { applyTheme, followShellTheme, getOnScreenTheme } from "../contexts/theme-provider";
import { installHostChannel, onHostMessage, postToHost } from "../host/channel";
import {
  shareDocumentToPage,
  shareHelloToHost,
  shareHtmlRequestToPage,
  shareRenderHtmlToHost,
  shareRenderReadyToHost,
} from "../host/declarations/services";
import { ToolBlockExpansionState } from "../components/tugways/blocks/expansion-state";
import { CHART_STATE_ATTR, renderChartInto } from "../lib/chart/render-chart";
import { CodeSessionStore } from "../lib/code-session-store";
import { TestFrameChannel } from "../lib/code-session-store/testing/mock-feed-store";
import { ConnectionLifecycle } from "../lib/connection-lifecycle";
import { FeedStore } from "../lib/feed-store";
import { flushSync, installGestureScope } from "../lib/gesture-scope";
import { enhancementsSettled } from "../lib/markdown/pending-enhancements";
import { SessionMetadataStore } from "../lib/session-metadata-store";
import {
  decodeShareDocument,
  shareExpansionOverrides,
  type ShareFigureDocument,
  type ShareRenderDocument,
} from "../lib/share-turns";
import { FeedId } from "../protocol";
import { RunOfferStore } from "../lib/run-offer-store";
import { styledHtml } from "./share-html";
import { ShareRoot } from "./share-root";

const shareId = new URLSearchParams(window.location.search).get("share") ?? "";

installGestureScope(window);
// The theme is the requester's, put on screen here as a body puts the
// shell's: this page never sends the window's canvas colour or writes the
// global theme.
followShellTheme();
installHostChannel();
document.documentElement.setAttribute("data-share-page", "");

let rendered = false;

/** Build the inert stores, seed them, and mount the page once. */
function mount(doc: ShareRenderDocument): void {
  const channel = new TestFrameChannel();
  const conn = channel as unknown as TugConnection;
  const codeSessionStore = new CodeSessionStore({
    conn,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: `share:${shareId}`,
    sessionMode: "new",
    offWire: true,
  });
  // The model the turns were answered by reaches the cells as a live card's
  // does: one `system_metadata` frame on the session's sideband feed.
  const feed = new FeedStore(conn, [FeedId.SESSION_SIDEBAND]);
  const sessionMetadataStore = new SessionMetadataStore(feed, FeedId.SESSION_SIDEBAND);
  if (doc.modelName !== null) {
    channel.dispatchFrame(
      FeedId.SESSION_SIDEBAND,
      new TextEncoder().encode(JSON.stringify({ type: "system_metadata", model: doc.modelName })),
    );
  }
  codeSessionStore.seedStaticTranscript(doc.turns);

  const expansion = new ToolBlockExpansionState();
  expansion.seed({ overrides: shareExpansionOverrides(doc.turns, doc.toolMode) });
  const turnNumbers = new Map<string, number>();
  doc.turns.forEach((turn, i) => turnNumbers.set(turn.turnKey, doc.turnNumbers[i]!));
  // The card's runs, as they were when the share was made, so each offer
  // draws its result under it.
  const offerRuns = new RunOfferStore();
  offerRuns.seed(doc.offerRuns);

  const container = document.getElementById("deck-container") ?? document.body;
  const root = createRoot(container);
  // Committed before this returns, so the cells' layout effects — the
  // markdown's first render among them — have run when readiness is read.
  flushSync(() => {
    root.render(
      React.createElement(ShareRoot, {
        header: doc.header,
        codeSessionStore,
        sessionMetadataStore,
        expansion,
        turnNumbers,
        offerRuns,
      }),
    );
  });
}

/**
 * Draw one figure as a picture, in the deck root. Resolves `false` when the
 * figure did not draw: the spec was refused, or the engine or its text
 * measurement was not to be had.
 */
async function mountFigure(doc: ShareFigureDocument): Promise<boolean> {
  // The page's ground and margin are the figure's, not the column's; CSS
  // reads this attribute ([L06]).
  document.documentElement.setAttribute("data-share-figure", "");
  const container = document.getElementById("deck-container") ?? document.body;
  const figure = document.createElement("div");
  container.appendChild(figure);
  await renderChartInto(figure, doc.source, { layers: doc.layers, picture: true });
  return figure.getAttribute(CHART_STATE_ATTR) === "rendered";
}

/**
 * The bound on the wait for font faces, from the page's layout. It is not
 * the wait: every face is asked for by name and answers in tens of
 * milliseconds. Under the render's own deadline; never a frame.
 */
const FACE_HORIZON_MS = 2000;

/**
 * Resolve once every font face the laid-out page asked for has loaded, or
 * failed (which draws the fallback a live card draws too). Reading the
 * height lays the page out, which is what marks a face `loading`.
 *
 * **Each face is loaded by name, never only awaited.** The page's first
 * layout runs before its Latin faces have arrived, so every character falls
 * through the family stack to the CJK subsets whose `unicode-range` covers
 * ASCII, and WebKit marks those subsets `loading`. It opens no request for
 * them: the Latin faces land a few milliseconds later and draw the text, the
 * subsets are never fetched, and their `loaded` promises never settle, nor
 * the set's `ready`. A wait on `loaded` alone therefore ran to the horizon
 * on every render. `load()` on a face in that state opens the request, and
 * the same promise then settles. Read 2026-11-17 on a page of Latin text:
 * 31 faces `loading` at layout, the 5 Latin ones loaded within 50 ms, the 26
 * JP and KR subsets unchanged 300 ms on with no request open, and all 26
 * loaded 30–46 ms after `load()`.
 */
async function facesLoaded(): Promise<void> {
  void document.documentElement.scrollHeight;
  const loading: Promise<unknown>[] = [];
  document.fonts.forEach((face) => {
    if (face.status === "loading") loading.push(face.load().catch(() => undefined));
  });
  if (loading.length === 0) return;
  let horizon: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(loading),
    new Promise<void>((resolve) => {
      horizon = setTimeout(resolve, FACE_HORIZON_MS);
    }),
  ]);
  clearTimeout(horizon);
}

async function render(json: string): Promise<void> {
  const decoded = decodeShareDocument(json);
  if (decoded === null) {
    // Said where the host's log hears it; the deadline answers the render.
    console.error("share page: the document does not decode");
    return;
  }
  const doc = decoded.document;
  if (doc.theme !== "" && doc.theme !== getOnScreenTheme()) await applyTheme(doc.theme);
  if (decoded.kind === "figure") {
    if (!(await mountFigure(decoded.document))) {
      console.error("share page: the figure did not draw");
      return;
    }
  } else {
    mount(decoded.document);
    await enhancementsSettled();
  }
  await facesLoaded();
  // The content's own size: `scrollHeight` never reads less than the view's
  // viewport, which the host sized before it knew the content. The deck root
  // is the column for turns and the figure with its margin for a figure, so
  // its width is the document's; the root element's would be the viewport's.
  const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
  const root = document.getElementById("deck-container") ?? document.body;
  const width = Math.ceil(root.getBoundingClientRect().width);
  postToHost(shareRenderReadyToHost, { id: shareId, width, height });
}

(async () => {
  await initTugmark(wasmUrl);
  onHostMessage(shareDocumentToPage, ({ id, document: json }) => {
    if (id !== shareId || rendered) return;
    rendered = true;
    render(json).catch((err: unknown) => {
      // A cell that throws is a fault the host's log names; the deadline
      // answers the render.
      console.error(`share page: the render failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    });
  });
  onHostMessage(shareHtmlRequestToPage, ({ id }) => {
    if (id !== shareId) return;
    const root = document.querySelector<HTMLElement>("main.share-page");
    postToHost(shareRenderHtmlToHost, { id: shareId, html: root === null ? "" : styledHtml(root) });
  });
  postToHost(shareHelloToHost, { id: shareId });
})();
