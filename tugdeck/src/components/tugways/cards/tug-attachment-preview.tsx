/**
 * tug-attachment-preview.tsx — the general-purpose attachment-preview
 * facility, shared by the transcript (read-only) and the prompt-entry
 * editor (compose phase, deletable).
 *
 * It has two faces, both driven by the per-card {@link AtomBytesStore}:
 *
 *  - the **strip** ({@link TugAttachmentPreview}): a row of thumbnail
 *    tiles, one per image atom, mounted below a user-row body in the
 *    transcript (a fixed-width, wrapping grid) OR as the prompt-entry's Z4C
 *    zone while composing (a single-row, fixed-HEIGHT strip — see the CSS
 *    pair for the two layouts and why the compose one is height-driven).
 *    Each tile paints, in order: the baked `thumbnailDataUrl`; else the
 *    full-resolution bytes the moment they land (the replay window, before
 *    the bake); else a transparent reserved slot — never a dark box.
 *  - the **sheet** ({@link AttachmentPreviewSheet}, internal): the
 *    full-resolution image, opened in a pane-sheet when a tile is
 *    clicked, with ←/→ paging across the message's image set and a Copy
 *    action. The strip owns the sheet via {@link useTugSheet}, so a
 *    consumer drops in `<TugAttachmentPreview …/>` and gets click-to-zoom
 *    for free.
 *
 * Delete: when `deletable` is set (the compose phase — you can't delete an
 * attachment already committed to the transcript), each tile grows a ✕
 * affordance and the sheet a Delete action. Both are [L11] controls: they
 * dispatch `REMOVE_ATTACHMENT` (the atom id on `value`) through the chain
 * to the parent responder, which owns the substrate (editor doc + bytes
 * store) and performs the removal. The strip holds no delete state; it
 * re-renders from the shrunken atom array the responder produces.
 *
 * Density: `compact` steps both faces down for a surface a few hundred pixels
 * wide (the Overview rail) — smaller tiles, a sheet that opens at the narrow
 * width tier short of the host card's edges, and that sheet's chrome (Copy,
 * Delete, Done) at the smaller button scale, since three card-scale buttons
 * are most of what a rail-width footer holds. It is a size, never a different
 * design: same tiles, same captions, same sheet, same gestures. The default is
 * the card's.
 *
 * The bytes-store IS external state: its contents grow on the live path
 * (drop / paste / synthesize) and on the replay path (synthesizer mints
 * entries from JSONL content blocks; thumbnail bake fires fire-and-forget
 * and updates the entry when complete). Both faces subscribe via
 * `useSyncExternalStore` so a late-arriving thumbnail lands as a
 * re-render rather than leaving a tile stuck on its placeholder.
 *
 * Laws:
 *  - [L02] external state (the bytes store) enters React via
 *    `useSyncExternalStore`; the strip snapshot is the per-atom
 *    thumbnail-data-URL projection, stable across quiescent rebuilds.
 *  - [L06] appearance via CSS — tile dimensions, gap, caption
 *    typography, placeholder, hover wash, and the sheet's aspect-lock
 *    all flow from this component's slot family + CSS.
 *  - [L11] the ✕ / Delete are controls — they dispatch `REMOVE_ATTACHMENT`
 *    through the chain; the parent responder owns the delete state.
 *  - [L19] file pair, module docstring, exported props interface,
 *    `data-slot="tug-attachment-preview"` on the strip root.
 *  - [L20] one component-token slot family (`--tugx-attachment-*`).
 *
 * @module components/tugways/cards/tug-attachment-preview
 */

import "./tug-attachment-preview.css";

import * as React from "react";
import { AlertTriangle, File as FileIcon, ImageOff, X } from "lucide-react";

import type { AtomSegment } from "@/lib/tug-atom-img";
import type { AtomBytesStore } from "@/lib/atom-bytes-store";
import { blobUrl, elideFileName } from "@/lib/file-kinds";
import {
  osThumbnailFor,
  requestOSThumbnail,
  subscribeToOSThumbnails,
} from "@/lib/os-thumbnail-store";
import { decorateChipLabel } from "./tug-atom-text-body";
import type { TurnAddress } from "../tug-transcript-entry";
import { useTugSheet } from "@/components/tugways/tug-sheet";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { BlockCopyButton } from "@/components/tugways/body-kinds/affordances/block-copy-button";
import { useFocusable, useSeedKeyView } from "@/components/tugways/use-focusable";
import type { FocusPolicy } from "@/components/tugways/focus-manager";
import { useItemGroupKeyboard } from "@/components/tugways/use-item-group-keyboard";
import { useSpatialOrder } from "@/components/tugways/use-spatial-order";
import type { SpatialOrder } from "@/components/tugways/spatial-order";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import { useControlDispatch } from "@/components/tugways/use-control-dispatch";
import { ResponderChainContext } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { writeImageToNativeClipboard } from "@/lib/tug-native-clipboard";
import { toBase64 } from "@/lib/attachment-upload";
import { registerAttachmentPreviewOpener } from "@/lib/attachment-preview-open";

// ---------------------------------------------------------------------------
// Strip props
// ---------------------------------------------------------------------------

/** How much room the hosting surface can spare. See {@link TugAttachmentPreviewProps.density}. */
export type TugAttachmentPreviewDensity = "comfortable" | "compact";

/**
 * What each density asks of the sheet: which width tier it opens at, and how
 * much of the host card it may take. The comfortable pair is the shipped
 * lightbox — the widest tier, 90% of the card. The compact pair is the
 * decision width capped well short of the card's edges, because on a rail the
 * margin IS the difference between a panel and a lid.
 */
const SHEET_GEOMETRY: Record<
  TugAttachmentPreviewDensity,
  { displayWidth: "sm" | "xl"; maxHostFraction: number }
> = {
  comfortable: { displayWidth: "xl", maxHostFraction: 0.9 },
  compact: { displayWidth: "sm", maxHostFraction: 0.85 },
};

/**
 * The button scale each density's chrome runs at. A sheet a third the width
 * carries the same three controls — Copy, Delete, Done — and at the card's
 * scale they are most of what a rail-width footer contains.
 */
const CHROME_SIZE: Record<
  TugAttachmentPreviewDensity,
  { button: "sm" | "md"; copy: "sm" | "md" }
