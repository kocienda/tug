/**
 * Pure derivation of the Session card's `<TugPaneBanner>` spec from the
 * `CodeSessionSnapshot` plus a small UI-local context (the dismissed
 * error timestamp). The body renders **one** banner whose props
 * are computed by mapping the spec's discriminated kind to
 * `TugPaneBanner` props.
 *
 * The banner is reserved for genuine **breakage** — only the `error`
 * kind. It is the one surface allowed to lock the card (it sets `inert`
 * on the pane body), which is the right cost for a session that can't be
 * reached and needs an explicit dismiss.
 *
 * Every *transient*, self-healing interruption — API retries, transport
 * blips, the replay-timeout dwell, and forward-compat unknown events —
 * was once a `status`-variant banner here, but a banner locks the prompt
 * for a notice that doesn't warrant it. Those now route to non-blocking
 * top-right pane bulletins (`transient-notice.ts` +
 * `TransientNoticeController`), driven directly off the store. So this
 * helper is down to two outcomes: `error` or `none`.
 *
 * Why a separate module: the helper is pure, takes a snapshot, and
 * returns a discriminated union. Testing it in isolation
 * (`session-card-banner-spec.test.ts`) verifies the branch without spinning
 * up a real card render. The body does the spec → `TugPaneBanner` props
 * mapping inline since that's a presentational concern best read
 * alongside the JSX that consumes it.
 */

import type { CodeSessionSnapshot } from "@/lib/code-session-store";

/**
 * Subset of `LastErrorCause` that the card banner-routes. The full
 * cause includes `resume_failed`, which is intercepted upstream by
 * `useSessionCardObserver` (the binding is cleared and the picker
 * re-presents with notice), so the card never banners it.
 */
export type BannerErrorCause = Exclude<
  NonNullable<CodeSessionSnapshot["lastError"]>["cause"],
  "resume_failed"
>;

/** Discriminated union returned by `deriveSessionCardBannerSpec`. */
export type SessionCardBannerSpec =
  | { kind: "none" }
  | {
      kind: "error";
      cause: BannerErrorCause;
      message: string;
      /**
       * Reducer-stamped `Date.now()` from when the error was
       * recorded. Threaded through to the Dismiss button so a click
       * stamps `dismissedAt`, suppressing this exact error; a fresh
       * error (different `at`) re-raises naturally.
       */
      at: number;
      /**
       * For a `wire_error`, the bridge's slug for the emit site that wrote
       * the frame. The detail panel names it, because a strip reading
       * "Protocol error" and nothing else asks the reader to go find
       * tugcode's source. Absent on every other cause, and on a frame from a
       * tugcode older than the field.
       */
      site?: string;
    };

/**
 * UI-local context the helper needs in addition to the snapshot.
 * `dismissedAt` is the `at` of the last-dismissed error: a Dismiss click
 * stamps it, suppressing that exact error until a fresh one (different
 * `at`) arrives.
 */
export interface SessionCardBannerCtx {
  dismissedAt: number | null;
}

/**
 * Pure derivation. The banner shows only genuine breakage:
 * - `error` when `lastError` is set, banner-routable (not `resume_failed`),
 *   and not user-dismissed
 * - `none` otherwise
 *
 * Transient interruptions (retry / transport / replay-timeout dwell /
 * unknown-event) are NOT banners — they route to top-right pane bulletins
 * via `TransientNoticeController`. The cold-restore loading window is the
 * `SessionRestoring` placeholder; this helper runs only once `SessionCardBody` is
 * mounted, i.e. after the restore has resolved.
 */
export function deriveSessionCardBannerSpec(
  snap: CodeSessionSnapshot,
  ctx: SessionCardBannerCtx,
): SessionCardBannerSpec {
  if (
    snap.lastError !== null &&
    snap.lastError.cause !== "resume_failed" &&
    snap.lastError.at !== ctx.dismissedAt
  ) {
    // A logged-out / missing-CLI gate is not a card-local concern: the
    // observer unbinds the card to its picker and the app-modal ConfigureTug
    // owns re-login (single login surface). Never surface it as a banner —
    // return `none` so no red error lock flashes before the unbind lands.
    if (
      snap.lastError.cause === "session_state_errored" &&
      (snap.lastError.message === "auth_required" ||
        snap.lastError.message === "claude_missing")
    ) {
      return { kind: "none" };
    }
    return {
      kind: "error",
      cause: snap.lastError.cause as BannerErrorCause,
      message: snap.lastError.message,
      at: snap.lastError.at,
      ...(snap.lastError.site !== undefined
        ? { site: snap.lastError.site }
        : {}),
    };
  }
  return { kind: "none" };
}

// Backend `detail` summaries (the first line of an errored session's detail)
// are internal tokens — most notably `crash_budget_exhausted`. These map them
// to human copy so the banner strip never surfaces an identifier; the raw
// stderr tail still rides the diagnostic panel unchanged ([P08]).
const ERROR_SUMMARY_COPY: Record<string, string> = {
  crash_budget_exhausted:
    "The session stopped unexpectedly and couldn't be restarted.",
  resume_failed: "Tug couldn't resume the previous session.",
};

/**
 * Map a backend error `detail` summary to human copy. Known tokens get tailored
 * copy; a `spawn failed: …` reason collapses to a humane line; any other empty
 * or `lower_snake_case` token falls back to a generic sentence so an internal
 * identifier never reaches the user. An already-human summary passes through.
 */
export function humanizeErrorSummary(summary: string): string {
  const key = summary.trim();
  if (key in ERROR_SUMMARY_COPY) return ERROR_SUMMARY_COPY[key];
  if (key.startsWith("spawn failed")) {
    return "Tug couldn't start the session process.";
  }
  const looksInternal = key === "" || /^[a-z0-9_]+$/.test(key);
  return looksInternal ? "The session ended unexpectedly." : key;
}
