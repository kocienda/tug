/**
 * SideQuestionStore — the `/btw` side-question request/response history over
 * the CODE_INPUT / CODE_OUTPUT frames (Spec S02).
 *
 * A side question ("what was that config file again?") is answered from the
 * live conversation with no tools and never enters the transcript. This store
 * sends a `side_question` CODE_INPUT (stamped with the card's
 * `tug_session_id`) and resolves the `side_question_answer` frame whose
 * `request_id` matches — the same single-shot request/response shape as
 * {@link HooksInventoryStore}, extended to keep a **history** of exchanges so
 * the overlay can dim earlier asks rather than showing only the latest.
 *
 * The exchange is ephemeral and session-scoped ([P03]): in-memory only, no
 * tugbank / JSONL / web storage. It is NOT dispatched into the code-session
 * store, so it never becomes a transcript row and survives a Maker ▸
 * Reload with no trace ([P05]). The answer is a single settled one-shot
 * ([Q02] resolved: one terminal `control_response`, no token streaming).
 *
 * @module lib/side-question-store
 */

import type { FeedStore } from "./feed-store";
import type { FeedIdValue } from "../protocol";
import { FeedId } from "../protocol";
import { getConnection } from "./connection-singleton";
import type { PendingContextStore } from "./pending-context-store";
import { btwContextLabel, composeBtwContextBody } from "./pending-context-store";
import { getTugbankClient } from "./tugbank-singleton";
import { SIDE_QUESTIONS_DOMAIN, putSideQuestionHistory } from "@/settings-api";

/** Cap on persisted side questions per session ([P07]) — the tail is what the
 *  overlay needs, mirroring the shell ledger's per-session cap. */
const MAX_PERSISTED_SIDE_QUESTIONS = 100;

/** Parse a persisted `/btw` history blob into settled exchanges. */
function parsePersistedSideQuestions(raw: unknown): SideQuestionExchange[] {
  if (!Array.isArray(raw)) return [];
  const out: SideQuestionExchange[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.question !== "string") continue;
    const phase: SideQuestionPhase = o.phase === "error" ? "error" : "answered";
    const answer = typeof o.answer === "string" ? o.answer : null;
    // A persisted "answered" with no answer text is corrupt — drop it.
    if (phase === "answered" && answer === null) continue;
    out.push({
      id: o.id,
      question: o.question,
      phase,
      answer,
      synthetic: o.synthetic === true,
      at: typeof o.at === "number" ? o.at : 0,
    });
  }
  return out;
}

// ── Wire type (mirror tugcode `SideQuestionAnswer`) ─────────────────────────

/** A settled `/btw` answer from tugcode (CODE_OUTPUT frame). */
export interface SideQuestionAnswerPayload {
  request_id: string;
  /** The answer text, or `null` when Claude returned no response. */
  answer: string | null;
  /** `true` when the CLI synthesized the answer. */
  synthetic: boolean;
}

/** Parse a CODE_OUTPUT `side_question_answer` payload, or `null`. */
export function parseSideQuestionAnswerPayload(
  payload: unknown,
): SideQuestionAnswerPayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== "side_question_answer") return null;
  if (typeof p.request_id !== "string") return null;
  const answer = typeof p.answer === "string" ? p.answer : null;
  const synthetic = p.synthetic === true;
  return { request_id: p.request_id, answer, synthetic };
}

// ── Snapshot ────────────────────────────────────────────────────────────────

/** Lifecycle of one side-question exchange. */
export type SideQuestionPhase = "loading" | "answered" | "error";

/** One ask/answer exchange in the session's history. */
export interface SideQuestionExchange {
  /** The `request_id` (`btw-${seq}`). */
  readonly id: string;
  readonly question: string;
  readonly phase: SideQuestionPhase;
  /** The settled answer, or `null` (loading, or no response received). */
  readonly answer: string | null;
  readonly synthetic: boolean;
  /** Ask time (ms epoch), stamped when `ask` is called. */
  readonly at: number;
}

/** Reactive snapshot the overlay renders via `useSyncExternalStore`. */
export interface SideQuestionSnapshot {
  /** Exchanges newest-last; the current ask is the tail. */
  readonly exchanges: readonly SideQuestionExchange[];
}

const EMPTY_SNAPSHOT: SideQuestionSnapshot = { exchanges: [] };

