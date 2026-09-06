/**
 * Pure document logic for the Jots feature — no IO, no timers, no React.
 *
 * Everything decision-shaped lives here so it is testable as pure logic
 * (`src/__tests__/jots-doc.test.ts`): the immutable S01 document
 * transforms, the undo/redo stack, echo suppression, and the foreign-merge
 * open-row carve-out (Risk R01). `jots-store.ts` composes these with the
 * feed subscription, autosave, and the `useSyncExternalStore` surface.
 *
 * Mirrors the Rust model in `tugcast/src/jots.rs` (Spec S01/S02).
 */

import type { AtomSegment } from "./tug-atom-img";

/** The only document version this build reads and writes. */
export const JOTS_VERSION = 1;

/**
 * One atom standing in a jot's text: its identity plus the index of the
 * `U+FFFC` it occupies. The same shape `prompt-history-store.ts` already
 * serialises an atom in, minus the `path` field that is a prompt-history
 * concern — a jot has no bytes store and no asset base, so an image atom
 * travels as metadata and its chip draws pending ([B09]).
 *
 * Mirrors `JotAtom` in `tugcast/src/jots.rs`; the two must agree, or the
 * field is dropped on the next save.
 */
export interface JotAtom {
  /** Index of the `U+FFFC` this atom stands at, in the jot's `text`. */
  position: number;
  type: string;
  label: string;
  value: string;
  /** Bytes-store key for an image atom. A jot stores no bytes, so this is a
   *  link that will usually resolve to nothing — kept because it is the atom's
   *  identity, and because a jot moved back into a card whose store still
   *  holds the row resolves it. */
  id?: string;
}

/** One reusable jot: an opaque id and its (possibly multi-line) text. The
 *  row's handle is the *incipit* (opening line of `text`), not a stored title. */
export interface Jot {
  id: string;
  text: string;
  /**
   * The atoms standing in `text` — one per `U+FFFC` in it, in document order.
   *
   * A jot is where a chip goes to be kept: a file mention, a commit, a session
   * citation pasted out of a transcript. Before this field the text was saved
   * and the chips were not, so a reopened jot showed a placeholder character
   * with nothing behind it and no way to say what had been there. Additive and
   * optional, exactly as `origins` was: absent on every jot written before this
   * existed and on every jot of plain prose.
   *
   * Mirrors `Jot.atoms` in `tugcast/src/jots.rs` — and, like `origins`, it must
   * be named on the READ side below or every round trip through this build
   * silently drops it.
   */
  atoms?: JotAtom[];
  /**
   * Absolute project roots this jot's text was written against — the
   * provenance of whatever was pasted in, mirroring `Jot.origins` in
   * `tugcast/src/jots.rs` (the two must agree, or the field is dropped on the
   * next save).
   *
   * A jot is usually a passage lifted out of a transcript, and such a passage
   * cites files relative to a repo root the sentence never names. The text
   * survives the copy; the root survives only if it is carried, so a Tug copy
   * puts it on the pasteboard and the paste records it here. Readers try each
   * root and take the first that names a real file.
   *
   * Absent on every jot written before this existed, and on any jot typed
   * rather than pasted.
   */
  origins?: string[];
}

/** The whole jots document. Array position is display order ([P09]). */
export interface JotsDoc {
  version: number;
  jots: Jot[];
}

/** The JOTS feed frame payload (Spec S02). */
export interface JotsFrame {
  doc: JotsDoc;
  hash: string | null;
  error: string | null;
}

/** The empty document served when `jots.json` is missing. */
export function emptyDoc(): JotsDoc {
  return { version: JOTS_VERSION, jots: [] };
}

/** Generate a stable opaque jot id: `jt_` + 12 hex chars. */
export function newJotId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `jt_${hex}`;
}

/**
 * The jot's *incipit* — its opening line, the handle shown in the list
 * (borrowed from how papal bulls are named by their first words). Empty when
 * the jot has no text yet.
 */
export function jotIncipit(jot: Jot): string {
  return jot.text.trimStart().split("\n", 1)[0]?.trim() ?? "";
}

/**
 * Parse a JOTS feed payload into a validated frame, or `null` if the bytes
 * are not a well-formed S02 frame.
 */
