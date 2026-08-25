/**
 * tug-text-editor/clipboard-filters.ts — copy / cut / paste DOM event
 * handlers for atom-bearing tug-text-editor selections.
 *
 * ## Wire format
 *
 * This module owns the *browser-mode* clipboard path (a normal Safari /
 * Chrome tab during development). Inside Tug.app (WKWebView) copy and
 * paste of atom selections go through the native NSPasteboard bridge
 * instead (see `tug-native-clipboard.ts` and `tug-text-editor.tsx`),
 * because WebKit's pasteboard normalization swallows custom MIME types
 * and sanitizes HTML — both of which silently drop atom data. The
 * native bridge writes/reads a Tug-private pasteboard type
 * (`dev.tug.prompt-atoms`) carrying the same sidecar this module emits,
 * so the wire schema below is shared across both paths.
 *
 * In browser mode, two payloads land on the system clipboard for every
 * copy / cut:
 *
 * 1. `text/plain`: human-readable text where each U+FFFC has been
 *    substituted with the atom's label. External apps that paste
 *    plain text see meaningful characters, not tofu glyphs.
 * 2. `application/x-tug-atoms`: the raw JSON sidecar
 *    (`{version, text, atoms}`). Within one browser, the synchronous
 *    `copy`/`paste` event preserves this custom type in-process, so the
 *    paste handler reads it straight back — no HTML envelope needed.
 *
 * ## Self-contained sidecar (atoms carry their bytes)
 *
 * The sidecar is fully self-contained so a selection round-trips across
 * cards / windows / sessions, not just within the card that still holds
 * the bytes. Each atom entry carries its `segment` (including the
 * optional `id`) and, for image atoms whose bytes live in the per-card
 * `AtomBytesStore`, the `bytes` themselves. On paste the handler
 * rehydrates those bytes into the destination card's store keyed by the
 * atom id, so the chip reconstitutes fully — image preview, submit-time
 * wire payload, and all.
 *
 * Laws: [L06] DOM clipboard manipulation, no React state, [L07]
 *        event handlers receive the live `view` from CM6's dispatch,
 *        [L11] clipboard operations are responder actions on the
 *        component-owned document, [L19] file structure, [L22]
 *        direct DOM event handling without React round-trip.
 */

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { TUG_ATOM_CHAR, type AtomSegment } from "@/lib/tug-atom-img";
import {
  addAtomsEffect,
  getAtomsInRange,
  type PositionedAtom,
} from "./atom-decoration";
import { processAttachmentFiles } from "./drop-extension";
import { downsampleImage } from "@/lib/image-downsample";
import type { AtomBytesEntry, AtomBytesStore } from "@/lib/atom-bytes-store";
import {
  hasNativeClipboardBridge,
  readClipboardViaNative,
  writeClipboardViaNative,
} from "@/lib/tug-native-clipboard";
import { clipboardOriginFor } from "@/lib/clipboard-origin";

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/** Custom MIME type carrying the atom-sidecar JSON inside a tug clipboard. */
export const TUG_ATOMS_MIME = "application/x-tug-atoms";

/**
 * Schema for the sidecar payload. `version` allows future evolution;
 * any reader should refuse to apply payloads with versions it does
 * not understand and fall back to plain-text paste.
 *
 * `text` carries the document text with U+FFFC at each atom position;
 * `atoms` carries one entry per U+FFFC with the segment data. The
 * payload is fully self-contained — a paste handler can rebuild the
 * destination doc + decorations from this alone, no dependency on
 * `text/plain` (which the browser may or may not have available, and
 * which carries label-substituted text anyway).
 */
