/**
 * atom-text — the `(text, atoms)` substrate: walking it, flattening it, and
 * putting it on the clipboard with its atoms intact.
 *
 * Every surface that carries atoms carries the same pair: text with a `U+FFFC`
 * at each atom position, and a parallel array naming what stands there. The
 * prompt editor holds it, a submitted turn holds it, the transcript row renders
 * it. This module is the three things every consumer of that pair needs:
 *
 *  - {@link walkAtomText} — the pair as an ordered segment sequence, which is
 *    what a renderer maps over;
 *  - {@link formatAtomTextForCopy} — the pair as readable text, which is what
 *    an app outside Tug gets;
 *  - {@link atomTextClipboardPayload} / {@link copyAtomTextFrom} — the pair as
 *    a clipboard sidecar, which is what makes a paste back into Tug produce
 *    chips rather than the words they were flattened into.
 *
 * The three are one module because they must not disagree: what a row draws,
 * what its copy writes, and what a paste rebuilds are three readings of one
 * substrate, and a surface that took two of them from different places is one
 * edit away from three answers to one question.
 *
 * The sidecar can only ride the native bridge — WebKit's pasteboard
 * normalization swallows custom MIME types (see `tug-native-clipboard.ts`), so
 * outside Tug.app the copy degrades to the plain-text write it replaced.
 *
 * @module lib/atom-text
 */

import {
  withClipboardOrigins,
  type TugAtomsClipboardEntry,
  type TugAtomsClipboardPayload,
} from "@/components/tugways/tug-text-editor/clipboard-filters";

import type { AtomBytesEntry } from "./atom-bytes-store";
import { clipboardOriginFor } from "./clipboard-origin";
import { atomPlainText } from "./atom-plain-text";
import {
  hasNativeClipboardBridge,
  writeClipboardViaNative,
} from "./tug-native-clipboard";
import { TUG_ATOM_CHAR, type AtomSegment } from "./tug-atom-img";
import type { TugSubstrateAtom } from "./tug-text-types";

// ---------------------------------------------------------------------------
// Walking the substrate
// ---------------------------------------------------------------------------

/**
 * One segment in the walked output of {@link walkAtomText}: either a
 * run of plain text, an atom occurrence (paired with its entry from
 * the parallel `atoms` array), or a `stray-ffc` — a `U+FFFC` that had
 * no matching atom in `atoms`.
 *
 * The `stray-ffc` case is the defensive branch matching
 * `buildWirePayload`'s invariant ([Spec S03]): when the atoms array
 * is shorter than the count of `U+FFFC` characters in the text, the
 * surplus is rendered as a visible character rather than crashing.
 */
export type AtomTextSegment =
  | { kind: "text"; text: string }
  | { kind: "atom"; atom: AtomSegment }
  | { kind: "stray-ffc" };

/**
 * Walk `text`, splitting at `U+FFFC` characters. For each `U+FFFC`
 * the parallel-indexed entry in `atoms` becomes an `atom` segment;
 * any `U+FFFC` past the end of `atoms` becomes a `stray-ffc` segment.
 *
 * Pure — no React, no DOM, no theme reads. Stable for same inputs.
 */
