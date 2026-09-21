/**
 * SessionActivityCard — the expanded view of the compact activity sparkline ([P12]).
 * Small-multiples: one metric block per channel, always all of them.
 *
 * Design canon (see the plan's research note): Tufte sparklines — no chrome,
 * the latest value tied to its line by a shared color accent; small multiples
 * on one aligned grid so the eye compares data, not design; Grafana's stat
 * pattern — label + value overlaid ON the graph's own box, so each label is
 * closest to (literally attached to) the thing it labels.
 *
 * The row set is STATIC: every channel renders from the first open, as a flat
 * baseline with a dimmed zero until work arrives. Nothing appears or
 * disappears; the card never re-renders after mount.
 *
 * Surface: rendered inside the beat strip's activity popover (the compact
 * strip is the entry point; this is its expansion).
 *
 * Laws:
 *   [L02] trivially upheld — no external state enters React at all: the row
 *         set is a constant, and every live reading (series + value) is
 *         sampled imperatively off the render path ([P03]).
 *   [L06] the numeric value is written to the DOM imperatively on a calm tick
 *         — never React state, so a busy session doesn't re-render the card.
 *   [L19] `.tsx`/`.css` pair, `data-slot="session-activity-card"`.
 *
 * @module components/tugways/cards/session-activity-card
 */

import "./session-activity-card.css";

import React, { useCallback, useEffect, useMemo, useRef } from "react";

import { TugSparkline } from "@/components/tugways/tug-sparkline";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import {
  ACTIVITY_BIN_MS,
  ACTIVITY_DESCRIPTORS,
  getSessionActivityStore,
  type ActivityChannel,
} from "@/lib/session-activity-store";

/** Human label + one-line description (the hover tooltip) for each channel. */
const CHANNEL_META: Readonly<
  Record<ActivityChannel, { label: string; blurb: string }>
> = {
  text: {
    label: "Text",
    blurb: "Prose the model is streaming — characters per second.",
  },
  tokens: {
    label: "Tokens",
    blurb: "The model's raw generation rate — output tokens per second.",
  },
  tools: {
    label: "Tools",
    blurb: "Foreground tool work — file edits, searches, and commands.",
  },
  subagents: {
    label: "Subagents",
    blurb: "Background agents — their tool calls and results.",
  },
  cpu: {
    label: "CPU",
    blurb: "CPU used by this session's process tree (claude + subprocesses).",
  },
  memory: {
    label: "Memory",
    blurb: "Resident memory across the session's process tree.",
  },
  disk: {
    label: "Disk",
    blurb: "Disk read + write throughput across the session's process tree.",
  },
};

/**
 * The card's fixed row set, in canonical order — every one renders from the
 * first open (flat baseline + dimmed zero until work arrives; nothing is
 * added later). Memory is deliberately absent: still sampled on the wire,
 * just not shown — a slow-moving level, not a compelling per-second signal.
 */
const VISIBLE_CHANNELS: readonly ActivityChannel[] = [
  "text",
  "tokens",
  "tools",
  "subagents",
  "cpu",
  "disk",
];

/** Trailing bins (~1s) summed into a rate channel's per-second value. */
const RATE_READOUT_BINS = 4;
/**
 * The sparkline's fixed pixel width — every row spans the card's full content
 * width, edge to edge, so the graphics ARE the card (Tufte: maximize
 * data-ink; the iStat/Grafana full-bleed line). The card's width derives from
 * this one constant.
 */
const SPARK_WIDTH = 248;
/**
 * The graph zone's height within each metric block. The head (label + value)
 * has its own reserved band above the graph — same tinted block, so the
 * label stays bound to its line, but the line can never run into the text
 * (the Grafana stat anatomy: text zone over graph zone).
 */
const SPARK_HEIGHT = 26;
/** Readout repaint cadence while gliding — fast enough that the eased
 *  number reads as motion. Not a standing clock: the glide burst runs only
 *  downstream of an activity event and stops when the string converges. */
