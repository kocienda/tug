/**
 * `SessionRouteIndicatorBadge` — the Z4B Claude Code indicator badge for
 * the Session card's prompt-entry toolbar.
 *
 * Names the destination the prompt targets — Claude Code, the only resting
 * mode ([P01]). Rendered as a two-line `TugPushButton`
 * (`layout="label-top"`): the `CLAUDE CODE` caption over the running
 * stream-json version, matching the other Z4B chrome chips.
 *
 * The value is the running stream-json version (with `· N events` appended
 * on drift, flagged with a `TriangleAlert` icon and a `data-drift` hook
 * when the dispatch detected drift, [D04] / [Q03]). A **left click** opens
 * Anthropic's Claude Code changelog in the system browser; a **right
 * click** opens the report popover listing running / validated versions
 * and any drift events. Falls back to the tugbank-persisted last-known
 * version before the live `system_metadata.version` lands, or `?` when
 * none has ever been seen.
 *
 * Laws:
 *  - [L02] external state enters through `useSyncExternalStore` — the
 *    `CodeSessionStore` transcript and `SessionMetadataStore` version are
 *    subscribed, never mirrored into React state.
 *  - [L06] no React state for appearance — the report popover's
 *    open/closed state is owned by `TugPopover` and driven imperatively
 *    (`handle.open()` on right-click); the drift treatment is pure
 *    render from the derived summary.
 *  - [L11] the chip emits no chain action — its left click opens an
 *    external URL and its right click opens the report popover via the
 *    imperative handle; `TugPopover` owns the disclosure.
 *  - [L19] file pair (`.tsx` + `.css`); the report node carries
 *    `data-slot="session-route-indicator-badge-report"`.
 *  - [L20] owns only the `--tugx-route-indicator-*` report-geometry
 *    slots; composes `TugPushButton` (the chip) and `SessionCautionBadge`
 *    (the report rows), each of which keeps its own tokens.
 *
 * @module components/tugways/chrome/session-route-indicator-badge
 */

import "./session-route-indicator-badge.css";

import React, { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { TriangleAlert } from "lucide-react";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  TugPopover,
  TugPopoverAnchor,
  TugPopoverContent,
  type TugPopoverHandle,
} from "@/components/tugways/tug-popover";
import { openUrlInOS } from "@/lib/os-open";
import {
  VALIDATED_CC_VERSION,
  logDriftEvent,
  summarizeDrift,
  type DriftEvent,
} from "@/components/tugways/cards/session-assistant-renderer-dispatch";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { SessionMetadataStore } from "@/lib/session-metadata-store";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import type { TaggedValue } from "@/lib/tugbank-client";

import { SessionCautionBadge } from "./session-caution-badge";

// ── External links ─────────────────────────────────────────────────────────

/**
 * Anthropic's Claude Code changelog. Clicking the Code-route chip opens this
 * in the system browser ([D13] interactive Z4B chip); the AI configuration
 * mixer sheet's footer link opens the same page. The version/drift report
 * lives on the chip's right-click menu.
 */
export const CLAUDE_CODE_CHANGELOG_URL =
  "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md";

// ── Last-known version persistence ─────────────────────────────────────────

/**
 * tugbank slot for the most recent Claude Code version seen in any
 * session. The badge falls back to it before the live session's
 * `system_metadata` lands, so a version number shows immediately; the
 * mixer sheet's footer version line reads the same slot.
 */
export const CC_VERSION_DOMAIN = "dev.tugapp.dev";
export const CC_VERSION_KEY = "ccVersion";

/** Read the persisted last-known version from its tugbank tagged value. */
export function parseLastKnownVersion(
  entry: TaggedValue | undefined,
): string | null {
  return entry?.kind === "string" && typeof entry.value === "string"
    ? entry.value
    : null;
}