// ── SideQuestionStore ─────────────────────────────────────────────────────────

export class SideQuestionStore {
  private _snapshot: SideQuestionSnapshot = EMPTY_SNAPSHOT;
  private _listeners = new Set<() => void>();
  private _unsubscribeFeed: (() => void) | null = null;
  private _lastPayloadRef: unknown = undefined;
  private readonly _feedStore: FeedStore;
  private readonly _feedId: FeedIdValue;
  /** The segment the `/btw` frame is addressed to — the wire's key. */
  private readonly _tugSessionId: string;
  /** The line the history is filed under — the durable key ([P12]). */
  private readonly _lineId: string;
  private readonly _pendingContextStore: PendingContextStore | undefined;
  private _seq = 0;

  /**
   * @param tugSessionId The segment this store speaks to. It addresses the
   * `side_question` frame, and it is the key the history was written under
   * before the line model — read once as the carry below.
   * @param lineId The durable key for the `/btw` history ([P12]) — the line,
   * not the segment, because the exchanges belong to the conversation and a
   * card rotates through a session id per stage.
   */
  constructor(
    feedStore: FeedStore,
    feedId: FeedIdValue,
    tugSessionId: string,
    lineId: string,
    pendingContextStore?: PendingContextStore,
  ) {
    this._feedStore = feedStore;
    this._feedId = feedId;
    this._tugSessionId = tugSessionId;
    this._lineId = lineId;
    this._pendingContextStore = pendingContextStore;
    this._unsubscribeFeed = feedStore.subscribe(() => this._onFeedUpdate());
    this._loadPersisted();
  }