> = {
  comfortable: { button: "md", copy: "md" },
  compact: { button: "sm", copy: "sm" },
};

export interface TugAttachmentPreviewProps {
  /**
   * Transcript entry address, threaded through to each tile's caption so
   * the strip and the inline chip share an identical label. Omitted
   * (`undefined`) for a surface with no committed turn yet — the
   * prompt-entry compose phase, or a queued (ghost) send — in which case
   * the caption is the atom's bare `image-N` label, matching the inline
   * chip on that same surface.
   */
  address?: TurnAddress;
  /**
   * Image atoms from the surface's substrate, already filtered to
   * `type === "image"` by the caller. Order is the same order the inline
   * chips appear in.
   */
  atoms: ReadonlyArray<AtomSegment>;
  /**
   * Per-card bytes-store handle. Both the strip and the sheet subscribe
   * to it via `useSyncExternalStore` so a late-arriving thumbnail bake
   * re-renders the affected tile without external orchestration.
   */
  bytesStore: AtomBytesStore;
  /**
   * Compose-phase delete affordance. When `true`, each tile grows a ✕ and
   * the preview sheet a Delete button; activating either dispatches the
   * `REMOVE_ATTACHMENT` action (carrying the atom id) through the chain to
   * the parent responder — which owns the substrate (editor doc + bytes
   * store) and performs the removal ([L11]). The strip itself holds no
   * delete state; it re-renders from the shrunken `atoms` array the
   * responder produces. Omitted (`false`) on the transcript — a committed
   * attachment can't be deleted.
   * @selector [data-deletable]
   */
  deletable?: boolean;
  /**
   * How much room the surface can spare for pictures.
   *
   * `comfortable` (the default) is the Session card's: a card read at a
   * document's width, where a thumbnail can be big enough to recognize at a
   * glance and the sheet can open near the card's full width.
   *
   * `compact` is for a RAIL — a surface a few hundred pixels wide, where the
   * comfortable tile eats the composer and the sheet opens wall-to-wall with
   * no margin left to read it as nested. It is one declaration and it carries
   * both halves: the strip's tiles step down a size (`[data-density]` in
   * `tug-attachment-preview.css`), and the sheet opens at the narrow tier with
   * a tighter cap on the card, so it stays a panel ON the rail rather than a
   * lid over it. Nothing else changes — same tiles, same captions, same sheet,
   * same gestures.
   * @selector [data-density="compact"]
   * @default "comfortable"
   */
  density?: TugAttachmentPreviewDensity;
  /** Forwarded to the strip root element. */
  className?: string;
  /** Forwarded to the strip root element (for test anchoring). */
  "data-testid"?: string;
  /**
   * Author the strip's tiles into a focus group ([P10]) — when set, **each
   * tile is its own leaf cycle stop** (Tab moves tile-to-tile, no
   * arrow-roving), like the Z2 status cells. The engine drives DOM focus onto
   * the tile during the walk; the tile's own `role="button"` handles
   * Return / Space natively to open its preview sheet. Supplied by the
   * prompt-entry's compose-phase Z4C zone; omitted in the read-only transcript
   * strip, where the tiles are not Tab stops.
   */
  focusGroup?: string;
  /**
   * Order of the FIRST tile within {@link focusGroup}; tiles take consecutive
   * orders left→right in `atoms` order. Defaults to 0.
   */
  focusOrderBase?: number;
  /** Walk policy when registered (`accept` default; `skip` = a11y-only). */
  focusPolicy?: FocusPolicy;
  /**
   * Activating a tile that has no pixels — a non-image attachment, or one
   * whose attach failed. The image lightbox has nothing to show for either, so
   * the click is the host's to interpret: the Text card reveals the link in
   * the document, or retries the failed upload. Omit and such a tile is inert.
   */
  onActivateFile?: (atom: AtomSegment) => void;
  /**
   * Measure whether the tile row overflows, and mark the strip when it does so
   * the stylesheet can pay for the scrollbar out of the tile height.
   *
   * This belongs to the **prompt entry's compose strip** specifically — a
   * fixed-HEIGHT single row, where shrinking the tiles is the only place the
   * scrollbar's pixels can come from. It used to be inferred from
   * {@link deletable}, which happened to be true for exactly that one surface
   * and stopped being a safe proxy the moment a second surface wanted a ✕: the
   * measurement writes an attribute that changes the row's size, so on a strip
   * whose height is *not* fixed the `ResizeObserver` re-fires on its own write
   * and spins.
   *
   * A strip that scrolls by ordinary CSS — the Text card's — wants none of it.
   * @default false
   */
  measureRowOverflow?: boolean;
}

// ---------------------------------------------------------------------------
// useSyncExternalStore subscription (strip)
// ---------------------------------------------------------------------------

interface TileSnapshot {
  readonly atomId: string;
  readonly label: string;
  readonly value: string;
  /**
   * The atom's own type. `"image"` for everything the prompt entry puts in a
   * strip; the Text card's projection also mints `"file"` for a non-image
   * attachment, which has no pixels and must not be mistaken for an image
   * whose bytes have not landed yet.
   */
  readonly type: string;
  readonly thumbnailDataUrl: string | undefined;
  /**
   * Full-resolution bytes + media type when the store entry is present.
   * Used as the paint fallback before the thumbnail bake lands (the replay
   * window, where `put` writes content first and the thumbnail follows) so
   * a tile shows the real image rather than an empty box.
   */
  readonly content: string | undefined;
  readonly mediaType: string | undefined;
  /**
   * Absolute path of the file behind the entry, when it has one.
   *
   * The Text card's strip paints from this rather than from base64: its tiles
   * stand for files already on disk, so holding their bytes in JS would park a
   * whole document's assets in memory to draw thumbnails. `/api/fs/blob`
   * streams, revalidates by `ETag`, and is what the viewer card already reads.
   * The prompt entry's tiles keep painting from `content`, which genuinely has
   * to exist in JS because it goes on the wire.
   */
  readonly path: string | undefined;
  /**
   * The atom resolves to a bytes-store entry that carries nothing paintable —
   * no thumbnail, no content, no path. This is the "broken image" state: a
   * recalled history atom whose bytes are gone and whose durable thumbnail was
   * never captured (re-seeded as an empty marker), or a projected link whose
   * file is missing. Distinct from the pre-pixel drop window (no entry at all),
   * which stays a transparent reserved slot.
   */
  readonly broken: boolean;
}

