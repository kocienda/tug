/**
 * `TugDictationButton` — the microphone in a composer's Z5 trailing slot, and
 * the whole of the deck's dictation UI.
 *
 * One component mounted by both composers, because a mic in the Session entry
 * and a mic in the Overview rail are the same control over the same store: the
 * only things that differ are the size and which composer's handle it hands
 * over. Everything about *whether* dictation is available, which composer holds
 * it, and what a refusal says lives behind `dictation-store.ts`, so this file
 * is a face and a click.
 *
 * **It renders nothing rather than a dead button.** No host handler means a dev
 * browser with no Tug.app behind it; no `target.dictation` means a composer with
 * no live editor to write into. Either way a mic would be a control whose press
 * could not do the thing it depicts, which is worse than no control at all.
 *
 * **One node across every mode** ([L26]). `data-mode` carries the face and CSS
 * reads it; nothing swaps the element, and a refused mic is `aria-disabled`
 * rather than `disabled` so it still opens its tooltip and still takes a press
 * ([L31], [P07]) — the user may have just granted the permission that was
 * missing, and a button that refuses to be tried again sends them to reload the
 * deck.
 *
 * **What `live` looks like is the wave, not a tinted mic.** `TugButton` mounts
 * `icon` and `activityIcon` as two nodes and lets the cascade pick between them
 * off `data-tug-activity`, so with `activity="busy"` the mic glyph is swapped
 * *out* — this is the Submit button's own arbitration face, and `aria-pressed`
 * is what carries the toggle state once the glyph no longer can.
 *
 * References: [B03], [B04], [B07], [P03], [P07], Spec S06, Table T01,
 * Table T03, [L26], [L31].
 *
 * @module components/tugways/tug-dictation-button
 */

import { Mic } from "lucide-react";

import { isDictationAvailable } from "@/lib/dictation-bridge";
import { dictationStore, useDictationFace } from "@/lib/dictation-store";
import type { PromptInsertTarget } from "@/lib/prompt-insert-target";

import { TugProgressIndicator } from "./tug-progress-indicator";
import { TugPushButton } from "./tug-push-button";
import { TugTooltip } from "./tug-tooltip";

import "./tug-dictation-button.css";

export interface TugDictationButtonProps {
  /**
   * Who is asking, as the store keys claims. Both composers pass their card
   * id, which is also what the modal-hold release is keyed on — a composer
   * with no card id renders no mic at all, because neither arbitration nor
   * release could name it.
   */
  composerId: string;
  /** The card the claim belongs to, for the modal-hold release (Table T03). */
  cardId: string;
  /** The composer, as the thing dictation writes into. */
  target: PromptInsertTarget;
  /** `lg` in the Session entry, `sm` in the Overview — their Submit sizes. */
  size: "sm" | "lg";
  focusGroup?: string;
  focusOrder?: number;
}

/** What the tooltip says, per phase. A refusal speaks Table T01 instead. */
const PHASE_TOOLTIP: Readonly<Record<string, string>> = {
  idle: "Dictate",
  starting: "Preparing dictation…",
  preparing: "Preparing dictation…",
  live: "Stop dictating",
};

export function TugDictationButton({
  composerId,
  cardId,
  target,
  size,
  focusGroup,
  focusOrder,
}: TugDictationButtonProps): React.ReactElement | null {
  // Read before either early return, because a hook cannot be conditional.
  // Availability does not change over a session's life — the handler is there
  // from the moment the page loads or never — so no render depends on it.
  const face = useDictationFace(composerId);

  const handle = target.dictation;
  if (handle === undefined || !isDictationAvailable()) return null;

  const live = face.mode === "live";
  const busy = live || face.mode === "preparing" || face.mode === "starting";
  const refused = face.mode === "refused";
  const label = refused ? (face.refusalText ?? "Dictate") : PHASE_TOOLTIP[face.mode];

  return (
    <TugTooltip content={label}>
      <TugPushButton
        className="tug-dictation-button"
        data-testid="tug-dictation-button"
        // The face, as an attribute CSS reads ([L06]). `data-dictation-id` is
        // what an app-test names the live session by when it pushes events in.
        data-mode={face.mode}
        data-dictation-id={face.sessionId ?? undefined}
        subtype="icon"
        size={size}
        // `ghost`, not "quiet" — there is no `quiet` emphasis on `TugButton`
        // (`filled | outlined | ghost | tinted | primary`), and `ghost` is the
        // low-emphasis one. Which is the right read anyway: the mic stands
        // beside a filled Submit, and two filled controls in one Z5 row would
        // give the eye nothing to calibrate the primary action against.
        emphasis="ghost"
        role="action"
        focusGroup={focusGroup}
        focusOrder={focusOrder}
        aria-label={label}
        aria-pressed={live}
        // Not `disabled`: a refused mic must still be pressable ([L31], [P07]).
        aria-disabled={refused || undefined}
        onClick={() => {
          dictationStore.toggle(composerId, cardId, handle);
        }}
        icon={<Mic size={size === "lg" ? 16 : 14} strokeWidth={2.5} />}
        // `busy` for all three live-ish phases, because the button says "the
        // system is listening or getting ready to" with one glyph. A phase edge
        // happens at most four times in a session, so a render per edge is
        // cheaper than the hand-written attribute the Submit button needs.
        activity={busy ? "busy" : undefined}
        activityIcon={
          <TugProgressIndicator
            variant="wave"
            state="running"
            role="inherit"
            size={14}
          />
        }
      />
    </TugTooltip>
  );
}
