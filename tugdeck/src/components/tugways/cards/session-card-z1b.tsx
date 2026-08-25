/**
 * session-card-z1b.tsx — Z1B "end-state" row for both halves of a
 * session-card transcript turn (user + assistant).
 *
 * The component lands inside `TugTranscriptEntry`'s controls slot
 * on both row halves. Z1A (identifier + timestamp + sequence) is
 * supplied by `TugTranscriptEntry`'s header; the entry body hosts
 * the per-half content (user text on the user row; streaming
 * markdown / thinking / tool-calls on the asst row); this
 * component owns the footer row that sits beneath the body.
 *
 * Layout (Option B — body on top, Z1B beneath):
 *
 *     [TugTranscriptEntry header — Z1A: identifier + timestamp]
 *     [body — per-half content]
 *     [Z1B — end-state + copy]               ← THIS COMPONENT
 *
 * **Committed-end-state only.** Per [D19], SessionZ1B owns the
 * end-state aggregate (OK / interrupted / error badge, per-turn
 * time + tokens, whole-turn COPY). The transcript-level in-flight
 * indicator is `SessionZ1C`'s job (chrome below `TugListView`, not a
 * list row). SessionZ1B no longer multiplexes "indicator ↔
 * end-state" — the live thinking indicator does not appear here.
 *
 * **Participant variants.** The component dispatches on `participant`:
 *
 *  - **`participant="assistant"`** — asst-half. Renders
 *    `[badge • time • tokens] • [COPY]` only when `turn` is
 *    defined; renders nothing (an empty slot div) while in-flight
 *    (`turn === undefined`).
 *  - **`participant="user"`** — user-half. Always shows
 *    `[badge] • [COPY]` with a static "OK" badge — no time /
 *    tokens (those are asst-side data). The user's submission is
 *    complete the instant it posts, so the row carries its end-
 *    state immediately, in-flight and committed alike, and the
 *    badge never reflects `turn.turnEndReason`: an interrupt or
 *    error belongs to the *response*, not to the act of
 *    submitting.
 *
 * **Mode dispatch — purely per-row.** The component takes one
 * data-driving prop: `turn`. End-state presence is derived
 * per-participant:
 *
 *  - user half → always end-state (submission completes the
 *    instant it posts; `turn` only adds the copy text once it lands).
 *  - assistant half, `turn !== undefined` → end-state.
 *  - assistant half, `turn === undefined` → no child (empty slot div).
 *
 * **Mount-identity discipline ([L26]).** Z1B is a single always-
 * mounted `<div data-slot="session-z1b">` whose CHILD swaps exactly
 * once per row when `turn` lands. The slot div itself is never
 * unmounted at the turn boundary — so any focus / hover state the
 * row carries survives the swap. `AssistantTurnCell` / `UserMessageCell` are
 * keyed by stable `turnKey` (byte-identical pre/post commit), so
 * the cell wrappers survive the same transition; this component
 * inherits that contract.
 *
 * **Trailing copy button.** When `turn` is defined and `bodyText`
 * is non-empty, the row's trailing edge renders a `BlockCopyButton`
 * whose `getText` returns `bodyText`. Suppressed for in-flight
 * rows (nothing to copy yet) and for empty-body committed rows.
 * The aria-label varies by participant ("Copy response" vs "Copy
 * message"); both share the same labelled `BlockCopyButton`
 * affordance so the COPY chip reads identically on both halves.
 * `bodyCopy`, when supplied, takes the write itself — the user half
 * copies an atom substrate, whose chips ride a clipboard sidecar.
 *
 * Conformance:
 *  - [L02] no external-state reads — the component is a pure
 *    function of `participant` + `turn` + `bodyText`. The caller
 *    has already subscribed to the data source.
 *  - [L06] all appearance state flows through CSS classes /
 *    `data-participant` attributes and the `:empty` collapse rule.
 *    No inline style for appearance.
 *  - [L19] file pair with the component; `data-slot` anchors on
 *    every visible primitive.
 *  - [L20] consumer-only — no new token slot family. The component
 *    inherits typography from the row's chrome.
 *
 * @module components/tugways/cards/session-card-z1b
 */

import "./session-card-z1b.css";

import React from "react";
import { Check, ShieldAlert, ShieldX, Unplug } from "lucide-react";

