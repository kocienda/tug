/**
 * session-chip-verdict.ts — which face a baked session chip wears.
 *
 * The composer's chip is pixels: it cannot subscribe, cannot cascade, and
 * cannot read the `data-missing` skin `tug-session-identity.css` paints over
 * the mounted pill. So the one fact the pill gets from CSS — *nothing on this
 * machine answers for this reference* — has to be decided before the bake and
 * handed to the painter.
 *
 * Deciding it here rather than inside `tug-atom-img.ts` keeps the painter
 * ignorant of the citation store, and keeps the rule in one expression the
 * widget, the selection re-bake and a test can all read.
 *
 * **Only `unknown` is missing.** `pending` is this client not having heard
 * back, and dashing on it would flash every chip dashed for the width of one
 * round trip; `found` and `elsewhere` are both sessions a reader can reach,
 * and the elsewhere distinction is the mounted pill's to draw — the bake has
 * no tooltip to carry the sentence that would make a second face mean
 * anything.
 *
 * @module lib/session-chip-verdict
 */

import { sessionCitationStore } from "@/lib/session-citation-store";
import {
  isSessionAtomType,
  sessionVerdictAskKey,
} from "@/lib/session-atom-shape";
import type { AtomSegment } from "@/lib/tug-atom-img";

/**
 * Whether a session atom's chip should bake in the `missing` face.
 *
 * Reads the cached answer only — it never asks. The ask belongs to the widget
 * that mounts the chip (`AtomWidget.toDOM`), under {@link
 * sessionVerdictAskKey}'s spelling, which is the same key this reads under.
 *
 * A non-session atom is never missing: no other type has a verdict to be
 * missing from.
 */
export function sessionChipVerdict(atom: AtomSegment): "default" | "missing" {
  if (!isSessionAtomType(atom.type)) return "default";
  const answer = sessionCitationStore.getAnswer(sessionVerdictAskKey(atom));
  return answer.status === "unknown" ? "missing" : "default";
}