export function walkAtomText(
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
): AtomTextSegment[] {
  const segments: AtomTextSegment[] = [];
  let buf = "";
  let atomIndex = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === TUG_ATOM_CHAR) {
      if (buf.length > 0) {
        segments.push({ kind: "text", text: buf });
        buf = "";
      }
      const atom = atoms[atomIndex];
      if (atom === undefined) {
        segments.push({ kind: "stray-ffc" });
      } else {
        segments.push({ kind: "atom", atom });
      }
      atomIndex++;
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) {
    segments.push({ kind: "text", text: buf });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Copy-text formatter
// ---------------------------------------------------------------------------

/**
 * Format an atom-bearing substrate as plain text suitable for the
 * clipboard. Walks the same `(text, atoms)` pair the renderer walks,
 * substituting each atom occurrence with its {@link atomPlainText}
 * spelling — the one table every writer of the `text/plain` flavor
 * reads, so a commit copied from here and a commit copied from the
 * editor are the same string.
 *
 * A stray `U+FFFC` (atom missing or wrong-shape in the parallel
 * array) is passed through verbatim — visible regression rather
 * than a silent drop, mirroring `buildWirePayload`'s defensive
 * posture ([Spec S03]).
 *
 * Every copy of an atom-bearing surface reads this output for its
 * `text/plain` flavor, so the copied text carries an honest representation
 * of each atom — pasting into a markdown surface renders `@`-completion
 * atoms as proper links; dropped-file atoms paste as bare filenames since
 * there is no path to represent.
 */
export function formatAtomTextForCopy(
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
): string {
  const segments = walkAtomText(text, atoms);
  let out = "";
  for (const seg of segments) {
    if (seg.kind === "text") {
      out += seg.text;
    } else if (seg.kind === "stray-ffc") {
      out += TUG_ATOM_CHAR;
    } else {
      out += atomPlainText(seg.atom);
    }
  }
  return out;
}

/**
 * Format an atom-bearing substrate for a consumer that wants each atom's
 * VALUE rather than its display spelling — the commit message handed to git
 * is the one such consumer.
 *
 * `commit:64747b8c` is a label a reader recognises; git wants `64747b8c9a`.
 * `[atom-text.ts](<tugdeck/src/lib/atom-text.ts>)` is a link a markdown reader
 * follows; a commit message wants the path. So the exit spelling is the
 * consumer's, not the copy's ([B05]) — this is the second spelling, beside
 * {@link atomPlainText}'s, and there are exactly two.
 *
 * A stray `U+FFFC` passes through verbatim, as everywhere else.
 */
export function formatAtomTextAsValues(
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
): string {
  let out = "";
  for (const seg of walkAtomText(text, atoms)) {
    if (seg.kind === "text") out += seg.text;
    else if (seg.kind === "stray-ffc") out += TUG_ATOM_CHAR;
    else out += seg.atom.value;
  }
  return out;
}

/**
 * The positionless segments {@link walkAtomText} and its formatters take, out
 * of the positioned list a stored or mirrored substrate carries.
 *
 * Document order is the order the placeholders appear in the text, so dropping
 * the positions loses nothing the text does not already say.
 */
export function substrateSegments(
  atoms: ReadonlyArray<TugSubstrateAtom>,
): AtomSegment[] {
  return atoms.map((atom) => ({
    kind: "atom" as const,
    type: atom.type,
    label: atom.label,
    value: atom.value,
    ...(atom.id !== undefined ? { id: atom.id } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * Build the clipboard sidecar for a `(text, atoms)` substrate: one entry per
 * `U+FFFC` in `text`, positioned where that character sits.
 *
 * `getBytes` resolves an atom id to its stored image bytes so an image chip
 * pastes as a picture rather than as a name with nothing behind it. Omit it
 * for a surface with no bytes store; an atom whose bytes have been evicted
 * travels as metadata only, which is what it is.
 *
 * Returns `null` when the substrate carries no atoms — a plain-prose copy has
 * no sidecar to write beyond whatever provenance the caller attaches.
 */
export function atomTextClipboardPayload(
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
  getBytes?: (id: string) => AtomBytesEntry | null,
): TugAtomsClipboardPayload | null {
  const entries: TugAtomsClipboardEntry[] = [];
  let atomIndex = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== TUG_ATOM_CHAR) continue;
    const segment = atoms[atomIndex];
    atomIndex++;
    // A stray `U+FFFC` with no atom beside it is passed over, matching the
    // renderer's defensive walk ([Spec S03]): the character survives in the
    // sidecar's text, and nothing claims to know what it stood for.
    if (segment === undefined) continue;
    const entry: TugAtomsClipboardEntry = { position: i, segment };
    const id = segment.id;
    if (id !== undefined && getBytes !== undefined) {
      const bytes = getBytes(id);
      if (bytes !== null) entry.bytes = bytes;
    }
    entries.push(entry);
  }
  if (entries.length === 0) return null;
  return { version: 1, text, atoms: entries };
}

/**
 * Copy an atom-bearing substrate: `plain` as the readable text, the substrate
 * itself as the atom sidecar, and the project root in scope at `node` as
 * provenance — the same stamp {@link copyTextFrom} applies to prose.
 *
 * Resolves `true` once the write lands, so a caller's "Copied" flash waits on
 * the write rather than on the call ([L23]).
 */
export function copyAtomTextFrom(
  node: Node | null | undefined,
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
  plain: string,
  getBytes?: (id: string) => AtomBytesEntry | null,
): Promise<boolean> {
  return copyAtomText(text, atoms, plain, clipboardOriginFor(node), getBytes);
}

/**
 * Copy an atom-bearing substrate stamped with roots the caller already holds
 * rather than with one read off the DOM — the {@link copyTextWithOrigins}
 * shape, for a surface whose provenance is data.
 *
 * The Jots card is the one such surface: a jot carries the roots of every
 * passage pasted into it, so it has more than one root to pass on and no DOM
 * node that knows them.
 */
export function copyAtomTextWithOrigins(
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
  plain: string,
  origins: readonly string[],
  getBytes?: (id: string) => AtomBytesEntry | null,
): Promise<boolean> {
  return copyAtomText(text, atoms, plain, origins, getBytes);
}

function copyAtomText(
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
  plain: string,
  origins: readonly string[] | string | null,
  getBytes?: (id: string) => AtomBytesEntry | null,
): Promise<boolean> {
  if (hasNativeClipboardBridge()) {
    const sidecar = withClipboardOrigins(
      atomTextClipboardPayload(text, atoms, getBytes),
      text,
      origins,
    );
    const wrote = writeClipboardViaNative(
      plain,
      sidecar === null ? "" : JSON.stringify(sidecar),
    );
    if (wrote) return Promise.resolve(true);
  }
  const writeText = navigator.clipboard?.writeText;
  if (writeText === undefined) return Promise.resolve(false);
  return writeText
    .call(navigator.clipboard, plain)
    .then(() => true)
    .catch(() => false);
}
