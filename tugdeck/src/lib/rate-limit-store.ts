/**
 * RateLimitStore — app-level, account-global subscription-quota store
 * ([#step-3.5]).
 *
 * The subscription quota is **account-global** — one limit shared by every
 * session and session card — so it belongs in a single app-level store, not the
 * per-card `SessionMetadataStore` (that's why [#step-3.5] supersedes [Q02] for
 * this surface). This store owns a `FeedStore` on the SESSION_SIDEBAND feed
 * (where the tugcast supervisor rewraps `rate_limit_event` off CODE_OUTPUT,
 * [#step-3]) and tracks the **latest** `rate_limit_event` across all sessions;
 * since the quota is account-global, the most-recent event is authoritative
 * regardless of which session emitted it.
 *
 * Constructed once at deck-manager boot and consumed by the single
 * `RateLimitBannerProvider` via `useSyncExternalStore` ([L02]). The SESSION_SIDEBAND
 * feed also carries `system_metadata` / `session_capabilities`; those are
 * ignored here (discriminated by `type`), the same way `SessionMetadataStore`
 * ignores `rate_limit_event`.
 *
 * **Laws:** [L02] external state enters React through useSyncExternalStore only.
 *
 * @module lib/rate-limit-store
 */

import { Subscribable } from "./subscribable";
import { FeedStore } from "./feed-store";
import { FeedId, type RateLimitInfo } from "../protocol";
import type { TugConnection } from "../connection";

/**
 * Parse the `rate_limit_info` object of a `rate_limit_event` payload into a
 * {@link RateLimitInfo}, or null if malformed. Tolerant ([D18]/[Q13]): unknown
 * extra fields are dropped (forward-compat), a missing field falls back to a
 * benign default rather than throwing, and a non-string `status` (the
 * load-bearing field) rejects the frame so a drift degrades gracefully.
 */
function parseRateLimitInfo(raw: unknown): RateLimitInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.status !== "string") return null;
  const info: RateLimitInfo = {
    status: obj.status,
    resetsAt: typeof obj.resetsAt === "number" ? obj.resetsAt : 0,
    rateLimitType: typeof obj.rateLimitType === "string" ? obj.rateLimitType : "",
    overageStatus: typeof obj.overageStatus === "string" ? obj.overageStatus : "",
    isUsingOverage: Boolean(obj.isUsingOverage),
  };
  if (typeof obj.overageDisabledReason === "string") {
    info.overageDisabledReason = obj.overageDisabledReason;
  }
  // `utilization` is the 0–1 fraction the /usage gauges key their % on. Absent
  // on older CLIs; carried through when present.
  if (typeof obj.utilization === "number") {
    info.utilization = obj.utilization;
  }
  return info;
}

/**
 * App-level store for the account-global subscription quota. Exposes the
 * `useSyncExternalStore` contract (`subscribe` / `getSnapshot`) plus a
 * test-only ingest seam.
 */
export class RateLimitStore extends Subscribable {
  private _latest: RateLimitInfo | null = null;
  private _feedStore: FeedStore;
  private _unsubscribeFeed: () => void;
  private _lastPayloadRef: unknown = undefined;

  constructor(connection: TugConnection) {
    super();
    // SESSION_SIDEBAND carries no workspace_key and is intentionally
    // unfiltered — we want every session's frames here (account-global
    // quota), unlike the per-card stores.
    this._feedStore = new FeedStore(connection, [FeedId.SESSION_SIDEBAND]);
    this._unsubscribeFeed = this._feedStore.subscribe(() => this._onFeedUpdate());
    // Pick up any payload already replayed on subscribe.
    this._onFeedUpdate();
  }

  private _onFeedUpdate(): void {
    const payload = this._feedStore.getSnapshot().get(FeedId.SESSION_SIDEBAND);
    // Reference comparison: only process a changed payload.
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;

    if (typeof payload !== "object" || payload === null) return;
    // Ignore the feed's other residents (system_metadata / session_capabilities).
    if ((payload as Record<string, unknown>).type !== "rate_limit_event") return;

    const info = parseRateLimitInfo(
      (payload as Record<string, unknown>).rate_limit_info,
    );
    // A malformed frame is dropped, not written as null — keep the last-known
    // good quota rather than blanking it on a single drifted payload.
    if (info === null) return;
    this._setLatest(info);
  }

  private _setLatest(info: RateLimitInfo): void {
    this._latest = info;
    this.notify();
  }

  /** Latest account-global quota, or null before the first event. (L02) */
  getSnapshot = (): RateLimitInfo | null => this._latest;

  /**
   * Test-only. Apply a quota as if a live `rate_limit_event` had landed,
   * bypassing the feed. The app-test drives the banner with this via the
   * `__tug` surface (`ingestRateLimit`) — no live claude round-trip needed.
   *
   * @internal — reached only through the DEV-gated `window.__tug` test surface.
   */
  _ingestForTest = (info: RateLimitInfo): void => this._setLatest(info);

  /** Tear down the feed subscription. */
  dispose(): void {
    this._unsubscribeFeed();
    this._feedStore.dispose();
    this.clearListeners();
  }
}