function buildSnapshot(
  atoms: ReadonlyArray<AtomSegment>,
  bytesStore: AtomBytesStore,
): ReadonlyArray<TileSnapshot> {
  const out: TileSnapshot[] = [];
  for (const atom of atoms) {
    const id = atom.id ?? "";
    const entry = id.length > 0 ? bytesStore.get(id) : null;
    const hasThumb = (entry?.thumbnailDataUrl ?? "").length > 0;
    const hasContent = (entry?.content ?? "").length > 0;
    const hasPath = (entry?.path ?? "").length > 0;
    out.push({
      atomId: id,
      label: atom.label,
      value: atom.value,
      type: atom.type,
      thumbnailDataUrl: entry?.thumbnailDataUrl,
      content: entry?.content,
      mediaType: entry?.mediaType,
      path: entry?.path,
      // A file tile is never broken for want of pixels — it has none by
      // nature. Only an image with nothing to paint is.
      broken:
        atom.type === "image" &&
        entry !== null &&
        !hasThumb &&
        !hasContent &&
        !hasPath,
    });
  }
  return out;
}

/**
 * `Object.is`-stable snapshot key for the strip's `useSyncExternalStore`
 * contract. Recomputed only when the atoms array reference changes or any
 * tile's thumbnail-data-URL changes; without it every `getSnapshot` would
 * allocate a fresh array and React would tear under concurrent renders.
 */
function snapshotKey(snap: ReadonlyArray<TileSnapshot>): string {
  let key = "";
  for (const t of snap) {
    // Content presence (not the bytes themselves) joins the key so the
    // tile re-renders when content lands ahead of its thumbnail — without
    // hashing the whole base64 string on every snapshot. `broken` joins it
    // too so a same-id atom flipping from broken-marker to real bytes (or
    // back) busts the cache even though its presence flags didn't move.
    // `type` and `path` join it because both decide which branch of the src
    // ladder a tile takes, and neither is implied by the presence flags.
    key += `${t.atomId}|${t.type}|${t.thumbnailDataUrl ?? ""}|${
      (t.content ?? "").length > 0 ? "c" : ""
    }|${t.path ?? ""}|${t.broken ? "b" : ""}|`;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Does the row fit?
// ---------------------------------------------------------------------------

/** The flag the compose strip's stylesheet keys its scrolling pose on. */
const SCROLLS_ATTR = "data-scrolls";

/**
 * Mark the compose strip when its row does not fit, so the stylesheet can pay
 * for the scrollbar out of the tile height.
 *
 * A DOM write, never React state ([L06]) — this is appearance, and nothing
 * above the strip has any use for the answer.
 *
 * **The flag is decided at the row's NATURAL size, always.** That is the whole
 * subtlety: the flag SHRINKS the tiles, and a shorter tile is a narrower tile
 * (width follows the image's aspect), so a row measured while already flagged
 * can easily be found to fit — clear the flag, the tiles grow back, it
 * overflows again, and the strip flickers between the two forever. Dropping
 * the flag before the read makes the answer a pure function of the images and
 * the box's width, so it converges in one pass and stays converged. The read
 * is synchronous and nothing paints between the two writes.
 *
 * Observed rather than computed-once because both inputs move on their own: the
 * card resizes, and a tile has no width at all until its image decodes (the
 * `<img>` is `width: auto` over a data URL). Watching the cells covers the
 * second — their widths are exactly what changes when pixels land.
 */
function useComposeStripScrolls(
  stripRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  // Re-observes when the tile set changes: cells come and go with it.
  tiles: ReadonlyArray<TileSnapshot>,
): void {
  React.useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip === null || !active) return;

    const measure = (): void => {
      strip.removeAttribute(SCROLLS_ATTR);
      // Forces the layout that the removal above invalidated, which is the
      // point: this is the natural row's width, not the flagged row's.
      const overflows = strip.scrollWidth > strip.clientWidth;
      strip.toggleAttribute(SCROLLS_ATTR, overflows);
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    for (const cell of strip.querySelectorAll(
      ".tug-attachment-preview__cell",
    )) {
      observer.observe(cell);
    }
    return () => observer.disconnect();
  }, [stripRef, active, tiles]);
}

// ---------------------------------------------------------------------------
// Strip component — the public face
// ---------------------------------------------------------------------------

/**
 * The attachment-preview strip. See the module docstring for the
 * substrate, subscription model, and the laws this honours.
 *
 * Returns `null` when `atoms` is empty (no DOM is rendered, so the
 * containing surface's height accounting sees no strip contribution —
 * the transcript row collapses to body-only, and the prompt-entry Z4C
 * zone takes no vertical space).
 */
export const TugAttachmentPreview = React.forwardRef<
  HTMLDivElement,
  TugAttachmentPreviewProps
