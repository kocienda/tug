/**
 * tug-text-editor/atom-decoration.ts — atom widgets and the decoration field
 * that holds them.
 *
 * Atoms in the editor's text stream are represented by U+FFFC (the
 * Object Replacement Character). For every U+FFFC position we want
 * to render as an atom, the `atomDecorationField` carries a
 * `Decoration.replace` over `[pos, pos + 1)` whose widget renders the
 * styled `<img>` produced by `tug-atom-img.ts` [D05]. The flat-text
 * representation matches the existing `TugTextEngine` model, so
 * `view.state.doc.toString()` round-trips through the same offset
 * semantics.
 *
 * The decoration field's range set is also the source the
 * `atomicRanges` provider reads (see `atomic-ranges.ts`), so cursor
 * motion and deletion treat each atom as a single unit per [Q01].
 *
 * Theme regeneration: atom chips are baked at widget construction
 * (colors are resolved at `createAtomImgElement` call time), so a
 * theme switch must dispatch `regenerateAtomsEffect` to rebuild every
 * widget. Subscription to `subscribeThemeChange` is wired in
 * `tug-text-editor.tsx`.
 *
 * Laws: [L02] no React state for atom segments — atoms live entirely
 *        in CM6's StateField, [L06] atom widget DOM is appearance,
 *        [L07] effect handlers operate on the transaction-supplied
 *        state, [L11] atoms participate in editing actions on the
 *        component-owned document, [L19] file structure, [L22] atom
 *        operations dispatch through the CM6 transaction stream — no
 *        React round-trip.
 */

import { invertedEffects } from "@codemirror/commands";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, PluginValue, ViewUpdate } from "@codemirror/view";
import { Facet, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Range, Transaction } from "@codemirror/state";
import {
  bakeAtomChipDataUri,
  createAtomImgElement,
  TUG_ATOM_CHAR,
  type AtomSegment,
} from "@/lib/tug-atom-img";
import type { AtomBytesStore } from "@/lib/atom-bytes-store";
import type { AtomPathRoots } from "@/lib/atom-file-path";
import { stampAnnotation } from "@/lib/annotator/annotation-element";
import { payloadForAtom } from "@/lib/annotator/payloads";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Identity of an atom occurrence in the document, paired with its position. */
export interface PositionedAtom {
  /** Position of the U+FFFC character in the document. */
  position: number;
  /** Atom identity. */
  segment: AtomSegment;
}

// ---------------------------------------------------------------------------
// Bytes-store facet — read by AtomWidget at toDOM time
// ---------------------------------------------------------------------------

/**
 * CM6 facet exposing the per-card `AtomBytesStore` to atom widgets.
 * `tug-text-editor.tsx` registers it via
 * `atomBytesStoreFacet.of(getBytesStore)` so the widget can query
 * bytes-state at mount time to decide initial `pending` appearance.
 *
 * The facet carries a thunk (not the store directly) so widgets read
 * the live store at the moment of mount — matching the [L07] pattern
 * the drop / completion extensions use. Editors that don't
 * participate in attachment bytes simply don't register the facet;
 * the default thunk returns `null` and widgets render in their
 * non-pending appearance unconditionally.
 *
 * After mount, the `pendingAtomSyncPlugin` (below) takes over and
 * keeps `data-pending` synchronized with the bytes-store via direct
 * DOM mutation — no widget rebuild needed when bytes arrive.
 */
export const atomBytesStoreFacet = Facet.define<
  () => AtomBytesStore | null,
  () => AtomBytesStore | null
>({
  combine: (values) => (values.length > 0 ? values[0]! : () => null),
});

/**
 * CM6 facet exposing the roots a relative atom value may be resolved
 * against, so a widget can stamp the annotation contract on the chip it
 * mounts.
 *
 * A `file` or `directory` atom minted by an `@` mention carries a value the
 * file index reported relative to the project root, and an annotation's
 * payload is an *openable* target — so the payload cannot be built without
 * the roots. They are carried as a thunk, and read at `toDOM`, for the same
 * reason the bytes store is ([L07]): the card's binding and the session's
 * cwd both arrive after mount, and a snapshot taken at construction would
 * leave every atom placed before the first turn stamped with nothing.
 *
 * An editor that registers no roots still stamps the kinds that need none —
 * a link atom, a pasted image — because `payloadForAtom` refuses only the
 * relative path it cannot address.
 */
