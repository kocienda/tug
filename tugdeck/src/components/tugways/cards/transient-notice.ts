/**
 * Transient-notice projection — the pure half of the Session card's
 * non-blocking interruption surface.
 *
 * Self-healing model interruptions (API retries, transport blips, replay
 * dwell, unknown events, and — once the bridge forwards them — model-refusal
 * fallback and output truncation) are *notifications*, not breakage. They must
 * never lock the card the way the `error` banner does. This module turns a
 * `CodeSessionSnapshot` into the set of bulletins that should be showing
 * ({@link projectNotices}), and diffs two such sets into the imperative
 * post/dismiss actions a controller applies to the pane bulletin API
 * ({@link reconcileNotices}).
 *
 * Both functions are pure and DOM-free so the transition logic is unit-tested
 * without a store or a mounted toaster. The controller that observes the store
 * and applies the actions lives in `transient-notice-controller.tsx`; it never
 * routes this state through React render ([L22]).
 */

import type { CodeSessionSnapshot } from "@/lib/code-session-store";
import { classifyApiRetry } from "./api-retry";

/** Maps to a pane bulletin tone helper (`neutral` = the base call). */
export type NoticeTone = "neutral" | "caution" | "danger" | "success";

/**
 * How long a notice lives:
 *  - `condition` — persists with no auto-timeout and no dismiss button; the
 *    controller dismisses it when the driving store condition clears (a retry
 *    recovers, the wire reconnects, the dwell ends).
 *  - `ack` — persists with an explicit OK button; a forward-compat FYI the
 *    user acknowledges rather than one that clears itself.
 *  - `ephemeral` — auto-dismisses on the bulletin's default timer; a one-shot
 *    informational glance (truncation, model-fallback).
 */
export type NoticePersistence = "condition" | "ack" | "ephemeral";

/** One notice the card wants shown, derived from the snapshot. */
export interface NoticeDesc {
  id: string;
  message: string;
  description?: string;
  tone: NoticeTone;
  persistence: NoticePersistence;
  /**
   * Epoch-ms the notice is counting down toward (an API retry's next-attempt
   * `deadline`). Present only while that deadline is still in the future; the
   * controller reads it to know it must keep re-projecting at 1 Hz so the
   * embedded "next try in Ns" stays live. Absent once the deadline passes.
   */
  countdownTo?: number;
}

/** Imperative action a controller applies to the pane bulletin API. */
export type NoticeAction =
  | { type: "show"; desc: NoticeDesc }
  | { type: "dismiss"; id: string };

/** Stable bulletin ids — one per condition, so updates replace in place. */
export const NOTICE_IDS = {
  apiRetry: "notice-api-retry",
  transport: "notice-transport",
  replayTimeout: "notice-replay-timeout",
  unknownEvent: "notice-unknown-event",
  refusalFallback: "notice-refusal-fallback",
  outputTruncated: "notice-output-truncated",
} as const;

/**
 * Build the api-retry description. The attempt count is the store-driven spine
 * ("attempt N of M"); while the next attempt's `deadline` is still ahead of
 * `now` a live "next try in Ns" tail rides alongside it. Both are honest live
 * signals — the count climbs as the SDK backs off, the countdown ticks toward
 * the moment it tries again — so the bulletin reads as *working*, not stuck.
 * Once the deadline passes (the attempt is in flight) the tail drops and only
 * the count remains until the next `api_retry` frame resets the deadline.
 */
function retryDescription(
  attempt: number,
  maxRetries: number,
  deadline: number,
  now: number,
): string {
  const base = `Retrying — attempt ${attempt} of ${maxRetries}`;
  const secs = Math.ceil((deadline - now) / 1000);
  return secs >= 1 ? `${base} · next try in ${secs}s` : base;
}

/**
 * The notices that should be showing for this snapshot at time `now` (epoch
 * ms). `now` only feeds the api-retry countdown; every other notice is
 * time-independent. Order is stable but irrelevant — the bulletin stack owns
 * visual ordering. Mutually independent: a snapshot can drive several at once
 * (e.g. offline *and* mid-retry).
 */
