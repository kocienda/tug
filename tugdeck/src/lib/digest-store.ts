/**
 * `DigestStore` — app-scoped snapshot cache for DIGEST lines.
 *
 * Hydrates from tugcast's in-memory digester on first observation (one
 * `list_digest_lines` CONTROL round-trip — the
 * `session-state-changes-reader` pattern), then folds live `DIGEST`
 * feed frames as the digester emits them. The response carries a
 * per-scope window of beats, so a card that reconnects to a running
 * tugcast comes back wearing its recent beats instead of blank.
 *
 * There is no toggle in the snapshot. The beat is deterministic and costs
 * nothing to produce, so it has no switch; the subsystem's one switch is
 * `dev.tugapp.overview/enabled` and it gates the Observer's wakes ([P10]).
 *
 * **Laws.** [L02] — external state (wire frames, CONTROL responses,
 * the digest tail) enters React only through `useSyncExternalStore`
 * via {@link useDigest}; snapshots are referentially stable between
 * folds. Nothing persists anywhere: the digester's deque dies with the
 * process, and the deck never caches digest lines locally.
 */

import { useSyncExternalStore } from "react";

import type { TugConnection } from "@/connection";
import { stripAnsi } from "@/lib/ansi/strip-ansi";
import {
  FeedId,
  encodeListDigestLines,
  parseDigestFrame,
  type ListDigestLinesOk,
} from "@/protocol";

/**
 * Mirror of tugcast's tail length — the rolling display cap, applied PER
 * SCOPE. A global cap would undo the per-scope restore the ledger read
 * performs: every selector here filters by session after the fact, so
 * trimming the log app-wide throws away exactly the quiet card's lines the
 * ledger went to the trouble of finding.
 */
export const DIGEST_LINES_CAP = 20;

/**
 * The digester's spelling for a line that IS the user's own submission.
 *
 * Named rather than inlined because two readers depend on it and neither owns
 * it: the masthead's ladder, and the test that pins the ladder's behaviour.
 */
export const ASK_KIND = "ask";

/**
 * The digester's spelling for a turn that has ended — `Done` or `Stopped`.
 *
 * What it is read for here is the negative, through
 * {@link turnInFlightForScope}: a session whose newest in-turn line is
 * anything else has a turn in flight, which is the condition the masthead's
 * ladder switches on ([D187]).
 */
export const TURN_KIND = "turn";

/**
 * The kinds that are not part of an AI turn at all, and so say nothing about
 * whether one is running.
 *
 * A `shell` line is the card's own shell feature — a command the user ran
 * beside the transcript, recorded because it is part of what the session did
 * rather than because a turn is open. A `notice` is the same shape from the
 * other direction: a background job reaching its terminal state, a resume, a
 * truncated response — all of which can land after the turn that started them
 * has ended.
 */
const OUT_OF_TURN_KINDS: ReadonlySet<string> = new Set(["shell", "notice"]);

/**
 * Whether `scope` has a turn in flight, as the digest can tell it.
 *
 * The test is the newest **in-turn** line: a turn marker means the last turn
 * ended, anything else means one is running, and a scope the digest has never
 * spoken about has never started one. Out-of-turn lines
 * ({@link OUT_OF_TURN_KINDS}) are walked past rather than answered with, which
 * is the whole reason this is a function rather than `latest.kind !==
 * TURN_KIND`: one `$ ls` beside an idle transcript would otherwise read as a
 * live turn for as long as the session sat there, and the masthead's ladder
 * would hold a stale Observer post where the standing sentence belongs.
 *
 * A line with no kind at all answers `false`. Both doors a line arrives
 * through carry one, so an absent kind means a wire older than [D187]'s — and
 * "no turn" is the reading that falls through to the description ladder rather
 * than the one that pins a post.
 */
export function turnInFlightForScope(
  lines: readonly DigestLineEntry[],
  scope: string,
  clearedKeys?: ReadonlySet<string>,
): boolean {
  if (scope.length === 0) return false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (clearedKeys?.has(line.key) === true) continue;
    if (
      line.scopes.length > 0 &&
      !line.scopes.includes(scope) &&
      !line.scopes.includes("app")
    ) {
      continue;
    }
    if (line.kind === undefined) return false;
    if (OUT_OF_TURN_KINDS.has(line.kind)) continue;
    return line.kind !== TURN_KIND;
  }
  return false;
}

/** How the digester heads an Ask line. */
const ASK_PREFIX = "asked: ";

