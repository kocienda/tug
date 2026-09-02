/**
 * file-view-card.tsx — the read-only viewer card body.
 *
 * One card renders every viewable file kind; the body branches on
 * `classifyFileKind` of its bound path. A future kind is a branch here, not a
 * new card: one registry entry, one seed shape (`{ path }`), one open-registry
 * story, one Cards card filter.
 *
 * The card is strictly read-only. It keeps no dirty state, registers no save
 * plumbing, and publishes no `menuState.file` block — which is why the native
 * File menu's Save / Save As… / Revert to Saved validate disabled while a
 * viewer is frontmost, with no Swift-side change.
 *
 * The bytes come from tugcast's `/api/fs/blob`, which streams them, so the
 * card points an `<img>` at a URL rather than holding content in memory.
 *
 * Laws:
 *  - [L02] the bound path is card state (the persisted bag), and the open
 *    registry is an external module store read through its own subscribe.
 *  - [L03] the open-registry registration lives in `useLayoutEffect` — an
 *    `open-file` for the same path can arrive before a passive effect commits.
 *  - [L06] load / error appearance rides `ImageBlock`'s
 *    `data-tugx-image-status` attribute, never React state for visuals.
 *  - [L20] the card styles its own frame only; `--tugx-image-*` belongs to
 *    `ImageBlock` and is never overridden here.
 *
 * @module components/tugways/cards/file-view-card
 */

import "./file-view-card.css";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { classifyFileKind, blobUrl } from "@/lib/file-kinds";
import { formatByteSize } from "@/lib/image-card-settings";
import { useImageCardSettings } from "@/lib/use-image-card-settings";
import { usePdfCardSettings } from "@/lib/use-pdf-card-settings";
import { openingZoomToPdfZoom } from "@/lib/pdf-card-settings";
import { useTugSheet } from "@/components/tugways/tug-sheet";
import { presentCardSettingsSheet } from "./card-settings-sheet";
import { cardTitleStore } from "@/lib/card-title-store";
import { paneTitleBarItemsStore } from "@/lib/pane-title-bar-items-store";
import { openPathInOS } from "@/lib/os-open";
import { useResponder } from "@/components/tugways/use-responder";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import {
  notifyOpenFileViewCardsChanged,
  registerOpenFileViewCard,
  unregisterOpenFileViewCard,
} from "@/lib/file-view-open-registry";
import { TugLabel } from "@/components/tugways/tug-label";
import { ImageBlock } from "@/components/tugways/body-kinds/image-block";
import { PdfView, type PdfViewState } from "@/components/tugways/cards/pdf-view";
import { useCardStatePreservation } from "@/components/tugways/use-card-state-preservation";

/**
 * The viewer card's persistence payload: the file it is bound to, plus how
 * the PDF surface was left. Reopening a document at page one and 100% when
 * the reader had it fitted and half way down is exactly the state loss [L23]
 * exists to prevent.
 */
export interface FileViewCardBagContent {
  path: string;
  view?: PdfViewState;
}

/** Narrow an unknown restored bag payload. */
function coerceBagContent(state: unknown): FileViewCardBagContent | null {
  if (state === null || typeof state !== "object") return null;
  const record = state as Record<string, unknown>;
  if (typeof record.path !== "string" || record.path.length === 0) return null;
  const view = coerceViewState(record.view);
  return view === null ? { path: record.path } : { path: record.path, view };
}

/** Narrow the restored PDF view state; anything unrecognized is the default. */
function coerceViewState(value: unknown): PdfViewState | null {
  if (value === null || typeof value !== "object") return null;
  const { pageMode, zoom } = value as Record<string, unknown>;
  if (pageMode !== "continuous" && pageMode !== "single" && pageMode !== "two") {
    return null;
  }
  const validZoom =
    zoom === "fit-width" ||
    zoom === "fit-page" ||
    (typeof zoom === "number" && Number.isFinite(zoom));
  return validZoom ? { pageMode, zoom: zoom as PdfViewState["zoom"] } : null;
}