export const atomPathRootsFacet = Facet.define<
  () => AtomPathRoots | null,
  () => AtomPathRoots | null
>({
  combine: (values) => (values.length > 0 ? values[0]! : () => null),
});

// ---------------------------------------------------------------------------
// AtomWidget
// ---------------------------------------------------------------------------

/**
 * Module-level regeneration counter. Bumped each time
 * `regenerateAtomsEffect` is processed so that new `AtomWidget`
 * instances created after the bump compare `!eq` to instances
 * created before it. Without the bump, two widgets carrying the
 * same `segment` would be treated as identical by CM6's
 * reconciliation and the cached DOM (with stale chip colors baked at
 * the old theme's tokens) would survive a theme switch.
 *
 * The counter is read at widget construction, so any caller that
 * builds an `AtomWidget` (insertAtom, restoreState, regenerate)
 * automatically picks up the current generation. Module-level
 * because it tracks a global "render generation" the way browsers
 * track frame counts.
 */
let _atomRegenToken = 0;

/**
 * CodeMirror widget that paints an atom as a replaced inline element.
 *
 * `toDOM` defers to `createAtomImgElement` so the atom looks identical
 * to the rest of the tug ecosystem (gallery, prompt-input, prompt-entry).
 * `eq` returns true only when two widgets share both the same segment
 * identity AND the same regeneration token; theme switches bump the
 * token so the new widgets force a DOM rebuild.
 */
export class AtomWidget extends WidgetType {
  /** Render generation captured at construction. */
  public readonly regenToken: number;

  constructor(public readonly segment: AtomSegment) {
    super();
    this.regenToken = _atomRegenToken;
  }

  override eq(other: AtomWidget): boolean {
    return (
      this.regenToken === other.regenToken
      && this.segment.type === other.segment.type
      && this.segment.label === other.segment.label
      && this.segment.value === other.segment.value
    );
  }

  override toDOM(view: EditorView): HTMLImageElement {
    // Initial pending state: derived from the live bytes-store at
    // mount time. An atom with an `id` but no matching store entry
    // is mid-processing (drop fired, async byte-fill hasn't
    // completed yet); render in the pending appearance until the
    // pending-sync ViewPlugin updates the DOM. Atoms without an
    // `id` never render as pending (legacy completion atoms, link /
    // command atoms — no bytes-store relationship).
    let pending = false;
    if (this.segment.id !== undefined) {
      const getStore = view.state.facet(atomBytesStoreFacet);
      const store = getStore();
      if (store !== null && store.get(this.segment.id) === null) {
        pending = true;
      }
    }
    const img = createAtomImgElement(
      this.segment.type,
      this.segment.label,
      this.segment.value,
      { id: this.segment.id, pending },
    );
    // The chip carries the annotation contract, so one right-click path
    // serves the composer and the transcript alike: `annotationFromEvent`
    // reads a real payload back off this element, and the registry decides
    // what a file / directory / image / link atom offers. Unguarded, because
    // an atom in an editor is a manipulable object — the guard's
    // `preventDefault` on mousedown is also what begins a selection, and a
    // chip that cannot be selected cannot be deleted where it sits.
    const payload = payloadForAtom(
      this.segment,
      view.state.facet(atomPathRootsFacet)() ?? undefined,
    );
    if (payload !== null) stampAnnotation(img, payload, { guardPress: false });
    return img;
  }

  override ignoreEvent(): boolean {
    // Allow click/mousedown to bubble so editor selection and
    // double-click-to-select-atom work through the normal pipeline.
    return false;
  }
}

// ---------------------------------------------------------------------------
// State effects
// ---------------------------------------------------------------------------

/**
 * Add atom decorations at the given positions. Each entry's `position`
 * must point at a U+FFFC character in the document — callers
 * responsible for inserting the character in the same transaction.
 */
export const addAtomsEffect = StateEffect.define<readonly PositionedAtom[]>();

/**
 * Force re-creation of every atom widget — used when colors baked into
 * the chip data URI become stale after a theme switch. The decorations'
 * positions are unchanged; only the widget instances are replaced.
 */
export const regenerateAtomsEffect = StateEffect.define<null>();

/**
 * Replace the entire atom decoration set with the supplied list.
 * Used by state-restoration paths (Step 7) and by tests that need a
 * deterministic starting point.
 */