  /**
   * Seed the history from the durable per-session `/btw` blob ([P07]), read
   * synchronously from the TugbankClient cache (populated by the boot DEFAULTS
   * frame before the card's services are constructed). Only settled exchanges
   * were persisted; `_seq` resumes past the highest `btw-{n}` so a new ask
   * keeps a unique `#b{n}`. No listeners exist yet, so this sets the snapshot
   * directly without a notify.
   */
  private _loadPersisted(): void {
    // `?.getValue?.` also tolerates a partial mock client (tests) missing the
    // method — the durable read simply yields nothing there.
    const client = getTugbankClient();
    let loaded = parsePersistedSideQuestions(
      client?.getValue?.(SIDE_QUESTIONS_DOMAIN, this._lineId),
    );
    // The one-time carry from the pre-lines key ([P12]).
    let carried = false;
    if (loaded.length === 0 && this._tugSessionId !== this._lineId) {
      loaded = parsePersistedSideQuestions(
        client?.getValue?.(SIDE_QUESTIONS_DOMAIN, this._tugSessionId),
      );
      carried = loaded.length > 0;
    }
    if (loaded.length === 0) return;
    this._snapshot = { exchanges: loaded };
    let maxSeq = 0;
    for (const ex of loaded) {
      const n = ex.id.startsWith("btw-") ? Number.parseInt(ex.id.slice(4), 10) : NaN;
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
    this._seq = maxSeq;
    // Written under the line key immediately, so the carry happens exactly
    // once in this line's life.
    if (carried) this._persist();
  }

  /** Persist the settled exchanges (capped tail) to the durable blob ([P07]).
   *  No-op without a live TugbankClient (tests / headless) so no stray fetch. */
  private _persist(): void {
    // Only with a real (live-app) TugbankClient — a null or partial mock
    // (tests / headless) means no live persistence context, so no stray fetch.
    if (typeof getTugbankClient()?.getValue !== "function") return;
    const settled = this._snapshot.exchanges
      .filter((ex) => ex.phase !== "loading")
      .slice(-MAX_PERSISTED_SIDE_QUESTIONS)
      .map((ex) => ({
        id: ex.id,
        question: ex.question,
        phase: ex.phase,
        answer: ex.answer,
        synthetic: ex.synthetic,
        at: ex.at,
      }));
    putSideQuestionHistory(this._lineId, settled);
  }

  private _onFeedUpdate(): void {
    const payload = this._feedStore.getSnapshot().get(this._feedId);
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;
    const parsed = parseSideQuestionAnswerPayload(payload);
    if (parsed === null) return;
    this._settle(parsed);
  }

  /**
   * Correlate a settled answer to its pending exchange by `request_id` and
   * flip it in place. `answer === null` ⇒ `error` ("no response received"),
   * otherwise `answered`. An answer for an unknown id is ignored.
   */
  private _settle(parsed: SideQuestionAnswerPayload): void {
    let changed = false;
    let settledAnswer: SideQuestionExchange | null = null;
    const exchanges = this._snapshot.exchanges.map((ex) => {
      if (ex.id !== parsed.request_id || ex.phase !== "loading") return ex;
      changed = true;
      const next = {
        ...ex,
        phase: parsed.answer === null ? ("error" as const) : ("answered" as const),
        answer: parsed.answer,
        synthetic: parsed.synthetic,
      };
      if (next.phase === "answered") settledAnswer = next;
      return next;
    });
    if (!changed) return;
    this._set({ exchanges });
    // Durable ([P07]): a newly settled exchange is written to the per-session
    // blob so the overlay history survives an app relaunch.
    this._persist();
    // VISIBILITY=Context ([P08], the submission-time variant): a newly answered
    // side question auto-stages onto the pending-context queue to ride the next
    // `❯` submission. Fires once, on the live settle — a re-render never
    // re-settles — so a manual un-stage afterwards is not clobbered.
    if (settledAnswer !== null && this._pendingContextStore?.isContext("btw")) {
      const ex: SideQuestionExchange = settledAnswer;
      this._pendingContextStore.stage({
        source: "btw",
        ref: ex.id,
        label: btwContextLabel(ex.id),
        body: composeBtwContextBody(ex.question, ex.answer ?? ""),
      });
    }
  }

  /**
   * Ask a side question. Mints a `request_id`, appends a `loading` exchange,
   * and sends the `side_question` CODE_INPUT verb for this card's session. The
   * send is un-gated (turn-state-independent, like the `/hooks` precedent), so
   * `/btw` works idle or mid-turn ([P04]).
   */
  ask(question: string): void {
    const trimmed = question.trim();
    if (trimmed.length === 0) return;
    this._seq += 1;
    const requestId = `btw-${this._seq}`;
    const conn = getConnection();
    if (!conn) {
      this._append({
        id: requestId,
        question: trimmed,
        phase: "error",
        answer: null,
        synthetic: false,
        at: Date.now(),
      });
      return;
    }
    this._append({
      id: requestId,
      question: trimmed,
      phase: "loading",
      answer: null,
      synthetic: false,
      at: Date.now(),
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        tug_session_id: this._tugSessionId,
        type: "side_question",
        request_id: requestId,
        question: trimmed,
      }),
    );
    conn.send(FeedId.CODE_INPUT, bytes);
  }

  /**
   * Dismiss a single exchange by id (the per-row `×`). For a still-`loading`
   * exchange this is a cancel: the row leaves the zone, and a late answer for
   * that id is ignored ({@link _settle} only settles a present loading row).
   * The control-request itself is fire-and-forget — there is no protocol
   * cancel — so this is purely a surface dismissal.
   */
  dismiss(id: string): void {
    const next = this._snapshot.exchanges.filter((ex) => ex.id !== id);
    if (next.length === this._snapshot.exchanges.length) return;
    this._set({ exchanges: next });
    this._persist();
  }

  /** Empty the whole zone (the footer's Clear). */
  clear(): void {
    if (this._snapshot.exchanges.length === 0) return;
    this._set(EMPTY_SNAPSHOT);
    this._persist();
  }

  private _append(exchange: SideQuestionExchange): void {
    this._set({ exchanges: [...this._snapshot.exchanges, exchange] });
  }

  private _set(next: SideQuestionSnapshot): void {
    this._snapshot = next;
    for (const listener of this._listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): SideQuestionSnapshot => this._snapshot;

  /** Test seam — settle a pending exchange, bypassing the connection. @internal */
  _ingestForTest(payload: unknown): void {
    const parsed = parseSideQuestionAnswerPayload(payload);
    if (parsed === null) {
      throw new Error("SideQuestionStore._ingestForTest: malformed payload");
    }
    this._settle(parsed);
  }

  dispose(): void {
    if (this._unsubscribeFeed) {
      this._unsubscribeFeed();
      this._unsubscribeFeed = null;
    }
    this._listeners.clear();
  }
}