/** The final path segment — the card's display name. */
function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * The masthead's third line: what kind of document this is, in the words a
 * reader would use.
 *
 * `classifyFileKind` answers with a coarse `FileKind` — the three branches
 * the card body switches on — and "image" is not what a reader calls a PNG.
 * So the extension supplies the name and the classification supplies the
 * category, which is why this is composed here rather than asked of the
 * classifier. A PDF also says how long it is, once the surface has told the
 * card ([Q03] leaves image dimensions and byte size to a follow-on; the line
 * takes them without changing shape when they arrive).
 */
function fileKindLabel(path: string, pdfPages: number | null): string {
  const kind = classifyFileKind(path);
  if (kind === "pdf") {
    return pdfPages === null
      ? "PDF"
      : `PDF · ${pdfPages} ${pdfPages === 1 ? "page" : "pages"}`;
  }
  const dot = basename(path).lastIndexOf(".");
  const ext = dot <= 0 ? null : basename(path).slice(dot + 1).toUpperCase();
  if (kind === "image") return ext === null ? "Image" : `${ext} image`;
  return ext ?? "File";
}

/**
 * The strip under an image: what it measures, what kind it is, and what it
 * weighs on disk. Every line is a fact about the FILE rather than about the
 * view, which is why it says nothing about the current scaling — a reader who
 * wants to know how big something really is turns this on and reads the
 * numbers, and the numbers must not move when the card is resized.
 *
 * A fact the card does not have yet is simply absent: dimensions arrive when
 * the image decodes and the byte count when the HEAD lands, and a placeholder
 * for either would be a resting lie for the moment it stood.
 */
function ImageInfoStrip({
  path,
  naturalSize,
  byteSize,
}: {
  path: string;
  naturalSize: { width: number; height: number } | null;
  byteSize: number | null;
}) {
  const parts: string[] = [];
  if (naturalSize !== null) {
    parts.push(`${naturalSize.width} × ${naturalSize.height}`);
  }
  parts.push(fileKindLabel(path, null));
  if (byteSize !== null) parts.push(formatByteSize(byteSize));

  return (
    <TugLabel
      size="sm"
      className="file-view-card-info"
      data-slot="file-view-card-info"
      data-testid="file-view-card-info"
    >
      {parts.join("  ·  ")}
    </TugLabel>
  );
}