/**
 * An ask line as a sentence rather than as a beat: the prompt without the
 * `asked:` head the digest gives it.
 *
 * The head belongs to the strip, where the line sits among tool beats and has
 * to say what kind of thing it is. On the masthead's upper line it is the only
 * thing there, so the head is a label on a line with nothing to be told apart
 * from.
 */
export function askPromptText(line: DigestLineEntry): string {
  return line.text.startsWith(ASK_PREFIX)
    ? line.text.slice(ASK_PREFIX.length)
    : line.text;
}

/** One displayable digest line. `key` is stable line identity (the
 * strip's fade-in animation keys on it). */
export interface DigestLineEntry {
  key: string;
  text: string;
  /**
   * What the line is an account of, as the digester spelled it — `ask`,
   * `said`, `tool`, `result`, `shell`, `turn`, `notice`, `wait`. Carried by
   * both doors the lines arrive through — the live DIGEST frame and the
   * mount-time tail read — because the ladders that switch on it cannot tell
   * an absent kind from a turn still running.
   */
  kind?: string;
  scopes: readonly string[];
  beat: number;
  atMs: number;
}

export interface DigestSnapshot {
  /** Ledger-tail load state; live folds work in any state. */
  status: "idle" | "pending" | "ready";
  /** Rolling log, oldest-first, capped at {@link DIGEST_LINES_CAP}. */
  lines: readonly DigestLineEntry[];
  /** Convenience: newest line app-wide, or null before the first. */
  latest: DigestLineEntry | null;
  /**
   * Per-scope cleared watermarks: submitting a new message clears
   * that card's strip, so `cleared.get(scope)` holds the line keys
   * that existed at submit time — the selector skips them; lines
   * arriving afterwards show normally.
   */
  cleared: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Trim `lines` (oldest-first) so no scope keeps more than `cap` of them,
 * preserving order. A line covering several scopes counts against each but
 * is kept once; unscoped app-wide ambience gets a window of its own.
 *
 * The mirror of tugcast's `list_digest_lines_per_scope`, and needed for the
 * same reason on this side of the wire.
 */
export function capLinesPerScope(
  lines: readonly DigestLineEntry[],
  cap: number,
): DigestLineEntry[] {
  const taken = new Map<string, number>();
  const kept: DigestLineEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const keys = line.scopes.length > 0 ? line.scopes : [""];
    if (!keys.some((key) => (taken.get(key) ?? 0) < cap)) continue;
    for (const key of keys) taken.set(key, (taken.get(key) ?? 0) + 1);
    kept.push(line);
  }
  kept.reverse();
  return kept;
}

/**
 * The newest line about `scope` — a card's strip shows commentary
 * about ITS session, never another card's. A line whose `scopes`
 * include the literal `"app"` (or carry no scopes at all) is
 * app-wide ambience and shows everywhere; a multi-scope line shows
 * on every card it covers — that's the cross-session weave working,
 * not a leak.
 */
export function latestLineForScope(
  lines: readonly DigestLineEntry[],
  scope: string,
  clearedKeys?: ReadonlySet<string>,
): DigestLineEntry | null {
  if (scope.length === 0) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (clearedKeys?.has(line.key) === true) continue;
    if (
      line.scopes.length === 0 ||
      line.scopes.includes(scope) ||
      line.scopes.includes("app")
    ) {
      return line;
    }
  }
  return null;
}

/**
 * The newest ASK about `scope` — the user's own submission for the turn in
 * flight, and rung (2) of the masthead's ladder ([D187]).
 *
 * Separate from {@link latestLineForScope} rather than a filter over it
 * because the two answer different questions: the beat is whatever the session
 * said most recently, and the ask is what the whole turn is FOR, which every
 * beat after it buries. The distinction only became expressible when the
 * digest's `kind` took the retired `intent` pin's place on the wire.
 *
 * A scope with no ask — a session that has never been prompted, or one whose
 * ask has rolled off the capped window — answers null, and the ladder falls
 * through to the rest form.
 */
export function latestAskForScope(
  lines: readonly DigestLineEntry[],
  scope: string,
  clearedKeys?: ReadonlySet<string>,
): DigestLineEntry | null {
  if (scope.length === 0) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.kind !== ASK_KIND) continue;
    if (clearedKeys?.has(line.key) === true) continue;
    if (line.scopes.includes(scope)) return line;
  }
  return null;
}

/**
 * The newest `limit` lines about `scope`, newest-first — the strip's history
 * popover. Same scope rule as {@link latestLineForScope} (the session's own
 * lines plus `app`-wide / unscoped ambience); cleared watermarks are NOT
 * applied, since the history shows what actually happened.
 */
