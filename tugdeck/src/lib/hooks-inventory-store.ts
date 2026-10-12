/**
 * HooksInventoryStore — single-shot `/hooks` request/response over the
 * CODE_INPUT / CODE_OUTPUT frames ([#step-12c]).
 *
 * `/hooks` is a read-only view of the hook configuration in Claude Code's
 * `settings.json` files. The sheet asks for it once on open (and on refresh);
 * tugcode reads the user / project / local settings and answers with a single
 * `hooks_inventory` frame. This store sends a `hooks_query` CODE_INPUT
 * (stamped with the card's `tug_session_id`) and resolves the response whose
 * `request_id` matches — mirroring `/diff`'s `GitDiffStore` and `/skills`'s
 * `SkillsInventoryStore`. Request/response keeps the listing fresh (settings
 * edits show on the next open) with no persistence.
 *
 * Also home to the read-only **event catalog** + the pure projection
 * ({@link selectHookEventRows}, {@link countHooks}) so the accordion mapping
 * is unit-testable without React or a live connection.
 *
 * @module lib/hooks-inventory-store
 */

import { Subscribable } from "./subscribable";
import type { FeedSnapshotSource } from "./feed-store";
import type { FeedIdValue } from "../protocol";
import { FeedId } from "../protocol";
import { getConnection } from "./connection-singleton";

// ── Wire types (mirror tugcode `HooksInventory`) ────────────────────────────

/** One hook command under a matcher group. */
export interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
}

/** A matcher group under a hook event — a tool-name matcher + its commands. */
export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommand[];
}

/** A single-shot `/hooks` payload from tugcode (CODE_OUTPUT frame). */
export interface HooksInventoryPayload {
  request_id: string;
  /** Event name → its matcher groups (concatenated across settings scopes). */
  events: Record<string, HookMatcherGroup[]>;
}

/** Lifecycle of the current/last `/hooks` request. */
export type HooksInventoryPhase = "idle" | "loading" | "ready" | "error";

/** Reactive snapshot the sheet renders via `useSyncExternalStore`. */
export interface HooksInventorySnapshot {
  phase: HooksInventoryPhase;
  requestId: string | null;
  payload: HooksInventoryPayload | null;
  error: string | null;
}

const EMPTY_SNAPSHOT: HooksInventorySnapshot = {
  phase: "idle",
  requestId: null,
  payload: null,
  error: null,
};

// ── Event catalog (the known hook events + descriptions) ─────────────────────

/** One known hook event — name + a one-line description for the trigger row. */
export interface HookEventInfo {
  name: string;
  description: string;
}

/**
 * The hook events `/hooks` always lists (in this order), with descriptions —
 * mirroring Claude Code's `/hooks`. A static catalog (these aren't on the
 * wire); update here if Claude Code's event set changes. Events configured in
 * `settings.json` but absent from this catalog are still shown, appended after.
 */
export const HOOK_EVENT_CATALOG: readonly HookEventInfo[] = [
  { name: "PreToolUse", description: "Before tool execution" },
  { name: "PostToolUse", description: "After tool execution" },
  { name: "PostToolUseFailure", description: "After tool execution fails" },
  { name: "PostToolBatch", description: "After a batch of tool calls resolves" },
  { name: "PermissionDenied", description: "After auto mode classifier denies a tool call" },
  { name: "UserPromptSubmit", description: "When you submit a prompt" },
  { name: "Notification", description: "When Claude Code sends a notification" },
  { name: "Stop", description: "When the main agent finishes responding" },
  { name: "SubagentStop", description: "When a subagent finishes responding" },
  { name: "PreCompact", description: "Before a context compaction" },
  { name: "SessionStart", description: "When a session starts or resumes" },
  { name: "SessionEnd", description: "When a session ends" },
];

// ── Pure projection (unit-tested) ────────────────────────────────────────────

/** One accordion row — a hook event with its configured groups + count. */
export interface HookEventRow {
  name: string;
  description: string;
  /** Total hook commands across the event's matcher groups. */
  count: number;
  groups: HookMatcherGroup[];
}

/** Total hook commands across the event's matcher groups. */
function countEventHooks(groups: HookMatcherGroup[]): number {
  return groups.reduce((sum, g) => sum + g.hooks.length, 0);
}

/**
 * The accordion rows: every catalog event (in catalog order) with its
 * configured groups + count, followed by any configured events not in the
 * catalog (sorted by name) so nothing the user set up is hidden.
 */