export interface TugAtomsClipboardPayload {
  version: 1;
  /** Document text with U+FFFC at atom positions. */
  text: string;
  /** Atoms aligned with U+FFFC characters in `text`. */
  atoms: TugAtomsClipboardEntry[];
  /**
   * The absolute project roots this text was READ against — its provenance.
   *
   * Prose cites files the way people talk about them: `tugdeck/src/x.css:12`,
   * relative to a repo root the sentence never names because everyone reading
   * it in place already knows which one. Carry the text somewhere else and the
   * citation is unresolvable, not because anything was lost but because the
   * root was never written down. This is where it gets written down.
   *
   * It is the same argument {@link TugAtomsClipboardEntry.assetPath} makes for
   * an attachment — a relative link means nothing without its document — one
   * level up: for the sentence rather than the link.
   *
   * A LIST, because a destination accumulates. A jot pasted into twice from
   * two projects is about both, and dropping the first root to record the
   * second would put out links that were working a moment ago. Readers try
   * every root and take the first that confirms.
   *
   * Absent for a copy from a surface with no project — which is honest, and
   * leaves the destination exactly as well off as it was before any of this.
   */
  origins?: string[];
  /**
   * Ranges of `text` that are markdown links to attached files, for the
   * attachments a *document* copy carries that are not atoms.
   *
   * The atom schema is positional — one U+FFFC per entry — and a markdown link
   * is a range of literal text, so the two do not fit the same shape. An image
   * link is substituted with U+FFFC and rides as an ordinary atom entry, which
   * is what lets the prompt entry reconstitute it as an image chip with no
   * special case at all. A **non-image** link stays literal text and is
   * recorded here instead: the prompt inserts it as markup untouched, because
   * there is no atom entry to place — which is how "non-images in the prompt
   * are markup, never atoms" holds by construction rather than by a rule
   * somebody has to remember ([P05]).
   *
   * A destination that also understands documents uses these ranges to copy
   * the bytes into its own asset base and rewrite the link when it resolves
   * somewhere else.
   */
  assets?: TugAtomsClipboardAssetRange[];
}

/** One non-atom asset link inside a copied range. */
export interface TugAtomsClipboardAssetRange {
  /** Offset into the payload's `text` where the link begins. */
  from: number;
  /** Offset just past the link's closing `)`. */
  to: number;
  /** The file's absolute, canonical path — see {@link TugAtomsClipboardEntry.assetPath}. */
  assetPath: string;
  /** The file's own name, for the destination's link label. */
  assetName: string;
}

/**
 * One atom in the sidecar. `segment` carries the display identity
 * (including the optional `id`); `bytes` carries the image payload for
 * atoms whose bytes lived in the source card's `AtomBytesStore`, so the
 * sidecar is self-contained — a paste destination rehydrates the bytes
 * into its own store keyed by `segment.id` without any dependency on the
 * source card. Absent for non-image atoms (file / command / link / doc)
 * and for image atoms whose bytes had been evicted before the copy.
 */
export interface TugAtomsClipboardEntry {
  position: number;
  segment: AtomSegment;
  bytes?: AtomBytesEntry;
  /**
   * Absolute, canonical path of the file this atom stands for.
   *
   * A relative link means nothing without its document, and the absolute path
   * is the only spelling that survives a hop through the clipboard into a
   * surface with a different base — the prompt entry has a project directory,
   * but it is not the document the link was relative to. A destination uses it
   * to copy the bytes into its own asset base when it needs its own copy
   * ([P04]).
   *
   * This is also the *original* file, where `bytes.content` is a downsample.
   * A destination that is writing a file to disk must read from here, never
   * from `content`, or it stores a degraded copy that looks perfectly fine.
   */
  assetPath?: string;
  /** The file's own name, for the destination's link label. */
  assetName?: string;
}

/**
 * Output of `serializeClipboard`. The DOM event handler below wires
 * each field to a clipboard MIME type; tests round-trip the fields
 * via `parseClipboardSidecar`.
 */
