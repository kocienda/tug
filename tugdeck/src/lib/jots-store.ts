/**
 * `jotsStore` — the [L02] store surface for the Jots card.
 *
 * Composes the pure logic in `jots-doc.ts` with the live JOTS feed,
 * optimistic mutations, debounced autosave (`PUT /api/jots`), a bounded
 * undo/redo stack, and hash-gated echo suppression. The React surface is
 * `subscribe` / `getSnapshot`, returning `{ doc, error }`.
 *
 * Selection is *appearance* and lives in the component ([L06]). The
 * open-for-edit row is *structure* — which row mounts its editor — so it lives
 * here as `editingId` on the snapshot ([L02]): the section body, the cell
 * renderer, and the descend effect all read one source. It also drives the
 * foreign-merge carve-out (Risk R01) and undo coalescing.
 */

import { FeedId } from "../protocol";
import type { TugConnection } from "../connection";
import { getConnection } from "./connection-singleton";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";
import {
  type JotsDoc,
  type UndoStack,
  applyCreate,
  applyDelete,
  applyOrder,
  applyAddOrigins,
  applyUpdate,
  emptyDoc,
  emptyUndo,
  mergeForeignDoc,
  newJotId,
  parseJotsFrame,
  pushUndo,
  redo,
  shouldIgnoreFrame,
  undo,
} from "./jots-doc";

/** The React-visible snapshot. */
export interface JotsSnapshot {
  doc: JotsDoc;
  /** Non-null when the on-disk file is unreadable or a save was rejected. */
  error: string | null;
  /**
   * The id of the row currently open for editing, or null when none is open.
   * Set by `beginEdit` and by `createJot` (create-and-open); cleared by
   * `commitEdit`. The section body mounts the editor for this row and descends
   * into it; a header `+` opens the freshly-created row through this field.
   */
  editingId: string | null;
}

/** Debounce for text edits; structural mutations save immediately. */
const SAVE_DEBOUNCE_MS = 500;