export const replaceAtomsEffect = StateEffect.define<readonly PositionedAtom[]>();

/** One atom demotion: which decoration to drop and how to undo it. */
export interface DemotedAtom {
  /** Start offset of the decoration to drop, in the transaction's
   *  FINAL coordinates. */
  position: number;
  /** The atom as it stood in the transaction's START state — the
   *  record `atomInvertedEffects` re-adds when the demotion is
   *  undone. */
  original: PositionedAtom;
}

/**
 * Drop the atom decorations named by `position`. Needed by edits that
 * turn an atom back into literal text (command demotion): replacing
 * the U+FFFC with a longer string makes the replace-decoration
 * *stretch* over the inserted text under auto-mapping rather than
 * collapse, so neither the field's mapping nor the collapse-detection
 * in `atomInvertedEffects` sees a deletion — removal and its undo both
 * need this explicit record.
 */
export const removeAtomsEffect = StateEffect.define<readonly DemotedAtom[]>();

// ---------------------------------------------------------------------------
// atomDecorationField
// ---------------------------------------------------------------------------

/**
 * The single source of truth for atom decorations in a `TugTextEditor`
 * instance. Maps automatically through document changes: deleting a
 * range that covers a U+FFFC character drops the decoration with it.
 */
export const atomDecorationField = StateField.define<DecorationSet>({
  create(): DecorationSet {
    return Decoration.none;
  },

  update(deco: DecorationSet, tr: Transaction): DecorationSet {
    let next = deco.map(tr.changes);

    for (const effect of tr.effects) {
      if (effect.is(addAtomsEffect)) {
        next = next.update({
          add: effect.value.map(toAtomRange),
          sort: true,
        });
      } else if (effect.is(replaceAtomsEffect)) {
        next = Decoration.set(effect.value.map(toAtomRange));
      } else if (effect.is(removeAtomsEffect)) {
        const positions = new Set(effect.value.map((d) => d.position));
        next = next.update({
          filter: (from) => !positions.has(from),
        });
      } else if (effect.is(regenerateAtomsEffect)) {
        next = regenerateWidgets(next, tr.state);
      }
    }

    return next;
  },

  provide: (f) => EditorView.decorations.from(f),
});

/** Build a `Decoration.replace` range for a positioned atom. */
function toAtomRange(p: PositionedAtom): Range<Decoration> {
  return Decoration.replace({
    widget: new AtomWidget(p.segment),
    inclusive: false,
  }).range(p.position, p.position + 1);
}

/**
 * Walk the existing decoration set and construct a fresh widget for
 * each atom occurrence. Bumping `_atomRegenToken` before constructing
 * the new widgets means every new widget compares `!eq` to its
 * predecessor (segments match but tokens don't), which forces CM6's
 * reconciliation to remount the DOM and the freshly-resolved theme
 * tokens take effect inside `createAtomImgElement`.
 */