export function linesForScope(
  lines: readonly DigestLineEntry[],
  scope: string,
  limit: number,
): DigestLineEntry[] {
  const out: DigestLineEntry[] = [];
  if (scope.length === 0) return out;
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (
      line.scopes.length === 0 ||
      line.scopes.includes(scope) ||
      line.scopes.includes("app")
    ) {
      out.push(line);
    }
  }
  return out;
}

/**
 * One heading of the beat history and the beats that ran beneath it.
 *
 * The heading is an Observer post ([B08]) — absent for the run of beats
 * before the first post of the stretch, which is the ordinary opening of any
 * turn: nothing has been written about it yet.
 */
export interface BeatHistoryGroup {
  heading?: string;
  beats: DigestLineEntry[];
}

/**
 * Fold a line list into post groups: each line sits under the newest `heading`
 * written at or before it, and a run of consecutive lines sharing one heading
 * collapses, so a post shows ONCE in the history popover instead of repeating
 * on every beat row.
 *
 * This used to group by the voice's pinned `intent` — a phrase extracted from
 * the assistant's own interstitial narration, which [F01] found is mostly
 * "Let me check the reducer". The heading is a written sentence now, so the
 * grouping is worth reading; the mechanics are the same.
 *
 * Both lists are ordered newest-first, which is how the popover reads them,
 * and input order is preserved.
 */
export function groupBeatHistory(
  lines: readonly DigestLineEntry[],
  headings: readonly { atMs: number; text: string }[] = [],
): BeatHistoryGroup[] {
  const groups: BeatHistoryGroup[] = [];
  for (const line of lines) {
    const heading = headings.find((h) => h.atMs <= line.atMs)?.text;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.heading === heading) {
      last.beats.push(line);
    } else {
      groups.push({
        ...(heading !== undefined ? { heading } : {}),
        beats: [line],
      });
    }
  }
  return groups;
}

const EMPTY_LINES: readonly DigestLineEntry[] = Object.freeze([]);
const EMPTY_CLEARED: ReadonlyMap<string, ReadonlySet<string>> = new Map();
const IDLE_SNAPSHOT: DigestSnapshot = Object.freeze({
  status: "idle",
  lines: EMPTY_LINES,
  latest: null,
  cleared: EMPTY_CLEARED,
});

// ---------------------------------------------------------------------------
// CONTROL response bus — action-dispatch publishes, the store consumes.
// ---------------------------------------------------------------------------

type OkListener = (payload: ListDigestLinesOk) => void;
const okListeners = new Set<OkListener>();

/** Called by `action-dispatch.ts` when `list_digest_lines_ok` lands. */
export function publishListDigestLinesOk(payload: ListDigestLinesOk): void {
  for (const listener of [...okListeners]) listener(payload);
}