export function projectNotices(
  snap: CodeSessionSnapshot,
  now: number,
): NoticeDesc[] {
  const out: NoticeDesc[] = [];

  if (snap.apiRetry !== null) {
    const cls = classifyApiRetry(snap.apiRetry.error, snap.apiRetry.errorStatus);
    const { attempt, maxRetries, deadline } = snap.apiRetry;
    // The connection classification is the `stalled` state's own, and it is
    // reported on the state strip rather than here. A bulletin as well would
    // say one fact twice in two registers — and the strip is the better of
    // the two for this one, because a bulletin is dismissible transient
    // chatter and a stalled network is the card's whole current condition.
    // Every other classification keeps its bulletin.
    if (cls.category !== "connection") {
      out.push({
        id: NOTICE_IDS.apiRetry,
        message: cls.label,
        description: retryDescription(attempt, maxRetries, deadline, now),
        tone: cls.severity === "likely-fatal" ? "danger" : "caution",
        persistence: "condition",
        // Only while the deadline is ahead: signals the controller to keep
        // re-projecting at 1 Hz so the "next try in Ns" tail stays live.
        ...(deadline > now ? { countdownTo: deadline } : {}),
      });
    }
  }

  // Only `offline` — the cold-restore `restoring` window is owned by the
  // `SessionRestoring` placeholder, so surfacing it here would double-signal.
  if (snap.transportState === "offline") {
    out.push({
      id: NOTICE_IDS.transport,
      message: "Reconnecting…",
      description: "Lost the connection to the agent. Trying to reconnect.",
      tone: "caution",
      persistence: "condition",
    });
  }

  if (snap.replayTimeoutDwellActive) {
    out.push({
      id: NOTICE_IDS.replayTimeout,
      message: "Session history unavailable",
      description: "Resuming with an empty transcript.",
      tone: "caution",
      persistence: "condition",
    });
  }

  if (snap.refusalFallback !== null) {
    const { fallbackModel } = snap.refusalFallback;
    out.push({
      id: NOTICE_IDS.refusalFallback,
      message: "Retrying on a fallback model",
      description:
        fallbackModel.length > 0
          ? `The selected model declined; continuing on ${fallbackModel}.`
          : "The selected model declined; continuing on a fallback model.",
      tone: "neutral",
      persistence: "ephemeral",
    });
  }

  if (snap.outputTruncated) {
    out.push({
      id: NOTICE_IDS.outputTruncated,
      message: "Response truncated",
      description: "The reply hit the output-length limit and was cut off.",
      tone: "neutral",
      persistence: "ephemeral",
    });
  }

  if (snap.unknownEvent !== null) {
    out.push({
      id: NOTICE_IDS.unknownEvent,
      message: "Unsupported event",
      description: `This build doesn't understand "${snap.unknownEvent.originalType}" yet. The session is unaffected.`,
      tone: "caution",
      persistence: "ack",
    });
  }

  return out;
}

function sameDesc(a: NoticeDesc, b: NoticeDesc): boolean {
  return (
    a.message === b.message &&
    a.description === b.description &&
    a.tone === b.tone &&
    a.persistence === b.persistence
  );
}

/**
 * Diff the previously-projected notices against the next set into the
 * post/dismiss actions to apply. A notice that is new or whose content changed
 * (e.g. a climbing retry attempt) emits `show` under its stable id — Sonner
 * replaces in place. A notice gone from `next` emits `dismiss`. Idempotent: an
 * unchanged set yields no actions, so a re-emitted snapshot is a no-op and a
 * dismissed `ack` notice is never re-nagged until its content changes.
 */
export function reconcileNotices(
  prev: NoticeDesc[],
  next: NoticeDesc[],
): NoticeAction[] {
  const actions: NoticeAction[] = [];
  const prevById = new Map(prev.map((d) => [d.id, d]));
  const nextById = new Map(next.map((d) => [d.id, d]));

  for (const desc of next) {
    const before = prevById.get(desc.id);
    if (before === undefined || !sameDesc(before, desc)) {
      actions.push({ type: "show", desc });
    }
  }
  for (const desc of prev) {
    if (!nextById.has(desc.id)) {
      actions.push({ type: "dismiss", id: desc.id });
    }
  }
  return actions;
}
