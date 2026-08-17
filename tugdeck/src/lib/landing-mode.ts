/**
 * landing-mode — the one interface the composer reads to drive a landing
 * ([P01]).
 *
 * A landing mode owns the prompt entry's whole document: the editor holds a
 * message, Z5 swaps to cancel / auto-message / land, and the composer's own
 * prompt draft is set aside until the mode exits. Commit mode was the first;
 * join mode is the second. Because the composer holds exactly one document, at
 * most one landing mode can be active — and one `landingMode` slot on
 * `TugPromptEntry` makes that structural rather than a rule two controllers
 * each have to remember.
 *
 * The interface is extracted from `CommitModeController`'s shipped public
 * shape rather than designed fresh, so the commit surface conforms with no
 * change to its behavior and its test file stays the regression net.
 *
 * @module lib/landing-mode
 */

import type { DraftOverlayPhase } from "@/lib/changeset-draft-store";
import type { CommitPhase, JoinPhase } from "@/lib/changeset-verb-store";

/** Which landing this mode performs — the composer's chrome reads it. */
export type LandingKind = "commit" | "join";

/**
 * What a land press did — the verdict `land` hands back to whoever pressed
 * ([L31]).
 *
 * A `void` land is a door held open for silence: a caller that discards the
 * outcome looks identical to a caller that never had one, and the compiler
 * cannot tell the difference. Reporting by type is the structural half of the
 * no-silent-refusals contract; the controller surfacing its own refusals is the
 * other half, so a caller that ignores this still cannot lose the reason.
 */
export type LandOutcome =
  /** Handed to the host's land hook — it fires on the host's beat. */
  | { kind: "staged" }
  /** Ran inline; no hook was installed. */
  | { kind: "fired" }
  /** Refused, with the sentence the mode surfaced. */
  | { kind: "refused"; sentence: string };

/**
 * The fault sentence both landing modes use when the changeset service is
 * absent. A missing store means the app is broken rather than that the user did
 * something wrong, so the sentence names the remediation instead of a hint
 * ([L31]).
 */
export const CHANGES_SERVICE_DISCONNECTED =
  "The changes service isn't connected — reload the card and try again";

/**
 * A refusal the mode has surfaced, published so a notice surface can speak it
 * ([L31]).
 */
export interface LandingRefusal {
  /** The human sentence, from the mode's own disabled-reason producer. */
  sentence: string;
  /**
   * `gate` — the mode's land gate refused, which is the user's to clear.
   * `fault` — a dependency is missing, which is the app being broken and needs
   * a remediation rather than a hint.
   */
  kind: "gate" | "fault";
  /**
   * Monotonic per-controller counter. Pressing a refusing button twice must
   * speak twice, and the second refusal is usually word-for-word the first, so
   * a surface that keyed on the sentence would go quiet exactly when the user
   * is asking again.
   */
  seq: number;
}

/**
 * The land verb's round-trip phase. Commit and join share `idle` / `pending` /
 * `done` / `error`; join adds the two beats commit has no analogue for.
 */
export type LandingPhase = CommitPhase | JoinPhase;

/**
 * Refusal equality for the controllers' `snapshotsEqual` — `seq` carries the
 * identity, so a repeat of the same sentence is a different refusal.
 */
export function sameRefusal(a: LandingRefusal | null, b: LandingRefusal | null): boolean {
  if (a === null || b === null) return a === b;
  return a.seq === b.seq && a.sentence === b.sentence && a.kind === b.kind;
}

/** What every landing mode publishes; each kind adds its own fields. */
export interface LandingSnapshot {
  /** Whether the mode is active (the composer is a message editor). */
  active: boolean;
  /** The `/commit <message>` or `/dash-join … <message>` seed, or null. */
  seedMessage: string | null;
  /**
   * The land gate ignoring message emptiness. The land button's JS-disabled
   * state; message-empty is CSS-gated on the entry's `data-commit-empty` so
   * per-keystroke React state is avoided ([L22]).
   */
  canLandIgnoringMessage: boolean;
  /**
   * Why {@link canLandIgnoringMessage} is false, in the mode's own words — or
   * null when it is true.
   *
   * A disabled control that cannot say what would enable it is a dead end, and
   * the land button is the worst place to have one: the whole landing is in
   * front of it. Each mode already computes this sentence for its own surface
   * (join's is `joinDisabledReason`, over the preview's outcome and blockers),
   * so what this field does is carry the sentence to the button rather than let
   * the composer fall back to a constant that names no cause.
   */
  landBlockedReason: string | null;
  /** The auto-message draft overlay phase (drives the pencil pose + pulse). */
  draftPhase: DraftOverlayPhase;
  /** Live draft text — streaming while drafting, the settled message otherwise. */
  draftText: string;
  /** The settled persisted message (the seed source). */
  persistedMessage: string;
  /** Whether the persisted draft was user-edited (guards the Replace confirm). */
  edited: boolean;
  /**
   * Every land gate satisfied right now, message included — what the Session
   * menu's landing item gates on. Distinct from {@link canLandIgnoringMessage},
   * which omits the message so the button can CSS-gate emptiness per keystroke.
   */
  landReady: boolean;
  /** Land round-trip phase — `"pending"` drives the in-flight button label. */
  landPhase: LandingPhase;
  /** Land error detail to surface, or null. */
  landError: string | null;
  /**
   * The most recent refused land press, or null when none has been refused
   * since the mode last exited or landed ([L31]).
   */
  landRefusal: LandingRefusal | null;
  /** Draft error detail to surface, or null. */
  draftError: string | null;
}

/**
 * The façade `TugPromptEntry` drives. Both `CommitModeController` and
 * `JoinModeController` implement it; the composer never names either class.
 */
export interface LandingMode {
  /** Which landing this is — the composer's labels are functions of it. */
  readonly kind: LandingKind;

  // Store surface ([L02]).
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => LandingSnapshot;

  /** Install (or clear) the composer's live read of its message document. */
  setMessageProvider: (read: (() => string) | null) => void;
  /** The composer's message crossed the empty ↔ non-empty line. */
  notifyMessageChanged: () => void;
  /** Persist a message edit into the mode's draft row. */
  persistMessage: (text: string) => void;
  /** Request an auto-message draft; `force` is the confirmed Regenerate. */
  requestDraft: (force?: boolean) => void;
  /** Cancel an in-flight auto-message draft; a no-op when nothing is drafting. */
  cancelDraft: () => void;
  /**
   * Land, subject to the mode's gate. A refusal is surfaced by the mode itself
   * and reported here by type ([L31]) — never a silent no-op.
   */
  land: (message: string) => LandOutcome;
  /** The user leaving the route: persist what is typed, then exit. */
  leave: () => void;
  /** Exit the mode without persisting (the land path's own way out). */
  exit: () => void;
  /**
   * Install (or clear with `null`) the host's land orchestrator, so the land
   * can be staged behind the Changes shade's dismissal instead of firing
   * inline.
   */
  setLandHook: (hook: ((runLand: () => void) => void) | null) => void;
}