function regenerateWidgets(
  deco: DecorationSet,
  state: EditorState,
): DecorationSet {
  _atomRegenToken++;
  const ranges: Range<Decoration>[] = [];
  const cursor = deco.iter();
  while (cursor.value !== null) {
    const widget = (cursor.value.spec as { widget?: WidgetType }).widget;
    if (widget instanceof AtomWidget) {
      ranges.push(
        Decoration.replace({
          widget: new AtomWidget(widget.segment),
          inclusive: false,
        }).range(cursor.from, cursor.to),
      );
    }
    cursor.next();
  }
  // `state` is unused at present but kept in the signature so future
  // regeneration logic (e.g. font-size-driven re-layout) has access.
  void state;
  return Decoration.set(ranges);
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Enumerate every atom currently in the document, in document order.
 * The result is suitable for clipboard serialization and for state
 * preservation [L23 — Step 7].
 */
export function getAtomsInState(state: EditorState): PositionedAtom[] {
  const result: PositionedAtom[] = [];
  const cursor = state.field(atomDecorationField).iter();
  while (cursor.value !== null) {
    const widget = (cursor.value.spec as { widget?: WidgetType }).widget;
    if (widget instanceof AtomWidget) {
      result.push({ position: cursor.from, segment: widget.segment });
    }
    cursor.next();
  }
  return result;
}

/**
 * Restrict an atom list to those falling inside a half-open
 * `[from, to)` range. Used by clipboard-output to scope the sidecar
 * to the actually-selected atoms.
 */
export function getAtomsInRange(
  state: EditorState,
  from: number,
  to: number,
): PositionedAtom[] {
  const result: PositionedAtom[] = [];
  const cursor = state.field(atomDecorationField).iter();
  while (cursor.value !== null) {
    const widget = (cursor.value.spec as { widget?: WidgetType }).widget;
    if (widget instanceof AtomWidget && cursor.from >= from && cursor.from < to) {
      result.push({ position: cursor.from, segment: widget.segment });
    }
    cursor.next();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Transaction builders
// ---------------------------------------------------------------------------

/**
 * Dispatch a transaction that inserts an atom at the given position.
 * The transaction inserts U+FFFC in the document and adds the matching
 * decoration in the same step, so the editor never observes a
 * partially-applied atom. Selection lands immediately after the new
 * atom.
 */
export function insertAtomAt(
  view: EditorView,
  pos: number,
  segment: AtomSegment,
): void {
  view.dispatch({
    changes: { from: pos, insert: TUG_ATOM_CHAR },
    effects: addAtomsEffect.of([{ position: pos, segment }]),
    selection: { anchor: pos + 1 },
    scrollIntoView: true,
    userEvent: "input.tug-atom",
  });
}

/**
 * Dispatch a transaction that inserts an atom at the current selection
 * head (replacing any selected range first).
 */
export function insertAtomAtSelection(
  view: EditorView,
  segment: AtomSegment,
): void {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: TUG_ATOM_CHAR },
    effects: addAtomsEffect.of([{ position: from, segment }]),
    selection: { anchor: from + 1 },
    scrollIntoView: true,
    userEvent: "input.tug-atom",
  });
}

// ---------------------------------------------------------------------------
// History integration — inverted effects for atom deletions
// ---------------------------------------------------------------------------
//
// `atomDecorationField`'s decorations are auto-mapped through document
// changes — a deletion that covers a U+FFFC drops its decoration along
// with the character. That's correct for the forward direction, but
// breaks `undo`: when the inverse change re-inserts the U+FFFC text,
// the decoration field has no record of the atom segment that used to
// live there, so the restored character renders as a tofu glyph
// instead of an atom widget.
//
// `@codemirror/commands`' `invertedEffects` facet is the supported
// hook for "make a custom field's state survive undo": for every
// transaction recorded in history, we register effects that should
// be applied when the transaction is later undone. Here we examine
// the pre-change atom set and emit `addAtomsEffect.of(removed)` for
// any atom whose range was entirely deleted by `tr.changes`.
//
// Detection uses `mapPos` rather than `touchesRange` because
// `touchesRange === "cover"` requires *strict* containment (change
// extends past both ends of the queried range); an exact-match
// deletion of `[0, 1)` against an atom at `[0, 1)` returns `true`,
// not `"cover"`. The `mapPos` collapse test is the correct predicate:
// if the atom's start (mapped right) and end (mapped left) land at
// the same post-change position, the range collapsed to a point —
// i.e. the atom was deleted.
//
// Forward additions (paste, insertAtom, replace-state) don't need an
// inverted effect from us: the history undoes the underlying change
// (which deletes the inserted U+FFFC) and our field's auto-mapping
// drops the matching decoration along with it. So the only direction
// that needs explicit help is "atom existed before the transaction
// and was removed by it" — exactly the case `touchesRange === "cover"`
// detects.
//
// Laws: [L02] field state participates in CM6's history machinery
//        rather than being copied through React state, [L19] file
//        structure (extension lives next to the field it covers).
export const atomInvertedEffects: Extension = invertedEffects.of((tr) => {
  const result: StateEffect<unknown>[] = [];
  const before = tr.startState.field(atomDecorationField);
  const removed: PositionedAtom[] = [];
  before.between(0, tr.startState.doc.length, (from, to, value) => {
    const widget = (value.spec as { widget?: WidgetType }).widget;
    if (widget instanceof AtomWidget) {
      const mappedFrom = tr.changes.mapPos(from, 1);
      const mappedTo = tr.changes.mapPos(to, -1);
      if (mappedFrom >= mappedTo) {
        // Atom range collapsed under the change — it was deleted.
        removed.push({ position: from, segment: widget.segment });
      }
    }
  });
  // Demotions (atom → literal text) replace the U+FFFC rather than
  // delete it, so the collapse test above never sees them; the
  // `removeAtomsEffect` carries the original atom record for exactly
  // this — re-add it when the demoting transaction is undone.
  for (const effect of tr.effects) {
    if (effect.is(removeAtomsEffect)) {
      removed.push(...effect.value.map((d) => d.original));
    }
  }
  if (removed.length > 0) {
    result.push(addAtomsEffect.of(removed));
  }
  return result;
});