export interface ClipboardSerialization {
  /** Plain text including U+FFFC at atom positions. */
  text: string;
  /** Plain text with atom labels in place of U+FFFC — for external apps. */
  fallback: string;
  /** JSON sidecar payload with atom data; null if no atoms in range. */
  sidecar: TugAtomsClipboardPayload | null;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a `[from, to)` slice of an editor state into clipboard
 * payloads. Pure: takes only the data it needs, returns plain values.
 * Tested in isolation; the DOM event handler below is the thin shell.
 *
 * `getBytes`, when supplied, resolves an atom id to its stored image
 * bytes so the sidecar can carry them inline (self-contained paste). It
 * is the source card's `AtomBytesStore.get`; omit it (or return null)
 * for editors without a bytes-store, in which case image atoms travel
 * as metadata only.
 */
export function serializeClipboard(
  text: string,
  atoms: readonly PositionedAtom[],
  from: number,
  getBytes?: (id: string) => AtomBytesEntry | null,
  origins?: readonly string[],
): ClipboardSerialization {
  const local: TugAtomsClipboardEntry[] = atoms.map((a) => {
    const entry: TugAtomsClipboardEntry = {
      position: a.position - from,
      segment: a.segment,
    };
    const id = a.segment.id;
    if (id !== undefined && getBytes !== undefined) {
      const bytes = getBytes(id);
      if (bytes !== null) entry.bytes = bytes;
    }
    return entry;
  });

  let fallback = text;
  if (local.length > 0) {
    // Replace each U+FFFC with the corresponding atom's label, walking
    // back-to-front so earlier replacements don't shift later positions.
    const sorted = [...local].sort((a, b) => b.position - a.position);
    for (const a of sorted) {
      fallback = fallback.slice(0, a.position)
        + a.segment.label
        + fallback.slice(a.position + 1);
    }
  }

  // A selection with no atoms still earns a sidecar when it has provenance to
  // carry: plain prose citing a file is the ordinary case, not the exotic one,
  // and it is the case with nothing else to ride on.
  const carried = parseOrigins(origins ?? null);
  const sidecar: TugAtomsClipboardPayload | null =
    local.length > 0 || carried !== null
      ? { version: 1, text, atoms: local }
      : null;
  if (sidecar !== null && carried !== null) sidecar.origins = carried;

  return {
    text,
    fallback,
    sidecar,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Validate and parse a JSON sidecar payload. The sidecar travels two
 * ways into this function:
 *   - browser-mode paste reads `application/x-tug-atoms` from
 *     `clipboardData` and hands the raw JSON here;
 *   - the Tug.app native bridge reads the `dev.tug.prompt-atoms`
 *     pasteboard type and hands the raw JSON here.
 *
 * Preserves the optional `segment.id` and per-atom `bytes` (the
 * self-contained image payload) so a paste destination can rehydrate
 * the bytes into its own store. Returns null on malformed JSON or
 * schema mismatch, so the caller falls back to plain-text paste.
 */
export function parseClipboardSidecar(
  raw: string,
): TugAtomsClipboardPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== 1) return null;
    if (typeof obj.text !== "string") return null;
    const atomsRaw = obj.atoms;
    if (!Array.isArray(atomsRaw)) return null;
    const out: TugAtomsClipboardEntry[] = [];
    for (const a of atomsRaw as unknown[]) {
      if (typeof a !== "object" || a === null) return null;
      const entry = a as Record<string, unknown>;
      if (typeof entry.position !== "number") return null;
      const seg = entry.segment as Record<string, unknown> | undefined;
      if (!seg || seg.kind !== "atom") return null;
      if (typeof seg.type !== "string") return null;
      if (typeof seg.label !== "string") return null;
      if (typeof seg.value !== "string") return null;
      const segment: AtomSegment = {
        kind: "atom",
        type: seg.type,
        label: seg.label,
        value: seg.value,
      };
      if (typeof seg.id === "string") segment.id = seg.id;
      const out_entry: TugAtomsClipboardEntry = {
        position: entry.position,
        segment,
      };
      const bytes = parseBytesEntry(entry.bytes);
      if (bytes !== null) out_entry.bytes = bytes;
      // Reconstruction means every field has to be named here or it is
      // silently dropped on every paste — "additive and optional" is free on
      // the write side and never free on the read side.
      if (typeof entry.assetPath === "string") {
        out_entry.assetPath = entry.assetPath;
      }
      if (typeof entry.assetName === "string") {
        out_entry.assetName = entry.assetName;
      }
      out.push(out_entry);
    }
    const payload: TugAtomsClipboardPayload = {
      version: 1,
      text: obj.text,
      atoms: out,
    };
    const assets = parseAssetRanges(obj.assets);
    if (assets !== null) payload.assets = assets;
    const origins = parseOrigins(obj.origins);
    if (origins !== null) payload.origins = origins;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Attach `origins` to a sidecar, minting one when the copy had no other reason
 * to carry a sidecar at all. Returns `null` only when there is nothing to say:
 * no atoms, no assets, no provenance.
 *
 * Every copy path that knows its project calls this on the way to the write,
 * which is what keeps "prose carries its root" from being a rule each surface
 * re-implements slightly differently.
 */
export function withClipboardOrigins(
  sidecar: TugAtomsClipboardPayload | null,
  text: string,
  origins: readonly string[] | string | null | undefined,
): TugAtomsClipboardPayload | null {
  const list = parseOrigins(
    typeof origins === "string" ? [origins] : (origins ?? null),
  );
  if (list === null) return sidecar;
  const base: TugAtomsClipboardPayload = sidecar ?? {
    version: 1,
    text,
    atoms: [],
  };
  return { ...base, origins: list };
}

/**
 * Validate the payload's optional `origins` list: absolute paths only, deduped,
 * order preserved. Returns `null` when nothing usable survives, so a malformed
 * field degrades to "this copy carried no provenance" rather than to a root
 * that resolves paths against the wrong repository.
 *
 * Absolute is not a formality. A relative root would have to be resolved
 * against something, and the only candidate is the destination's own project —
 * which is exactly the assumption this field exists to stop making.
 */
export function parseOrigins(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "string") continue;
    if (!item.startsWith("/")) continue;
    if (!out.includes(item)) out.push(item);
  }
  return out.length > 0 ? out : null;
}

