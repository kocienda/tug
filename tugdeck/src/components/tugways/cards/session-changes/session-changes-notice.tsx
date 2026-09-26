/**
 * session-changes-notice.tsx — the Changes shade's fixed notice band.
 *
 * Every refusal of a gesture that starts in the Changes shade speaks inside the
 * Changes shade ([B01]). The seat is a fixed band under the shade's header and
 * above its scroller ([P03]): a sibling of `.session-changes-view` rather than
 * a child of it, because a child would scroll away from the rows it is about.
 * The shade's auto-size absorbs the band with no measurement — the shade is
 * `height: fit-content` under a `max-height: 100%` cap and anchored at the
 * bottom, so the band grows it upward into the transcript region ([L06]).
 *
 * The band replaces a strip that said the same words in the seam between the
 * shade's bottom edge and the composer's top edge. That seat was a half-measure
 * at a second distance: outside the scrim by geometry, but still not inside the
 * gesture. The words themselves are unchanged — {@link landingNoticeFace} still
 * decides them — and so are the `session-landing-notice-*` testids, so the pins
 * that already measure them keep working.
 *
 * What is new is the shell. A refusal here wears `TugInlineDialog`, the same
 * primitive the blocked join's blockers already wear one fold below
 * ([B04]) — which means the band's own root has to carry the live region
 * `TugInlineAlert` used to supply, because the dialog announces nothing
 * ([L31] in the other modality).
 *
 * Several tenants can be live at once and the band renders one ([P05]); which
 * one is {@link rankShadeNotices}'s to decide, out in a module with no DOM to
 * need. This file owns only the local questions a surface can answer: which
 * notice is dismissed, whether the details were copied, and whether a fading
 * refusal's four seconds are up. It takes no key view and never focuses on
 * mount — the shade is passive ([P17]).
 *
 * The tenants are the two landings and the shade's own four verbs — claim,
 * disclaim, discard and Auto-Message — whose refusals used to be posted into the
 * card's top-right bulletin lane by three zero-render controllers. That lane
 * sits in the transcript region this shade's own scrim dims, so a refusal of a
 * gesture made here arrived greyed out, above the shade, with an OK button. The
 * plumbing did not move: the verb store's per-`entryKey` error slots and the
 * draft store's overlay are read exactly as the controllers read them, and only
 * the surface that reads them changed.
 *
 * Reads every store through `useSyncExternalStore` ([L02]); the evidence fold
 * is a native `<details>`, so open/closed is the element's ([L06]).
 *
 * @module components/tugways/cards/session-changes/session-changes-notice
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";

import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugInlineDialog } from "@/components/tugways/tug-inline-dialog";
import type { TugInlineDialogIconRole } from "@/components/tugways/tug-inline-dialog";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { LANDING_WORDS } from "@/components/tugways/tug-prompt-entry";
import type { LandingMode, LandingSnapshot } from "@/lib/landing-mode";
import { landingNoticeFace } from "@/lib/landing-notice";
import type { ChangesRouteController } from "@/lib/changes-route-controller";
import {
  arcReplayOutcomeStore,
  conflictDescription,
  type ArcReplayOutcome,
} from "@/lib/arc-replay-outcome-store";
import { getChangesetDraftStore } from "@/lib/changeset-draft-store";
import {
  useChangesetClaim,
  useChangesetDisclaim,
  useChangesetDiscard,
} from "@/lib/changeset-verb-store";

import {
  SHADE_NOTICE_RANK,
  rankShadeNotices,
  shadeOriginReplay,
  type ShadeNoticeCandidate,
  type ShadeNoticeTone,
} from "./session-changes-notice-face";

import "./session-changes-notice.css";

// The view declares the prop's shape, because the card is what fills it and
// the view is the seam the two meet at. Type-only, so the cycle is erased.
import type { SessionChangesNoticeSource } from "./session-changes-view";

/** How long a gate refusal stands before it fades ([P07] of the prior arc). */
const REFUSAL_FADE_MS = 4000;

/**
 * A landing mode the band was not given.
 *
 * `useSyncExternalStore` cannot be called conditionally, and the `notice` prop
 * is optional — a host that carries no landing should still get the band's
 * other tenants. So an absent mode subscribes to nothing and snapshots `null`,
 * with both functions module constants so the hook sees one stable identity.
 */
