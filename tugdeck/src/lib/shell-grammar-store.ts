/**
 * shell-grammar-store — the deck's client for tugcast's command-grammar grader.
 *
 * One instance per Session card session, sharing the card's `SHELL_OUTPUT`
 * `FeedStore` (no new feed — the same session-scoped filter `PathCommandsStore`
 * uses). A `shell_grammar` request carries one line; the reply echoes that line
 * with its band and, on `maybe` only, the program's own condensed
 * documentation. Answers are cached by exact line, because a user editing the
 * tail of a draft re-presents earlier prefixes constantly.
 *
 * Every failure resolves to `unknown`: no transport, no reply in time, a
 * malformed frame, or no store at all. `unknown` is byte-for-byte the
 * pre-grader path — ask the model, then apply the veto — so a grader that is
 * absent or slow changes nothing about how a line is routed.
 *
 * [L02] store surface (`subscribe` / `getSnapshot`); [L22] direct feed read.
 *
 * @module lib/shell-grammar-store
 */

import { Subscribable } from "./subscribable";
import { FeedId, type FeedIdValue } from "../protocol";
import type { FeedStore } from "./feed-store";
import { getConnection } from "./connection-singleton";
import type { GrammarBand } from "./shell-line-classifier";

/** A graded line: how strong the evidence is, and what to arm the model with. */
export interface LineGrade {
  band: GrammarBand;
  /** The program's documentation. Present on `maybe` and nowhere else. */
  synopsis?: string;
}

/** The answer for a line nothing could be established about. */
export const UNKNOWN_GRADE: LineGrade = { band: "unknown" };

/**
 * How long submit waits for a grade before proceeding without one.
 *
 * This wait is **in series ahead of** `VERDICT_SUBMIT_WAIT_MS` (2s), so the two
 * add: a grade wait as generous as the verdict wait would double the worst-case
 * pause between Return and the line going somewhere, which is the one
 * user-visible cost this whole feature exists to reduce. It is small because it
 * should almost never be spent — the typing debounce fires the grade request
 * alongside the classify request, so by the time Return arrives the grade is
 * normally already cached. The 150ms is only for the case where Return beats
 * the debounce, and an expired wait grades `unknown`, which is today's path.
 */
export const GRADE_SUBMIT_WAIT_MS = 150;

/**
 * How long a request stays outstanding before it settles to `unknown` on its
 * own.
 *
 * Grading is table lookups and a `stat`, so a reply this late is a reply that
 * is never coming — a dropped socket, a restarted tugcast. Without this every
 * such line would leave a resolver parked forever, and a session's worth of
 * drafts would accumulate as a slow leak. A late reply is still folded into the
 * cache if it does arrive; only the waiting is bounded.
 */
const GRADE_REQUEST_TIMEOUT_MS = 2000;

/**
 * Distinct lines remembered before the oldest is dropped. Matches
 * `ShellVerdictCache.capacity` — the two caches hold answers about the same
 * drafts and are cleared together.
 */
const GRADE_CACHE_CAPACITY = 32;

function isBand(value: unknown): value is GrammarBand {
  return value === "yes" || value === "maybe" || value === "no" || value === "unknown";
}

export class ShellGrammarStore extends Subscribable {
  private readonly _grades = new Map<string, LineGrade>();
  private readonly _pending = new Map<string, (grade: LineGrade) => void>();
  private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _unsubscribeFeed: () => void;
  /** Immutable copy handed to `getSnapshot`, rebuilt when a grade lands —
   * `useSyncExternalStore` compares snapshots by identity, so returning the
   * live map would make every change invisible [L02]. */
  private _snapshot: ReadonlyMap<string, LineGrade> = new Map();
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

  /** The grade already known for this line, if the reply has landed. */
  get(line: string): LineGrade | undefined {
    return this._grades.get(line);
  }