/**
 * Validate the payload's optional `assets` range list. Returns `null` when it
 * is absent or unusable, which degrades to reference-only paste — a correct
 * behavior rather than a broken one.
 */
function parseAssetRanges(
  raw: unknown,
): TugAtomsClipboardAssetRange[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TugAtomsClipboardAssetRange[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.from !== "number" || typeof r.to !== "number") continue;
    if (typeof r.assetPath !== "string" || typeof r.assetName !== "string") {
      continue;
    }
    out.push({
      from: r.from,
      to: r.to,
      assetPath: r.assetPath,
      assetName: r.assetName,
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Validate a sidecar atom's `bytes` field against the `AtomBytesEntry`
 * shape. Returns null for absent or malformed bytes — an atom without
 * recoverable bytes still pastes as a (pending) chip; we just don't
 * rehydrate the store for it.
 */
function parseBytesEntry(raw: unknown): AtomBytesEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.content !== "string") return null;
  if (typeof b.mediaType !== "string") return null;
  const entry: AtomBytesEntry = { content: b.content, mediaType: b.mediaType };
  if (typeof b.thumbnailDataUrl === "string") {
    entry.thumbnailDataUrl = b.thumbnailDataUrl;
  }
  // `path` names the ORIGINAL upload, where `content` is the downsample. A
  // destination writing a file to disk reads from the path; dropping it here
  // would leave it able to reach only the degraded copy, and store that
  // instead — a corruption that renders perfectly and is invisible until
  // somebody opens the file expecting their original.
  if (typeof b.path === "string") {
    entry.path = b.path;
  }
  // The dropped file's own name, which is what a destination writing it into a
  // document's `assets/` names the file and labels the link by. Dropping it
  // here would leave `path`'s UUID as the only name available.
  if (typeof b.name === "string") {
    entry.name = b.name;
  }
  return entry;
}

/**
 * Rehydrate a sidecar's image bytes into a destination `AtomBytesStore`.
 * For each pasted atom that carries both an `id` and `bytes`, `put` the
 * bytes keyed by id so the reconstituted chip resolves non-pending and
 * the submit-time wire payload finds its image. No-op for atoms without
 * bytes (file / command / link / doc) and when no store is available.
 *
 * Shared by the browser-mode paste handler and the native-bridge paste
 * path so both reconstitute images identically.
 */
export function rehydrateSidecarBytes(
  payload: TugAtomsClipboardPayload,
  store: AtomBytesStore | null,
): void {
  if (store === null) return;
  for (const a of payload.atoms) {
    const id = a.segment.id;
    if (id === undefined) continue;
    if (a.bytes !== undefined) {
      store.put(id, a.bytes);
      continue;
    }
    // An attachment copied out of a *document* carries no inline bytes — the
    // strip it came from never held any, painting straight from disk instead.
    // Seed the entry from its path and read the file in; the chip renders from
    // the path immediately and resolves to real bytes when they land, which is
    // what `buildWirePayload` needs to submit it.
    if (a.assetPath !== undefined && a.assetPath.length > 0) {
      store.put(id, { content: "", mediaType: "", path: a.assetPath });
      fetchSidecarAssetBytes(id, a.assetPath, store);
    }
  }
}

/**
 * Read an asset off disk and put it in `store` as real, submittable bytes.
 *
 * Fire-and-forget, and deliberately downsampled: this is the prompt entry's
 * contract, where the bytes exist in JS because they are about to go on the
 * wire. What stays on disk is the untouched original, and `path` keeps
 * pointing at it — the same shape a restored draft attachment has.
 */
function fetchSidecarAssetBytes(
  id: string,
  path: string,
  store: AtomBytesStore,
): void {
  void (async () => {
    try {
      const res = await fetch(`/api/fs/blob?path=${encodeURIComponent(path)}`);
      if (!res.ok) return;
      const outcome = await downsampleImage(await res.blob());
      if (!outcome.ok) return;
      // Re-read rather than reconstruct: the user may have removed the chip
      // while the read was in flight.
      if (store.get(id) === null) return;
      store.put(id, {
        content: outcome.result.content,
        mediaType: outcome.result.mediaType,
        thumbnailDataUrl: outcome.result.thumbnailDataUrl,
        path,
      });
    } catch {
      // The file moved or was deleted. The chip keeps its path-only entry,
      // which paints but submits as preview-only — the pre-existing
      // degradation for an attachment whose bytes cannot be read.
    }
  })();
}

// ---------------------------------------------------------------------------
// DOM event handlers
// ---------------------------------------------------------------------------

/**
 * Handle a copy/cut event on the editor. Writes the plain-text and
 * sidecar payloads, then on cut dispatches a delete transaction
 * through the view. Returns `true` if the event was fully handled
 * (so the caller's `domEventHandlers` should `preventDefault`).
 *
 * Inside Tug.app the sidecar goes on the **native** pasteboard, not on this
 * event's `clipboardData`. ⌘C and ⌘X are `routing: "native"` commands, so
 * AppKit performs them against the WKWebView and this DOM handler is what
 * actually runs — the responder action's native write never fires for a
 * keystroke. And a custom MIME type set on `clipboardData` does not survive
 * WebKit's pasteboard normalization, which is the whole reason the bridge
 * exists. Left to `setData` alone, every keyboard copy of an attachment
 * arrived at its destination as the label text and nothing else.
 */
function handleCopyOrCut(
  view: EditorView,
  event: ClipboardEvent,
  isCut: boolean,
  getBytesStore: () => AtomBytesStore | null,
): boolean {
  const { from, to } = view.state.selection.main;
  if (from === to) return false; // empty selection — let CM6 default fire

  const text = view.state.doc.sliceString(from, to);
  const atoms = getAtomsInRange(view.state, from, to);
  const store = getBytesStore();
  const getBytes = store !== null ? (id: string) => store.get(id) : undefined;
  // An editor is a surface like any other: text copied out of one carries the
  // project it was written against, read off the nearest stamp above the
  // editor's own DOM.
  const origin = clipboardOriginFor(view.dom);
  const payload = serializeClipboard(
    text,
    atoms,
    from,
    getBytes,
    origin === null ? undefined : [origin],
  );

  const wroteNatively =
    payload.sidecar !== null &&
    hasNativeClipboardBridge() &&
    writeClipboardViaNative(payload.fallback, JSON.stringify(payload.sidecar));

  if (!wroteNatively) {
    const dt = event.clipboardData;
    if (dt === null) return false;
    if (payload.sidecar !== null) {
      dt.setData("text/plain", payload.fallback);
      dt.setData(TUG_ATOMS_MIME, JSON.stringify(payload.sidecar));
    } else {
      dt.setData("text/plain", payload.text);
    }
  }

  event.preventDefault();

  if (isCut) {
    view.dispatch({
      changes: { from, to, insert: "" },
      selection: { anchor: from },
      userEvent: "delete.cut",
    });
  }
  return true;
}

/**
 * Walk a `DataTransferItemList` and return the `File` objects for
 * items whose MIME starts with `image/`. The shape DataTransferItem
 * is awkward — items can be type `file`, type `string`, or both —
 * and `getAsFile()` returns `null` for non-file items. This helper
 * isolates that quirk so the paste handler stays readable.
 *
 * Returns `null` when no image items are present (the common case —
 * text paste, internal sidecar paste); callers fall through to the
 * sidecar/text path. Returns an empty array only if items report as
 * images but `getAsFile()` yields nothing (rare; defensive).
 *
 * Exported because the Text card's paste handler asks the same question of
 * the same event. Re-authoring the `DataTransferItem` quirk-handling for the
 * second surface is how the two drifted apart the first time.
 */
export function extractImageFiles(
  items: DataTransferItemList | null,
): readonly File[] | null {
  if (items === null || items.length === 0) return null;
  const out: File[] = [];
  let anyImage = false;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== "file") continue;
    if (!item.type.startsWith("image/")) continue;
    anyImage = true;
    const file = item.getAsFile();
    if (file !== null) out.push(file);
  }
  return anyImage ? out : null;
}