function docsEqual(a: JotsDoc, b: JotsDoc): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class JotsStore {
  private doc: JotsDoc = emptyDoc();
  private undoStack: UndoStack = emptyUndo();
  private editBaseline: JotsDoc | null = null;
  private editingId: string | null = null;
  private error: string | null = null;
  private lastWrittenHash: string | null = null;

  private snapshot: JotsSnapshot = Object.freeze({
    doc: this.doc,
    error: null,
    editingId: null,
  });
  private readonly listeners = new Set<() => void>();
  private unsubFeed: (() => void) | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(conn: TugConnection | null) {
    if (conn === null) {
      tugDevLogStore.warn("jots-store", "no connection at construction; feed inactive");
      return;
    }
    // Late subscription still replays the cached connect-time frame (see
    // `TugConnection.onFrame`), so eager subscription here is safe.
    this.unsubFeed = conn.onFrame(FeedId.JOTS, (payload) => this.onFrame(payload));
  }

  dispose(): void {
    this.unsubFeed?.();
    this.unsubFeed = null;
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): JotsSnapshot => this.snapshot;

  // ── Feed ingestion ─────────────────────────────────────────────────────

  private onFrame(payload: Uint8Array): void {
    const frame = parseJotsFrame(payload);
    if (frame === null) return;

    // Our own write echoing back — ignore so it can't disturb an open edit.
    if (shouldIgnoreFrame(frame, this.lastWrittenHash)) {
      if (this.error !== frame.error) {
        this.error = frame.error;
        this.commit();
      }
      return;
    }

    // Server reports the file is unreadable: adopt its last-good doc + error.
    if (frame.error !== null) {
      if (!docsEqual(frame.doc, this.doc) || this.error !== frame.error) {
        this.doc = frame.doc;
        this.error = frame.error;
        this.commit();
      }
      return;
    }

    this.lastWrittenHash = frame.hash;

    // Same content we already hold (our own echo, or coincidental): no merge,
    // no undo reset — just clear any stale error.
    if (docsEqual(frame.doc, this.doc)) {
      if (this.error !== null) {
        this.error = null;
        this.commit();
      }
      return;
    }

    // Genuine foreign change: merge (preserving the open row, R01) and, per
    // [P07], drop the undo history that never applied to this document.
    this.doc = mergeForeignDoc(this.doc, frame.doc, this.editingId);
    this.error = null;
    this.undoStack = emptyUndo();
    this.commit();
  }

  // ── Mutations ──────────────────────────────────────────────────────────

  /**
   * Insert a blank jot after `afterId` (or at end) and open it for editing;
   * returns its id. Opening it here (setting `editingId` + the coalescing
   * baseline) is what lets a header `+` or a ⌘Return chain create-and-open in
   * one call — the section's descend effect reacts to `editingId`.
   */
  createJot(afterId: string | null = null): string {
    this.undoStack = pushUndo(this.undoStack, this.doc);
    const result = applyCreate(this.doc, afterId, newJotId());
    this.doc = result.doc;
    this.editingId = result.id;
    if (this.editBaseline === null) {
      this.editBaseline = this.doc;
    }
    this.commit();
    this.save(true);
    return result.id;
  }

  /** Set a jot's text. Debounced save; coalesced undo while editing. */
  updateJot(id: string, text: string): void {
    // When not inside a begin/commit bracket, each update is its own undo
    // entry; while bracketed, a typing burst coalesces to one entry at commit.
    if (this.editBaseline === null) {
      this.undoStack = pushUndo(this.undoStack, this.doc);
    }
    this.doc = applyUpdate(this.doc, id, text);
    this.commit();
    this.save(false);
  }

  /**
   * Record the project roots a paste brought into a jot — its provenance, so a
   * relative path in the pasted text still names a file long after the session
   * it came from is closed.
   *
   * NOT an undo entry, and not a coalescing concern: this is a fact about
   * where text came from, arriving in the same gesture as the text itself. An
   * undo of the paste restores a document whose jot never had the origin, so
   * the two stay consistent without this pushing a step of its own — and a
   * step here would make ⌘Z ask twice for one paste.
   */
  addJotOrigins(id: string, origins: readonly string[]): void {
    const next = applyAddOrigins(this.doc, id, origins);
    if (next === this.doc) return; // nothing new — no write, no autosave
    this.doc = next;
    this.commit();
    this.save(false);
  }

  /** Remove a jot; returns the id that should take selection next. */
  deleteJot(id: string): string | null {
    this.undoStack = pushUndo(this.undoStack, this.doc);
    const result = applyDelete(this.doc, id);
    this.doc = result.doc;
    this.commit();
    this.save(true);
    return result.nextSelected;
  }

  /** Reorder to match `ids` (a full permutation of the current ids). */
  setOrder(ids: string[]): void {
    this.undoStack = pushUndo(this.undoStack, this.doc);
    this.doc = applyOrder(this.doc, ids);
    this.commit();
    this.save(true);
  }

  /** Open a row for editing: snapshots the pre-edit doc for undo coalescing. */
  beginEdit(id: string): void {
    this.editingId = id;
    if (this.editBaseline === null) {
      this.editBaseline = this.doc;
    }
    this.commit();
  }

  /** Close the open row: push one coalesced undo entry and flush the save.
   *  A row left EMPTY on close is discarded rather than persisted — creating a
   *  jot (via `+` / ⌘N / Space / ⌘Return) then leaving without typing must
   *  not leave a blank row behind. */
  commitEdit(): void {
    const editingId = this.editingId;
    const baseline = this.editBaseline;
    this.editBaseline = null;
    this.editingId = null;
    if (editingId !== null) {
      const jot = this.doc.jots.find((s) => s.id === editingId);
      if (jot !== undefined && jot.text.trim() === "") {
        // Undo restores the pre-edit doc (so clearing an existing jot to
        // empty is undoable); a never-populated new row leaves no trace.
        if (baseline !== null && !docsEqual(baseline, this.doc)) {
          this.undoStack = pushUndo(this.undoStack, baseline);
        }
        this.doc = applyDelete(this.doc, editingId).doc;
        this.commit();
        this.save(true);
        return;
      }
    }
    if (baseline !== null && !docsEqual(baseline, this.doc)) {
      this.undoStack = pushUndo(this.undoStack, baseline);
    }
    this.commit();
    // A commit is a save point: flush any pending debounced write now.
    this.save(true);
  }

  undo(): void {
    const result = undo(this.undoStack, this.doc);
    if (result === null) return;
    this.undoStack = result.stack;
    this.doc = result.doc;
    this.commit();
    this.save(true);
  }

  redo(): void {
    const result = redo(this.undoStack, this.doc);
    if (result === null) return;
    this.undoStack = result.stack;
    this.doc = result.doc;
    this.commit();
    this.save(true);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private commit(): void {
    this.snapshot = Object.freeze({
      doc: this.doc,
      error: this.error,
      editingId: this.editingId,
    });
    for (const listener of this.listeners) listener();
  }

  private save(immediate: boolean): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (immediate) {
      void this.flushSave();
    } else {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        void this.flushSave();
      }, SAVE_DEBOUNCE_MS);
    }
  }

  private async flushSave(): Promise<void> {
    const doc = this.doc;
    try {
      const resp = await fetch("/api/jots", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc }),
      });
      if (resp.ok) {
        const json = (await resp.json()) as { hash?: unknown };
        if (typeof json.hash === "string") this.lastWrittenHash = json.hash;
        if (this.error !== null) {
          this.error = null;
          this.commit();
        }
        return;
      }
      const json = (await resp.json().catch(() => ({}))) as { message?: unknown };
      const msg =
        typeof json.message === "string" ? json.message : `jots save failed (${resp.status})`;
      if (this.error !== msg) {
        this.error = msg;
        this.commit();
      }
    } catch (e) {
      tugDevLogStore.error("jots-store", `save request failed: ${String(e)}`);
    }
  }
}

// ── Module singleton ───────────────────────────────────────────────────────

let instance: JotsStore | null = null;

/** The lazily-constructed process-wide jots store. */
export function getJotsStore(): JotsStore {
  if (instance === null) {
    instance = new JotsStore(getConnection());
  }
  return instance;
}