const NO_SUBSCRIBE = (): (() => void) => () => {};
const NO_SNAPSHOT = (): LandingSnapshot | null => null;

/**
 * One live notice and everything the band needs to render and clear it.
 *
 * The candidate is what the ranker sees. The mode is what a Retry has to press
 * and what supplies the button's word, and it is null for every tenant with
 * nothing to send again — a refused claim is a round trip that already
 * happened, whose remedy is the user's rather than a button's. Keeping the two
 * together is why the band can speak for whichever tenant won without having
 * decided in advance which one that would be.
 */
interface ShadeTenant {
  candidate: ShadeNoticeCandidate;
  /** Dismissal slot — `"<kind>:<channel>"` for a landing, `"<verb>:error"` for a verb. */
  slot: string;
  mode: LandingMode | null;
}

/**
 * Clear one dismissal slot, leaving the rest alone and the object identity
 * unchanged when there was nothing there. A slot whose channel went empty has
 * to forget what was dismissed in it, or the next notice on that channel — the
 * same failure settling twice, say — arrives pre-dismissed and says nothing.
 */
function forgetSlot(
  set: React.Dispatch<React.SetStateAction<Record<string, string | null>>>,
  slot: string,
): void {
  set((prev) => (prev[slot] == null ? prev : { ...prev, [slot]: null }));
}

/**
 * The four shade verbs whose refusals seat here, and the titles the bulletin
 * controllers they replace posted. Transcribed rather than reworded (Spec S01):
 * a refusal's sentence is not this arc's to change, only its seat.
 */
const VERB_NOTICE_TITLES = {
  claim: "Claim failed",
  disclaim: "Disclaim failed",
  discard: "Discard failed",
  draft: "Auto-Message failed",
} as const;

/** One of the shade's own verbs, as the band addresses it. */
type ShadeVerb = keyof typeof VERB_NOTICE_TITLES;

/**
 * Push order for the verb tenants. It decides nothing on its own — the four sit
 * at one rank and recency separates them ([P05]) — so this is only the order a
 * reader meets them in, and the order two refusals that arrived in the same
 * frame fall back to.
 */
const SHADE_VERBS: readonly ShadeVerb[] = ["claim", "disclaim", "discard", "draft"];

/**
 * A shade-origin replay outcome's face, transcribed from the bulletin the Arcs
 * card still posts for its own presses (Spec S01) so the words do not change.
 *
 * All six outcomes seat here, successes included ([P04]): `replayed`, `recorded`
 * and `current` are behind the scrim exactly as the refusals are, and a press
 * whose only answer arrived dimmed above the shade is the same dead button
 * whether the answer was good news or bad.
 */
function replayFace(outcome: ArcReplayOutcome): {
  tone: ShadeNoticeTone;
  title: string;
  description: string | null;
} {
  switch (outcome.outcome) {
    case "current":
      return {
        tone: "default",
        title: `${outcome.arc} is already current with its base`,
        description: null,
      };
    case "replayed":
      return {
        tone: "success",
        title: `${outcome.arc} replayed onto its base`,
        description: null,
      };
    case "recorded":
      return {
        tone: "success",
        title: `${outcome.arc}'s rebase is recorded`,
        description: null,
      };
    case "conflicted":
      return {
        tone: "caution",
        title: `${outcome.arc} can't replay cleanly`,
        description: conflictDescription(outcome),
      };
    default:
      // `deferred` and `error` say the same thing in the same words — the
      // difference between a precondition and a crash is the detail's, not the
      // title's, which is how the bulletin said it too.
      return {
        tone: "caution",
        title: "Couldn't replay that arc",
        description: outcome.detail,
      };
  }
}

export interface SessionChangesNoticeProps {
  /** The per-card Changes controller — the band's address for every shade verb. */
  changesController: ChangesRouteController;
  /**
   * The landing half of the band, from the card: the two landing modes and the
   * composer's after-a-landing beat. Absent leaves the band to its other
   * tenants.
   */
  notice?: SessionChangesNoticeSource;
}

