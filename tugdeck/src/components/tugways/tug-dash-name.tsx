/**
 * `TugDashName` — a dash named in whichever of its two registers applies.
 *
 * **The register is the fact.** A dash somebody is working leads with that
 * worker's session atom, the dash riding inside it — because a session is
 * always shown WITH its bound dash, and splitting the two onto one line would
 * state the pairing twice and let the halves drift. A dash nobody is working
 * has no atom to ride and takes the caret run in monospace. Proportional in a
 * pill means somebody is on this; monospace means nobody is, and a reader can
 * sort a list on that before a word is read.
 *
 * **Two or more workers on one dash is legal**, not a race: `bound_sessions`
 * is a list because two cards on one dash is doctrine, and the Lens already
 * answers that with one chip per session. This renders one atom per bound
 * session for the same reason, rather than inventing a "+1 more".
 *
 * **The enclosure is not authored here.** `DashSigil atom` wears the settled
 * session-atom skin, so the pill's radius, hairline, padding and size scale are
 * `tug-session-identity.css`'s and change with it. A dash atom and a session
 * atom are siblings by construction rather than by two sets of numbers kept
 * equal by hand. The one thing this file adds is the family, because that is
 * the register and the skin has nothing to say about it.
 *
 * The dash is passed rather than looked up. A surface rendering this row
 * already holds the fact, and making the atom re-derive it from the changeset
 * store would put something the row was built from behind a feed arriving.
 *
 * Laws: [L19] file pair, docblock, `data-slot`; [L20] owns `--tugx-dash-name-*`.
 *
 * @module components/tugways/tug-dash-name
 */

import "./tug-dash-name.css";

import type React from "react";

import { DashSigil } from "@/components/tugways/dash-sigil";
import { TugSessionIdentity } from "@/components/tugways/tug-session-identity";
import { useSessionIdentity } from "@/lib/session-identity";

export function TugDashName({
  name,
  review,
  boundSessions,
  slot,
  workerSlot,
}: {
  name: string;
  review: string | null;
  /** Live sessions mated to this dash. Empty (or absent) is the unbound
   *  register — which is a statement, not a fallback. */
  boundSessions?: readonly string[];
  /** The `data-slot` an unbound name answers to on this surface. */
  slot: string;
  /**
   * The `data-slot` a worker's atom answers to. Separate from `slot` because
   * the two registers are two different statements rather than one with a
   * variant — a surface asking "what dash is on this row" and one asking "who
   * is working it" are asking different questions, and a single slot would
   * answer both with whichever happened to render.
   */
  workerSlot: string;
}): React.ReactElement {
  const bound = boundSessions ?? [];
  if (bound.length === 0) {
    return (
      <span className="tug-dash-name" data-register="unbound">
        <DashSigil name={name} review={review} slot={slot} atom />
      </span>
    );
  }
  return (
    <span className="tug-dash-name" data-register="bound">
      {bound.map((sessionId) => (
        <BoundWorkerAtom
          key={sessionId}
          sessionId={sessionId}
          dash={{ name, review }}
          slot={workerSlot}
        />
      ))}
    </span>
  );
}

/** One worker's atom, resolved by id, wearing the dash it is working. */
function BoundWorkerAtom({
  sessionId,
  dash,
  slot,
}: {
  sessionId: string;
  dash: { name: string; review: string | null };
  slot: string;
}): React.ReactElement {
  const identity = useSessionIdentity(sessionId);
  return (
    <TugSessionIdentity
      identity={identity}
      tier="chip"
      size="2xs"
      dash={dash}
      tooltip={false}
      data-slot={slot}
    />
  );
}
