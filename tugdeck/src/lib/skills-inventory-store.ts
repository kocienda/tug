/**
 * SkillsInventoryStore — single-shot `/skills` request/response over the
 * CODE_INPUT / CODE_OUTPUT frames ([#step-12d]).
 *
 * `/skills` is a one-shot, not a continuous feed: the sheet asks for the
 * project's plugin + user skill listing once (and again on an explicit
 * refresh), and tugcode answers with a single `skills_inventory` frame.
 * This store sends a `skills_inventory_query` CODE_INPUT carrying a
 * correlating `requestId` (stamped with the card's `tug_session_id` so
 * tugcast routes it to the right tugcode), and resolves the response whose
 * `request_id` matches the in-flight request. A request/response (rather than
 * a session-init push) keeps the listing fresh across a card rebind / HMR
 * reload with no ledger persistence — mirroring `/diff`'s `GitDiffStore`.
 *
 * Its source is the session mirror's routed store for `skills_inventory`: the
 * ingest host routes this session's frames of that type there, so the
 * high-traffic CODE_OUTPUT stream only wakes this store on the one frame it
 * cares about; `requestId` disambiguates rapid refreshes.
 *
 * Pure presentation helpers (`skillSourceLabel`, `formatSkillTokens`,
 * `skillLockLabel`, `skillsSummaryLine`) live here so the listing mapping is
 * unit-testable without React or a live connection.
 *
 * @module lib/skills-inventory-store
 */

import { Subscribable } from "./subscribable";
import type { FeedSnapshotSource } from "./feed-store";
import type { FeedIdValue } from "../protocol";
import { FeedId } from "../protocol";
import { getConnection } from "./connection-singleton";

// ── Wire types (mirror tugcode `SkillsInventory`) ───────────────────────────

/** One skill in the `/skills` inventory (a plugin or user skill). */
export interface SkillInventoryEntry {
  /** Display name — `<plugin>:<name>` for plugin skills, bare for user skills. */
  name: string;
  /** One-line description from the SKILL.md frontmatter; `""` when absent. */
  description: string;
  /** Originating plugin name, or `"user"` for `~/.claude/skills`. */
  source: string;
  /** Plugin skills are author-locked ("managed via /plugin"); user skills are not. */
  locked: boolean;
  /** Frontmatter token estimate — the per-skill cost loaded into the prompt. */
  tokens: number;
}

/** A single-shot `/skills` payload from tugcode (CODE_OUTPUT frame). */
export interface SkillsInventoryPayload {
  request_id: string;
  skills: SkillInventoryEntry[];
}

/** Lifecycle of the current/last `/skills` request. */
export type SkillsInventoryPhase = "idle" | "loading" | "ready" | "error";

/** Reactive snapshot the sheet renders via `useSyncExternalStore`. */
export interface SkillsInventorySnapshot {
  phase: SkillsInventoryPhase;
  /** Correlation id of the in-flight (or last) request; `null` before any. */
  requestId: string | null;
  /** The resolved payload when `phase === "ready"`. */
  payload: SkillsInventoryPayload | null;
  /** Human-readable error when `phase === "error"`. */
  error: string | null;
}

const EMPTY_SNAPSHOT: SkillsInventorySnapshot = {
  phase: "idle",
  requestId: null,
  payload: null,
  error: null,
};

// ── Pure presentation helpers (unit-tested) ─────────────────────────────────

/**
 * Human label for a skill's origin: `Plugin <name>` for a plugin skill,
 * `User` for a personal `~/.claude/skills` skill.
 */
export function skillSourceLabel(entry: SkillInventoryEntry): string {
  return entry.source === "user" ? "User" : `Plugin ${entry.source}`;
}

/** Format a token estimate as `~90 tok`, matching Claude Code's `/skills`. */
export function formatSkillTokens(tokens: number): string {
  return `~${tokens} tok`;
}

/**
 * Lock annotation for a skill, or `null` when it carries none. Plugin skills
 * are author-locked (edited via `/plugin`), so they read "locked by author";
 * user skills are editable and show nothing.
 */
export function skillLockLabel(entry: SkillInventoryEntry): string | null {
  return entry.locked ? "locked by author" : null;
}