>(function TugAttachmentPreview(
  {
    address,
    atoms,
    bytesStore,
    deletable = false,
    density = "comfortable",
    className,
    "data-testid": dataTestid,
    focusGroup,
    focusOrderBase = 0,
    focusPolicy,
    onActivateFile,
    measureRowOverflow = false,
  },
  ref,
) {
  // [L11] control side: the ✕ / Delete dispatch `REMOVE_ATTACHMENT` (the
  // atom id on `value`) to the parent responder, which owns the substrate
  // and performs the removal. The strip holds no delete state itself. The
  // dispatch resolves the parent responder at THIS render location (inside
  // the prompt-entry's `ResponderScope`), so it targets the prompt-entry
  // even for the Delete button that renders in the portaled sheet.
  const { dispatch: controlDispatch } = useControlDispatch();
  const removeSenderId = React.useId();
  const dispatchRemove = React.useCallback(
    (atom: AtomSegment): void => {
      if (atom.id === undefined) return;
      controlDispatch({
        action: TUG_ACTIONS.REMOVE_ATTACHMENT,
        value: atom.id,
        sender: removeSenderId,
        phase: "discrete",
      });
    },
    [controlDispatch, removeSenderId],
  );

  // Read at click time so `openPreview` — memoized on the atom set — does not
  // have to be rebuilt when the host passes a fresh closure ([L07]).
  const onActivateFileRef = React.useRef(onActivateFile);
  onActivateFileRef.current = onActivateFile;

  const cacheRef = React.useRef<{
    atoms: ReadonlyArray<AtomSegment>;
    key: string;
    snap: ReadonlyArray<TileSnapshot>;
  } | null>(null);

  const subscribe = React.useCallback(
    (listener: () => void) => bytesStore.subscribe(listener),
    [bytesStore],
  );
  const getSnapshot = React.useCallback((): ReadonlyArray<TileSnapshot> => {
    const candidate = buildSnapshot(atoms, bytesStore);
    const key = snapshotKey(candidate);
    const cached = cacheRef.current;
    if (cached !== null && cached.atoms === atoms && cached.key === key) {
      return cached.snap;
    }
    cacheRef.current = { atoms, key, snap: candidate };
    return candidate;
  }, [atoms, bytesStore]);

  const tiles = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // The strip owns the sheet: a tile click opens the full-resolution
  // preview on that atom, stepping across the rest with ←/→. The sheet is
  // per-pane (TugSheet's portal), so visually at most one preview shows at
  // a time regardless of which row hosts the hook.
  const { showSheet, renderSheet } = useTugSheet();
  const openPreview = React.useCallback(
    (atom: AtomSegment, clickedIndex: number): void => {
      // The sheet is an image lightbox — it paints a data URL and pages across
      // an image set. A tile with no pixels has nothing for it to show, so the
      // click goes to the host instead of opening an empty panel.
      if (atom.type !== "image") {
        onActivateFileRef.current?.(atom);
        return;
      }
      void showSheet({
        title: atom.value,
        // The preview owns its own top bar (title + actions), so the
        // sheet's header is suppressed; `title` stays for aria-label. A
        // full-bleed lightbox is the one sanctioned exemption from the
        // shared modal-header convention (tugx-header.css). The width tier
        // and the cap are the DENSITY's (see `SHEET_GEOMETRY`): a card gets
        // the widest tier at 90% of its frame, a rail the narrow tier well
        // short of its edges. Drag-resize gives the image real room either
        // way, and `aspectLockContent` locks the panel to the image's aspect
        // so the margin around it stays uniform at every size.
        hideHeader: true,
        displayWidth: SHEET_GEOMETRY[density].displayWidth,
        resizable: true,
        aspectLockContent: true,
        maxHostFraction: SHEET_GEOMETRY[density].maxHostFraction,
        content: (close) => (
          <AttachmentPreviewSheet
            atoms={atoms}
            startIndex={clickedIndex}
            bytesStore={bytesStore}
            density={density}
            onClose={() => close()}
            onRemove={
              deletable
                ? (a) => {
                    dispatchRemove(a);
                    // Deleting from the preview returns to the strip, which
                    // reflects the removal from the responder's updated atom
                    // array — simpler than live-shrinking the open sheet.
                    close();
                  }
                : undefined
            }
          />
        ),
      });
    },
    [showSheet, atoms, bytesStore, deletable, density, dispatchRemove],
  );

  // A transcript image chip is an annotation, and its click reaches the
  // delegated layer — a plain function that cannot call `useTugSheet`. So
  // the strip offers itself: asked for an atom it holds, it opens the same
  // lightbox a thumbnail click opens. Registered in a layout effect
  // ([L03]) because the gesture that asks can land in the frame the strip
  // first paints.
  React.useLayoutEffect(() => {
    return registerAttachmentPreviewOpener((atomId) => {
      const index = atoms.findIndex((a) => a.id === atomId);
      if (index === -1) return false;
      openPreview(atoms[index] as AtomSegment, index);
      return true;
    });
  }, [atoms, openPreview]);

  // The strip needs its own handle on its root to measure the row, and the
  // host may have asked for one too — so the callback feeds both.
  const stripRef = React.useRef<HTMLDivElement | null>(null);
  const setStripEl = React.useCallback(
    (el: HTMLDivElement | null): void => {
      stripRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref !== null && ref !== undefined) ref.current = el;
    },
    [ref],
  );
  useComposeStripScrolls(stripRef, measureRowOverflow, tiles);

  // Empty atoms → no DOM. The host surface sees no strip contribution.
  if (tiles.length === 0) return null;

  return (
    <div
      ref={setStripEl}
      data-slot="tug-attachment-preview"
      data-deletable={deletable ? "" : undefined}
      data-density={density === "compact" ? "compact" : undefined}
      className={className}
      data-testid={dataTestid}
    >
      {tiles.map((tile, i) => (
        <AttachmentPreviewTile
          key={tile.atomId.length > 0 ? `id-${tile.atomId}` : `pos-${i}`}
          tile={tile}
          caption={decorateChipLabel(atoms[i] as AtomSegment, address)}
          deletable={deletable}
          onOpen={() => openPreview(atoms[i] as AtomSegment, i)}
          onRemove={() => dispatchRemove(atoms[i] as AtomSegment)}
          focusGroup={focusGroup}
          focusOrder={focusOrderBase + i}
          focusPolicy={focusPolicy}
        />
      ))}
      {renderSheet()}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Tile — one thumbnail (internal)
// ---------------------------------------------------------------------------

interface AttachmentPreviewTileProps {
  tile: TileSnapshot;
  caption: string;
  deletable: boolean;
  /** Open this tile's full-resolution preview sheet. */
  onOpen: () => void;
  /** Dispatch `REMOVE_ATTACHMENT` for this tile (compose phase). */
  onRemove: () => void;
  /** Cycle focus group when the strip is authored into one; else undefined. */
  focusGroup?: string;
  /** This tile's order within {@link focusGroup}. */
  focusOrder: number;
  /** Walk policy when registered. */
  focusPolicy?: FocusPolicy;
}

/**
 * How many characters of a caption are shown before it is elided.
 *
 * A prompt attachment's caption is the minted `image-N` and always fits. A
 * document asset's is the file's real name, which routinely does not — and the
 * compose cell is `width: auto`, so an un-elided one does not overflow, it
 * makes the tile as wide as the name and shoves the rest of the strip off the
 * end. This budget pairs with `--tugx-attachment-tile-max-width` (112px): at
 * the caption's monospaced 0.7rem it comes to a hair under that cap, so the
 * caption can never be what decides a tile's width. Retune the two together.
 * The CSS clips as well, which is what covers the narrower transcript tile.
 */
const CAPTION_MAX_CHARS = 16;

/**
 * The edge, in points, a QuickLook thumbnail is asked for. Comfortably over
 * both tile sizes (56px compose, 64px transcript) so the same cached render
 * serves either without upscaling, and the host multiplies it by the window's
 * backing factor on the way out.
 */
const QUICKLOOK_REQUEST_POINTS = 96;

/**
 * One attachment thumbnail. A leaf in the focus language ([P10]): when the
 * strip authors a `focusGroup`, the tile registers as a cycle stop and the
 * engine drives DOM focus onto it during the walk; its own `role="button"`
 * handles Return / Space natively to open the preview sheet (the engine leaves
 * a leaf's act keys to the native pipeline — `responder-chain-provider`). Each
 * tile is its own component so the per-tile {@link useFocusable} call is a top-
 * level hook, not a hook inside `.map` ([L19]).
 */
function AttachmentPreviewTile({
  tile,
  caption,
  deletable,
  onOpen,
  onRemove,
  focusGroup,
  focusOrder,
  focusPolicy,
}: AttachmentPreviewTileProps): React.ReactElement {
  const registered = focusGroup !== undefined;
  const focusableId = React.useId();
  const { focusableRef } = useFocusable({
    id: focusableId,
    group: focusGroup ?? "",
    order: focusOrder,
    policy: focusPolicy,
    register: registered,
  });

  // Paint order, FOUC-free: the baked thumbnail when present; else the
  // full-resolution bytes the moment they land (the replay window, where
  // content arrives before the thumbnail bake); else `undefined` — render a
  // transparent reserved slot, NEVER a dark box, for the brief drop-time
  // window before any pixels exist. If a bake never lands (corrupt / exotic
  // codec on replay), the content fallback persists — the tile shows the
  // original scaled down rather than an empty box. Heavier than a thumbnail,
  // but rare and strictly better than the alternative.
  //
  // A fourth rung sits below content: an entry that names a file on disk
  // paints straight from `/api/fs/blob`. That is how the Text card's strip
  // renders a whole document's assets without holding any of their bytes.
  const isFile = tile.type !== "image";
  const isFailed = tile.type === "failed";
  // A non-image attachment has no pixels of its own, but macOS can usually draw
  // it: QuickLook renders a page of the text, the first page of the PDF, the
  // slide of the deck. Asked for once per path and cached across mounts, so a
  // strip that re-renders on every keystroke does not re-render the file
  // ([L02] — external state through `useSyncExternalStore`, never an effect
  // writing component state).
  const quickLookPath = isFile && !isFailed && tile.path !== undefined
    ? tile.path
    : "";
  const quickLook = React.useSyncExternalStore(
    subscribeToOSThumbnails,
    () => osThumbnailFor(quickLookPath),
    () => null,
  );
  React.useEffect(() => {
    if (quickLookPath === "") return;
    requestOSThumbnail(quickLookPath, QUICKLOOK_REQUEST_POINTS);
  }, [quickLookPath]);
  const hasThumb =
    tile.thumbnailDataUrl !== undefined && tile.thumbnailDataUrl.length > 0;
  const hasContent =
    tile.content !== undefined &&
    tile.content.length > 0 &&
    tile.mediaType !== undefined &&
    tile.mediaType.length > 0;
  const hasPath = tile.path !== undefined && tile.path.length > 0;
  const src = isFile
    ? (quickLook ?? undefined)
    : hasThumb
      ? tile.thumbnailDataUrl
      : hasContent
        ? `data:${tile.mediaType};base64,${tile.content}`
        : hasPath
          ? blobUrl(tile.path as string)
          : undefined;

  return (
    <div
      data-slot="tug-attachment-preview__cell"
      className="tug-attachment-preview__cell"
    >
      <div
        ref={focusableRef as (el: HTMLDivElement | null) => void}
        role="button"
        // The engine drives DOM focus here during the cycle walk (a
        // `tabIndex=-1` element is programmatically focusable); a native `0`
        // when the strip is not authored into a cycle (the transcript).
        tabIndex={registered ? -1 : 0}
        // A pure preview trigger: a click while focus-cycling must not pull
        // card focus to the editor (the pane-focus-controller's activate →
        // apply-focus path), matching the Z2 status cells.
        data-no-activate={registered ? "" : undefined}
        data-slot="tug-attachment-preview__tile"
        className="tug-attachment-preview__tile"
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        aria-label={caption}
        title={tile.value}
      >
        <span
          data-slot="tug-attachment-preview__thumb"
          className="tug-attachment-preview__thumb"
          // The frame (border + fill) is gated on this in CSS, so the
          // pre-pixel window shows nothing instead of an empty box.
          data-has-image={src !== undefined || isFile ? "" : undefined}
        >
          {src !== undefined ? (
            <img
              className="tug-attachment-preview__thumb-img"
              src={src}
              alt={caption}
            />
          ) : isFile ? (
            // A non-image attachment — a zip, an archive, a spreadsheet. It
            // has no pixels by nature, so it gets a glyph and its name rather
            // than the reserved slot an image-with-no-bytes-yet gets. Without
            // this branch the tile would be an invisible gap with no delete
            // affordance.
            <span
              data-slot="tug-attachment-preview__file"
              className="tug-attachment-preview__file"
              // Appearance via an attribute + CSS, never React state ([L06]).
              // A failed tile is the same tile in the caution tone: the file
              // it stands for is named right below it, which is the whole
              // reason this reads better than a banner could.
              data-failed={isFailed ? "" : undefined}
              aria-label={isFailed ? `${tile.value} — attach failed` : tile.value}
              title={isFailed ? `${tile.value} — attach failed. Click to retry.` : tile.value}
            >
              {isFailed ? (
                <AlertTriangle aria-hidden="true" />
              ) : (
                <FileIcon aria-hidden="true" />
              )}
            </span>
          ) : tile.broken ? (
            // Broken image: the atom points at a bytes-store entry with no
            // pixels — a recalled history image whose bytes are gone and whose
            // durable thumbnail was never captured. A broken-image glyph
            // reads as "this image is broken" rather than a blank slot that
            // looks like it's still loading.
            <span
              data-slot="tug-attachment-preview__broken"
              className="tug-attachment-preview__broken"
              aria-label="Image unavailable"
              title="Image unavailable"
            >
              <ImageOff aria-hidden="true" />
            </span>
          ) : (
            // No pixels yet (the brief pre-bake drop window): a transparent,
            // reserved slot — never a dark box. The fixed-height zone already
            // holds the space, so the image simply pops in when the bake lands.
            <span
              data-slot="tug-attachment-preview__placeholder"
              className="tug-attachment-preview__placeholder"
              aria-hidden="true"
            />
          )}
          {deletable && (src !== undefined || tile.broken || isFile) && (
            // Compose-phase delete. A component-owned overlay affordance (not a
            // TugButton) pinned to the thumbnail's own top-right corner, so it
            // stays flush regardless of cell/caption width. It is an [L11]
            // control — the click dispatches `REMOVE_ATTACHMENT` through the
            // chain — and `data-tug-focus="refuse"` keeps focus on the editor.
            // `stopPropagation` keeps the X from also opening the sheet.
            <button
              type="button"
              data-slot="tug-attachment-preview__delete"
              className="tug-attachment-preview__delete"
              data-tug-focus="refuse"
              aria-label={`Remove ${tile.value}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <X size={12} strokeWidth={2.5} aria-hidden="true" />
            </button>
          )}
        </span>
        <span
          data-slot="tug-attachment-preview__caption"
          className="tug-attachment-preview__caption"
          // The full name where a reader can still get at it. The visible
          // text is elided; the accessible name on the tile above is not.
          title={caption}
        >
          {elideFileName(caption, CAPTION_MAX_CHARS)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sheet body — the full-resolution preview (internal)
// ---------------------------------------------------------------------------

/**
 * Decode `dataUrl` to a PNG `Blob` for the clipboard. The clipboard's
 * image flavor is `image/png` everywhere; a PNG source passes through,
 * anything else (JPEG/WebP) re-encodes through an offscreen canvas.
 * Returned as a promise so the caller can hand it straight to
 * `new ClipboardItem({ "image/png": buildPngBlob(...) })` — WebKit honors
 * a promise-valued clipboard item, keeping the async decode inside the
 * originating user gesture (a pre-resolved blob would lose transient
 * activation and reject with NotAllowed).
 */
async function buildPngBlob(dataUrl: string): Promise<Blob> {
  const sourceBlob = await (await fetch(dataUrl)).blob();
  if (sourceBlob.type === "image/png") return sourceBlob;
  const objectUrl = URL.createObjectURL(sourceBlob);
  try {
    const png = await new Promise<Blob | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (ctx === null) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((out) => resolve(out), "image/png");
      };
      img.onerror = () => resolve(null);
      img.src = objectUrl;
    });
    if (png === null) throw new Error("png re-encode failed");
    return png;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Write the preview image to the clipboard as a PNG. Resolves `true` on a
 * confirmed write (so {@link BlockCopyButton} flashes "Copied"), `false`
 * when the clipboard image API is unavailable or the write rejects — the
 * honest-feedback contract ([L23]).
 */
async function copyImageToClipboard(dataUrl: string): Promise<boolean> {
  // Prefer the native NSPasteboard bridge inside Tug.app. The WKWebView's
  // JS clipboard image write does not work there — the same reason
  // clipboard READ is bridged natively — so the web path below is only the
  // browser-dev fallback.
  // Only a `data:` URL carries its bytes inline. A path-backed tile's src is a
  // blob-route URL, whose tail is a query string rather than base64 — slicing
  // at the comma there would hand the pasteboard nonsense, so that case takes
  // the fetch-and-encode path below instead.
  if (dataUrl.startsWith("data:")) {
    const comma = dataUrl.indexOf(",");
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
    if (writeImageToNativeClipboard(base64)) {
      return true;
    }
  } else if (dataUrl.length > 0) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const buffer = new Uint8Array(await blob.arrayBuffer());
      if (writeImageToNativeClipboard(toBase64(buffer))) return true;
    } catch {
      // Fall through to the web clipboard path.
    }
  }
  const clip = navigator.clipboard;
  if (
    clip === undefined ||
    clip === null ||
    typeof ClipboardItem === "undefined" ||
    typeof clip.write !== "function"
  ) {
    return false;
  }
  try {
    await clip.write([new ClipboardItem({ "image/png": buildPngBlob(dataUrl) })]);
    return true;
  } catch {
    return false;
  }
}

// Focus-group order of the sheet's keyboard stops, in Tab order. The
// leaf buttons (Copy / Delete / Done) and the pager share one closed
// spatial ring; the pager is a delegating selection group whose interior
// cursor roves the dots. Delete is conditional — its slot is simply
// absent when the sheet isn't deletable.
/** A responder that exists for identity alone handles nothing. Hoisted so
 *  the registration is not a fresh object on every render. */
const EMPTY_PREVIEW_ACTIONS = {};

const PREVIEW_COPY_ORDER = 0;
const PREVIEW_DELETE_ORDER = 1;
const PREVIEW_PAGER_ORDER = 2;
const PREVIEW_DONE_ORDER = 3;

interface AttachmentPreviewSheetProps {
  /**
   * The full set of image atoms for the surface whose strip was clicked,
   * in strip order. The preview opens on {@link startIndex}; the user
   * steps through the rest via the footer pager dots.
   */
  atoms: ReadonlyArray<AtomSegment>;
  /** Index into {@link atoms} the preview opens on. Clamped defensively. */
  startIndex: number;
  /** Per-card bytes store carrying the image content + mediaType. */
  bytesStore: AtomBytesStore;
  /** Dismiss callback wired to the host sheet's `close`. */
  onClose?: () => void;
  /**
   * Internal remove hook supplied by {@link TugAttachmentPreview} when the
   * surface is deletable. The owner wires it to dispatch `REMOVE_ATTACHMENT`
   * (and close the sheet); the sheet just calls it for the current image
   * when the footer Delete button is activated. Not a public API — the
   * chain-dispatch ([L11]) lives in the owner.
   */
  onRemove?: (atom: AtomSegment) => void;
  /**
   * The strip's density, stamped on the sheet root so its own chrome — the
   * title band, the footer's buttons — can tighten to the narrow tier it
   * opens at on a rail.
   */
  density: TugAttachmentPreviewDensity;
}

/**
 * Project the bytes-store entry for `atom` into a data URL string, or
 * `null` when the atom has no id or no entry is present.
 */
function buildPreviewSnapshot(
  atom: AtomSegment,
  bytesStore: AtomBytesStore,
): string | null {
  const id = atom.id;
  if (id === undefined || id.length === 0) return null;
  const entry = bytesStore.get(id);
  if (entry === null) return null;
  // Prefer the full-resolution bytes; fall back to the durable thumbnail
  // for a recalled preview-only entry (no full bytes, but a thumbnail rode
  // history) so the sheet shows the (smaller) image rather than nothing. A
  // broken entry has neither — the sheet renders its empty state.
  if (entry.content.length > 0 && entry.mediaType.length > 0) {
    return `data:${entry.mediaType};base64,${entry.content}`;
  }
  if (entry.thumbnailDataUrl !== undefined && entry.thumbnailDataUrl.length > 0) {
    return entry.thumbnailDataUrl;
  }
  // A path-backed entry — the Text card's projection, whose tiles never hold
  // bytes. The blob route serves the full-resolution original, which is
  // exactly what the lightbox wants.
  if (entry.path !== undefined && entry.path.length > 0) {
    return blobUrl(entry.path);
  }
  return null;
}

function AttachmentPreviewSheet({
  atoms,
  startIndex,
  bytesStore,
  onClose,
  onRemove,
  density,
}: AttachmentPreviewSheetProps): React.ReactElement {
  const count = atoms.length;
  const clamp = React.useCallback(
    (i: number): number => Math.min(Math.max(i, 0), Math.max(count - 1, 0)),
    [count],
  );
  const [index, setIndex] = React.useState(() => clamp(startIndex));
  const atom = atoms[index];
  const title = atom?.value ?? "";

  const subscribe = React.useCallback(
    (listener: () => void) => bytesStore.subscribe(listener),
    [bytesStore],
  );
  const getSnapshot = React.useCallback(
    () => (atom !== undefined ? buildPreviewSnapshot(atom, bytesStore) : null),
    [atom, bytesStore],
  );
  const dataUrl = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // The node exists for identity — the sheet's trapped focus rests inside
  // this root — and handles nothing.
  //
  // It used to register `COPY`, on the belief that the chord is matched in
  // the capture-phase keybinding pipeline and dispatched to the first
  // responder. It is not: `COPY` is `routing: "native"`, so the pipeline
  // passes ⌘C through untouched and AppKit performs Edit ▸ Copy as
  // `NSText.copy(_:)` against the document selection. The handler never
  // ran. What the claim did do was terminate the Edit-menu validation walk
  // with no `validateAction` to answer for it, so Edit ▸ Copy read as
  // available over an image preview that could not serve it. Copying the
  // image is the sheet's Copy button, which works and carries the flash.
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const responderId = React.useId();
  const chainManager = React.useContext(ResponderChainContext);
  const { ResponderScope, responderRef } = useOptionalResponder({
    id: responderId,
    actions: EMPTY_PREVIEW_ACTIONS,
  });
  const setRoot = React.useCallback(
    (el: HTMLDivElement | null): void => {
      rootRef.current = el;
      responderRef(el);
    },
    [responderRef],
  );
  const handleRootFocus = React.useCallback((): void => {
    if (
      chainManager !== null &&
      chainManager.getFirstResponder() !== responderId
    ) {
      chainManager.makeFirstResponder(responderId);
    }
  }, [chainManager, responderId]);

  // Focus language ([tuglaws/focus-language.md]). The sheet wraps this body
  // in a `FocusModeScope` trap, so these calls bind to the trapped mode.
  //
  //  - Every keyboard stop — Copy, Delete, the pager, Done — is authored
  //    into ONE focus group and placed in ONE closed spatial ring on both
  //    axes. `Tab` walks them in order; any arrow roves them, and no arrow
  //    direction is left undeclared (which would dead-beep).
  //  - The pager is a roving item-container ([P01]): its dots are interior
  //    cursor members the spatial navigator traverses as part of the ring
  //    (an off-edge arrow falls through to the adjacent node — Delete on
  //    the left, Done on the right). In `live` commit mode each interior
  //    move pages the image (the tab-bar model). So ←/→ page the preview
  //    while the cursor is inside the pager.
  //  - Done is the persistent default ring, so `Return` always dismisses
  //    (never the destructive Delete). The opening key view is seeded on
  //    the PAGER for a multi-image set — so arrows page the instant the
  //    sheet opens — and on Done for a single image (no pager).
  const focusGroup = React.useId();
  const hasDelete = onRemove !== undefined && atom !== undefined;
  const hasPager = count > 1;
  useSeedKeyView(
    `${focusGroup}:${hasPager ? PREVIEW_PAGER_ORDER : PREVIEW_DONE_ORDER}`,
  );
  const sheetSpatialOrder = React.useMemo<SpatialOrder>(() => {
    const pagerNode = `${focusGroup}:${PREVIEW_PAGER_ORDER}`;
    const nodes = [`${focusGroup}:${PREVIEW_COPY_ORDER}`];
    if (hasDelete) nodes.push(`${focusGroup}:${PREVIEW_DELETE_ORDER}`);
    if (hasPager) nodes.push(pagerNode);
    nodes.push(`${focusGroup}:${PREVIEW_DONE_ORDER}`);
    return {
      // A single closed ring on both axes — every node has all four arrow
      // directions declared, so no direction is left undeclared (no
      // dead-arrow warning).
      rings: [
        { axis: "horizontal", nodes, closed: true },
        { axis: "vertical", nodes, closed: true },
      ],
      // The pager is a delegating selection group: the resolver checks this
      // BEFORE the ring, so an in-bounds arrow roves the dots (paging the
      // image), and only an off-the-end arrow falls through to the ring
      // (crossing to the adjacent button). `length` is the dot count.
      groups: hasPager ? [{ node: pagerNode, length: count }] : [],
    };
  }, [focusGroup, hasDelete, hasPager, count]);
  useSpatialOrder(sheetSpatialOrder);

  // The pager — a roving item-container over the dots. `live` commit pages
  // the image as the cursor moves; a pointer click moves the cursor too
  // (`setCursor`) so keyboard and mouse share one selection. The dot
  // elements are collected from refs in render order.
  const pagerId = React.useId();
  const dotRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const pageTo = React.useCallback(
    (i: number): void => setIndex(clamp(i)),
    [clamp],
  );
  const pager = useItemGroupKeyboard({
    id: pagerId,
    group: focusGroup,
    order: PREVIEW_PAGER_ORDER,
    register: hasPager,
    commit: "live",
    collectItems: () => dotRefs.current.slice(0, count),
    initialIndex: () => clamp(index),
    onSelect: (_el, i) => pageTo(i),
    onMove: (_el, i) => pageTo(i),
  });
  // Keep the cursor's item range in sync with the rendered dots. The
  // keyboard handler and a pointer `setCursor` both depend on this range,
  // so it must be registered before events fire ([L03]) — `useLayoutEffect`,
  // not `useEffect`. `syncItems` is stable, so this runs on mount and only
  // re-runs on a real count change.
  const pagerSyncItems = pager.syncItems;
  React.useLayoutEffect(() => {
    pagerSyncItems();
  }, [count, pagerSyncItems]);

  // The image area is the sheet's aspect-lock region: its `aspect-ratio`
  // (set from the image's natural dimensions on load) drives the panel's
  // content height. Written to the DOM directly — appearance via DOM, not
  // React state ([L06]).
  const imageAreaRef = React.useRef<HTMLDivElement>(null);
  const handleImageLoad = React.useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>): void => {
      const img = event.currentTarget;
      const area = imageAreaRef.current;
      if (area === null || img.naturalWidth === 0 || img.naturalHeight === 0)
        return;
      area.style.setProperty(
        "--preview-aspect",
        String(img.naturalWidth / img.naturalHeight),
      );
    },
    [],
  );

  return (
    <ResponderScope>
      <div
        ref={setRoot}
        data-slot="tug-attachment-preview-sheet"
        className="tug-attachment-preview-sheet"
        data-density={density === "compact" ? "compact" : undefined}
        // The whole preview refuses first-responder promotion: a
        // pointer-down anywhere inside must NOT coarsen the key view onto
        // the sheet box and strip the Done button of its seeded default
        // ring. Done stays the resting default; Tab still reaches Copy.
        data-tug-focus="refuse"
        onFocus={handleRootFocus}
      >
        {/* Top bar — title at the left, a right-aligned actions cluster.
            The sheet runs with `hideHeader`, so this bar owns the title. */}
        <div
          data-slot="tug-attachment-preview-sheet__bar"
          className="tug-attachment-preview-sheet__bar"
        >
          <span className="tug-attachment-preview-sheet__title">{title}</span>
          <div className="tug-attachment-preview-sheet__actions">
            <BlockCopyButton
              subtype="text"
              size={CHROME_SIZE[density].copy}
              emphasis="outlined"
              aria-label="Copy image"
              data-slot="tug-attachment-preview-sheet__copy"
              disabled={dataUrl === null}
              copyAction={() => copyImageToClipboard(dataUrl ?? "")}
              focusGroup={focusGroup}
              focusOrder={PREVIEW_COPY_ORDER}
            />
          </div>
        </div>
        <div
          ref={imageAreaRef}
          data-slot="tug-attachment-preview-sheet__image-area"
          data-tug-aspect-region=""
          className="tug-attachment-preview-sheet__image-area"
        >
          {dataUrl !== null ? (
            <img
              data-slot="tug-attachment-preview-sheet__image"
              className="tug-attachment-preview-sheet__image"
              src={dataUrl}
              alt={atom?.label ?? title}
              onLoad={handleImageLoad}
            />
          ) : (
            <div
              data-slot="tug-attachment-preview-sheet__empty"
              className="tug-attachment-preview-sheet__empty"
              aria-hidden="true"
            />
          )}
        </div>
        {/* Footer — a three-part flex row: a left cell (Delete when
            compose-phase), the centered paging dots, and the right-aligned
            Done button. The outer cells are equal-weight so the dots land
            on the row's true center while Done stays pinned to the trailing
            edge. */}
        <div className="tug-attachment-preview-sheet__footer">
          <div className="tug-attachment-preview-sheet__footer-side">
            {hasDelete && (
              <TugPushButton
                emphasis="outlined"
                role="danger"
                size={CHROME_SIZE[density].button}
                onClick={() => onRemove?.(atom as AtomSegment)}
                focusGroup={focusGroup}
                focusOrder={PREVIEW_DELETE_ORDER}
              >
                Delete
              </TugPushButton>
            )}
          </div>
          {/* Pager — a roving item-container ([P01]). The container is the
              single Tab stop; the dots are its cursor members. ←/→ rove the
              cursor and `live` commit pages the image. A click moves the
              cursor too (`setCursor`) so pointer and keyboard share one
              selection. Rendered only for a multi-image set. */}
          {hasPager ? (
            <div
              ref={pager.attachRoot}
              onKeyDown={pager.onKeyDown}
              data-slot="tug-attachment-preview-sheet__pager"
              className="tug-attachment-preview-sheet__pager"
              role="tablist"
              aria-label="Image"
            >
              {atoms.map((a, i) => (
                <button
                  key={
                    a.id !== undefined && a.id.length > 0
                      ? `id-${a.id}`
                      : `pos-${i}`
                  }
                  ref={(el) => {
                    dotRefs.current[i] = el;
                  }}
                  type="button"
                  className="tug-attachment-preview-sheet__dot"
                  data-active={i === index ? "" : undefined}
                  role="tab"
                  aria-selected={i === index ? "true" : "false"}
                  aria-label={a.value}
                  onClick={() => {
                    pager.setCursor(i);
                    setIndex(clamp(i));
                  }}
                />
              ))}
            </div>
          ) : (
            <div
              data-slot="tug-attachment-preview-sheet__pager"
              className="tug-attachment-preview-sheet__pager"
            />
          )}
          <div className="tug-attachment-preview-sheet__footer-side tug-attachment-preview-sheet__footer-end">
            <TugPushButton
              emphasis="primary"
              role="action"
              size={CHROME_SIZE[density].button}
              onClick={onClose}
              focusGroup={focusGroup}
              focusOrder={PREVIEW_DONE_ORDER}
              persistentDefaultRing
            >
              Done
            </TugPushButton>
          </div>
        </div>
      </div>
    </ResponderScope>
  );
}
