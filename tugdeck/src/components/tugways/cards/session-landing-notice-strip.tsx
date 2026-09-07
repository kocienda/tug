/**
 * session-landing-notice-strip.tsx — a landing's refusal, spoken at the seam.
 *
 * When git refuses a commit the report used to land in the card's top-right
 * bulletin lane: at the far end of the card from the button that was pressed,
 * and — because the Changes shade raises a pane scrim over the transcript
 * region — dimmed behind it. The refusal belongs inside the gesture instead,
 * in the seam between the shade's bottom edge and the composer's top edge
 * ([P03]). That seam is the entry pane's first child, so it is outside the
 * scrim by geometry rather than by a z-index anybody has to maintain, and it
 * is one gutter from Z5.
 *
 * What to say is {@link landingNoticeFace}'s to decide; this file renders it
 * and owns only the local questions a surface can answer: which notice is
 * dismissed, whether the details were copied, and whether a fading refusal's
 * four seconds are up. Two channels can be true at once ([P02]) and the strip
 * shows one — the error, which is a landing the server refused and stands, in
 * front of the refusal, which is this deck refusing to send one.
 *
 * Reads the mode through `useSyncExternalStore` ([L02]); the evidence fold is
 * a native `<details>`, so open/closed is the element's ([L06], [P08]).
 *
 * @module components/tugways/cards/session-landing-notice-strip
 */

import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";

import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugInlineAlert } from "@/components/tugways/tug-inline-alert";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { LANDING_WORDS } from "@/components/tugways/tug-prompt-entry";
import type { LandingMode } from "@/lib/landing-mode";
import { landingNoticeFace } from "@/lib/landing-notice";

import "./session-landing-notice-strip.css";

/** How long a gate refusal stands before it fades ([P07]). */
const REFUSAL_FADE_MS = 4000;

export interface SessionLandingNoticeStripProps {
  /** The landing mode to speak for — one strip per mode, each gated on its own `active`. */
  controller: LandingMode;
  /**
   * The composer's own after-a-landing beat, passed through from the card.
   *
   * Retry and Z5 are one act ([P04]), and a Z5 press does one thing more than
   * `land()`: it returns focus to the editor and pulls the transcript back to
   * the live edge, because the landing narrates itself down there. A Retry
   * without it would land the commit and leave the reader looking away from
   * the receipt, with focus stranded on a button about to unmount.
   */
  onAfterRetry?: () => void;
}

/** The notice at the seam, or `null` when this mode has nothing to say. */
export function SessionLandingNoticeStrip({
  controller,
  onAfterRetry,
}: SessionLandingNoticeStripProps): React.ReactElement | null {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const face = useMemo(
    () => landingNoticeFace(controller.kind, snapshot),
    [controller.kind, snapshot],
  );

  // Dismissal is per channel, because the two are independent: dismissing a
  // standing server error must not silence the refusal of the press that
  // follows it. Each side clears when its own channel goes null ([P02]).
  const [dismissed, setDismissed] = useState<{ error: string | null; refusal: string | null }>({
    error: null,
    refusal: null,
  });
  const [copied, setCopied] = useState(false);
  const [fadedSeq, setFadedSeq] = useState<string | null>(null);

  const errorKey = face.error?.key ?? null;
  const refusalKey = face.refusal?.key ?? null;

  // A channel that went empty forgets what was dismissed in it, so the next
  // notice on that channel speaks even when it is word-for-word the last one.
  useEffect(() => {
    if (errorKey === null) setDismissed((prev) => (prev.error === null ? prev : { ...prev, error: null }));
  }, [errorKey]);
  useEffect(() => {
    if (refusalKey === null)
      setDismissed((prev) => (prev.refusal === null ? prev : { ...prev, refusal: null }));
  }, [refusalKey]);

  // "Copied" is the confirmation ([P06]), so it lasts exactly as long as the
  // notice it confirms — a new failure is a new thing to copy.
  useEffect(() => {
    setCopied(false);
  }, [errorKey]);

  // A gate refusal fades ([P07]): the user can see the condition and clear it,
  // and the seat should not fill with "not yet". One timer armed on the
  // refusal's own key, cleared on change and on unmount — an event's one-shot,
  // not a poll.
  const fading = face.refusal !== null && face.refusal.tone === "caution";
  useEffect(() => {
    if (!fading || refusalKey === null) return;
    const timer = setTimeout(() => setFadedSeq(refusalKey), REFUSAL_FADE_MS);
    return () => clearTimeout(timer);
  }, [fading, refusalKey]);

  // The mode's lifetime is the notice's ([P05]). Every hook above runs first,
  // because a bailout before them would change the hook order between renders.
  if (!snapshot.active) return null;

  const error = face.error !== null && dismissed.error !== face.error.key ? face.error : null;
  const refusal =
    face.refusal !== null &&
    dismissed.refusal !== face.refusal.key &&
    !(face.refusal.tone === "caution" && fadedSeq === face.refusal.key)
      ? face.refusal
      : null;
  // The server refusing a landing that went out outranks this deck refusing to
  // send one: the first is a thing that failed, the second is a press that
  // never happened.
  const notice = error ?? refusal;
  if (notice === null) return null;

  const words = LANDING_WORDS[controller.kind];

  const handleCopy = (): void => {
    // Writing inside a trusted click is silent in WKWebView; it is *reading*
    // the clipboard that raises the permission sheet ([P06]).
    const text =
      notice.detail === null
        ? `${notice.title}\n${notice.remedy}`
        : `${notice.title}\n${notice.remedy}\n\n${notice.detail}`;
    void navigator.clipboard?.writeText(text);
    setCopied(true);
  };

  const handleRetry = (): void => {
    const outcome = controller.retry();
    // A refused retry has already spoken for itself through the mode ([L31]),
    // and the reader has not moved — the branch mirrors `performSubmit`'s.
    if (outcome.kind !== "refused") onAfterRetry?.();
  };

  return (
    <div
      className="session-landing-notice-strip"
      data-slot="session-landing-notice-strip"
      data-channel={notice.channel}
      data-tone={notice.tone}
    >
      <TugInlineAlert
        tone={notice.tone}
        live={notice.tone === "danger" ? "alert" : "status"}
        icon="TriangleAlert"
        title={notice.title}
        message={
          <>
            {notice.remedy}
            {notice.detail !== null ? (
              <details className="session-landing-notice-evidence">
                <summary>Show git&rsquo;s message</summary>
                <pre>{notice.detail}</pre>
              </details>
            ) : null}
          </>
        }
        actions={
          notice.retry ? (
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
                {words.retry}
              </TugPushButton>
            </>
          ) : undefined
        }
      />
      <TugIconButton
        className="session-landing-notice-dismiss"
        icon={<X size={14} />}
        aria-label="Dismiss"
        size="xs"
        onClick={() =>
          setDismissed((prev) => ({ ...prev, [notice.channel]: notice.key }))
        }
        data-testid="session-landing-notice-dismiss"
      />
    </div>
  );
}