import { BlockCopyButton } from "@/components/tugways/body-kinds/affordances/block-copy-button";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugLabel } from "@/components/tugways/tug-label";
import {
  endStateBadgeFor,
  shellEndStateBadge,
} from "@/lib/code-session-store/end-state";
import type {
  TurnEntry,
  TurnEndReason,
} from "@/lib/code-session-store/types";

import {
  formatDurationMs,
  formatTokensCaps,
} from "./session-card-telemetry-renderers";
import { turnHasTiming } from "@/lib/code-session-store/telemetry";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Which half of the turn this Z1B instance belongs to. Drives the
 * `data-participant` attribute and the per-variant content choices
 * (see module docstring).
 */
export type SessionZ1BParticipant = "user" | "assistant" | "shell" | "refs";

export interface SessionZ1BProps {
  /**
   * Which transcript half the Z1B sits on. The user variant
   * suppresses the time / tokens metrics (those are asst-side
   * data) and is always end-state (the submission completes the
   * instant it posts). The asst variant carries the full metrics
   * row, but only renders end-state once `turn` is defined; while
   * in-flight, the transcript-level `SessionZ1C` carries the
   * indicator (this slot is empty). The shell variant ([D111])
   * shows the exchange's exit badge + duration (no tokens), gated
   * on the exchange being settled. The refs variant ([P03]) reads
   * the same way for a `/match` / `/search` run: its end-state badge
   * (complete, or interrupted for a cancelled run) + how long it ran,
   * gated on the run being settled.
   */
  participant: SessionZ1BParticipant;
  /**
   * The committed turn entry for this row, if any. `undefined` for
   * the in-flight row (the single row the data source emits while
   * a turn is mid-stream); populated post-`turn_complete` for every
   * committed row. The presence of this field gates whether the
   * assistant half renders its end-state.
   */
  turn?: TurnEntry;
  /**
   * The committed turn's signed per-turn token count — `window(N) −
   * window(N−1)` from the transcript window-walk, computed by the
   * transcript data source. The asst-half renders it; the user half
   * ignores it. `undefined` for in-flight / user rows. Negative at a
   * `/compact` turn.
   */
  perTurnTokens?: number;
  /**
   * Total tokens spent by the subagents this turn launched — a
   * separate readout from `perTurnTokens` because agent tokens burn
   * in their own contexts and never enter the main session's window.
   * Rendered as an additional `N agent tokens` segment only when
   * positive; `undefined` / `0` renders nothing extra.
   */
  agentTokens?: number;
  /**
   * The markdown the copy-button affordance writes to the clipboard.
   * The user half passes the submitted message text; the assistant half
   * passes the full turn serialized by `turnEntryToMarkdown` (every
   * tool call's input/output plus the assistant prose). When non-
   * empty AND `turn` is defined, the row's trailing edge renders a
   * `BlockCopyButton` whose `getText` returns this string. Suppressed
   * for in-flight rows (nothing to copy yet) and for empty-body
   * committed rows.
   */
  bodyText?: string | (() => string);
  /**
   * Copy path that supersedes the plain-text write, for a body that is more
   * than text. The user half is an atom substrate: its chips ride a clipboard
   * sidecar so a paste back into Tug re-materializes them, which a `writeText`
   * of the flattened string cannot do. Resolves `true` on a confirmed write.
   *
   * {@link bodyText} is still required — it gates the affordance's presence
   * and is the readable text this path writes on `.string`.
   */
  bodyCopy?: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Z1B status / end-state row. See module docstring for layout,
 * mode dispatch, participant variants, and conformance notes.
 */
/**
 * Read a shell turn's exit facts for the Z1B end-state ([D111]). Returns
 * `null` for a non-shell turn (defensive — the `"shell"` participant is only
 * ever paired with a `shell`-origin turn). `settled` gates the end-state:
 * while an exchange is in flight its Z1B stays empty (the block's own
 * lifecycle dot is the running signal).
 */
function readShellFacts(
  turn: TurnEntry | undefined,
): { settled: boolean; exitCode: number | null } | null {
  const m = turn?.messages[0];
  if (m === undefined || m.kind !== "shell_exchange") return null;
  return { settled: m.settledAtMs !== null, exitCode: m.exitCode };
}

/**
 * Whether a refs run has settled ([P03]). Same gate as the shell half: while
 * a run streams, its block's own lifecycle dot is the signal and this slot
 * stays empty — an end-state badge on a list still growing would read "OK"
 * about a run that has not finished.
 */
function refsSettled(turn: TurnEntry | undefined): boolean {
  const m = turn?.messages[0];
  return m !== undefined && m.kind === "refs_result" && !m.inFlight;
}

export const SessionZ1B: React.FC<SessionZ1BProps> = ({
  participant,
  turn,
  perTurnTokens,
  agentTokens,
  bodyText,
  bodyCopy,
}) => {
  const isUserHalf = participant === "user";
  const isShellHalf = participant === "shell";
  const isRefsHalf = participant === "refs";
  const shellSettled = isShellHalf && readShellFacts(turn)?.settled === true;
  // End-state presence — per [D19] SessionZ1B is committed-end-state
  // only.
  //
  //  - User half: submission completes the instant it posts; end-
  //    state is shown immediately, in-flight and committed alike.
  //  - Assistant half: end-state shown only when `turn !== undefined`.
  //    While in-flight the transcript-level `SessionZ1C` carries the
  //    indicator; this slot renders nothing.
  //  - Shell half ([D111]) and refs half ([P03]): end-state shown once the
  //    exchange / run settles; while in flight the block's own lifecycle dot
  //    is the signal and this slot stays empty.
  const hasEndState =
    isUserHalf ||
    (isShellHalf
      ? shellSettled
      : isRefsHalf
        ? refsSettled(turn)
        : turn !== undefined);
  // End-state reason. The user half is pinned to `complete` — its
  // badge reports "the message was submitted," never the response's
  // outcome, so an interrupt / error never bleeds onto the user row.
  const reason: TurnEndReason =
    isUserHalf || turn === undefined ? "complete" : turn.turnEndReason;
  const showCopy =
    hasEndState &&
    bodyText !== undefined &&
    (typeof bodyText === "function" || bodyText.length > 0);
  // Defer serialization to the click: a `() => string` thunk is used
  // as `getText` directly; a plain string is wrapped.
  const getBodyTextForCopy: () => string =
    typeof bodyText === "function" ? bodyText : () => bodyText ?? "";
  // Per-participant copy phrasing — the affordance itself is the
  // same `BlockCopyButton`; only the aria-label differs.
  const copyAriaLabel =
    participant === "assistant" ? "Copy response" : "Copy message";

  return (
    <div
      className="session-z1b"
      data-slot="session-z1b"
      data-participant={participant}
    >
      {hasEndState ? (
        <EndStateDisplay
          participant={participant}
          reason={reason}
          turn={turn}
          perTurnTokens={perTurnTokens}
          agentTokens={agentTokens}
        />
      ) : null}
      {showCopy ? (
        <>
          <TugLabel
            size="xs"
            emphasis="calm"
            aria-hidden
            className="session-z1b-separator"
          >
            •
          </TugLabel>
          <span className="session-z1b-copy">
            <BlockCopyButton
              data-slot="session-z1b-copy"
              getText={getBodyTextForCopy}
              copyAction={bodyCopy}
              aria-label={copyAriaLabel}
              // One step up from the affordance default (`2xs`) so
              // COPY's 11px font + 12px icon read at the same scale
              // as the row's surrounding `TugLabel size="xs"` (12px)
              // and `TugBadge size="md"` (12px font). The `2xs`
              // default suits in-block-header callsites where the
              // surrounding text is muted path-label scale.
              size="xs"
            />
          </span>
        </>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// End-state display
// ---------------------------------------------------------------------------

/**
 * Per-reason icon for the end-state badge. The Lucide `size` prop
 * sets the SVG's intrinsic dimensions; `tug-badge.css`'s
 * `.tug-badge-size-md .tug-badge-icon svg` rule then scales the
 * rendered icon to match the badge's 12px font-size. The 14px
 * source size leaves the glyph a hair larger than the label text
 * before the CSS scale-down, which keeps stroke weight crisp at
 * the rendered size.
 *
 * The two shield glyphs (interrupted / error) carry
 * `session-z1b-shield-icon`, which `session-card-z1b.css` renders a touch
 * larger than the 12px badge default so the shield reads at full
 * weight next to its label.
 */
function endStateBadgeIcon(reason: TurnEndReason): React.ReactNode {
  switch (reason) {
    case "complete":
      return <Check size={14} aria-hidden="true" />;
    case "interrupted":
      return (
        <ShieldAlert
          size={16}
          className="session-z1b-shield-icon"
          aria-hidden="true"
        />
      );
    case "error":
      return (
        <ShieldX size={16} className="session-z1b-shield-icon" aria-hidden="true" />
      );
    case "transport_lost":
      return <Unplug size={14} aria-hidden="true" />;
  }
}

/**
 * Z1B end-state display. Two participant variants share a single
 * primitive:
 *
 *  - `participant="assistant"` → `[badge • time • tokens]`
 *  - `participant="user"` → `[badge]` only
 *
 * The badge is driven by the caller-supplied `reason`: the assistant
 * half passes `turn.turnEndReason`; the user half passes a fixed
 * `complete` so its badge always reads "OK" — the user's
 * submission is done the instant it posts, independent of how the
 * response ends. The asst-half adds the per-turn time + tokens;
 * the user-half omits them because they're asst-side data (a user
 * message has no active-ms or token-cost attributable to the
 * submission itself), and its `turn` may still be `undefined`
 * while the response is in-flight.
 *
 * The badge's `ghost` emphasis keeps it visually subordinate to
 * the identifier above. A `•` separator sits between each pair of
 * items (badge / time / tokens) — the same glyph as the trailing
 * `•` before COPY, so the whole row reads with one separator.
 *
 * When the turn launched subagents, a second token segment breaks
 * their spend out (`N agent tokens`) — separate from the main figure
 * because agent tokens never enter the session's context window; one
 * summed number would misread against the Z2 CONTEXT cell.
 */
function EndStateDisplay({
  participant,
  reason,
  turn,
  perTurnTokens,
  agentTokens,
}: {
  participant: SessionZ1BParticipant;
  reason: TurnEndReason;
  turn: TurnEntry | undefined;
  perTurnTokens: number | undefined;
  agentTokens: number | undefined;
}): React.ReactElement {
  // The shell half reads the exchange's own exit status ([D111]) — same
  // badge grammar as a Claude turn, its own vocabulary (`exit N` / `killed`).
  // The icon still comes from the shared reason→glyph map, since the shell
  // turn's `turnEndReason` mirrors the exit outcome (`buildShellTurnEntry`).
  const shellFacts =
    participant === "shell" ? readShellFacts(turn) : null;
  const badge =
    shellFacts !== null
      ? shellEndStateBadge(shellFacts.exitCode)
      : endStateBadgeFor(reason, turn?.interruptReason);
  return (
    <span
      className="session-z1b-end-state"
      data-slot="session-z1b-end-state"
      data-participant={participant}
    >
      <TugBadge
        size="md"
        emphasis="ghost"
        role={badge.role}
        icon={endStateBadgeIcon(reason)}
        iconGap={5}
      >
        {badge.text}
      </TugBadge>
      {participant === "assistant" && turn !== undefined ? (
        <>
          <TugLabel size="xs" emphasis="calm" aria-hidden>
            •
          </TugLabel>
          <TugLabel size="xs">
            {turnHasTiming(turn) ? formatDurationMs(turn.activeMs) : "—"}
          </TugLabel>
          <TugLabel size="xs" emphasis="calm" aria-hidden>
            •
          </TugLabel>
          <TugLabel size="xs">
            {`${formatTokensCaps(perTurnTokens ?? 0)} tokens`}
          </TugLabel>
          {agentTokens !== undefined && agentTokens > 0 ? (
            <>
              <TugLabel size="xs" emphasis="calm" aria-hidden>
                •
              </TugLabel>
              <TugLabel size="xs" data-slot="session-z1b-agent-tokens">
                {`${formatTokensCaps(agentTokens)} agent tokens`}
              </TugLabel>
            </>
          ) : null}
        </>
      ) : null}
      {/* Shell and refs halves: badge + duration, no tokens (neither burns
          any). Duration uses the same formatter as the assistant time
          segment. */}
      {(participant === "shell" || participant === "refs") && turn !== undefined ? (
        <>
          <TugLabel size="xs" emphasis="calm" aria-hidden>
            •
          </TugLabel>
          <TugLabel size="xs">{formatDurationMs(turn.activeMs)}</TugLabel>
        </>
      ) : null}
    </span>
  );
}
