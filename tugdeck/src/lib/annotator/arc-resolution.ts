/**
 * Does this name an arc in the project's arc log? — the annotator's adapter
 * over `arc-citation-store`.
 *
 * It keeps every other resolver's contract: synchronous, cached, and an answer
 * that arrives later re-runs the pass. The verdict key is noted before the
 * store is read, so ink painted under a `pending` answer is re-walked when the
 * answer lands, and ink painted under a `confirmed` one is re-walked if a
 * reconnect drops it.
 *
 * @module lib/annotator/arc-resolution
 */

import { arcCitationStore } from "@/lib/arc-citation-store";
import { arcVerdictKey, noteVerdictKey } from "./verdict-keys";

/**
 * What the arc log says about one name.
 *
 *  - `pending` — not asked yet, or the ask is in flight. Nothing is marked.
 *  - `confirmed` — the arc can be read back. `joinSha` is the squash commit
 *    when the arc was joined; a `discarded` arc has none, since nothing of it
 *    landed.
 *  - `refuted` — nothing on this machine can read it back. The text stays
 *    plain.
 */
export type ArcVerdict =
  | { state: "pending" }
  | { state: "confirmed"; fate: "live" | "joined" | "discarded"; joinSha?: string }
  | { state: "refuted" };

const PENDING: ArcVerdict = Object.freeze({ state: "pending" });
export const REFUTED_ARC: ArcVerdict = Object.freeze({ state: "refuted" });

/**
 * The verdict for `name` in the arc log of `root`, asking on a miss — the
 * same side effect inside a synchronous pass every other resolver makes:
 * record the want, answer `pending`, notify on arrival.
 */
export function resolveArcRef(root: string, name: string): ArcVerdict {
  if (root === "" || name === "") return REFUTED_ARC;
  noteVerdictKey(arcVerdictKey(root, name));
  const answer = arcCitationStore.getAnswer(root, name);
  if (answer.status === "pending") {
    arcCitationStore.request(root, name);
    return PENDING;
  }
  if (answer.status === "missing") return REFUTED_ARC;
  return answer.joinSha === undefined || answer.fate !== "joined"
    ? { state: "confirmed", fate: answer.fate }
    : { state: "confirmed", fate: answer.fate, joinSha: answer.joinSha };
}
