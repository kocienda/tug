/**
 * path-commands-store — the deck cache of everything the shell-line classifier
 * needs to decide a typed line could name a command ([P08], Spec S02).
 *
 * The membership question is "will this session's shell resolve this word?",
 * and two sources answer it together: the login-PATH executable set, and the
 * session shell's own aliases, functions and builtins. tugcast replies to one
 * `path_commands` request with a frame for each — `path_commands` and
 * `shell_words` — and this store holds them separately and hands out their
 * union. Names only: membership is all the classifier asks, and shipping the
 * expansions would put a second copy of them somewhere nobody could keep
 * coherent with the shell.
 *
 * One instance per Session card session, sharing the card's `SHELL_OUTPUT`
 * `FeedStore` (no new feed — the same session-scoped filter the shell session
 * store uses). `request()` fires the verb once, at session bind, so the set is
 * warm before the first submit, and carries the card's project dir because the
 * word dump's shell stands there and rc files branch on where they are.
 *
 * `getSnapshot()` returns `null` until the `path_commands` reply lands — the
 * classifier treats null as "answer Code", the safety net that keeps the first
 * command-shaped line of a session from misrouting while the set loads. A
 * `shell_words` frame arriving first is held aside and unioned in when the
 * command set lands, so that net keeps exactly one trigger.
 *
 * tugcast also *pushes* a fresh `path_commands` frame when the PATH set changes
 * under a running session, so a `brew install` becomes routable without a
 * reload. Every fold is idempotent for that reason.
 *
 * [L02] store surface (`subscribe` / `getSnapshot`); [L22] direct feed read.
 *
 * @module lib/path-commands-store
 */

import { Subscribable } from "./subscribable";
import { FeedId, type FeedIdValue } from "../protocol";
import type { FeedStore } from "./feed-store";
import { getConnection } from "./connection-singleton";

export class PathCommandsStore extends Subscribable {
  private _pathCommands: ReadonlySet<string> | null = null;
  private _shellWords: ReadonlySet<string> | null = null;
  /** The union the classifier reads, rebuilt only when a frame folds ([L02]). */
  private _union: ReadonlySet<string> | null = null;
  private readonly _unsubscribeFeed: () => void;
  private _requested = false;

  constructor(
    private readonly _feedStore: FeedStore,
    private readonly _feedId: FeedIdValue,
    private readonly _tugSessionId: string,
    private readonly _projectDir?: string,
  ) {
    super();
    this._unsubscribeFeed = _feedStore.subscribe(() => this._onFeedUpdate());
    // Fold any frame already present at construction (replay-on-subscribe).
    this._onFeedUpdate();
  }

  /**
   * Request the command set once (idempotent). Fired at session bind so the set
   * is warm before the first submit. A missing transport is a silent no-op —
   * the classifier answers Code until the set loads.
   */
  request(): void {
    if (this._requested) return;
    this._requested = true;
    const message: Record<string, unknown> = {
      type: "path_commands",
      tug_session_id: this._tugSessionId,
    };
    if (this._projectDir) message.cwd = this._projectDir;
    getConnection()?.send(
      FeedId.SHELL_INPUT,
      new TextEncoder().encode(JSON.stringify(message)),
    );
  }

  private _onFeedUpdate(): void {
    this._fold(this._feedStore.getSnapshot().get(this._feedId));
  }

  /**
   * Fold one `SHELL_OUTPUT` payload. Anything that is not one of this store's
   * two frames for this session leaves it untouched, so it shares the feed with
   * every other shell frame without noticing them.
   */
  private _fold(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as Record<string, unknown>;
    if (p.tug_session_id !== this._tugSessionId) return;

    if (p.type === "path_commands") {
      if (!Array.isArray(p.commands)) return;
      this._pathCommands = toNameSet(p.commands);
    } else if (p.type === "shell_words") {
      if (!Array.isArray(p.names)) return;
      this._shellWords = toNameSet(p.names);
    } else {
      return;
    }

    // Null until the command set lands, whichever frame arrived first: the
    // classifier's "still loading → answer Code" net needs one trigger, not two.
    if (this._pathCommands === null) return;
    const union = new Set(this._pathCommands);
    if (this._shellWords) for (const name of this._shellWords) union.add(name);
    this._union = union;
    this.notify();
  }

  /**
   * Every word this session's shell would resolve — PATH names ∪ shell word
   * names — or `null` until the command set lands.
   */
  getSnapshot = (): ReadonlySet<string> | null => this._union;

  dispose(): void {
    this._unsubscribeFeed();
    this.clearListeners();
  }

  /** Test seam: fold a raw `SHELL_OUTPUT` payload as if it arrived on the feed. */
  _ingestForTest(payload: unknown): void {
    this._fold(payload);
  }
}

function toNameSet(names: readonly unknown[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const name of names) {
    if (typeof name === "string") set.add(name);
  }
  return set;
}