// ---------------------------------------------------------------------------
// Atom-by-id deletion
// ---------------------------------------------------------------------------

/**
 * Find the document position of an atom with the given id. Returns
 * `null` when no atom matches — typical when the user deleted the
 * skeleton atom themselves (Cmd-Z, backspace) before the async byte
 * fill completed.
 *
 * Used by the drop / paste pipeline's failure path: when
 * `downsampleImage` rejects an image, we look up the skeleton atom
 * by id and dispatch a deletion. Cheap O(N) walk over the
 * decoration set — N is small (atoms in a single prompt) so no
 * index needed.
 */
export function findAtomPositionById(
  state: EditorState,
  id: string,
): number | null {
  const cursor = state.field(atomDecorationField).iter();
  while (cursor.value !== null) {
    const widget = (cursor.value.spec as { widget?: WidgetType }).widget;
    if (widget instanceof AtomWidget && widget.segment.id === id) {
      return cursor.from;
    }
    cursor.next();
  }
  return null;
}

/**
 * Dispatch a transaction that deletes the skeleton atom carrying
 * `id`. The decoration field's auto-mapping drops the matching
 * widget when the U+FFFC character is removed; CM6's atomic-ranges
 * provider keeps cursor motion sane.
 *
 * No-op when the atom isn't found (user already deleted it, or the
 * id never matched a live atom — defensive).
 *
 * Used exclusively by the drop / paste pipeline's failure path; not
 * a general-purpose primitive.
 */
export function removeAtomById(view: EditorView, id: string): void {
  const pos = findAtomPositionById(view.state, id);
  if (pos === null) return;
  view.dispatch({
    changes: { from: pos, to: pos + 1, insert: "" },
    userEvent: "delete.tug-atom-attachment-error",
  });
}

// ---------------------------------------------------------------------------
// Pending-sync ViewPlugin
// ---------------------------------------------------------------------------

/**
 * Reconcile atom widgets' `data-pending` attribute with the live
 * bytes-store. Subscribes to the store at mount; on every
 * notification, walks every atom widget in `view.contentDOM` and
 * sets / clears `data-pending` based on whether that widget's
 * `data-atom-id` has a matching store entry.
 *
 * Why DOM mutation rather than CM6 widget rebuild: the bytes
 * arriving for an atom changes the atom's *appearance* only — the
 * underlying segment (type / label / value / id) is unchanged.
 * Forcing a widget rebuild would flicker the chip, churn through
 * `eq()` comparisons, and risk losing focus / selection state if
 * the widget's DOM was the focused element. Direct attribute
 * mutation is the [L06] path: ephemeral appearance state belongs in
 * the DOM, not React or CM6 state.
 *
 * Idempotent: setting an attribute to the value it already holds is
 * a no-op in the DOM. So repeated notifications during a busy drop
 * (many atoms transitioning at once) don't churn the document.
 *
 * Lifecycle: unsubscribes on plugin destroy so abandoned views don't
 * leak listeners. The plugin is mounted as part of the extension
 * factory exported below so consumers that don't supply a
 * `atomBytesStoreFacet` (gallery, stand-alone editors) get a no-op
 * plugin — the facet's default thunk returns `null` and the plugin
 * never finds a store to subscribe to.
 */
class PendingAtomSyncPlugin implements PluginValue {
  private unsubscribe: (() => void) | null = null;
  private subscribedStore: AtomBytesStore | null = null;

  constructor(private readonly view: EditorView) {
    this.syncSubscription();
  }

