/**
 * shell-classify-store — the deck's client for the SharedAgent's shell
 * arbitration verdict.
 *
 * One instance per Session card session, sharing the card's `SHELL_OUTPUT`
 * `FeedStore` (no new feed — the same session-scoped filter `ShellGrammarStore`
 * and `PathCommandsStore` use). A `shell_classify` request carries one line and,
 * on the `maybe` band, the program's own condensed documentation; the reply
 * echoes the line and whether documentation was sent, and those two together are
 * the correlation key. They must be a pair: the same line answered with and
 * without documentation is two different questions, cached separately, and a
 * reply that carried only the line could resolve the wrong wait.
 *
 * **Everything degrades to `null`.** No transport, no reply in time, a malformed
 * frame, `ok:false`, a refusal — all resolve `null`, and `null` means the line
 * goes to Claude, which is byte-for-byte the pre-model path. A caller that has
 * to special-case failure is a caller doing it wrong.
 *
 * [L02] store surface (`subscribe` / `getSnapshot`); [L22] direct feed read;
 * [L27] the feed subscription acquired in the constructor is released in
 * `dispose()`, as is every parked resolver's timer.
 *
 * @module lib/shell-classify-store
 */

import { Subscribable } from "./subscribable";
import { FeedId, type FeedIdValue } from "../protocol";
import type { FeedStore } from "./feed-store";
import { getConnection } from "./connection-singleton";

/** What the agent can say about a line. `null` is "no opinion". */
export type ShellVerdict = "shell" | "prompt";

/**
 * How long a request stays outstanding before it settles to `null` on its own.
 *
 * One of **three** constants that must agree: the `classify` JobSpec timeout in
 * `tugrust/crates/tugcast/src/shared_agent.rs` is tugcast's own ceiling on the
 * same call, and `VERDICT_SUBMIT_WAIT_MS` in
 * `tugdeck/src/components/tugways/tug-prompt-entry.tsx` is how long submit waits
 * for the answer. All three bound the same user-visible pause between Return and
 * the line going somewhere, so they are the same number — lowering one silently
 * makes it the real deadline and the other two unreachable.
 */
export const CLASSIFY_REQUEST_TIMEOUT_MS = 2000;

/**
 * Distinct questions remembered before the oldest is dropped. Matches
 * `ShellVerdictCache.capacity` and `ShellGrammarStore`'s — the caches hold
 * answers about the same drafts and are cleared together.
 */
const VERDICT_CACHE_CAPACITY = 32;

/**
 * The cache and correlation key: a line, plus whether it was asked with
 * documentation. Two questions, never one.
 */
function keyFor(line: string, withGrammar: boolean): string {
  return `${withGrammar ? "g" : "-"}:${line}`;
}

export class ShellClassifyStore extends Subscribable {
  private readonly _verdicts = new Map<string, ShellVerdict>();
  private readonly _pending = new Map<string, (verdict: ShellVerdict | null) => void>();
  private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _unsubscribeFeed: () => void;
  /** Immutable copy handed to `getSnapshot`, rebuilt when a verdict lands —
   * `useSyncExternalStore` compares snapshots by identity, so returning the
   * live map would make every change invisible [L02]. */
  private _snapshot: ReadonlyMap<string, ShellVerdict> = new Map();
  private _disposed = false;

  constructor(
    private readonly _feedStore: FeedStore,
    private readonly _feedId: FeedIdValue,
    private readonly _tugSessionId: string,
  ) {
    super();
    this._unsubscribeFeed = _feedStore.subscribe(() => this._onFeedUpdate());
    // Fold any frame already present at construction (replay-on-subscribe).
    this._onFeedUpdate();
  }

  /** The verdict already known for this question, if one has landed. */
  get(line: string, grammar?: string): ShellVerdict | undefined {
    return this._verdicts.get(keyFor(line, grammar !== undefined));
  }

