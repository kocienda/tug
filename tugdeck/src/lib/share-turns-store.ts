/**
 * share-turns-store.ts — a Session card's share mode.
 *
 * One store per card, built beside the card's other services and living as
 * long as its `codeSessionStore`. It holds whether the card is in share mode,
 * which turns are marked and the anchor a shift-click extends from, the tool
 * mode and output format, and the gate every outward action passes through:
 * the last previewed artifact and the signature it was previewed for.
 *
 * The gate is a comparison, not a flag ({@link ShareTurnsStore.canSend}):
 * Copy, Save… and Share… are open exactly when the current signature equals
 * the previewed one. A toggle that moves the signature closes it with nothing
 * to clear, and toggling back reopens it, because the artifact previewed for
 * that signature is still the one held.
 *
 * Leaving share mode drops the selection, the artifact and a private
 * session's confirmation, so the next visit starts clean and asks again.
 *
 * React reads the snapshot with `useSyncExternalStore` ([L02]); the snapshot
 * object is rebuilt only on a change, so it is `Object.is`-stable between
 * edits.
 *
 * @module lib/share-turns-store
 */

import { Subscribable } from "./subscribable";
import {
  extendTo as extendSelection,
  shareSignature,
  toggleTurn as toggleSelection,
  type ShareFormat,
  type ShareToolMode,
} from "./share-turns";

/** What a preview produced, which every outward action sends as it is. */
export interface ShareArtifact {
  format: ShareFormat;
  /** The scrubbed Markdown — the artifact itself for `markdown`, the plain-text flavour otherwise. */
  markdown: string;
  /** The rendered file, for `pdf` and `png`; `""` for `markdown`. */
  path: string;
  /** The inline-styled HTML of a rendered PDF; `""` otherwise. */
  html: string;
}

/** What the shade's one action button does: the choice of its Action menu. */
export type ShareAction = "preview" | "copy" | "save" | "share";

/** The share mode as React reads it. */
export interface ShareTurnsSnapshot {
  active: boolean;
  selected: ReadonlySet<string>;
  anchor: string | null;
  toolMode: ShareToolMode;
  format: ShareFormat;
  /** The action the shade's button performs. Kept across visits, like the format. */
  action: ShareAction;
  /** The signature {@link lastArtifact} was previewed for, or `null`. */
  previewed: string | null;
  /** True while a preview is being prepared — the scrub and the render. */
  rendering: boolean;
  lastArtifact: ShareArtifact | null;
  /** Whether a private session's confirmation was given this visit. */
  privateConfirmed: boolean;
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

const INITIAL: ShareTurnsSnapshot = {
  active: false,
  selected: EMPTY_SELECTION,
  anchor: null,
  toolMode: "summaries",
  format: "pdf",
  action: "preview",
  previewed: null,
  rendering: false,
  lastArtifact: null,
  privateConfirmed: false,
};

/** A card's share mode: its selection, choices and preview gate. */
export class ShareTurnsStore extends Subscribable {
  private snapshot: ShareTurnsSnapshot = INITIAL;

  getSnapshot = (): ShareTurnsSnapshot => this.snapshot;

  private set(patch: Partial<ShareTurnsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.notify();
  }

  /**
   * Enter share mode with `selected` marked (nothing, by default) and
   * `anchor` as the place a shift-click extends from. The tool mode and
   * format keep the card's last choice. Entering while already in the mode
   * replaces the selection.
   */
  enter(selected?: Iterable<string>, anchor: string | null = null): void {
    this.set({
      active: true,
      selected: new Set(selected ?? []),
      anchor,
    });
  }

  /** Leave share mode, dropping the selection, the artifact and the private answer. */
  leave(): void {
    const s = this.snapshot;
    if (!s.active && s.lastArtifact === null && !s.privateConfirmed) return;
    this.set({
      active: false,
      selected: EMPTY_SELECTION,
      anchor: null,
      previewed: null,
      rendering: false,
      lastArtifact: null,
      privateConfirmed: false,
    });
  }

  /** Toggle `key`'s mark and make it the anchor. */
  toggle(key: string): void {
    const next = toggleSelection(this.snapshot, key);
    this.set({ selected: next.selected, anchor: next.anchor });
  }

  /** Mark every selectable turn from the anchor to `key`, in `order`. */
  extendTo(key: string, order: ReadonlyArray<string>): void {
    const next = extendSelection(this.snapshot, key, order);
    this.set({ selected: next.selected, anchor: next.anchor });
  }

  /**
   * Mark every turn in `keys` — the selectable turns, as the card reads them
   * — and clear the anchor, so the next shift-click starts from the turn it
   * lands on.
   */
  markAll(keys: Iterable<string>): void {
    this.set({ selected: new Set(keys), anchor: null });
  }

  /** Unmark every turn and clear the anchor. The mode stays on. */
  clearMarks(): void {
    if (this.snapshot.selected.size === 0 && this.snapshot.anchor === null) return;
    this.set({ selected: EMPTY_SELECTION, anchor: null });
  }

  setToolMode(toolMode: ShareToolMode): void {
    if (this.snapshot.toolMode !== toolMode) this.set({ toolMode });
  }

  setFormat(format: ShareFormat): void {
    if (this.snapshot.format !== format) this.set({ format });
  }

  setAction(action: ShareAction): void {
    if (this.snapshot.action !== action) this.set({ action });
  }

  setRendering(rendering: boolean): void {
    if (this.snapshot.rendering !== rendering) this.set({ rendering });
  }

  /** Record that a private session's turns may be rendered, until the mode is left. */
  confirmPrivate(): void {
    if (!this.snapshot.privateConfirmed) this.set({ privateConfirmed: true });
  }

  /** Hold `artifact` as the preview of `signature`, opening the gate while it matches. */
  markPreviewed(signature: string, artifact: ShareArtifact): void {
    this.set({ previewed: signature, lastArtifact: artifact });
  }

  isSelected(key: string): boolean {
    return this.snapshot.selected.has(key);
  }

  /** The current selection's signature. */
  signature(): string {
    return shareSignature(this.snapshot);
  }

  /** Whether Copy, Save… and Share… may act: the artifact held is of exactly this selection. */
  canSend(): boolean {
    const s = this.snapshot;
    return s.active && s.lastArtifact !== null && s.previewed === shareSignature(s);
  }

  dispose(): void {
    this.clearListeners();
  }
}