/**
 * Which glyph a tone wears. Three, not one: the band seats a replay's successes
 * too ([P04]), and a warning triangle over "replayed onto its base" would be the
 * face disagreeing with its own words.
 */
function toneIcon(tone: ShadeNoticeTone): React.ReactElement {
  switch (tone) {
    case "success":
      return <CircleCheck />;
    case "default":
      return <Info />;
    default:
      return <TriangleAlert />;
  }
}

/** Which `TugInlineDialog` icon tint a tone wears. */
function iconRoleForTone(tone: ShadeNoticeTone): TugInlineDialogIconRole {
  switch (tone) {
    case "danger":
      return "danger";
    case "caution":
      return "caution";
    case "success":
      return "success";
    default:
      return "default";
  }
}

/** The shade's notice band, or `null` when the shade has nothing to say. */
export function SessionChangesNotice(
  props: SessionChangesNoticeProps,
): React.ReactElement | null {
  const { changesController, notice } = props;
  const commitSnapshot = useSyncExternalStore(
    notice?.commitMode.subscribe ?? NO_SUBSCRIBE,
    notice?.commitMode.getSnapshot ?? NO_SNAPSHOT,
  );
  const joinSnapshot = useSyncExternalStore(
    notice?.joinMode.subscribe ?? NO_SUBSCRIBE,
    notice?.joinMode.getSnapshot ?? NO_SNAPSHOT,
  );

  // The shade's own verbs, read from the very slots the three retired bulletin
  // controllers read, and keyed by the card's entry — the key the presses went
  // out under ([P01], #deep-dive-verb-store). Only the surface moved.
  const claimError = useChangesetClaim(changesController.entryKey).error;
  const disclaimError = useChangesetDisclaim(changesController.entryKey).error;
  const discardError = useChangesetDiscard(changesController.entryKey).error;

  // The Auto-Message overlay, subscribed through *both* stores for the reason
  // the retired bulletin controller recorded: the owner id is derived from the
  // changes controller, so it moves when the line's seat does — and the overlay
  // the band ought to be reading changes without the draft store having emitted
  // anything at all. The snapshot is the detail *string* rather than the
  // overlay object, because `useSyncExternalStore` compares by identity ([L02])
  // and a fresh object every read is an endless re-render.
  const draftSubscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubscribeDraft = getChangesetDraftStore()?.subscribe(onStoreChange);
      const unsubscribeChanges = changesController.subscribe(onStoreChange);
      return () => {
        unsubscribeDraft?.();
        unsubscribeChanges();
      };
    },
    [changesController],
  );
  const draftSnapshot = useCallback((): string | null => {
    const store = getChangesetDraftStore();
    if (store === null) return null;
    const overlay = store.overlay(
      changesController.workspaceKey,
      changesController.draftOwnerKind,
      changesController.requestOwnerId(),
    );
    return overlay.phase === "error" ? overlay.detail : null;
  }, [changesController]);
  const draftError = useSyncExternalStore(draftSubscribe, draftSnapshot);

  // The replay slot. `arcReplayOutcomeStore` holds one outcome per session and
  // the corner lane reads the same slot, so the two divide it by the stamp the
  // press carries rather than by which surface is up ([P01], Spec S03). The
  // session read is the card's own, which exists whether or not the card is
  // bound — so on an unbound card this band is the slot's only reader, and the
  // stamp is what stops it claiming an Arcs-card press.
  const replayOutcome = useSyncExternalStore(
    arcReplayOutcomeStore.subscribe,
    useCallback(
      () => arcReplayOutcomeStore.outcomeFor(changesController.tugSessionId),
      [changesController],
    ),
  );
  const shadeReplay = shadeOriginReplay(replayOutcome, changesController.entryKey);

  // Both modes are read, each gated on its own `active` — which is how the seam
  // strip did it, with one instance per mode. Choosing the active mode first and
  // speaking only for that one looks equivalent and is not: it makes the band
  // silent for a refusal on the mode that lost the coin toss, which is the
  // [L31] failure this band exists to remove. The ordering between them is List
  // L01's (commit, then join) and it belongs to the ranker, not to a search.
  const commitFace = useMemo(
    () =>
      notice === undefined || commitSnapshot === null || !commitSnapshot.active
        ? null
        : landingNoticeFace(notice.commitMode.kind, commitSnapshot),
    [notice, commitSnapshot],
  );
  const joinFace = useMemo(
    () =>
      notice === undefined || joinSnapshot === null || !joinSnapshot.active
        ? null
        : landingNoticeFace(notice.joinMode.kind, joinSnapshot),
    [notice, joinSnapshot],
  );

  // Dismissal is per slot, and a slot is a mode's channel: dismissing a
  // standing commit error must not silence the refusal of the press that
  // follows it, nor anything the join is saying. Each slot clears when its own
  // channel goes null, so the next notice there speaks even when it is
  // word-for-word the last one.
  const [dismissed, setDismissed] = useState<Record<string, string | null>>({});
  const [copied, setCopied] = useState(false);
  const [faded, setFaded] = useState<Record<string, string | null>>({});

  // Recency among the verb tenants. The four sit at one rank ([P05]) and the
  // newest speaks, so each needs a number, and the number is assigned in an
  // effect rather than during render: a re-render that changed nothing must not
  // renumber a notice, or the band would reshuffle while the user reads it. The
  // counter itself is local data in a ref ([L24]) — it is never rendered.
  const [verbSeq, setVerbSeq] = useState<Partial<Record<ShadeVerb, number>>>({});
  const nextVerbSeq = useRef(0);
  const noteVerb = useCallback((verb: ShadeVerb, detail: string | null): void => {
    if (detail === null) {
      setVerbSeq((prev) => (prev[verb] === undefined ? prev : { ...prev, [verb]: undefined }));
      return;
    }
    const seq = (nextVerbSeq.current += 1);
    setVerbSeq((prev) => ({ ...prev, [verb]: seq }));
  }, []);

  const commitErrorKey = commitFace?.error?.key ?? null;
  const commitRefusalKey = commitFace?.refusal?.key ?? null;
  const joinErrorKey = joinFace?.error?.key ?? null;
  const joinRefusalKey = joinFace?.refusal?.key ?? null;

  useEffect(() => {
    if (commitErrorKey === null) forgetSlot(setDismissed, "commit:error");
  }, [commitErrorKey]);
  useEffect(() => {
    if (commitRefusalKey === null) forgetSlot(setDismissed, "commit:refusal");
  }, [commitRefusalKey]);
  useEffect(() => {
    if (joinErrorKey === null) forgetSlot(setDismissed, "join:error");
  }, [joinErrorKey]);
  useEffect(() => {
    if (joinRefusalKey === null) forgetSlot(setDismissed, "join:refusal");
  }, [joinRefusalKey]);

  // The verb slots, each forgetting its dismissal and taking its recency number
  // on its own detail string — so dismissing a refused claim never silences a
  // refused discard, and the same claim refused twice speaks the second time.
  useEffect(() => {
    if (claimError === null) forgetSlot(setDismissed, "claim:error");
    noteVerb("claim", claimError);
  }, [claimError, noteVerb]);
  useEffect(() => {
    if (disclaimError === null) forgetSlot(setDismissed, "disclaim:error");
    noteVerb("disclaim", disclaimError);
  }, [disclaimError, noteVerb]);
  useEffect(() => {
    if (discardError === null) forgetSlot(setDismissed, "discard:error");
    noteVerb("discard", discardError);
  }, [discardError, noteVerb]);
  useEffect(() => {
    if (draftError === null) forgetSlot(setDismissed, "draft:error");
    noteVerb("draft", draftError);
  }, [draftError, noteVerb]);

  // The replay slot forgets its dismissal when the slot empties, like every
  // other channel. Keyed on the outcome's `seq` rather than its words: two
  // identical answers in a row are two presses, and the second must speak.
  const replaySeq = shadeReplay?.seq ?? null;
  useEffect(() => {
    if (replaySeq === null) forgetSlot(setDismissed, "replay:outcome");
  }, [replaySeq]);

  // "Copied" is the confirmation, so it lasts exactly as long as the notice it
  // confirms — a new failure is a new thing to copy.
  useEffect(() => {
    setCopied(false);
  }, [commitErrorKey, joinErrorKey]);

  // A gate refusal fades: the user can see the condition and clear it, and the
  // seat should not fill with "not yet". One timer armed on the refusal's own
  // key, cleared on change and on unmount — an event's one-shot, not a poll.
  const commitFading = commitFace?.refusal?.tone === "caution";
  useEffect(() => {
    if (!commitFading || commitRefusalKey === null) return;
    const timer = setTimeout(
      () => setFaded((prev) => ({ ...prev, "commit:refusal": commitRefusalKey })),
      REFUSAL_FADE_MS,
    );
    return () => clearTimeout(timer);
  }, [commitFading, commitRefusalKey]);
  const joinFading = joinFace?.refusal?.tone === "caution";
  useEffect(() => {
    if (!joinFading || joinRefusalKey === null) return;
    const timer = setTimeout(
      () => setFaded((prev) => ({ ...prev, "join:refusal": joinRefusalKey })),
      REFUSAL_FADE_MS,
    );
    return () => clearTimeout(timer);
  }, [joinFading, joinRefusalKey]);

  // Every hook above runs before any bailout, because a bailout ahead of them
  // would change the hook order between renders.
  //
  // List L01's order falls out of the push order: the two errors at one rank
  // with commit first, then the two refusals, and the ranker keeps the caller's
  // order inside a rank.
  const tenants: ShadeTenant[] = [];
  if (notice !== undefined) {
    for (const [mode, face] of [
      [notice.commitMode, commitFace] as const,
      [notice.joinMode, joinFace] as const,
    ]) {
      if (face?.error == null) continue;
      const slot = `${mode.kind}:error`;
      if (dismissed[slot] === face.error.key) continue;
      tenants.push({
        mode,
        candidate: {
          rank: SHADE_NOTICE_RANK.landingError,
          key: face.error.key,
          channel: face.error.channel,
          tone: face.error.tone,
          title: face.error.title,
          description: face.error.remedy,
          detail: face.error.detail,
          // Retry is the error channel's alone: a press that never happened has
          // nothing to send again.
          act: face.error.retry ? "retry" : "none",
        },
        slot,
      });
    }
    for (const [mode, face] of [
      [notice.commitMode, commitFace] as const,
      [notice.joinMode, joinFace] as const,
    ]) {
      if (face?.refusal == null) continue;
      const slot = `${mode.kind}:refusal`;
      if (dismissed[slot] === face.refusal.key) continue;
      if (face.refusal.tone === "caution" && faded[slot] === face.refusal.key) continue;
      tenants.push({
        mode,
        candidate: {
          rank: SHADE_NOTICE_RANK.landingRefusal,
          key: face.refusal.key,
          channel: face.refusal.channel,
          tone: face.refusal.tone,
          title: face.refusal.title,
          description: face.refusal.remedy,
          detail: face.refusal.detail,
          act: "none",
        },
        slot,
      });
    }
  }

  // The shade's own verbs, one rank below the landing. They are pushed in
  // `SHADE_VERBS` order and separated by recency, so the list's order matters
  // only to two refusals that arrived in the same frame.
  const verbDetails: Record<ShadeVerb, string | null> = {
    claim: claimError,
    disclaim: disclaimError,
    discard: discardError,
    draft: draftError,
  };
  for (const verb of SHADE_VERBS) {
    const detail = verbDetails[verb];
    if (detail === null) continue;
    const slot = `${verb}:error`;
    if (dismissed[slot] === detail) continue;
    tenants.push({
      candidate: {
        rank: SHADE_NOTICE_RANK.verbError,
        // The detail string is the identity: the same verb refused twice for
        // two reasons is two notices, and twice for one reason is one.
        key: detail,
        channel: "error",
        tone: "danger",
        title: VERB_NOTICE_TITLES[verb],
        // Here the detail *is* the sentence, so it rides the description rather
        // than the evidence fold — which is what the bulletins this replaces
        // did with it, and the fold exists for git's own multi-line output.
        description: detail,
        detail: null,
        act: "none",
        seq: verbSeq[verb],
      },
      slot,
      // Nothing to send again: a refused claim is a round trip that already
      // happened, and its remedy is the user's.
      mode: null,
    });
  }

  // The replay outcome, last ([P05]): a landing or a verb refusal is something
  // the user is waiting on, and a rebase's answer can wait a beat behind either.
  if (shadeReplay !== null) {
    const slot = "replay:outcome";
    const key = String(shadeReplay.seq);
    if (dismissed[slot] !== key) {
      const face = replayFace(shadeReplay);
      tenants.push({
        candidate: {
          rank: SHADE_NOTICE_RANK.replayOutcome,
          key,
          channel: "replay",
          tone: face.tone,
          title: face.title,
          description: face.description,
          detail: null,
          act: "none",
        },
        slot,
        mode: null,
      });
    }
  }

  const winner = rankShadeNotices(tenants.map((tenant) => tenant.candidate));
  if (winner === null) return null;
  const tenant = tenants.find((candidate) => candidate.candidate === winner)!;
  const face = winner;

  const handleCopy = (): void => {
    // Writing inside a trusted click is silent in WKWebView; it is *reading*
    // the clipboard that raises the permission sheet.
    const said = face.description === null ? face.title : `${face.title}\n${face.description}`;
    const text = face.detail === null ? said : `${said}\n\n${face.detail}`;
    void navigator.clipboard?.writeText(text);
    setCopied(true);
  };

  const handleRetry = (): void => {
    if (tenant.mode === null) return;
    const outcome = tenant.mode.retry();
    // A refused retry has already spoken for itself through the mode ([L31]),
    // and the reader has not moved — the branch mirrors `performSubmit`'s.
    if (outcome.kind !== "refused") notice?.onAfterRetry();
  };

  const retryWord = tenant.mode === null ? null : LANDING_WORDS[tenant.mode.kind].retry;

  return (
    <div
      className="session-changes-notice"
      data-slot="session-changes-notice"
      data-testid="session-changes-notice"
      data-channel={face.channel}
      data-tone={face.tone}
      // The live region `TugInlineAlert` supplied and `TugInlineDialog` does
      // not. It rides the band's own root, outside the primitive, so no token
      // or slot contract is touched ([L20] is not in play for an ARIA
      // attribute).
      role={face.tone === "danger" ? "alert" : "status"}
    >
      <TugInlineDialog
        className="session-changes-notice-dialog"
        // The glyph follows the tone. [P04] holds that a shade-origin replay
        // needs no register of its own beyond `iconRole` and `data-tone`, and
        // this is not one — it is the same one face declining to put a warning
        // triangle on "replayed onto its base".
        icon={toneIcon(face.tone)}
        iconRole={iconRoleForTone(face.tone)}
        title={face.title}
        description={
          face.description === null && face.detail === null ? undefined : (
            <>
              {face.description}
              {face.detail !== null ? (
                <details className="session-changes-notice-evidence">
                  <summary>Show git&rsquo;s message</summary>
                  <pre>{face.detail}</pre>
                </details>
              ) : null}
            </>
          )
        }
        // The caller owns these buttons and therefore owns focus — and owns it
        // by declining it. No ref, no focus on mount ([P17]).
        actions={
          <>
            {face.act === "retry" && retryWord !== null ? (
              <>
                <TugPushButton
                  emphasis="outlined"
                  role="accent"
                  size="sm"
                  onClick={handleCopy}
                  data-testid="session-landing-notice-copy"
                >
                  {copied ? "Copied" : "Copy details"}
                </TugPushButton>
                <TugPushButton
                  emphasis="filled"
                  role="danger"
                  size="sm"
                  onClick={handleRetry}
                  data-testid="session-landing-notice-retry"
                >
                  {retryWord}
                </TugPushButton>
              </>
            ) : null}
            {/* Dismiss rides every tenant, not only the actless ones. A
                standing server error whose only way out was a second landing
                would be a notice the user cannot put down, and the per-channel
                dismissal above would be unreachable. */}
            <TugIconButton
              icon={<X size={14} />}
              aria-label="Dismiss"
              size="xs"
              onClick={() => setDismissed((prev) => ({ ...prev, [tenant.slot]: face.key }))}
              data-testid="session-landing-notice-dismiss"
            />
          </>
        }
      />
    </div>
  );
}