function subscribeToListDigestLinesOk(listener: OkListener): () => void {
  okListeners.add(listener);
  return () => okListeners.delete(listener);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

function lineKey(atMs: number, beat: number): string {
  return `${atMs}:${beat}`;
}

export class DigestStore {
  private readonly conn: TugConnection;
  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private snapshot: DigestSnapshot = IDLE_SNAPSHOT;
  private tailRequested = false;

  constructor(conn: TugConnection) {
    this.conn = conn;
    // Live lines fold as the commentator speaks — including while the
    // tail load is still pending (the merge dedupes by line identity).
    this.disposers.push(
      this.conn.onFrame(FeedId.DIGEST, (payload) => this._onDigest(payload)),
    );
    this.disposers.push(
      subscribeToListDigestLinesOk((payload) => this.onTail(payload)),
    );
  }

  dispose(): void {
    for (const fn of this.disposers) fn();
    this.disposers.length = 0;
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * A new message was submitted for `scope`: everything currently on
   * the log is "before" for that card — its strip clears until the
   * next line arrives. Called by `CodeSessionStore.send`.
   */
  clearScope(scope: string): void {
    if (scope.length === 0) return;
    const keys = new Set(this.snapshot.lines.map((l) => l.key));
    const cleared = new Map(this.snapshot.cleared);
    cleared.set(scope, keys);
    this.snapshot = Object.freeze({ ...this.snapshot, cleared });
    this.tick();
  }

  /**
   * Current snapshot. The first call kicks the one-shot ledger-tail
   * CONTROL request; live folds keep working regardless of its fate.
   */
  getSnapshot = (): DigestSnapshot => {
    if (!this.tailRequested) {
      this.tailRequested = true;
      this.snapshot = Object.freeze({
        ...this.snapshot,
        status: "pending" as const,
      });
      const frame = encodeListDigestLines();
      this.conn.send(frame.feedId, frame.payload);
    }
    return this.snapshot;
  };

  /**
   * One DIGEST frame off the wire, folded into the rolling beat log.
   *
   * Named rather than inlined at the subscription so the app-test surface can
   * reach it with bytes the wire would otherwise have supplied
   * ({@link _ingestDigestFrameForTest}) — the parse and the fold are then
   * exactly the production ones.
   *
   * `stripAnsi` guards the text here and at the tail hydrate, the store's two
   * doors ([B05] of the narration-one brief). The digester scrubs at the
   * source, but rows written before it did replay out of the ledger until
   * they age out, and a guard at the door is cheaper than a migration.
   */
  private _onDigest(payload: Uint8Array): void {
    const line = parseDigestFrame(payload);
    if (line === null) return;
    this.fold([
      {
        key: lineKey(line.at, line.beat),
        text: stripAnsi(line.text),
        ...(line.kind !== undefined ? { kind: line.kind } : {}),
        scopes: Object.freeze([...line.scopes]),
        beat: line.beat,
        atMs: line.at,
      },
    ]);
  }

  private onTail(payload: ListDigestLinesOk): void {
    const tail: DigestLineEntry[] = payload.lines.map((row) =>
      Object.freeze({
        key: lineKey(row.at_ms, row.beat),
        text: stripAnsi(row.text),
        ...(typeof row.kind === "string" ? { kind: row.kind } : {}),
        scopes: Object.freeze([...row.scopes]) as readonly string[],
        beat: row.beat,
        atMs: row.at_ms,
      }),
    );
    // Tail (history) first, then any live lines that landed while the
    // load was in flight; dedupe on line identity.
    const live = this.snapshot.lines;
    const seen = new Set(tail.map((l) => l.key));
    const merged = [...tail];
    for (const line of live) {
      if (seen.has(line.key)) continue;
      seen.add(line.key);
      merged.push(line);
    }
    this.commit(merged, "ready");
  }

  private fold(incoming: DigestLineEntry[]): void {
    const seen = new Set(this.snapshot.lines.map((l) => l.key));
    const fresh = incoming.filter((l) => !seen.has(l.key));
    if (fresh.length === 0) return;
    this.commit([...this.snapshot.lines, ...fresh], this.snapshot.status);
  }

  private commit(
    lines: DigestLineEntry[],
    status: DigestSnapshot["status"],
  ): void {
    const capped = capLinesPerScope(lines, DIGEST_LINES_CAP);
    this.snapshot = Object.freeze({
      status,
      lines: Object.freeze(capped) as readonly DigestLineEntry[],
      latest: capped.length > 0 ? capped[capped.length - 1] : null,
      cleared: this.snapshot.cleared,
    });
    this.tick();
  }

  private tick(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

// ---------------------------------------------------------------------------
// Singleton + hook
// ---------------------------------------------------------------------------

let _activeStore: DigestStore | null = null;

export function attachDigestStore(conn: TugConnection): DigestStore {
  if (_activeStore !== null) return _activeStore;
  _activeStore = new DigestStore(conn);
  return _activeStore;
}

export function getDigestStore(): DigestStore | null {
  return _activeStore;
}

/** Test-only: detach the singleton between cases. */
export function _resetDigestStoreForTest(): void {
  _activeStore?.dispose();
  _activeStore = null;
}

/**
 * Test-only: feed a DIGEST frame body as if it arrived over the wire.
 *
 * Not a mock — the bytes go through the production `parseDigestFrame` and the
 * production folds, so what the components see is what the wire would have
 * produced. `parseDigestFrame` rejects a malformed body silently, so a caller
 * must assert on rendered output rather than on having called this.
 */
export function _ingestDigestFrameForTest(body: unknown): void {
  if (_activeStore === null) return;
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  // Reach the private handler through the same path onFrame would.
  (_activeStore as unknown as { _onDigest(p: Uint8Array): void })._onDigest(bytes);
}

/**
 * React hook: the app-wide digest snapshot. Returns the idle snapshot
 * when no store is attached (gallery / fixtures).
 */
export function useDigest(): DigestSnapshot {
  return useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.getSnapshot() ?? IDLE_SNAPSHOT,
    () => IDLE_SNAPSHOT,
  );
}

