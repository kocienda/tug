/**
 * Does this candidate name a real session? — the annotator's adapter over
 * `session-citation-store`.
 *
 * The path scan has `pathResolutionStore`; the commit scan has the commit
 * resolver; this is the session scan's, and it keeps their contract exactly:
 * synchronous, cached, and an answer that arrives later re-runs the pass.
 *
 * **Resolution is not the spelling.** The ledger accepts a full uuid, a unique
 * 8-char prefix, or a **bare callsign** matched against `sessions.tag` — and
 * nothing else. `project/callsign` is not a query key in any arm; sent whole it
 * falls through every one and comes back unknown. So a detected pair is split
 * and the **callsign half** is what goes to the store.
 *
 * **The project half is evidence, not decoration.** It is checked against the
 * answer's own `projectDir` (by basename), and a callsign that resolves under a
 * different project is refuted rather than confirmed. That check is the whole
 * reason the pair shape beats the bare callsign the detector rejects: without
 * it the project prefix would add characters and nothing else.
 *
 * @module lib/annotator/session-resolution
 */

import {
  sessionAtomCallsign,
  sessionAtomProject,
} from "@/lib/session-atom-shape";
import { sessionCitationStore } from "@/lib/session-citation-store";
import { noteVerdictKey, sessionVerdictKey } from "./verdict-keys";

/**
 * What the ledger says about a session candidate.
 *
 * The path verdict's vocabulary, narrowed to what this decides:
 *
 *  - `pending` — nobody has asked, or the ask is in flight. The pass marks
 *    nothing and RESERVES the run, so no other scan may claim it while the
 *    answer is out (`annotate-content.ts`).
 *  - `confirmed` — the ledger holds it and the project half agrees. Carries
 *    the FULL session id, which is what a citation chip needs regardless of
 *    how the prose spelled it.
 *  - `refuted` — no such session, or it belongs to another project. The run
 *    goes back to the prose.
 */
export type SessionVerdict =
  | { state: "pending" }
  | { state: "confirmed"; sessionId: string }
  | { state: "refuted" };

const PENDING: SessionVerdict = Object.freeze({ state: "pending" });
const REFUTED: SessionVerdict = Object.freeze({ state: "refuted" });

/** The last path segment of `dir`, with any trailing separators ignored. */
function basename(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * The verdict for one detected session reference.
 *
 * Asking on a cache miss is a side effect inside a synchronous pass, which is
 * `pathResolutionStore.lookup`'s existing contract rather than a new pattern:
 * record the want, answer `pending`, notify on arrival. This must be the only
 * caller for a scanned candidate, so the ask is deduped by the store rather
 * than by luck.
 */
export function resolveSessionRef(target: string): SessionVerdict {
  const queried = sessionAtomCallsign(target);
  if (queried === "") return REFUTED;
  // The callsign is the ledger's key, and the store's own notifications name
  // it the same way — so the ink painted under this answer re-marks when the
  // ledger changes its mind. See `verdict-keys.ts`.
  noteVerdictKey(sessionVerdictKey(queried));
  const answer = sessionCitationStore.getAnswer(queried);
  if (answer.status === "pending") {
    sessionCitationStore.request(queried);
    return PENDING;
  }
  if (answer.status === "unknown") return REFUTED;
  const project = sessionAtomProject(target);
  // A pair's project half is checked; a bare uuid has none to check, and needs
  // none — it is already unambiguous.
  if (project !== null && basename(project) !== basename(answer.projectDir)) {
    return REFUTED;
  }
  return { state: "confirmed", sessionId: answer.sessionId };
}