export function parseJotsFrame(payload: Uint8Array): JotsFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const doc = obj.doc;
  if (typeof doc !== "object" || doc === null) return null;
  const d = doc as Record<string, unknown>;
  if (typeof d.version !== "number" || !Array.isArray(d.jots)) return null;
  const jots: Jot[] = [];
  for (const raw of d.jots) {
    if (typeof raw !== "object" || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== "string") return null;
    const jot: Jot = {
      id: s.id,
      text: typeof s.text === "string" ? s.text : "",
    };
    // Named explicitly on the read side or it is silently dropped on every
    // round trip — "additive and optional" is free on the write side and never
    // free here. Absolute only, deduped: a relative root would have to be
    // resolved against the reader's own project, which is the assumption the
    // field exists to stop making.
    if (Array.isArray(s.origins)) {
      const origins: string[] = [];
      for (const raw of s.origins as unknown[]) {
        if (typeof raw !== "string" || !raw.startsWith("/")) continue;
        if (!origins.includes(raw)) origins.push(raw);
      }
      if (origins.length > 0) jot.origins = origins;
    }
    // Same reason, same shape: named here or lost. An entry that is not a
    // well-formed atom is skipped rather than half-trusted — a chip claiming
    // an identity nothing wrote is worse than the placeholder it replaces.
    if (Array.isArray(s.atoms)) {
      const atoms: JotAtom[] = [];
      for (const raw of s.atoms as unknown[]) {
        const atom = parseJotAtom(raw);
        if (atom !== null) atoms.push(atom);
      }
      if (atoms.length > 0) jot.atoms = atoms;
    }
    jots.push(jot);
  }
  return {
    doc: { version: d.version, jots },
    hash: typeof obj.hash === "string" ? obj.hash : null,
    error: typeof obj.error === "string" ? obj.error : null,
  };
}

/**
 * Read one atom out of a parsed `jots.json` entry, or `null` when it is not
 * one. Exported for the document tests; the parser above is the only caller.
 */
export function parseJotAtom(raw: unknown): JotAtom | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.position !== "number" || !Number.isInteger(a.position)) return null;
  if (a.position < 0) return null;
  if (typeof a.type !== "string" || a.type === "") return null;
  if (typeof a.label !== "string") return null;
  if (typeof a.value !== "string") return null;
  const atom: JotAtom = {
    position: a.position,
    type: a.type,
    label: a.label,
    value: a.value,
  };
  if (typeof a.id === "string" && a.id !== "") atom.id = a.id;
  return atom;
}

/**
 * The jot's atoms as the positionless segments every atom consumer takes —
 * document order, which is the order the `U+FFFC` characters appear in the
 * text, so the pair zips.
 *
 * The record stores a position per atom because that is what makes the file
 * self-describing; every door out of a jot (the copy's sidecar, the drag, the
 * insert) wants the segment instead.
 *
 * Spelled out here rather than borrowed from `atom-text`'s
 * `substrateSegments`: this module is pure document logic with no IO, and
 * `atom-text` reaches the clipboard.
 */
export function jotAtomSegments(jot: Jot): AtomSegment[] {
  return (jot.atoms ?? []).map((atom) => ({
    kind: "atom" as const,
    type: atom.type,
    label: atom.label,
    value: atom.value,
    ...(atom.id !== undefined ? { id: atom.id } : {}),
  }));
}

// ── Immutable document transforms ──────────────────────────────────────────

/**
 * Insert a new blank jot after `afterId` (or at the end when `afterId` is
 * absent / not found). Returns the new document and the new jot's id.
 */
export function applyCreate(
  doc: JotsDoc,
  afterId: string | null,
  id: string,
): { doc: JotsDoc; id: string } {
  const jot: Jot = { id, text: "" };
  const idx = afterId === null ? -1 : doc.jots.findIndex((s) => s.id === afterId);
  const jots = doc.jots.slice();
  if (idx < 0) jots.push(jot);
  else jots.splice(idx + 1, 0, jot);
  return { doc: { ...doc, jots }, id };
}

/**
 * Set a jot's text and the atoms standing in it. No-op if `id` is absent.
 *
 * The two move together because they are one document: a text written without
 * its atoms is a text with anonymous placeholders in it. An empty `atoms`
 * clears the field rather than leaving a stale list behind — deleting the last
 * chip in a jot has to be recorded as the chip being gone.
 */
export function applyUpdate(
  doc: JotsDoc,
  id: string,
  text: string,
  atoms: readonly JotAtom[] = [],
): JotsDoc {
  const jots = doc.jots.map((s) => {
    if (s.id !== id) return s;
    const next: Jot = { ...s, text };
    if (atoms.length > 0) next.atoms = atoms.map((atom) => ({ ...atom }));
    else delete next.atoms;
    return next;
  });
  return { ...doc, jots };
}

/**
 * Record project roots a paste brought into a jot. Accumulates rather than
 * replaces: a jot pasted into twice from two projects is about both, and
 * dropping the first root to record the second would put out links that were
 * working a moment ago.
 *
 * Returns the document unchanged when there is nothing new to add, so a paste
 * from a project the jot already knows costs no write and no autosave.
 */