/**
 * Handle a paste event in browser mode (the substrate's
 * native-bridge paste path lives in `tug-text-editor.tsx` and calls
 * `parseClipboardHtmlEnvelope` directly). The browser-mode handler
 * has three branches in priority order:
 *
 *  1. **Image clipboard items.** If `clipboardData.items` contains
 *     one or more `image/*` files (Cmd+Shift+4 screenshot pastes,
 *     copy-from-Preview, etc.), claim the event and route the files
 *     through the same async pipeline drop uses — downsample, mint
 *     ids, populate the bytes-store, insert atoms.
 *  2. **Tug atom sidecar.** The custom MIME (`application/x-tug-atoms`)
 *     carries an internal copy from another tug surface. Decodes
 *     and re-inserts atoms verbatim.
 *  3. **Default.** Returns false; CM6's default text-paste path
 *     handles the event.
 *
 * Image pastes only fire when a bytes-store is available. Without a
 * store (gallery card, future detached prompt-entry), image items
 * fall through to the next branch — typically nothing comes back
 * since clipboards with image items don't usually carry the
 * substrate's atom sidecar.
 */
/**
 * Insert a parsed sidecar at the selection: its text, its atoms placed at their
 * carried offsets, and any image bytes rehydrated into this card's store first
 * so the reconstituted chips resolve non-pending immediately.
 *
 * One implementation for both routes into an atom paste — the DOM event's own
 * `application/x-tug-atoms`, and the native pasteboard read below it. They
 * inserted the same thing two ways before, which is one edit away from two
 * behaviors for one gesture.
 */