  update(update: ViewUpdate): void {
    // Re-evaluate which store the facet hands back on every update.
    // The facet's thunk reads a ref that the host swaps when a card
    // re-binds — most notably a `/compact` + resume, which disposes
    // the old `AtomBytesStore` and creates a fresh one. Without this
    // re-check we'd stay subscribed to the dead store and newly
    // dropped images would pulse forever, since their bytes land in
    // the new store whose notifications we never hear.
    this.syncSubscription();
    // The widget's own toDOM() handles initial state on mount;
    // bytes-arriving subscriptions handle the rest.
    void update;
  }

  destroy(): void {
    this.unsubscribeCurrent();
  }

  /**
   * Ensure we're subscribed to the store the facet currently returns.
   * Idempotent: if the facet's store is unchanged this is a no-op; if
   * it changed (or first became available) we drop the old listener,
   * subscribe to the new store, and run an immediate sync so bytes
   * that already landed in the new store clear their skeleton state.
   */
  private syncSubscription(): void {
    const getStore = this.view.state.facet(atomBytesStoreFacet);
    const store = getStore();
    if (store === this.subscribedStore) return;
    this.unsubscribeCurrent();
    if (store === null) return;
    const view = this.view;
    this.subscribedStore = store;
    this.unsubscribe = store.subscribe(() => {
      syncPendingAttributes(view, store);
    });
    syncPendingAttributes(view, store);
  }

  private unsubscribeCurrent(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.subscribedStore = null;
  }
}

/**
 * For each atom widget in `view.contentDOM`, set or clear
 * `data-pending` based on whether the matching id is present in the
 * bytes-store. Pure DOM walk + attribute mutation; no React, no
 * CM6 transactions. The widget's `data-atom-id` is the join key.
 *
 * Exported for the rare consumer that wants to force a manual sync
 * (e.g., after restoring from a snapshot); the ViewPlugin's
 * subscribe path handles the common case automatically.
 */
export function syncPendingAttributes(
  view: EditorView,
  store: AtomBytesStore,
): void {
  const imgs = view.contentDOM.querySelectorAll<HTMLImageElement>(
    "img[data-atom-id]",
  );
  for (const img of imgs) {
    const id = img.dataset.atomId;
    if (id === undefined) continue;
    const hasBytes = store.get(id) !== null;
    if (hasBytes) {
      if (img.dataset.pending !== undefined) {
        delete img.dataset.pending;
      }
    } else {
      if (img.dataset.pending !== "true") {
        img.dataset.pending = "true";
      }
    }
  }
}

/**
 * The pending-sync `ViewPlugin` exported for editor extension
 * registration. The atom widget's `toDOM` handles initial render;
 * this plugin handles the transition from pending → ready as bytes
 * arrive after async processing completes.
 */
export const pendingAtomSyncPlugin = ViewPlugin.fromClass(
  PendingAtomSyncPlugin,
);

// ---------------------------------------------------------------------------
// Selection-sync ViewPlugin
// ---------------------------------------------------------------------------

/**
 * Per-element cache of the two baked data-URIs an atom `<img>` swaps
 * between: its resting `src` and its selected-variant `src`. Keyed on
 * the element (a `WeakMap`, so a widget remounted by a theme switch or
 * doc edit drops its stale entry and re-bakes against the fresh theme).
 *
 * The resting URI is captured lazily from `img.src` the first time the
 * atom is selected; the selected URI is baked lazily (and once) from the
 * `data-atom-*` attributes the img already carries. Atoms that are never
 * selected pay nothing.
 */
const _restSrc = new WeakMap<HTMLImageElement, string>();
const _selectedSrc = new WeakMap<HTMLImageElement, string>();

/** Whether document position `pos` (an atom's U+FFFC offset) is covered
 *  by any non-empty selection range. Atoms are atomic, so a range that
 *  reaches `pos` covers the whole `[pos, pos + 1)` widget. */
function isPositionSelected(state: EditorState, pos: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= pos && range.to > pos) return true;
  }
  return false;
}

/**
 * Swap each atom widget's `<img>` between its resting and selected bakes
 * to match the editor's current text selection. A chip covered by the
 * selection paints with the `-selected-rest` chip tokens (saturated
 * surface, lighter glyphs) so it reads *forward* of the blue selection
 * wash instead of dissolving into it — the blue-on-blue problem the
 * default chip has when the selection overlay sits behind it.
 *
 * Why a DOM `src` swap rather than rebuilding the CM6 widget: selection
 * changes fire on every cursor move and drag. Folding selection state
 * into `AtomWidget.eq()` would churn the decoration set and remount
 * widget DOM on each tick. The atom's *identity* (type / label / value)
 * is unchanged by selection — only its appearance — so this is the [L06]
 * path: ephemeral appearance lives in the DOM, mutated directly, exactly
 * as {@link syncPendingAttributes} handles the pending pulse. The baked
 * selected URI is geometry-identical to the resting one, so the swap
 * never resizes the chip or shifts layout.
 */