export function applyAddOrigins(
  doc: JotsDoc,
  id: string,
  origins: readonly string[],
): JotsDoc {
  const fresh = origins.filter((root) => root.startsWith("/"));
  if (fresh.length === 0) return doc;
  let changed = false;
  const jots = doc.jots.map((jot) => {
    if (jot.id !== id) return jot;
    const merged = jot.origins?.slice() ?? [];
    for (const root of fresh) {
      if (!merged.includes(root)) {
        merged.push(root);
        changed = true;
      }
    }
    return changed ? { ...jot, origins: merged } : jot;
  });
  return changed ? { ...doc, jots } : doc;
}

/**
 * Remove a jot. Returns the new document and the id that should take
 * selection next (the successor row, else the new last row, else `null`).
 */
export function applyDelete(
  doc: JotsDoc,
  id: string,
): { doc: JotsDoc; nextSelected: string | null } {
  const idx = doc.jots.findIndex((s) => s.id === id);
  if (idx < 0) return { doc, nextSelected: null };
  const jots = doc.jots.slice();
  jots.splice(idx, 1);
  let nextSelected: string | null = null;
  if (jots.length > 0) {
    const nextIdx = Math.min(idx, jots.length - 1);
    nextSelected = jots[nextIdx].id;
  }
  return { doc: { ...doc, jots }, nextSelected };
}

/**
 * Reorder to match `ids`. Jots not named in `ids` keep their relative
 * order at the end (defensive; the caller always passes a full permutation).
 */
export function applyOrder(doc: JotsDoc, ids: string[]): JotsDoc {
  const byId = new Map(doc.jots.map((s) => [s.id, s]));
  const ordered: Jot[] = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (s) {
      ordered.push(s);
      byId.delete(id);
    }
  }
  for (const s of byId.values()) ordered.push(s);
  return { ...doc, jots: ordered };
}

// ── Undo/redo stack ────────────────────────────────────────────────────────

/** Bounded whole-document undo/redo stack ([P07]). */
export interface UndoStack {
  past: JotsDoc[];
  future: JotsDoc[];
}

/** Maximum retained undo entries. */
export const UNDO_LIMIT = 50;

export function emptyUndo(): UndoStack {
  return { past: [], future: [] };
}

/** Push `prevDoc` (the state before a mutation) onto the stack; clears redo. */
export function pushUndo(stack: UndoStack, prevDoc: JotsDoc): UndoStack {
  const past = [...stack.past, prevDoc];
  if (past.length > UNDO_LIMIT) past.shift();
  return { past, future: [] };
}

/** Walk back one step. Returns `null` when there is nothing to undo. */
export function undo(
  stack: UndoStack,
  current: JotsDoc,
): { stack: UndoStack; doc: JotsDoc } | null {
  if (stack.past.length === 0) return null;
  const past = stack.past.slice();
  const doc = past.pop() as JotsDoc;
  return { stack: { past, future: [current, ...stack.future] }, doc };
}

/** Walk forward one step. Returns `null` when there is nothing to redo. */
export function redo(
  stack: UndoStack,
  current: JotsDoc,
): { stack: UndoStack; doc: JotsDoc } | null {
  if (stack.future.length === 0) return null;
  const future = stack.future.slice();
  const doc = future.shift() as JotsDoc;
  return { stack: { past: [...stack.past, current], future }, doc };
}

// ── Frame decisions ────────────────────────────────────────────────────────

/**
 * True when an inbound frame is the echo of this client's own last write (its
 * hash matches `lastWrittenHash`) and should be ignored so it does not disturb
 * an in-progress edit ([P03]).
 */
export function shouldIgnoreFrame(frame: JotsFrame, lastWrittenHash: string | null): boolean {
  return lastWrittenHash !== null && frame.hash !== null && frame.hash === lastWrittenHash;
}

/**
 * Merge a foreign document (written by another build) into the local view,
 * preserving the row currently open for editing (Risk R01): every row takes
 * the foreign value except `openRowId`, which keeps its local content and is
 * re-inserted at its foreign position (or appended if the foreign doc dropped
 * it). When no row is open, the foreign document wins wholesale.
 */
export function mergeForeignDoc(
  local: JotsDoc,
  foreign: JotsDoc,
  openRowId: string | null,
): JotsDoc {
  if (openRowId === null) return foreign;
  const localOpen = local.jots.find((s) => s.id === openRowId);
  if (localOpen === undefined) return foreign;

  const foreignHasOpen = foreign.jots.some((s) => s.id === openRowId);
  const jots = foreign.jots.map((s) => (s.id === openRowId ? localOpen : s));
  if (!foreignHasOpen) jots.push(localOpen);
  return { ...foreign, jots };
}