export function insertSidecar(
  view: EditorView,
  sidecar: TugAtomsClipboardPayload,
  bytesStore: AtomBytesStore | null,
  resolve: PastedCommandResolver | null = null,
): void {
  rehydrateSidecarBytes(sidecar, bytesStore);
  const { from, to } = view.state.selection.main;
  // A sidecar paste is still a paste: a leading slash command chips here
  // exactly as it does on the plain-text route. A copy from a Tug surface
  // carries a sidecar even when it holds no atoms at all — provenance alone
  // mints one — so without this the same text chips when it comes from
  // another app and does not when it comes from Tug.
  const commandPlan =
    resolve !== null ? planLeadingCommandSidecar(sidecar, from, resolve) : null;
  const insert = commandPlan?.insert ?? sidecar.text;
  const atoms = commandPlan?.atoms ?? sidecar.atoms;
  const placedAtoms: PositionedAtom[] = atoms.map((a) => ({
    position: from + a.position,
    segment: a.segment,
  }));
  view.dispatch({
    changes: { from, to, insert },
    effects: placedAtoms.length > 0 ? addAtomsEffect.of(placedAtoms) : [],
    selection: { anchor: from + insert.length },
    userEvent: "input.paste",
    // Reveal the caret after the paste — without this the sidecar-paste path
    // leaves the caret below the fold on a paste that overflows the visible
    // rows. (The `keepCaretVisible` listener also re-checks post-layout, but
    // flag the transaction too for the immediate case.)
    scrollIntoView: true,
  });
}