export function syncSelectedAtoms(view: EditorView): void {
  const imgs = view.contentDOM.querySelectorAll<HTMLImageElement>(
    "img[data-atom-type]",
  );
  for (const img of imgs) {
    const pos = view.posAtDOM(img);
    if (isPositionSelected(view.state, pos)) {
      if (!_restSrc.has(img)) _restSrc.set(img, img.src);
      let selected = _selectedSrc.get(img);
      if (selected === undefined) {
        selected = bakeAtomChipDataUri(
          img.dataset.atomType ?? "",
          img.dataset.atomLabel ?? "",
          img.dataset.atomValue ?? "",
          { variant: "selected" },
        ).dataUri;
        _selectedSrc.set(img, selected);
      }
      if (img.src !== selected) img.src = selected;
      if (img.dataset.selected !== "true") img.dataset.selected = "true";
    } else {
      const rest = _restSrc.get(img);
      if (rest !== undefined && img.src !== rest) img.src = rest;
      if (img.dataset.selected !== undefined) delete img.dataset.selected;
    }
  }
}

/**
 * ViewPlugin that keeps atom chips' selected appearance in sync with the
 * editor selection. Re-syncs whenever the selection moves, the document
 * changes (atom offsets shift), or the viewport scrolls in new atom DOM.
 * Pure DOM mutation via {@link syncSelectedAtoms} — no CM6 transaction,
 * no React round-trip.
 */
class SelectedAtomSyncPlugin implements PluginValue {
  constructor(private readonly view: EditorView) {
    syncSelectedAtoms(view);
  }

  update(update: ViewUpdate): void {
    // Selection moves and doc edits (atom offsets shift) and viewport
    // scrolls (new atom DOM) all change which chips should read selected.
    // A theme switch dispatches `regenerateAtomsEffect`, which remounts
    // every chip's `<img>` at the resting bake with no doc/selection
    // change — re-sync on that too so a selected chip keeps its selected
    // appearance across the swap.
    const regenerated = update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(regenerateAtomsEffect)),
    );
    if (
      update.selectionSet
      || update.docChanged
      || update.viewportChanged
      || regenerated
    ) {
      syncSelectedAtoms(update.view);
    }
  }
}

/**
 * The selection-sync `ViewPlugin` exported for editor extension
 * registration. Paints the selected-state chip appearance for atoms the
 * text selection covers; no-op for editors with no atoms.
 */
export const selectedAtomSyncPlugin = ViewPlugin.fromClass(
  SelectedAtomSyncPlugin,
);

// ---------------------------------------------------------------------------
// Pending appearance theme
// ---------------------------------------------------------------------------

/**
 * CM6 `baseTheme` block styling the pending atom appearance.
 * Applies via attribute selector on the atom `<img>` element
 * written by `createAtomImgElement`.
 *
 * The pulse is a wide opacity swing (0.4 ↔ 1.0) on a 1s cycle — quick
 * enough to read as active rather than ambient during the 1-2 s window
 * of a large image downsample, without redrawing the SVG or touching
 * the chip's geometry, positioning, or editing semantics.
 *
 * Opacity ONLY, deliberately: `opacity` is one of the two properties
 * the compositor can animate. An earlier cut co-animated
 * `filter: saturate()`, which is never accelerable — it demoted the
 * loop to main-thread blending, restyling the editor subtree every
 * frame for as long as a pending chip existed. The washed-out read the
 * saturation carried is substantially the opacity dip's anyway.
 *
 * [L06] — appearance via CSS only; no React, no state.
 */
export const pendingAtomTheme: Extension = EditorView.baseTheme({
  "img[data-pending]": {
    animation: "tug-atom-pending-pulse 1s ease-in-out infinite",
  },
  "@keyframes tug-atom-pending-pulse": {
    "0%, 100%": {
      opacity: "0.4",
    },
    "50%": {
      opacity: "1",
    },
  },
});