  /**
   * Ask for a verdict, or hand back the cached one. Idempotent per question: a
   * second call while the first is in flight joins the same answer rather than
   * sending a second frame — which is what makes the typing debounce's prewarm
   * free for the submit that follows it. With no transport the answer is `null`
   * immediately, so a caller never waits on a request that was never sent.
   */
  request(line: string, grammar?: string): Promise<ShellVerdict | null> {
    const withGrammar = grammar !== undefined;
    const key = keyFor(line, withGrammar);
    const cached = this._verdicts.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    // A disposed store must not acquire anything new [L27]: its feed
    // subscription is gone, so a frame sent now could never be answered and
    // its timer would be the only thing to settle the wait.
    if (this._disposed) return Promise.resolve(null);

    const connection = getConnection();
    if (connection === null || connection === undefined) {
      return Promise.resolve(null);
    }

    return new Promise<ShellVerdict | null>((resolve) => {
      const existing = this._pending.get(key);
      if (existing !== undefined) {
        // Chain onto the in-flight request rather than opening a second one.
        this._pending.set(key, (verdict) => {
          existing(verdict);
          resolve(verdict);
        });
        return;
      }
      this._pending.set(key, resolve);
      this._timers.set(
        key,
        globalThis.setTimeout(() => {
          this._settle(key, null);
        }, CLASSIFY_REQUEST_TIMEOUT_MS),
      );
      connection.send(
        FeedId.SHELL_INPUT,
        new TextEncoder().encode(
          JSON.stringify({
            type: "shell_classify",
            tug_session_id: this._tugSessionId,
            line,
            ...(withGrammar ? { grammar } : {}),
          }),
        ),
      );
    });
  }

  /**
   * Ask for a verdict but never wait longer than `timeoutMs`. An expired wait is
   * `null` — the request stays in flight and its answer still lands in the
   * cache, so the next keystroke's submit gets it for free.
   */
  requestWithin(
    line: string,
    timeoutMs: number,
    grammar?: string,
  ): Promise<ShellVerdict | null> {
    const cached = this._verdicts.get(keyFor(line, grammar !== undefined));
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise<ShellVerdict | null>((resolve) => {
      // The race timer is retired when the answer wins it, so an answered
      // wait leaves no timer parked against a settled promise [L27].
      const timer = globalThis.setTimeout(() => resolve(null), timeoutMs);
      void this.request(line, grammar).then((verdict) => {
        globalThis.clearTimeout(timer);
        resolve(verdict);
      });
    });
  }

  /** Drop every cached verdict. Called with the grade cache, on draft teardown. */
  clear(): void {
    this._verdicts.clear();
    this._snapshot = new Map();
    this.notify();
  }

  /** Every verdict landed so far. Routing reads `get`; this is the [L02] surface. */
  getSnapshot = (): ReadonlyMap<string, ShellVerdict> => this._snapshot;

  dispose(): void {
    this._disposed = true;
    this._unsubscribeFeed();
    this.clearListeners();
    // Anything still waiting gets the answer that changes nothing — and
    // `_settle` clears each parked timer, so none outlives the store [L27].
    for (const key of [...this._pending.keys()]) this._settle(key, null);
  }

  /** Resolve whoever is waiting on this question and retire its timeout. */
  private _settle(key: string, verdict: ShellVerdict | null): void {
    const timer = this._timers.get(key);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      this._timers.delete(key);
    }
    const resolve = this._pending.get(key);
    if (resolve !== undefined) {
      this._pending.delete(key);
      resolve(verdict);
    }
  }

  private _onFeedUpdate(): void {
    this._fold(this._feedStore.getSnapshot().get(this._feedId));
  }

  private _fold(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as Record<string, unknown>;
    if (p.type !== "shell_classify") return;
    if (p.tug_session_id !== this._tugSessionId) return;
    if (typeof p.line !== "string" || typeof p.with_grammar !== "boolean") return;

    // Every failure shape reaches here as one degraded answer, so there is
    // nothing to branch on: a verdict, or no opinion.
    const verdict: ShellVerdict | null =
      p.ok === true && (p.verdict === "shell" || p.verdict === "prompt")
        ? p.verdict
        : null;

    const key = keyFor(p.line, p.with_grammar);
    // Only a verdict is remembered. A failure is not an answer about the line
    // — it is a fact about the agent at one moment — and caching one would
    // make the question unaskable for the rest of the session: `request` hands
    // back a cached `null` without asking, so the first `gs` that arrived while
    // the classify lane was cold would send every later `gs` to Claude too.
    if (verdict !== null) {
      // Re-insert so a repeatedly-consulted draft stays hot rather than aging
      // out behind drafts that were asked about once.
      this._verdicts.delete(key);
      this._verdicts.set(key, verdict);
      while (this._verdicts.size > VERDICT_CACHE_CAPACITY) {
        const oldest = this._verdicts.keys().next();
        if (oldest.done === true) break;
        this._verdicts.delete(oldest.value);
      }
      this._snapshot = new Map(this._verdicts);
    }

    this._settle(key, verdict);
    this.notify();
  }

  /** Test seam: fold a raw `SHELL_OUTPUT` payload as if it arrived on the feed. */
  _ingestForTest(payload: unknown): void {
    this._fold(payload);
  }
}