function handlePaste(
  view: EditorView,
  event: ClipboardEvent,
  getBytesStore: () => AtomBytesStore | null,
  onAttachmentError: (message: string) => void,
  getPastedCommandResolver: () => PastedCommandResolver | null,
  onPastedOrigins: (origins: readonly string[]) => void,
): boolean {
  const dt = event.clipboardData;
  if (dt === null) return false;

  // Branch 1: image clipboard items. Only fires when a bytes-store
  // is available; otherwise we have nowhere to stash the bytes and
  // the user would get an atom with no content.
  const bytesStore = getBytesStore();
  if (bytesStore !== null) {
    const imageFiles = extractImageFiles(dt.items);
    if (imageFiles !== null && imageFiles.length > 0) {
      event.preventDefault();
      const { from } = view.state.selection.main;
      void processAttachmentFiles(
        view,
        imageFiles,
        from,
        bytesStore,
        onAttachmentError,
      );
      return true;
    }
  }

  // Branch 2: tug atom sidecar (internal copy/paste).
  const sidecarRaw = dt.getData(TUG_ATOMS_MIME);
  if (sidecarRaw !== "") {
    const sidecar = parseClipboardSidecar(sidecarRaw);
    if (sidecar !== null) {
      insertSidecar(view, sidecar, bytesStore, getPastedCommandResolver());
      // The provenance the copy carried. Reported rather than applied: what to
      // do with a root is the HOST's question — a jot records it, the prompt
      // entry has a project of its own and ignores it.
      if (sidecar.origins !== undefined) onPastedOrigins(sidecar.origins);
      event.preventDefault();
      return true;
    }
  }

  // Branch 2b: the sidecar is on the PASTEBOARD but not in this event.
  //
  // Inside Tug.app an atom copy is written natively, to the Tug-private
  // `dev.tug.prompt-atoms` pasteboard type — the whole reason that path exists
  // is that WebKit's pasteboard normalization swallows custom MIME types. The
  // consequence is that a DOM `paste` event's `clipboardData` cannot see it:
  // `getData(TUG_ATOMS_MIME)` above comes back empty for a clipboard that
  // demonstrably carries an atom, and the paste falls through to plain text.
  // That is a session atom copied from the Session Summary panel, a Overview
  // ref, or a History line landing in the composer as its citation string.
  //
  // The editor's own ⌘V responder action reads the native bridge and does the
  // right thing; this branch is for every paste that reaches the DOM event
  // instead — a menu Paste, a middle-click, a keystroke WebKit handled before
  // the chain saw it. Claim the event and ask the bridge.
  //
  // Deliberately narrow: only when the bridge exists (inside Tug.app), only
  // after the DOM has been given every chance above, and the read's own plain
  // text is the fallback — so a clipboard with no sidecar still pastes exactly
  // what it would have pasted, just via one async hop.
  if (hasNativeClipboardBridge()) {
    event.preventDefault();
    const domText = dt.getData("text/plain");
    void readClipboardViaNative().then(({ text, atoms }) => {
      const sidecar = atoms !== "" ? parseClipboardSidecar(atoms) : null;
      if (sidecar !== null) {
        insertSidecar(view, sidecar, getBytesStore(), getPastedCommandResolver());
        if (sidecar.origins !== undefined) onPastedOrigins(sidecar.origins);
        return;
      }
      const plain = text !== "" ? text : domText;
      if (plain === "") return;
      const late = getPastedCommandResolver();
      if (late !== null && tryInsertLeadingCommandPaste(view, plain, late)) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: plain },
        selection: { anchor: from + plain.length },
        userEvent: "input.paste",
        scrollIntoView: true,
      });
    });
    return true;
  }

  // Branch 3: external plain text whose first position is an exact slash
  // command → chip it, keeping the rest of the paste as its argument text.
  const resolve = getPastedCommandResolver();
  if (resolve !== null) {
    const plain = dt.getData("text/plain");
    if (plain !== "" && tryInsertLeadingCommandPaste(view, plain, resolve)) {
      event.preventDefault();
      return true;
    }
  }

  // Branch 4: default — CM6's plain-text paste handles the event.
  return false;
}

// ---------------------------------------------------------------------------
// Leading-command paste
// ---------------------------------------------------------------------------

/**
 * Resolve a pasted command token to the atom segment to chip it as, or `null`
 * when the token isn't a recognized command. Both the full namespaced name
 * (`tugplug:implement`) and its unqualified leaf (`implement`) resolve — the
 * same rule as accepting a typed `/command ` against the popup. The host builds
 * this from its live command catalog; omitted (gallery / standalone) ⇒ no
 * recognition.
 */
export type PastedCommandResolver = (token: string) => AtomSegment | null;

/**
 * When pasted plain text begins with `/<command>` and the paste lands at the
 * document's very first position, replace that `/<command>` with a command chip
 * and keep the remaining pasted text as its argument — e.g. pasting
 * `/tugplug:implement dash/foo.md` yields `[chip] dash/foo.md`. The
 * insert and the atom decoration go out in one transaction.
 *
 * Returns true (and dispatches) on a recognized leading command; returns false
 * — no dispatch — when the caret isn't at offset 0, the text has no leading
 * `/token`, or the token isn't a known command, so the caller's default paste
 * runs untouched.
 */
