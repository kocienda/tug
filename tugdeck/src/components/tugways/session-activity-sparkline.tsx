/**
 * SessionActivitySparkline — one session's activity tape, wherever it is drawn.
 *
 * The tape is a fixed reading of a fixed series: the session's composite of
 * RATE work — characters, tokens, tool calls, subagents — over the window the
 * instrument shows, at the size and curve `tug-session-row` declares. Nothing
 * about it varies by surface, which is why it is one component rather than a
 * shape each mount assembles from the same six constants.
 *
 * It was two. The masthead's `MastheadSparkline` and the Cards card row's
 * `RowSparkline` were the same component under two names — same store, same
 * series, same rate-channel filter, same bin, same full scale, same curve, same
 * box, same title — and the only thing that told them apart was which file they
 * were written in. Two copies of one instrument is the state where a fix to the
 * channel filter lands on one surface and not the other, and the reader is left
 * comparing two graphs of the same work that do not agree.
 *
 * **Filtered to rate channels.** A gauge level moves whether or not the session
 * is working — a context-window fill is a level, not a rate — so a gauge write
 * must not wake this tape. The filter is `isRateChannel`, applied in the
 * subscription rather than in the series, because the wake is what costs.
 *
 * The instrument itself samples imperatively off React's render path and
 * scrolls under WAAPI; this component's whole job is to hand it the two
 * callbacks and the session's numbers ([L06]/[L13]).
 *
 * Laws: [L06] the tape is canvas and CSS, never React state; [L13] motion is
 *       the instrument's; [L20] `TugSparkline` is composed through its
 *       published props only.
 *
 * @module components/tugways/session-activity-sparkline
 */

import React, { useCallback } from "react";

import { TugSparkline } from "@/components/tugways/tug-sparkline";
import {
  ACTIVITY_BIN_MS,
  getSessionActivityStore,
  isRateChannel,
} from "@/lib/session-activity-store";
import {
  TUG_SESSION_ROW_SPARK_HEIGHT,
  TUG_SESSION_ROW_SPARK_WIDTH,
  TUG_SESSION_SPARK_CURVE,
  TUG_SESSION_SPARK_FULL_SCALE_CHARS,
} from "@/components/tugways/tug-session-row";

/** What the tape says it is, on every surface that draws one. */
const SPARK_TITLE = "Session activity — text, tokens, tools, and subagents";

/**
 * The handle on this instrument, as distinct from any other tape the app draws.
 * `TugSparkline` owns `data-slot="tug-sparkline"` and takes a closed prop list,
 * so a class is the mechanism available — and it is the one the Cards card's copy
 * already used.
 */
const SPARK_CLASS = "session-activity-spark";

export interface SessionActivitySparklineProps {
  /** Whose activity. An empty id draws an empty tape rather than throwing. */
  sessionId: string;
  /** Box width, in px. Defaults to the row's declared cut. */
  width?: number;
  /** Box height, in px. Defaults to the row's declared cut. */
  height?: number;
  className?: string;
}

export function SessionActivitySparkline({
  sessionId,
  width = TUG_SESSION_ROW_SPARK_WIDTH,
  height = TUG_SESSION_ROW_SPARK_HEIGHT,
  className,
}: SessionActivitySparklineProps): React.ReactElement {
  const activityStore = getSessionActivityStore();
  const getSeries = useCallback(
    (nowMs: number): number[] =>
      activityStore !== null && sessionId.length > 0
        ? activityStore.compositeSeries(sessionId, nowMs)
        : [],
    [activityStore, sessionId],
  );
  // The tape's data-event clock, filtered to rate channels — see the header.
  const subscribeActivity = useCallback(
    (wake: () => void): (() => void) =>
      activityStore !== null && sessionId.length > 0
        ? activityStore.subscribeActivity(sessionId, (channel) => {
            if (isRateChannel(channel)) wake();
          })
        : () => {},
    [activityStore, sessionId],
  );
  return (
    <TugSparkline
      getSeries={getSeries}
      subscribeActivity={subscribeActivity}
      binMs={ACTIVITY_BIN_MS}
      fullScale={TUG_SESSION_SPARK_FULL_SCALE_CHARS}
      curve={TUG_SESSION_SPARK_CURVE}
      width={width}
      height={height}
      // Its own class, always, on top of whatever the mount adds. A session's
      // tape is a findable thing and a generic sparkline is not, so this is what
      // a test or a stylesheet names to reach THIS instrument rather than
      // walking the structure around it. The Cards card's `.sessions-monitor-spark`
      // used to be that handle and went with the Cards card-only copy of the tape; a
      // selector that has to spell out `.tug-activity-line-trailing .tug-sparkline`
      // instead is naming three components to find one.
      className={
        className !== undefined
          ? `${SPARK_CLASS} ${className}`
          : SPARK_CLASS
      }
      title={SPARK_TITLE}
    />
  );
}