/** Persist `version` as the last-known Claude Code version (fire-and-forget). */
function persistLastKnownVersion(version: string): void {
  fetch(`/api/defaults/${CC_VERSION_DOMAIN}/${CC_VERSION_KEY}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: version }),
  }).catch((err) => {
    console.warn("[SessionRouteIndicatorBadge] persist version failed:", err);
  });
}

export interface SessionRouteIndicatorBadgeProps {
  /**
   * Session store — its committed transcript is walked for tool-call
   * drift (unknown tool names, unknown structured-result shapes). Read
   * only on the `Code` branch.
   */
  codeSessionStore: CodeSessionStore;
  /**
   * Session-metadata store — supplies `system_metadata.version`, both
   * for display and for the version-drift check. Omitted in gallery /
   * fixture mounts, where the badge has no version to show. Read only
   * on the `Code` branch.
   */
  sessionMetadataStore?: SessionMetadataStore;
  /** Forwarded class name for cascade-scoped customization. */
  className?: string;
  /** Author the chip into a focus group ([P02]) — forwarded to the composed
   *  {@link TugPushButton}. The session card passes its cycle group so the chip
   *  becomes a keyboard-focus-cycling stop; omitted elsewhere. */
  focusGroup?: string;
  /** Order within {@link focusGroup}. */
  focusOrder?: number;
}

/** Stable list key for a drift event row. */
function driftEventKey(event: DriftEvent): string {
  return `${event.caution.reason}:${event.toolUseId ?? "version"}`;
}

/** `1 event` / `N events`. */
function eventCountLabel(count: number): string {
  return `${count} ${count === 1 ? "event" : "events"}`;
}

/**
 * The route-aware indicator badge. See the module docstring for the
 * route→content table, mount-identity contract, and per-branch
 * behavior.
 */
export function SessionRouteIndicatorBadge({
  codeSessionStore,
  sessionMetadataStore,
  className,
  focusGroup,
  focusOrder,
}: SessionRouteIndicatorBadgeProps): React.ReactElement {
  // Narrowed to `transcript` — the only snapshot field the drift walk
  // reads. The committed transcript array's reference changes once per
  // turn commit, so the badge does not re-render on every streaming
  // delta the way a whole-snapshot subscription would.
  const transcript = useSyncExternalStore(
    codeSessionStore.subscribe,
    useCallback(
      () => codeSessionStore.getSnapshot().transcript,
      [codeSessionStore],
    ),
  );
  const version = useSyncExternalStore(
    useCallback(
      (listener) =>
        sessionMetadataStore !== undefined
          ? sessionMetadataStore.subscribe(listener)
          : () => {},
      [sessionMetadataStore],
    ),
    useCallback(
      () => sessionMetadataStore?.getSnapshot().version ?? null,
      [sessionMetadataStore],
    ),
  );

  // Last version seen in any prior session — the fallback the badge
  // shows before the live `system_metadata` version lands. [L02].
  const lastKnownVersion = useTugbankValue<string | null>(
    CC_VERSION_DOMAIN,
    CC_VERSION_KEY,
    parseLastKnownVersion,
    null,
  );

  const summary = useMemo(() => {
    const toolCalls = transcript.flatMap((turn) =>
      turn.messages.filter(
        (m): m is import("@/lib/code-session-store").ToolUseMessage =>
          m.kind === "tool_use",
      ),
    );
    return summarizeDrift({ toolCalls, version });
  }, [transcript, version]);

  // Triage logging. `logDriftEvent` dedupes by occurrence, so this
  // effect re-running on unrelated renders never spams the console.
  useEffect(() => {
    for (const event of summary.events) logDriftEvent(event);
  }, [summary]);

  // Persist each live version as it arrives so the next session has a
  // fallback. Skipped when it already matches what's stored.
  useEffect(() => {
    if (version !== null && version !== lastKnownVersion) {
      persistLastKnownVersion(version);
    }
  }, [version, lastKnownVersion]);

  // The version shown on the badge face: the live version when the
  // session has reported one, else the last-known version.
  const displayVersion = version ?? lastKnownVersion;

  const hasDrift = summary.count > 0;
  const cls =
    className === undefined
      ? "session-route-indicator-badge"
      : `session-route-indicator-badge ${className}`;

  // Content line: the running Claude Code version, with the drift event
  // count appended when drift is present (the running / validated split and
  // the full event list live in the click-expand report). `?` until any
  // version has been seen.
  let codeContent: string;
  if (displayVersion === null) {
    codeContent = "?";
  } else if (!hasDrift) {
    codeContent = displayVersion;
  } else {
    codeContent = `${version ?? displayVersion} · ${eventCountLabel(summary.count)}`;
  }

  const caption = "Claude Code";
  const content = codeContent;

  // Imperative handle for the report popover — opened on right-click of
  // the chip ([D13]). Left click is reassigned to the changelog, so the
  // disclosure is driven imperatively rather than by a `TugPopoverTrigger`'s
  // click-toggle.
  const popoverRef = React.useRef<TugPopoverHandle>(null);

  // Left click opens Anthropic's changelog in the system browser.
  const handleClick = (): void => openUrlInOS(CLAUDE_CODE_CHANGELOG_URL);

  // Right click opens the version / drift report popover.
  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    popoverRef.current?.open();
  };

  // Tooltip carries the version plus the affordance hint; it surfaces the
  // drift count so the signal survives even without opening the report.
  const title = hasDrift
    ? `Claude Code ${version ?? displayVersion ?? "?"} · ${eventCountLabel(summary.count)} drift — click for changelog, right-click for report`
    : `Claude Code ${displayVersion ?? "?"} — click for changelog, right-click for report`;

  return (
    <TugPopover ref={popoverRef}>
      <TugPopoverAnchor>
        <TugPushButton
          layout="label-top"
          label={caption}
          emphasis="tinted"
          role="action"
          size="sm"
          icon={hasDrift ? <TriangleAlert aria-hidden="true" /> : undefined}
          className={cls}
          data-route="code"
          data-drift={hasDrift ? "" : undefined}
          data-slot="session-route-indicator-badge"
          focusGroup={focusGroup}
          focusOrder={focusOrder}
          aria-label="Claude Code — open changelog"
          title={title}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
        >
          {content}
        </TugPushButton>
      </TugPopoverAnchor>
      {(
        <TugPopoverContent side="top" align="end" sideOffset={8} arrow spaceDismisses>
          <div
            className="session-route-indicator-badge-report"
            data-slot="session-route-indicator-badge-report"
          >
            <div className="session-route-indicator-badge-report-title">
              Claude Code stream-json
            </div>
            <div className="session-route-indicator-badge-versions">
              <div className="session-route-indicator-badge-version-row">
                <span className="session-route-indicator-badge-version-label">
                  running
                </span>
                <span className="session-route-indicator-badge-version-value">
                  {version ?? "—"}
                </span>
              </div>
              <div className="session-route-indicator-badge-version-row">
                <span className="session-route-indicator-badge-version-label">
                  validated
                </span>
                <span className="session-route-indicator-badge-version-value">
                  {VALIDATED_CC_VERSION}
                </span>
              </div>
            </div>
            {hasDrift && (
              <ul className="session-route-indicator-badge-report-list">
                {summary.events.map((event) => (
                  <li
                    key={driftEventKey(event)}
                    className="session-route-indicator-badge-report-row"
                  >
                    <SessionCautionBadge caution={event.caution} />
                    <span className="session-route-indicator-badge-report-detail">
                      {event.caution.detail ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TugPopoverContent>
      )}
    </TugPopover>
  );
}
