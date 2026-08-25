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
import { chipDisplayLabel } from "./command-atom";
import {
  hasNativeClipboardBridge,
  writeClipboardViaNative,
} from "./tug-native-clipboard";
import { TUG_ATOM_CHAR, type AtomSegment } from "./tug-atom-img";

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
 * substituting each atom occurrence with either a CommonMark inline
 * link `[label](value)` (when `value` is a meaningful URL distinct
 * from the label — e.g., an `@`-completed workspace path) or just
 * the bare label (when `value === label`, meaning the substrate has
 * no extra info to encode — e.g., a dropped file, since browsers
 * don't expose absolute paths for drag-and-drop files for security).
 *
 * A stray `U+FFFC` (atom missing or wrong-shape in the parallel
 * array) is passed through verbatim — visible regression rather
 * than a silent drop, mirroring `buildWirePayload`'s defensive
 * posture ([Spec S03]).
 *
 * The label is the chip's own displayed label ({@link chipDisplayLabel}),
 * so a slash command copies with the leading `/` it is drawn with — the
 * text a user pastes back is the text they submitted.
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
    } else if (seg.atom.value === seg.atom.label) {
      // No extra info to encode — drop the markdown-link wrapping
      // and emit the bare label. Avoids the redundant
      // `[raphael.jpeg](raphael.jpeg)` shape for browser-dropped
      // files where `f.name` is all the platform exposes.
      out += chipDisplayLabel(seg.atom.type, seg.atom.label, seg.atom.value);
    } else {
      // Use angle brackets so spaces, parens, and other non-URL-safe
      // chars in the path don't break CommonMark's link parsing.
      out += `[${chipDisplayLabel(seg.atom.type, seg.atom.label, seg.atom.value)}](<${seg.atom.value}>)`;
    }
  }
  return out;
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
  if (hasNativeClipboardBridge()) {
    const sidecar = withClipboardOrigins(
      atomTextClipboardPayload(text, atoms, getBytes),
      text,
      clipboardOriginFor(node),
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