/** The summary line for the sheet header — "6 skills" / "1 skill". */
export function skillsSummaryLine(count: number): string {
  return `${count} ${count === 1 ? "skill" : "skills"}`;
}

/** Parse a CODE_OUTPUT `skills_inventory` payload into a payload, or `null`. */
export function parseSkillsInventoryPayload(
  payload: unknown,
): SkillsInventoryPayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== "skills_inventory") return null;
  if (typeof p.request_id !== "string") return null;
  if (!Array.isArray(p.skills)) return null;
  const skills: SkillInventoryEntry[] = [];
  for (const raw of p.skills) {
    if (raw === null || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.name !== "string") continue;
    skills.push({
      name: s.name,
      description: typeof s.description === "string" ? s.description : "",
      source: typeof s.source === "string" ? s.source : "user",
      locked: s.locked === true,
      tokens: typeof s.tokens === "number" ? s.tokens : 0,
    });
  }
  return { request_id: p.request_id, skills };
}

// ── SkillsInventoryStore ─────────────────────────────────────────────────────

export class SkillsInventoryStore extends Subscribable {
  private _snapshot: SkillsInventorySnapshot = EMPTY_SNAPSHOT;
  private _unsubscribeFeed: (() => void) | null = null;
  private _lastPayloadRef: unknown = undefined;
  private readonly _feedStore: FeedSnapshotSource;
  private readonly _feedId: FeedIdValue;
  private readonly _tugSessionId: string;
  private _seq = 0;

  constructor(feedStore: FeedSnapshotSource, feedId: FeedIdValue, tugSessionId: string) {
    super();
    this._feedStore = feedStore;
    this._feedId = feedId;
    this._tugSessionId = tugSessionId;
    this._unsubscribeFeed = feedStore.subscribe(() => this._onFeedUpdate());
    // No initial check: a `skills_inventory` response only matters once we've
    // sent a request (`requestId` is null until then, so nothing matches).
  }

  private _onFeedUpdate(): void {
    const payload = this._feedStore.getSnapshot().get(this._feedId);
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;

    const parsed = parseSkillsInventoryPayload(payload);
    if (parsed === null) return;
    // Accept only the response correlated to the in-flight request.
    if (parsed.request_id !== this._snapshot.requestId) return;

    this._set({
      phase: "ready",
      requestId: parsed.request_id,
      payload: parsed,
      error: null,
    });
  }

  /**
   * Fire a fresh `/skills` request for this card's session. Moves the store
   * to `loading` under a new `requestId`; the matching `skills_inventory`
   * response resolves it to `ready`. Re-callable for a refresh control.
   */
  requestInventory(): void {
    const conn = getConnection();
    if (!conn) {
      this._set({
        phase: "error",
        requestId: null,
        payload: null,
        error: "Lost the connection to tugcast.",
      });
      return;
    }
    this._seq += 1;
    const requestId = `si-${this._seq}`;
    this._set({ phase: "loading", requestId, payload: null, error: null });
    // CODE_INPUT carries `tug_session_id` so tugcast routes it to this card's
    // tugcode (the same envelope `encodeCodeInputPayload` produces).
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        tug_session_id: this._tugSessionId,
        type: "skills_inventory_query",
        request_id: requestId,
      }),
    );
    conn.send(FeedId.CODE_INPUT, bytes);
  }

  private _set(next: SkillsInventorySnapshot): void {
    this._snapshot = next;
    this.notify();
  }

  getSnapshot = (): SkillsInventorySnapshot => this._snapshot;

  /**
   * Test seam — set the store to `ready` with `payload` directly, as if a
   * matching `skills_inventory` response had landed, bypassing the connection
   * and the request_id gate. Mirrors `GitDiffStore._ingestForTest`. @internal
   */
  _ingestForTest(payload: unknown): void {
    const parsed = parseSkillsInventoryPayload(payload);
    if (parsed === null) {
      throw new Error("SkillsInventoryStore._ingestForTest: malformed payload");
    }
    this._set({
      phase: "ready",
      requestId: parsed.request_id,
      payload: parsed,
      error: null,
    });
  }

  dispose(): void {
    if (this._unsubscribeFeed) {
      this._unsubscribeFeed();
      this._unsubscribeFeed = null;
    }
    this.clearListeners();
  }
}