export function FileViewCardContent({ cardId }: { cardId: string }) {
  const [path, setPath] = useState<string | null>(null);
  const [view, setView] = useState<PdfViewState | undefined>(undefined);
  // What the bytes turned out to be — the natural size the `<img>` reports and
  // the byte count the blob route's headers carry. Both are what the info
  // strip says, and neither is knowable before the file is read.
  const [naturalSize, setNaturalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [byteSize, setByteSize] = useState<number | null>(null);
  // The gear's sheet. `renderSheet()` is mounted once in the card body, the
  // same arrangement the Text card uses for its save decisions.
  const { showSheet, renderSheet } = useTugSheet();
  // How many pages the bound PDF turned out to have; null until the surface
  // reports, and for every non-PDF kind.
  const [pdfPages, setPdfPages] = useState<number | null>(null);
  // The surface mounts fresh per document, so its opening state is read once
  // per binding; a live prop would fight the reader's own zoom.
  const restoredViewRef = useRef<PdfViewState | undefined>(undefined);
  // The registry's `getPath` reads live at call time ([L07]), so it reads a
  // ref rather than the render-time value.
  const pathRef = useRef<string | null>(null);

  // ---- Card state preservation (the bound path) ----
  //
  // `onSave` reads the current path, so a rebind through the registry's
  // `openFile` persists by construction: Maker ▸ Reload and a cold boot both
  // re-resume the file the card is actually showing, not the one it opened
  // with ([L23]).
  useCardStatePreservation<FileViewCardBagContent | undefined>({
    onSave: () =>
      path === null ? undefined : view === undefined ? { path } : { path, view },
    onRestore: (state) => {
      const content = coerceBagContent(state);
      if (content === null) return;
      restoredViewRef.current = content.view;
      setView(content.view);
      setPath(content.path);
    },
  });

  // ---- open-file reuse registry ----

  useLayoutEffect(() => {
    registerOpenFileViewCard(cardId, {
      getPath: () => pathRef.current,
      openFile: (next) => {
        // A different document arrives at the default view, not the last
        // one's zoom.
        restoredViewRef.current = undefined;
        setView(undefined);
        // A different document has a different length; the old count would be
        // a resting lie on the masthead until the new one loaded. The same is
        // true of the previous file's dimensions and byte count.
        setPdfPages(null);
        setNaturalSize(null);
        setByteSize(null);
        setPath(next);
      },
    });
    return () => {
      unregisterOpenFileViewCard(cardId);
    };
  }, [cardId]);

  // A fresh card binds its path AFTER mount (the seed restores), so registry
  // consumers that project the card — the Cards card Files list — must re-read when
  // the binding lands, not only when the card registers.
  useLayoutEffect(() => {
    pathRef.current = path;
    notifyOpenFileViewCardsChanged();
  }, [path]);

  // ---- View settings ----
  //
  // Both kinds' settings are read on every viewer card, not only the kind the
  // card is currently showing. They are two `useTugbankValue` subscriptions
  // each ([L02]) and nothing else, and a card rebinds from a PNG to a PDF
  // through `openFile` without remounting — reading them conditionally would
  // mean a hook order that changes with the file on screen, which React
  // forbids outright.
  const image = useImageCardSettings(cardId);
  const pdf = usePdfCardSettings(cardId);

  // The file's size on disk, for the image info strip. A HEAD against the same
  // blob route the `<img>` is already pointed at: the response carries
  // `content-length`, so this costs a header exchange rather than a second
  // copy of the bytes. Only asked when the strip is actually shown — a reader
  // who never turns it on never pays for it.
  const kindNow = path === null ? null : classifyFileKind(path);
  const wantsByteSize = kindNow === "image" && image.settings.showInfo;
  useEffect(() => {
    if (path === null || !wantsByteSize) return;
    let cancelled = false;
    void fetch(blobUrl(path), { method: "HEAD" })
      .then((response) => {
        const header = response.headers.get("content-length");
        const parsed = header === null ? NaN : Number.parseInt(header, 10);
        if (!cancelled && Number.isFinite(parsed)) setByteSize(parsed);
      })
      .catch(() => {
        // A size we could not read is a line the strip simply does not print;
        // there is nothing to report to the reader about a header.
      });
    return () => {
      cancelled = true;
    };
  }, [path, wantsByteSize]);

  // ---- Title + masthead sync (pane chrome) ----
  //
  // Published from the moment the card HAS a path, not when the bytes land: a
  // tier that appeared once the image decoded would grow the chrome under a
  // reader who is already looking at the card. Until then the card holds no
  // document at all and is not a document card, so the pre-bind state still
  // clears.
  //
  // The string and the payload go out in one `set` — the tab bar and the
  // Window menu read the string, the pane renders the payload, and two calls
  // would race the store's equality guard into notifying twice. Teardown is a
  // separate effect below, keyed on the card alone: a `clear` in this
  // effect's cleanup would run before every re-publish (a PDF reporting its
  // page count, a rebind) and notify unconditionally, defeating that guard.
  useLayoutEffect(() => {
    if (path === null) {
      cardTitleStore.clear(cardId);
      return;
    }
    const name = basename(path);
    cardTitleStore.set(cardId, name, {
      kind: "card-masthead",
      icon: classifyFileKind(path) === "image" ? "Image" : "FileText",
      title: name,
      description: path,
      descriptionKind: "path",
      detail: fileKindLabel(path, pdfPages),
    });
  }, [cardId, path, pdfPages]);

  // The card's two verbs, each a standing button in the pane's title bar:
  // reveal the file, and open this card's own view settings. Both wear the
  // glyphs the Text card wears for the same commands — one gesture, one
  // glyph, wherever it appears. Membership is the card's; each control's
  // label, its enablement, and any chord are the command table's ([L30]).
  //
  // The gear appears only for a kind that HAS settings. A file the card can
  // name but not display has nothing to configure, and a gear that opened an
  // empty sheet would be a door onto a room with nothing in it.
  const settableKind = kindNow === "image" || kindNow === "pdf";
  useLayoutEffect(() => {
    if (path === null) {
      paneTitleBarItemsStore.set(cardId, null);
      return;
    }
    paneTitleBarItemsStore.set(cardId, [
      {
        commandId: TUG_ACTIONS.REVEAL_CARD_FILE,
        presentation: "button",
        icon: "FolderOpenDot",
      },
      ...(settableKind
        ? [
            {
              commandId: TUG_ACTIONS.SHOW_CARD_SETTINGS,
              presentation: "button" as const,
              icon: "Settings",
            },
          ]
        : []),
    ]);
  }, [cardId, path, settableKind]);

  // What this card published to the pane goes away with the card, and only
  // then ([L27]) — one teardown for both channels.
  useLayoutEffect(
    () => () => {
      cardTitleStore.clear(cardId);
      paneTitleBarItemsStore.set(cardId, null);
    },
    [cardId],
  );

  // Where the title bar's buttons land. Key-card routed, so a press arrives
  // here however focus happens to sit.
  const {
    ResponderScope: CardContentResponderScope,
    responderRef: cardContentResponderRef,
  } = useResponder({
    id: `${cardId}-card-content`,
    kind: "card-content",
    actions: {
      [TUG_ACTIONS.REVEAL_CARD_FILE]: () => {
        const live = pathRef.current;
        if (live !== null) openPathInOS(live, "reveal");
      },
      // Which sheet is the card's answer, not the command's: one gear
      // command, and the card showing the document is the only thing that
      // knows whether that document is pixels or pages. Read live from the
      // ref ([L07]) — a rebind through `openFile` must not leave this handler
      // opening the previous file's sheet.
      [TUG_ACTIONS.SHOW_CARD_SETTINGS]: () => {
        const live = pathRef.current;
        if (live === null) return;
        const liveKind = classifyFileKind(live);
        if (liveKind !== "image" && liveKind !== "pdf") return;
        void presentCardSettingsSheet(showSheet, liveKind, cardId);
      },
    },
  });

  if (path === null) {
    return (
      <div className="file-view-card" data-slot="file-view-card">
        <TugLabel className="file-view-card-notice">No file open.</TugLabel>
      </div>
    );
  }

  const kind = classifyFileKind(path);
  const name = basename(path);

  return (
    <CardContentResponderScope>
      <div
        ref={cardContentResponderRef as (el: HTMLDivElement | null) => void}
        className="file-view-card"
        data-slot="file-view-card"
        data-tug-scroll-key="file-view-card"
        // An image does not re-wrap when the card changes width — it re-fits,
        // and every offset in it scales with the content. So this scroller
        // holds its fractional position rather than an element's top edge,
        // which is the same place in the picture before and after.
        {...(kind === "image" ? { "data-tug-preserve": "fraction" } : {})}
        data-file-view-kind={kind}
        // The image settings that the CARD's own frame answers for rather than
        // the image block: how the frame scrolls at Actual Size, and whether
        // the strip is standing under the picture ([L06] — the attribute is
        // the state, and CSS reads it).
        {...(kind === "image"
          ? { "data-file-view-image-fit": image.settings.scaling }
          : {})}
      >
        {kind === "image" ? (
          <>
            <ImageBlock
              className="file-view-card-image"
              src={blobUrl(path)}
              alt={name}
              fit={image.settings.scaling}
              ground={image.settings.background}
              smoothing={image.settings.smoothing}
              onNaturalSize={setNaturalSize}
            />
            {image.settings.showInfo ? (
              <ImageInfoStrip
                path={path}
                naturalSize={naturalSize}
                byteSize={byteSize}
              />
            ) : null}
          </>
        ) : kind === "pdf" ? (
          <PdfView
            key={path}
            path={path}
            cardId={cardId}
            // The bag first — a document comes back where the reader left it —
            // and the preference only when there is no bag, which is exactly
            // "a document nobody has read yet" ([L23] state vs. preference).
            initialState={
              restoredViewRef.current ?? {
                pageMode: pdf.settings.pageMode,
                zoom: openingZoomToPdfZoom(pdf.settings.openingZoom),
              }
            }
            pageGap={pdf.settings.pageGap}
            invertInDark={pdf.settings.invertInDark}
            onStateChange={setView}
            onDocumentInfo={(info) => setPdfPages(info.pages)}
          />
        ) : (
          <TugLabel className="file-view-card-notice">
            Tug can&rsquo;t display this file yet.
          </TugLabel>
        )}
        {renderSheet()}
      </div>
    </CardContentResponderScope>
  );
}
