/**
 * SessionUsageLimitNotice — the transcript's row for a turn Claude Code
 * refused at a usage limit.
 *
 * Claude Code answers a refused turn with a synthetic assistant message
 * ("You've hit your session limit · resets 9:10pm (America/Los_Angeles)")
 * carrying `error: "rate_limit"`. Drawn as prose it reads like a reply; this
 * draws it as what it is — a stop — with a bold title naming the window and
 * a line saying when it resets. tugcode tags the block (`api_error`, on its
 * minting `content_block_start`) on both the live and the resume path, so a
 * reopened session draws the same row.
 *
 * When the tag carries no reset time, the message line is Claude Code's own
 * text, read from the streaming store like any assistant prose.
 *
 * Laws: [L02] store via `useSyncExternalStore`, [L06] appearance via CSS.
 */

import "./session-usage-limit-notice.css";

import React from "react";

import type { AssistantApiError } from "@tugproto/outbound";
import type { PropertyStore } from "@/lib/property-store";
import { TugInlineAlert } from "@/components/tugways/tug-inline-alert";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { usageLimitResetLine, usageLimitTitle } from "@/lib/rate-limit";

export interface SessionUsageLimitNoticeProps {
  apiError: AssistantApiError;
  streamingStore: PropertyStore;
  streamingPath: string;
}

export const SessionUsageLimitNotice: React.FC<SessionUsageLimitNoticeProps> = ({
  apiError,
  streamingStore,
  streamingPath,
}) => {
  const subscribe = React.useCallback(
    (onStoreChange: () => void) =>
      streamingStore.observe(streamingPath, onStoreChange),
    [streamingStore, streamingPath],
  );
  const claudeText = useSyncExternalStore(subscribe, () => {
    const value = streamingStore.get(streamingPath);
    return typeof value === "string" ? value : "";
  });
  const info = apiError.rate_limit_info;
  const resetLine = usageLimitResetLine(info?.resetsAt, Date.now());
  return (
    <TugInlineAlert
      className="session-usage-limit-notice"
      title={usageLimitTitle(info?.rateLimitType)}
      message={resetLine ?? (claudeText.length > 0 ? claudeText : undefined)}
      icon="Hourglass"
      tone="caution"
    />
  );
};