export function selectHookEventRows(
  events: Record<string, HookMatcherGroup[]>,
): HookEventRow[] {
  const catalogNames = new Set(HOOK_EVENT_CATALOG.map((e) => e.name));
  const rows: HookEventRow[] = HOOK_EVENT_CATALOG.map((e) => {
    const groups = events[e.name] ?? [];
    return { name: e.name, description: e.description, count: countEventHooks(groups), groups };
  });
  const extras = Object.keys(events)
    .filter((name) => !catalogNames.has(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      description: "",
      count: countEventHooks(events[name]),
      groups: events[name],
    }));
  return [...rows, ...extras];
}

/** Total configured hook commands across all events — the header count. */
export function countHooks(events: Record<string, HookMatcherGroup[]>): number {
  return Object.values(events).reduce((sum, g) => sum + countEventHooks(g), 0);
}

/** The header summary line — "N hooks configured" (pluralized). */
export function hooksSummaryLine(total: number): string {
  return `${total} ${total === 1 ? "hook" : "hooks"} configured`;
}

/** Parse a CODE_OUTPUT `hooks_inventory` payload into a payload, or `null`. */
export function parseHooksInventoryPayload(
  payload: unknown,
): HooksInventoryPayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== "hooks_inventory") return null;
  if (typeof p.request_id !== "string") return null;
  const rawEvents =
    typeof p.events === "object" && p.events !== null && !Array.isArray(p.events)
      ? (p.events as Record<string, unknown>)
      : {};
  const events: Record<string, HookMatcherGroup[]> = {};
  for (const [event, groups] of Object.entries(rawEvents)) {
    if (!Array.isArray(groups)) continue;
    const parsed: HookMatcherGroup[] = [];
    for (const rawGroup of groups) {
      if (rawGroup === null || typeof rawGroup !== "object") continue;
      const g = rawGroup as Record<string, unknown>;
      if (!Array.isArray(g.hooks)) continue;
      const hooks: HookCommand[] = [];
      for (const rawCmd of g.hooks) {
        if (rawCmd === null || typeof rawCmd !== "object") continue;
        const c = rawCmd as Record<string, unknown>;
        if (typeof c.type !== "string") continue;
        const cmd: HookCommand = { type: c.type };
        if (typeof c.command === "string") cmd.command = c.command;
        if (typeof c.timeout === "number") cmd.timeout = c.timeout;
        hooks.push(cmd);
      }
      const group: HookMatcherGroup = { hooks };
      if (typeof g.matcher === "string") group.matcher = g.matcher;
      parsed.push(group);
    }
    events[event] = parsed;
  }
  return { request_id: p.request_id, events };
}

// ── HooksInventoryStore ──────────────────────────────────────────────────────

export class HooksInventoryStore extends Subscribable {
  private _snapshot: HooksInventorySnapshot = EMPTY_SNAPSHOT;
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
  }

  private _onFeedUpdate(): void {
    const payload = this._feedStore.getSnapshot().get(this._feedId);
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;
    const parsed = parseHooksInventoryPayload(payload);
    if (parsed === null) return;
    if (parsed.request_id !== this._snapshot.requestId) return;
    this._set({ phase: "ready", requestId: parsed.request_id, payload: parsed, error: null });
  }

  /** Fire a fresh `/hooks` request for this card's session. */
  requestHooks(): void {
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
    const requestId = `hk-${this._seq}`;
    this._set({ phase: "loading", requestId, payload: null, error: null });
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        tug_session_id: this._tugSessionId,
        type: "hooks_query",
        request_id: requestId,
      }),
    );
    conn.send(FeedId.CODE_INPUT, bytes);
  }

  private _set(next: HooksInventorySnapshot): void {
    this._snapshot = next;
    this.notify();
  }

  getSnapshot = (): HooksInventorySnapshot => this._snapshot;

  /** Test seam — resolve to `ready` with `payload`, bypassing the connection. @internal */
  _ingestForTest(payload: unknown): void {
    const parsed = parseHooksInventoryPayload(payload);
    if (parsed === null) {
      throw new Error("HooksInventoryStore._ingestForTest: malformed payload");
    }
    this._set({ phase: "ready", requestId: parsed.request_id, payload: parsed, error: null });
  }

  dispose(): void {
    if (this._unsubscribeFeed) {
      this._unsubscribeFeed();
      this._unsubscribeFeed = null;
    }
    this.clearListeners();
  }
}
