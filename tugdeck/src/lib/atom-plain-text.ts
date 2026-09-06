/**
 * atom-plain-text — one plain-text spelling per atom kind, in one function.
 *
 * `text/plain` is the flavor that LEAVES Tug, so it is the one an atom cannot
 * afford to have three answers for. It had three: the annotation menu's
 * `atomPlainTextFor`, which knew a commit spells itself `commit:<8>`; the
 * substrate copy's `formatAtomTextForCopy`, which had one heuristic — bare
 * label when `value === label`, else `[label](<value>)` — and so wrote a
 * commit as `[commit:64747b8c](<64747b8c>)`, a markdown link with a sha for a
 * URL; and the editor's own `serializeClipboard` fallback, which wrote the
 * bare label through `chipDisplayLabel`. Three functions answering one
 * question, disagreeing on the two kinds whose label and value differ on
 * purpose.
 *
 * So the table is here and the three writers read it. The `value === label`
 * heuristic and `chipDisplayLabel`'s command-only special case are not gone;
 * they are arms of this table, which is the difference between a rule and a
 * coincidence.
 *
 * The spellings, and why each is what it is:
 *
 *  - **commit** → `commit:<8>`. Its value is a bare sha, which names nothing a
 *    reader outside Tug can place, and `commit:<8>` is what every commit
 *    surface already draws — so what the eye read and what the clipboard
 *    carries are one string. [D174] and `tuglaws/entity-presentation.md`.
 *  - **session** → its identity line. See the caveat below.
 *  - **command** → `/name`, the leading slash it is drawn with, so the text
 *    pasted back is the text that was submitted.
 *  - **file** and **directory** → `[name](<path>)`. The path is real
 *    information a plain paste should keep, and the angle brackets are what
 *    keep a space or a paren in it from breaking CommonMark's link parsing.
 *    A browser-dropped file exposes no path at all, so its value and label are
 *    equal and the redundant `[a.jpeg](<a.jpeg>)` collapses to the name.
 *  - **link** → `[label](<url>)`, the same shape for the same reason.
 *  - **image** → the name, which is what the collapse above already gives it:
 *    a pasted picture's value IS its filename, so label and value are equal
 *    and there is nothing for the link shape to carry. An image DROPPED from
 *    disk is the case that argues against a special arm — its value is a real
 *    absolute path, `payloadForAtom` opens it as one, and a rule that spelled
 *    it as the bare name would throw away exactly the information the file
 *    arm exists to keep.
 *
 * **The session is the one kind the substrate cannot fully answer**, and this
 * is a fact about the data rather than a gap in the table. A session atom's
 * segment holds the identity LINE (`project/tag`) as both its label and its
 * value; the citation the doctrine wants — `project/tag (shortId)` — needs the
 * identity record, reachable only from the session id, and the substrate does
 * not carry one (`payloadForAtom` has no session arm for the same reason). So
 * a copy that starts from a segment writes the line, and `atomPlainTextFor`
 * keeps the citation for the one caller that holds the id: the annotation
 * menu, working from the annotation payload rather than from the atom.
 *
 * Pure, and free of the session and identity stores on purpose — every writer
 * of the `text/plain` flavor can reach it, and a unit test can read its whole
 * table as data.
 *
 * @module lib/atom-plain-text
 */

import { chipDisplayLabel, COMMIT_ATOM_TYPE } from "./command-atom";
import { commitAtomLabel } from "./commit-format";
import { isSessionAtomType } from "./session-atom-shape";

/** The atom fields the spelling is decided from — `AtomSegment`'s own three. */
export interface AtomPlainTextInput {
  type: string;
  label: string;
  value: string;
}

/**
 * The `text/plain` spelling of one atom.
 *
 * Every writer of the flavor calls this, so a commit copied out of a
 * transcript, out of the prompt editor and out of a receipt is one string.
 */
export function atomPlainText(atom: AtomPlainTextInput): string {
  const { type, label, value } = atom;
  // From the VALUE rather than from the label: the label is whatever drew the
  // chip, and a commit's spelling is derived from its sha wherever it came
  // from — which is the same rule `TugCommitAtom` renders under.
  if (type === COMMIT_ATOM_TYPE) return commitAtomLabel(value);
  // The identity line, which is all the segment holds. The citation belongs to
  // `atomPlainTextFor`, above the substrate, where the session id is.
  if (isSessionAtomType(type)) return value;
  // The leading `/` the chip is drawn with — `chipDisplayLabel`'s one special
  // case, folded in here as an arm rather than standing beside the table.
  if (type === "command") return chipDisplayLabel(type, label, value);
  // Nothing extra to encode — the link shape would be `[a.jpeg](<a.jpeg>)`,
  // which reads as a mistake rather than as a reference.
  if (value === label || value === "") return label;
  return `[${label}](<${value}>)`;
}