const READOUT_PAINT_MS = 250;
/** EMA weight per paint (~1s time constant at the paint cadence) — the value
 *  eases toward its target instead of snapping tick-to-tick. */
const READOUT_EMA_ALPHA = 0.25;
/** Below this eased value with no live signal, the row reads as idle. */
const IDLE_EPSILON = 0.5;
/** Consecutive no-write paints before the glide burst declares the readout
 *  converged and stops its timer. The displayed string is rounded, so it
 *  settles long before the underlying EMA float does — once it has held
 *  still this long there is nothing left to animate. */
const READOUT_SETTLE_TICKS = 4;

function formatBytesPerSec(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bytes)} B/s`;
}

/** The raw current numeric for a channel (its native unit), or `null` for a
 *  zero/idle reading. The row eases the displayed value toward this. */
function numericFor(session: string, channel: ActivityChannel, nowMs: number): number | null {
  const store = getSessionActivityStore();
  if (store === null) return null;
  if (ACTIVITY_DESCRIPTORS[channel].kind === "gauge") {
    const raw = store.raw(session, channel);
    return raw === null || raw.value <= 0 ? null : raw.value;
  }
  // Rate channel: sum the trailing window into a per-second rate.
  const series = store.series(session, channel, nowMs);
  let sum = 0;
  for (let i = Math.max(0, series.length - RATE_READOUT_BINS); i < series.length; i++) {
    sum += series[i];
  }
  const perSec = sum / ((RATE_READOUT_BINS * ACTIVITY_BIN_MS) / 1000);
  return perSec < 1 ? null : perSec;
}

/** Format an eased numeric in the channel's unit. */
function formatValue(channel: ActivityChannel, value: number): string {
  if (channel === "cpu") return `${Math.round(value)}%`;
  if (channel === "disk") return formatBytesPerSec(value);
  if (channel === "text") return `${Math.round(value)} ch/s`;
  if (channel === "tokens") return `${Math.round(value)} tok/s`;
  return `${Math.round(value)}/s`;
}

function ActivityRow({
  session,
  channel,
}: {
  session: string;
  channel: ActivityChannel;
}): React.ReactElement {
  const descriptor = ACTIVITY_DESCRIPTORS[channel];
  const meta = CHANNEL_META[channel];
  const valueRef = useRef<HTMLSpanElement | null>(null);

  const getSeries = useCallback(
    (nowMs: number): number[] => {
      const store = getSessionActivityStore();
      return store !== null ? store.series(session, channel, nowMs) : [];
    },
    [session, channel],
  );
  // Fix the line's hue to this channel's descriptor color (the endpoint tie).
  const getColorChannel = useCallback((): string => channel, [channel]);

  // The row's data-event clock: the store's change-gated activity feed,
  // filtered to this row's own channel. Rate and gauge rows ride the same
  // wire — the store publishes a gauge event only when the level moves
  // past its ingestion epsilon, so an idle session's gauge rows are as
  // silent as its rate rows, and a moving gauge still wakes its tape.
  const subscribeActivity = useMemo(() => {
    return (wake: () => void): (() => void) => {
      const store = getSessionActivityStore();
      return store !== null
        ? store.subscribeActivity(session, (moved) => {
            if (moved === channel) wake();
          })
        : () => {};
    };
  }, [session, channel]);

  // Live value, eased toward its target and written imperatively ([L06]) so it
  // glides instead of snapping tick-to-tick. Opens at the true value (no
  // ramp-in), then EMA-smooths changes; decays gracefully to a dimmed ZERO in
  // the channel's unit when activity stops — an idle session does no work, so
  // its resting value is 0, not a "no data" arc. Never touches React state
  // ([P03]).
  //
  // The data event is the only clock. Easing needs a repaint cadence, so a
  // glide BURST runs at READOUT_PAINT_MS — but only downstream of an
  // activity event, and only until the displayed string stops changing.
  // The no-write gate below doubles as the termination condition: once the
  // rounded string has held still for READOUT_SETTLE_TICKS paints there is
  // nothing left to animate, and the burst stops itself. An idle row holds
  // no timer at all; the next event paints synchronously and re-arms it.
  useEffect(() => {
    let eased = 0;
    let seeded = false;
    // What was last written to the DOM. The eased value keeps drifting by
    // fractions after the reader's rounded string has settled; writing it
    // again replaces the text node, dirties style, and schedules a rendering
    // update for a display that did not change. Both writes are gated, not
    // just the text — an attribute set to the value it already holds is
    // delivered as a mutation too.
    let painted: string | null = null;
    let paintedIdle: string | null = null;
    const paint = (): boolean => {
      const el = valueRef.current;
      if (el === null) return false;
      const target = numericFor(session, channel, Date.now());
      const goal = target ?? 0;
      if (!seeded) {
        eased = goal;
        seeded = true;
      } else {
        eased += READOUT_EMA_ALPHA * (goal - eased);
      }
      const idle = target === null && eased < IDLE_EPSILON;
      const text = formatValue(channel, idle ? 0 : eased);
      const idleFlag = idle ? "true" : "false";
      let wrote = false;
      if (text !== painted) {
        el.textContent = text;
        painted = text;
        wrote = true;
      }
      if (idleFlag !== paintedIdle) {
        el.dataset.idle = idleFlag;
        paintedIdle = idleFlag;
        wrote = true;
      }
      return wrote;
    };
    let timer: number | null = null;
    let quietTicks = 0;
    const stopGlide = (): void => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const startGlide = (): void => {
      quietTicks = 0;
      if (timer !== null) return;
      timer = window.setInterval(() => {
        if (paint()) {
          quietTicks = 0;
        } else if (++quietTicks >= READOUT_SETTLE_TICKS) {
          stopGlide();
        }
      }, READOUT_PAINT_MS);
    };
    paint();
    // The mount burst settles the opening value (and, for a rate row with
    // recent history, rides the rolling window down to rest).
    startGlide();
    const store = getSessionActivityStore();
    const unsubscribe =
      store !== null
        ? store.subscribeActivity(session, (moved) => {
            if (moved !== channel) return;
            paint();
            startGlide();
          })
        : null;
    return () => {
      stopGlide();
      unsubscribe?.();
    };
  }, [session, channel]);

  return (
    <div className="session-activity-card-row" data-activity-channel={channel}>
      {/* One tinted block per metric (Gestalt common region — the label can
          only belong to the line it shares a box with), split into two
          zones: a reserved head band (label left, value right), then the
          graph beneath it. Separate zones, so the line can never run into
          the text no matter how hard it bursts. */}
      <div className="session-activity-card-row-head">
        <TugTooltip content={meta.blurb} side="left" align="center">
          <span className="session-activity-card-label" tabIndex={-1}>
            {meta.label}
          </span>
        </TugTooltip>
        <span ref={valueRef} className="session-activity-card-value" data-idle="true" />
      </div>
      <TugSparkline
        getSeries={getSeries}
        getColorChannel={getColorChannel}
        subscribeActivity={subscribeActivity}
        binMs={ACTIVITY_BIN_MS}
        fullScale={descriptor.fullScale}
        hold={descriptor.kind === "gauge"}
        curve={descriptor.curve}
        width={SPARK_WIDTH}
        height={SPARK_HEIGHT}
        className="session-activity-card-spark"
        title={`${meta.label} — ${meta.blurb}`}
      />
    </div>
  );
}

export function SessionActivityCard({
  session,
}: {
  session: string;
}): React.ReactElement {
  // The row set is a constant: every channel renders from the first open as
  // a flat baseline, and lights up when work arrives. No membership state,
  // no empty-state swap — the card never re-renders after mount.
  return (
    <div className="session-activity-card" data-slot="session-activity-card">
      <div className="session-activity-card-title">Activity</div>
      <div className="session-activity-card-rows">
        {VISIBLE_CHANNELS.map((channel) => (
          <ActivityRow key={channel} session={session} channel={channel} />
        ))}
      </div>
    </div>
  );
}