  /**
   * Ask for a grade, or hand back the cached one. Idempotent per line: a second
   * call while the first is in flight joins the same answer rather than sending
   * a second frame. With no transport the answer is `unknown` immediately, so a
   * caller never waits on a request that was never sent.
   */
  request(line: string): Promise<LineGrade> {
    const cached = this._grades.get(line);
    if (cached !== undefined) return Promise.resolve(cached);

    // A disposed store must not acquire anything new [L27]: its feed
    // subscription is gone, so a frame sent now could never be answered and
    // its timer would be the only thing to settle the wait.
    if (this._disposed) return Promise.resolve(UNKNOWN_GRADE);

    const connection = getConnection();
    if (connection === null || connection === undefined) {
      return Promise.resolve(UNKNOWN_GRADE);
    }

    return new Promise<LineGrade>((resolve) => {
      const existing = this._pending.get(line);
      if (existing !== undefined) {
        // Chain onto the in-flight request rather than opening a second one.
        this._pending.set(line, (grade) => {
          existing(grade);
          resolve(grade);
        });
        return;
      }
      this._pending.set(line, resolve);
      this._timers.set(
        line,
        globalThis.setTimeout(() => {
          this._settle(line, UNKNOWN_GRADE);
        }, GRADE_REQUEST_TIMEOUT_MS),
      );
      connection.send(
        FeedId.SHELL_INPUT,
        new TextEncoder().encode(
          JSON.stringify({
            type: "shell_grammar",
            tug_session_id: this._tugSessionId,
            line,
          }),
        ),
      );
    });
  }

  /**
   * Ask for a grade but never wait longer than `timeoutMs`. An expired wait is
   * `unknown` — the request stays in flight and its answer still lands in the
   * cache, so the next keystroke's submit gets it for free.
   */
  requestWithin(line: string, timeoutMs: number): Promise<LineGrade> {
    const cached = this._grades.get(line);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise<LineGrade>((resolve) => {
      // The race timer is retired when the answer wins it, so an answered
      // wait leaves no timer parked against a settled promise [L27].
      const timer = globalThis.setTimeout(() => resolve(UNKNOWN_GRADE), timeoutMs);
      void this.request(line).then((grade) => {
        globalThis.clearTimeout(timer);
        resolve(grade);
      });
    });
  }

  /** Drop every cached grade. Called with the verdict cache, on draft teardown. */
  clear(): void {
    this._grades.clear();
    this._snapshot = new Map();
    this.notify();
  }

  /** Every grade landed so far. Routing reads `get`; this is the [L02] surface. */
  getSnapshot = (): ReadonlyMap<string, LineGrade> => this._snapshot;

  dispose(): void {
    this._disposed = true;
    this._unsubscribeFeed();
    this.clearListeners();
    // Anything still waiting gets the answer that changes nothing.
    for (const line of [...this._pending.keys()]) this._settle(line, UNKNOWN_GRADE);
  }

  /** Resolve whoever is waiting on `line` and retire its timeout. */
  private _settle(line: string, grade: LineGrade): void {
    const timer = this._timers.get(line);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      this._timers.delete(line);
    }
    const resolve = this._pending.get(line);
    if (resolve !== undefined) {
      this._pending.delete(line);
      resolve(grade);
    }
  }

  private _onFeedUpdate(): void {
    this._fold(this._feedStore.getSnapshot().get(this._feedId));
  }

  private _fold(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as Record<string, unknown>;
    if (p.type !== "shell_grammar") return;
    if (p.tug_session_id !== this._tugSessionId) return;
    if (typeof p.line !== "string" || !isBand(p.band)) return;

    const grade: LineGrade =
      p.band === "maybe" && typeof p.synopsis === "string"
        ? { band: p.band, synopsis: p.synopsis }
        : { band: p.band };

    // Re-insert so a repeatedly-consulted draft stays hot rather than aging out
    // behind drafts that were asked about once.
    this._grades.delete(p.line);
    this._grades.set(p.line, grade);
    while (this._grades.size > GRADE_CACHE_CAPACITY) {
      const oldest = this._grades.keys().next();
      if (oldest.done === true) break;
      this._grades.delete(oldest.value);
    }
    this._snapshot = new Map(this._grades);

    this._settle(p.line, grade);
    this.notify();
  }

  /** Test seam: fold a raw `SHELL_OUTPUT` payload as if it arrived on the feed. */
  _ingestForTest(payload: unknown): void {
    this._fold(payload);
  }
}