export function tryInsertLeadingCommandPaste(
  view: EditorView,
  text: string,
  resolve: PastedCommandResolver,
): boolean {
  const { from, to } = view.state.selection.main;
  const plan = planLeadingCommandPaste(text, from, resolve);
  if (plan === null) return false;
  view.dispatch({
    changes: { from, to, insert: plan.insert },
    effects: addAtomsEffect.of([{ position: from, segment: plan.segment }]),
    selection: { anchor: from + plan.insert.length },
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  return true;
}

/**
 * Pure decision behind {@link tryInsertLeadingCommandPaste}: given the pasted
 * text, the caret offset it lands at, and the resolver, return the text to
 * insert (the atom's U+FFFC char + a separator + the remaining pasted text) and
 * the command's atom segment — or `null` when there's nothing to chip: the
 * caret isn't at offset 0, the text has no leading `/token`, or the token isn't
 * a known command. A separating space follows the chip (as a typed accept
 * leaves) unless the remaining pasted text already opens with whitespace, so
 * the chip never glues onto an argument nor doubles a space. Exported for the
 * test suite.
 */
export function planLeadingCommandPaste(
  text: string,
  from: number,
  resolve: PastedCommandResolver,
): { insert: string; segment: AtomSegment; consumed: number } | null {
  // Only when the command would occupy the document's first position.
  if (from !== 0) return null;
  const match = /^\/(\S+)/.exec(text);
  if (match === null) return null;
  const segment = resolve(match[1]!);
  if (segment === null) return null;
  // The token is `\S+`, so `rest` is empty or already starts with whitespace;
  // add the separator only when it doesn't (i.e. the command stood alone).
  const rest = text.slice(match[0].length);
  const sep = /^\s/.test(rest) ? "" : " ";
  return {
    insert: TUG_ATOM_CHAR + sep + rest,
    segment,
    consumed: match[0].length,
  };
}

/**
 * The {@link planLeadingCommandPaste} decision for a paste that arrives as a
 * SIDECAR — a copy from another Tug surface — rather than as plain text.
 *
 * The command chips the same way, and the sidecar's own atoms ride along at
 * their offsets, shifted by however much shorter the chip is than the
 * `/command` text it replaced. Returns `null` for every case the plain-text
 * planner returns null for, plus one of its own: an atom sitting INSIDE the
 * leading token. U+FFFC is not whitespace, so `/⟦atom⟧` matches the token
 * regex without the token ever having been text — that paste inserts verbatim.
 *
 * Positions are relative to the insert, as the sidecar's own are; the caller
 * offsets them by the paste point. Exported for the test suite.
 */
export function planLeadingCommandSidecar(
  sidecar: TugAtomsClipboardPayload,
  from: number,
  resolve: PastedCommandResolver,
): { insert: string; atoms: readonly PositionedAtom[] } | null {
  const plan = planLeadingCommandPaste(sidecar.text, from, resolve);
  if (plan === null) return null;
  if (sidecar.atoms.some((a) => a.position < plan.consumed)) return null;
  // Everything after the token keeps its distance from the END of the text,
  // which is the one measurement the rewrite leaves alone.
  const atoms: PositionedAtom[] = [{ position: 0, segment: plan.segment }];
  for (const a of sidecar.atoms) {
    atoms.push({
      position: plan.insert.length - (sidecar.text.length - a.position),
      segment: a.segment,
    });
  }
  return { insert: plan.insert, atoms };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Build the clipboard extension. Optional thunks unlock the
 * image-paste branch ([Step 2] of `dash/dev-atoms.md`):
 *
 *  - `getBytesStore`: per-card bytes-store; when present, image
 *    clipboard items route through the async downsample pipeline.
 *    Default `() => null` keeps the pre-Step-2 behavior (image
 *    pastes fall through to text).
 *  - `onAttachmentError`: surfaces downsample-rejection messages on
 *    the host's banner channel. Default no-op.
 *
 * Copy and cut paths are unchanged; they don't need the new params.
 */
export function clipboardExtension(
  getBytesStore: () => AtomBytesStore | null = () => null,
  onAttachmentError: (message: string) => void = () => undefined,
  getPastedCommandResolver: () => PastedCommandResolver | null = () => null,
  onPastedOrigins: (origins: readonly string[]) => void = () => undefined,
): Extension {
  return EditorView.domEventHandlers({
    copy(event, view) {
      return handleCopyOrCut(view, event, false, getBytesStore);
    },
    cut(event, view) {
      return handleCopyOrCut(view, event, true, getBytesStore);
    },
    paste(event, view) {
      return handlePaste(
        view,
        event,
        getBytesStore,
        onAttachmentError,
        getPastedCommandResolver,
        onPastedOrigins,
      );
    },
  });
}

/**
 * Pre-Step-2 const export. Equivalent to `clipboardExtension()` with
 * default thunks (no bytes-store wiring, no error surfacing). Kept
 * for consumers (and tests) that don't participate in attachment
 * bytes; new consumers should call `clipboardExtension` directly.
 */
export const clipboardExt: Extension = clipboardExtension();

// `TUG_ATOM_CHAR` is re-exported from this module so callers (notably
// tests) can build sidecar fixtures without a separate import. It's
// the same character `tug-atom-img` exports.
export { TUG_ATOM_CHAR };
