/**
 * Tugcast Binary Protocol v1
 *
 * Wire format per frame:
 * ```
 * [1 byte FeedId][1 byte flags][4 bytes payload length (BE u32)][payload]
 * ```
 *
 * - FeedId: open u8 namespace — known feeds have named constants,
 *   unknown values pass through without error (opaque routing).
 * - Flags: bit 0 = frame kind (0 = data, 1 = control/meta).
 *   Bits 1–7 are reserved; receivers ignore unknown flags.
 * - Length: big-endian u32, max MAX_PAYLOAD_SIZE.
 */

import type { InboundMessage, ReplayWindow } from "@tugproto/inbound";

/** Feed identifiers for different data streams (open u8 namespace) */
export const FeedId = {
  // Terminal
  TERMINAL_OUTPUT: 0x00,
  TERMINAL_INPUT: 0x01,
  TERMINAL_RESIZE: 0x02,
  // Snapshot feeds
  FILESYSTEM: 0x10,
  FILETREE: 0x11,
  FILETREE_QUERY: 0x12,
  GIT: 0x20,
  GIT_DIFF: 0x21,
  GIT_DIFF_QUERY: 0x22,
  CHANGESET: 0x23,
  CHANGESET_ALL: 0x24,
  GIT_LOG: 0x25,
  GIT_LOG_QUERY: 0x26,
  GIT_HEAD: 0x27,
  GIT_COMMIT_FILES: 0x28,
  GIT_COMMIT_FILES_QUERY: 0x29,
  // Stats (retired): the quartet's feeds were removed when the 1 Hz
  // unconditional push to every client was retired. The constants stay
  // reserved — never reuse 0x30-0x33 for another feed.
  STATS: 0x30,
  STATS_PROCESS_INFO: 0x31,
  STATS_TOKEN_USAGE: 0x32,
  STATS_BUILD_STATUS: 0x33,
  // Code (Claude Code bridge)
  CODE_OUTPUT: 0x40,
  CODE_INPUT: 0x41,
  // Per-session activity feed (binned channel samples)
  ACTIVITY: 0x42,
  // Defaults / Session
  DEFAULTS: 0x50,
  SESSION_SIDEBAND: 0x51,
  SESSION_STATE: 0x52,
  // Shell (reserved for Phase T2+)
  SHELL_OUTPUT: 0x60,
  SHELL_INPUT: 0x61,
  // Refs (the /match and /search file-reference commands: streamed result
  // rows down, search requests up)
  REFS_OUTPUT: 0x62,
  REFS_INPUT: 0x63,
  // Overview (app-wide narration channel: Observer/Operator/user posts down,
  // the card's questions up)
  OVERVIEW: 0x70,
  OVERVIEW_INPUT: 0x71,
  // Digest (the per-session beat: what a session is doing now)
  DIGEST: 0x80,
  // Usage (subscription usage panel: `claude -p "/usage"` response + request)
  USAGE: 0x90,
  USAGE_QUERY: 0x91,
  // Jots (reusable prompt fragments: whole-document push)
  JOTS: 0xa0,
  // Tripwires (the whole roster, republished on change)
  TRIPWIRES: 0xb0,
  // Router-internal
  CONTROL: 0xc0,
  HEARTBEAT: 0xff,
} as const;

export type FeedIdValue = (typeof FeedId)[keyof typeof FeedId];

/**
 * Legacy numeric alias for `FeedId.SESSION_STATE`. Duplicates the entry
 * in [`FeedId`] and exists only to satisfy the plan's requirement for a
 * named top-level protocol constant. Prefer `FeedId.SESSION_STATE` in new
 * code.
 */
export const FEED_ID_SESSION_STATE = FeedId.SESSION_STATE;

/** CONTROL action names routed to `AgentSupervisor::handle_control`. */
export const CONTROL_ACTION_SPAWN_SESSION = "spawn_session";
export const CONTROL_ACTION_CLOSE_SESSION = "close_session";
export const CONTROL_ACTION_RESET_SESSION = "reset_session";
export const CONTROL_ACTION_LIST_SESSIONS = "list_sessions";
export const CONTROL_ACTION_LIST_CARD_BINDINGS = "list_card_bindings";
export const CONTROL_ACTION_RESOLVE_SESSIONS = "resolve_sessions";
export const CONTROL_ACTION_TRASH_SESSION = "trash_session";
export const CONTROL_ACTION_RENAME_SESSION = "rename_session";
export const CONTROL_ACTION_SET_SESSION_PRIVATE = "set_session_private";
export const CONTROL_ACTION_TRASH_PROJECT_DIR_SESSIONS = "trash_project_dir_sessions";
export const CONTROL_ACTION_REQUEST_REPLAY = "request_replay";
/**
 * Default cold-resume window in **turns** — the canonical unit
 * (`tuglaws/turn-metric.md`). A turn is one committed response cycle, so
 * this bounds the load by intent rather than row density: a session with
 * ≤ N committed turns loads whole and shows no "load previous" affordance.
 * Tunable in one place.
 */
export const DEFAULT_REPLAY_WINDOW_TURNS = 25;
export const CONTROL_ACTION_RECORD_TURN_TELEMETRY = "record_turn_telemetry";
export const CONTROL_ACTION_RECORD_CONTEXT_BREAKDOWN = "record_context_breakdown";
export const CONTROL_ACTION_RECORD_SESSION_STATE_CHANGE =
  "record_session_state_change";
export const CONTROL_ACTION_LIST_SESSION_STATE_CHANGES =
  "list_session_state_changes";

/**
 * Wire shape for one row of the tugcast-side session ledger.
 * Mirrors `tugrust/crates/tugcast/src/session_ledger.rs::SessionRow` —
 * keep the fields in lockstep when the schema evolves.
 *
 * `card_id` is the card this session is bound to. Set on
 * `record_spawn` and preserved across `mark_closed` / `mark_failed`,
 * so the persisted row keeps the binding for client-side restore.
 */
export interface SessionRow {
  session_id: string;
  /**
   * The line of work this row is a **segment** of — the identity that owns the
   * callsign and the user's name ([P01]). A card that has rotated through
   * eight claude ids has eight `session_id`s and one `line_id`, so every
   * identity cache in the deck is keyed by this rather than by `session_id`.
   * Empty string on a row from an older tugcast that predates the model. Keep
   * in lockstep with the Rust `SessionRow.line_id`.
   */
  line_id: string;
  workspace_key: string;
  project_dir: string;
  created_at: number;
  last_used_at: number;
  turn_count: number;
  last_user_prompt: string | null;
  state: "live" | "closed" | "failed";
  card_id: string | null;
  /**
   * Whether `card_id` names a **background owner** rather than a deck card —
   * a tripwire's work tier, or whatever background spawner comes after it.
   * Computed server-side at projection from `card_id`; never stored.
   *
   * It is the distinction adoption turns on: a live session held by a
   * background owner has no card a user could be raised to, so the deck may
   * offer to seat it on one instead of refusing the gesture. `false` for an
   * unbound session — that is a different fact and a different remedy —
   * and `false` for an older tugcast that omits the field. Keep in lockstep
   * with the Rust `SessionRow.background`.
   */
  background: boolean;
  /** Session title — the user's `/rename` choice or an auto `aiTitle`; `null`
   *  when untitled. See {@link SessionRow.name_user_set} to tell them apart. */
  name: string | null;
  /** `true` only when `name` was set by the user via `/rename`. The Z4B session
   *  chip shows the hash unless this is `true`; the chooser ignores it (it shows
   *  any title). Defaults to `false` for older tugcast that omits the field. */
  name_user_set: boolean;
  /** Mnemonic `adjective-noun` callsign, minted client-side "from the drop" and
   *  made permanent by tugcast (a collision rerolls a complete fresh pair —
   *  never a numeric suffix, and a callsign any session ever minted is spent
   *  forever); `null` on legacy rows until they are next resumed. Layered over
   *  the UUID and the `/rename` name (precedence: name → tag → truncated UUID).
   *  It belongs to the **line**, so it is stable for the whole life of the
   *  conversation: an id change writes another segment against the same line
   *  and the callsign never moves.
   *  Defaults to `null` for older tugcast that omits the field. Keep in lockstep
   *  with the Rust `SessionRow.tag`. */
  tag: string | null;
  /** The rolling generated description — a standing line saying what the
   *  session is about, composed on tugcast's Summarize lane. `null` until the
   *  first one is written. Independent of `name` — a renamed session keeps
   *  being described, because the name is the title and this is the line
   *  beneath it. Defaults to `null` for older tugcast. Keep in lockstep with
   *  the Rust `SessionRow.synopsis`. */
  synopsis: string | null;
  /**
   * Provenance of the row: `"tug"` rows come from the sqlite ledger
   * (sessions Tug spawned or adopted); `"external"` rows were
   * discovered on disk with no ledger row — typically sessions created
   * by the Claude Code terminal app. External rows synthesize
   * `state: "closed"` / `card_id: null` and adopt into the ledger
   * automatically on first resume.
   */
  origin: "tug" | "external";
  /**
   * Present iff a live process outside this tugcast (the Claude Code
   * terminal app, another Tug instance) currently holds the session,
   * per the `~/.claude/sessions` registry. Such rows are unresumable
   * and untrashable until that process exits.
   */
  terminal_live: TerminalLive | null;
  /**
   * On-disk JSONL size in bytes — the picker's and the masthead's size readout
   * (an orthogonal "how big" signal, deliberately *not* a message/turn proxy).
   * Carried on `list_sessions` rows and on **every** `session_updated` push,
   * both read from the same scan cache: a push that omitted it would blank the
   * readout, because the client replaces its cached row wholesale. `null` for a
   * session the scanner has never seen, and absent from an older tugcast.
   */
  file_size?: number | null;
  /**
   * Whether this session is out of the Overview: no facts recorded, no posts
   * written, excluded from the Operator's answers. Toggled by `/private`.
   *
   * It rides the row because privacy is a **resting** state — the atom's marker
   * has to survive a reload, which an ack alone cannot do. Defaults to `false`
   * for an older tugcast. Keep in lockstep with the Rust `SessionRow.private`.
   */
  private?: boolean;
}

/** Busy/idle detail of a terminal-live session. */
export interface TerminalLive {
  status: "busy" | "idle" | "unknown";
}

/**
 * Normalize a wire session row to the full `SessionRow` shape.
 * `origin` and `terminal_live` default (`"tug"` / `null`) when absent —
 * `session_updated` pushes are built from bare ledger rows and never
 * carry them, and an older tugcast won't send them on listings either.
 */
export function normalizeSessionRow(
  row: Omit<
    SessionRow,
    | "origin"
    | "terminal_live"
    | "name_user_set"
    | "tag"
    | "synopsis"
    | "line_id"
    | "background"
  > &
    Partial<
      Pick<
        SessionRow,
        | "origin"
        | "terminal_live"
        | "name_user_set"
        | "tag"
        | "synopsis"
        | "line_id"
        | "background"
      >
    >,
): SessionRow {
  return {
    ...row,
    origin: row.origin === "external" ? "external" : "tug",
    terminal_live: row.terminal_live ?? null,
    file_size: row.file_size ?? null,
    name_user_set: row.name_user_set ?? false,
    tag: row.tag ?? null,
    synopsis: row.synopsis ?? null,
    private: row.private ?? false,
    line_id: row.line_id ?? "",
    background: row.background ?? false,
  };
}

/**
 * Wire shape for one row of `list_card_bindings_ok`. Each row is a
 * persisted (card_id → project_dir) binding the client uses on
 * startup/reconnect to put a session card back into a usable state
 * without showing the picker.
 *
 * The mode-selection gate is `turn_count > 0 || is_alive`:
 *
 * - `turn_count > 0` — claude has a JSONL on disk. Restore fires
 *   `spawn_session(mode=resume, session_id, project_dir, card_id)`
 *   and the JSONL replay rehydrates the transcript.
 * - `turn_count === 0 && is_alive === true` — **in-flight first
 *   turn**. The user submitted, claude is mid-response (possibly
 *   blocked on a permission/question control_request), no turn has
 *   committed to JSONL yet, but the live subprocess holds the runtime
 *   state. Restore fires `mode=resume` so the client rejoins the same
 *   session and the in-flight snapshot path delivers the partial
 *   assistant text + pending control_request_forward.
 * - `turn_count === 0 && is_alive === false` — Start Fresh + quit.
 *   No JSONL on disk and no live subprocess; resume would fail. Fire
 *   `mode=new` with a fresh `session_id` but the same `project_dir`
 *   so the card opens to its bound project on relaunch.
 */
export interface CardBinding {
  card_id: string;
  session_id: string;
  /**
   * The line this card is bound to ([P01]). One binding per line, and
   * `session_id` beside it is the segment a restore should resume ([P06]) —
   * so a card that has lived through eight id changes arrives as one row, not
   * eight. Empty string from an older tugcast.
   */
  line_id?: string;
  project_dir: string;
  state: "live" | "closed";
  turn_count: number;
  /**
   * True iff the server's in-memory supervisor holds a `Spawning` or
   * `Live` subprocess entry for this `session_id` at response time.
   * Combined with `turn_count` to gate `mode=resume` vs `mode=new` —
   * see the docstring above for the truth table.
   *
   * Older server builds (before this signal was added) won't emit the
   * field; treat the absence as `false` so the resume gate stays
   * conservative when running against a stale server.
   */
  is_alive?: boolean;
  /**
   * True iff an on-disk JSONL transcript exists (size > 0) for this
   * `session_id` — the exact file a `mode=resume` spawn would target. This is
   * the reliable resume signal: unlike `turn_count` (the ledger's live
   * `record_turn` counter, which stays 0 when claude wrote the transcript
   * outside a live turn), it stats the real file. The resume gate keys on it
   * so a session with a transcript is never mis-routed to `mode=new` (whose
   * `--session-id` would collide and crash-loop the card to `errored`).
   *
   * Older server builds won't emit the field; treat the absence as `false`
   * (the `turn_count`/`is_alive` clauses still gate resume conservatively).
   */
  has_jsonl?: boolean;
  /** Session title (user `/rename` or auto `aiTitle`); seeds the chip on restore.
   *  `name_user_set` gates whether the chip shows it or falls back to the hash. */
  name?: string | null;
  /** `true` only when `name` was a user `/rename`. Absent on older tugcast →
   *  treated as `false`, so an auto title never seeds the chip as a rename. */
  name_user_set?: boolean;
  /** Mnemonic tag; seeds the chip on card rebind (parity with `name`). Absent on
   *  older tugcast → treated as `null`. Keep in lockstep with the Rust binding row. */
  tag?: string | null;
  /** The rolling generated description; seeds the description line on card
   *  rebind (parity with `name`). Absent on older tugcast → treated as `null`.
   *  Keep in lockstep with the Rust binding row. */
  synopsis?: string | null;
  /**
   * The arc this session is working on — its owner key, and the arc's short
   * name for display. Null when unbound, and also when the arc's branch no
   * longer exists (the server nulls a binding to an arc that has been joined
   * or released).
   *
   * **Decode only.** `session-restore.ts` writes no bindings: it matches these
   * rows to cards and re-spawns, and the resulting `spawn_session_ok` ack is
   * what populates `cardSessionBindingStore`. The store's single-writer
   * contract is what the clear-then-restore reconnect order depends on, so
   * these ride the row for completeness and reach the store the same way
   * `workspace_key` does.
   */
  arc_id?: string | null;
  arc_name?: string | null;
}

/** Frame flags */
export const FrameFlags = {
  /** Normal data frame */
  DATA: 0x00,
  /** Control/meta frame about this feed */
  CONTROL: 0x01,
} as const;

export type FrameFlagsValue = (typeof FrameFlags)[keyof typeof FrameFlags];

/** Kind bit mask */
const KIND_BIT = 0x01;

/** Frame header size in bytes (1 FeedId + 1 flags + 4 length) */
export const HEADER_SIZE = 6;

/** Maximum payload size in bytes (16 MB) */
export const MAX_PAYLOAD_SIZE = 16 * 1024 * 1024;

/** A WebSocket frame containing a feed ID, flags, and payload */
export interface Frame {
  feedId: FeedIdValue;
  flags: number;
  payload: Uint8Array;
}

/**
 * Encode a frame into wire format bytes
 *
 * Returns an ArrayBuffer ready for WebSocket transmission.
 */
export function encodeFrame(frame: Frame): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_SIZE + frame.payload.length);
  const view = new DataView(buffer);

  view.setUint8(0, frame.feedId);
  view.setUint8(1, frame.flags);
  view.setUint32(2, frame.payload.length, false);

  new Uint8Array(buffer, HEADER_SIZE).set(frame.payload);

  return buffer;
}

/**
 * Decode a frame from wire format bytes
 *
 * @throws Error if the frame is incomplete or invalid
 */
export function decodeFrame(data: ArrayBuffer): Frame {
  const view = new DataView(data);

  if (data.byteLength < HEADER_SIZE) {
    throw new Error(
      `incomplete frame: need ${HEADER_SIZE} bytes, have ${data.byteLength}`
    );
  }

  const feedId = view.getUint8(0) as FeedIdValue;
  const flags = view.getUint8(1);
  const length = view.getUint32(2, false);

  if (length > MAX_PAYLOAD_SIZE) {
    throw new Error(`payload too large: ${length} bytes`);
  }

  if (data.byteLength < HEADER_SIZE + length) {
    throw new Error(
      `incomplete frame: need ${HEADER_SIZE + length} bytes, have ${data.byteLength}`
    );
  }

  // View into original buffer, no copy
  const payload = new Uint8Array(data, HEADER_SIZE, length);

  return { feedId, flags, payload };
}

/** Returns true if the flags indicate a control/meta frame */
export function isControlFrame(flags: number): boolean {
  return (flags & KIND_BIT) !== 0;
}

/**
 * Create a heartbeat frame (empty payload)
 */
export function heartbeatFrame(): Frame {
  return { feedId: FeedId.HEARTBEAT, flags: FrameFlags.DATA, payload: new Uint8Array(0) };
}

/**
 * Create a terminal input frame
 */
export function inputFrame(data: Uint8Array): Frame {
  return { feedId: FeedId.TERMINAL_INPUT, flags: FrameFlags.DATA, payload: data };
}

/**
 * Create a terminal resize frame
 */
export function resizeFrame(cols: number, rows: number): Frame {
  const json = JSON.stringify({ cols, rows });
  return {
    feedId: FeedId.TERMINAL_RESIZE,
    flags: FrameFlags.DATA,
    payload: new TextEncoder().encode(json),
  };
}

/**
 * Create a code input frame from a message object.
 *
 * Injects `tug_session_id` as the first field of the JSON payload so the
 * tugcast router's CODE_INPUT dispatcher can parse it before consulting
 * the supervisor ledger. The server hard-rejects CODE_INPUT frames that
 * are missing `tug_session_id` (Step 7's `missing_tug_session_id`
 * control error), so passing a real session id is required.
 */
export function encodeCodeInput(msg: object, tugSessionId: string): ArrayBuffer {
  const json = JSON.stringify({ tug_session_id: tugSessionId, ...msg });
  const payload = new TextEncoder().encode(json);
  const frame: Frame = {
    feedId: FeedId.CODE_INPUT,
    flags: FrameFlags.DATA,
    payload,
  };
  return encodeFrame(frame);
}

/**
 * Anthropic content-block wire shape — the API-native form of one
 * message's body, as an ordered array of text + image blocks.
 *
 * Carried verbatim on the `user_message` IPC frame post-Step-5c.
 * Tugdeck's `buildWirePayload` emits interleaved blocks honoring the
 * original atom positions in the substrate; tugcode forwards the array
 * straight to the Anthropic SDK with no construction step.
 *
 * Per [Spec S01](arc/dev-atoms.md#s01-attachment-wire-type)
 * (retired wire-shape `Attachment`) and [Step 5c](arc/dev-atoms.md#step-5c).
 */
// Content-block wire shapes now live in the shared client→tugcode contract
// ([#step-13c1]); re-exported so tugdeck call sites keep importing them from
// `@/protocol`.
export type {
  ContentBlock,
  ContentBlockText,
  ContentBlockImage,
  ContentBlockImageSourceBase64,
} from "@tugproto/inbound";

/**
 * Subscription-quota status, mirroring tugcode's `RateLimitInfo`
 * (`tugcode/src/types.ts`) verbatim. Carried by {@link RateLimitEvent}
 * on the per-turn quota broadcast claude 2.1.x emits at the start of
 * every turn. The Z4B rate-limit chip reads this to surface "X until
 * reset" and to escalate when `status !== "allowed"`.
 */
export interface RateLimitInfo {
  /** `"allowed"`, `"warning"`, `"exceeded"`, etc. */
  status: string;
  /** Unix epoch **seconds** at which the current window resets. */
  resetsAt: number;
  /** `"five_hour"`, `"daily"`, etc. */
  rateLimitType: string;
  /** `"accepted"` or `"rejected"`. */
  overageStatus: string;
  /** Reason overage is disabled (`"org_level_disabled"`, etc.). May be absent. */
  overageDisabledReason?: string;
  /** Whether the current turn is consuming overage allotment. */
  isUsingOverage: boolean;
  /** Window utilization as a 0–1 fraction (CLI ≥ 2.1.17x; absent on
   *  older payloads). The usage bulletins key their % barriers on it. */
  utilization?: number;
}

/**
 * Server-to-client `rate_limit_event` frame, mirroring tugcode's
 * `RateLimitEvent`. Rides the SESSION_SIDEBAND feed (the tugcast
 * supervisor rewraps it off CODE_OUTPUT alongside `system_metadata` /
 * `session_capabilities`); the client store discriminates by `type`.
 */
export interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: RateLimitInfo;
  ipc_version: number;
}

/**
 * Client → tugcode CODE_INPUT message contract — authored once in
 * `@tugproto/inbound` ([#step-13c1]) and re-exported here; `encodeCodeInputPayload`
 * below types its `msg` against it. tugdeck only ever constructs the subset of
 * verbs it sends, but the union is the full receiver contract.
 */
export type { InboundMessage };

/**
 * Encode an InboundMessage as the raw JSON payload bytes (no frame header).
 * Paired with `TugConnection.send(FeedId.CODE_INPUT, payload)`, which wraps
 * the payload in a frame at the connection layer. Distinct from
 * `encodeCodeInput`, which returns a fully framed ArrayBuffer.
 */
export function encodeCodeInputPayload(
  msg: InboundMessage,
  tugSessionId: string,
): Uint8Array {
  const json = JSON.stringify({ tug_session_id: tugSessionId, ...msg });
  return new TextEncoder().encode(json);
}

/**
 * Inverse of `encodeCodeInputPayload` — used by test doubles to decode
 * outbound frame payloads into structured InboundMessage objects for
 * assertion. Not called from production code paths.
 */
export function decodeCodeInputPayload(
  payload: Uint8Array,
): InboundMessage & { tug_session_id: string } {
  const json = new TextDecoder().decode(payload);
  return JSON.parse(json) as InboundMessage & { tug_session_id: string };
}

/**
 * Create a control frame with a JSON action payload
 */
export function controlFrame(action: string, params?: Record<string, unknown>): Frame {
  const json = JSON.stringify({ action, ...params });
  return {
    feedId: FeedId.CONTROL,
    flags: FrameFlags.DATA,
    payload: new TextEncoder().encode(json),
  };
}

/**
 * Session-mode choice on spawn. Mirrors
 * `CardSessionBinding["sessionMode"]` — kept as a standalone type so the
 * wire encoder can import it without dragging the binding store in.
 */
export type SpawnSessionMode = "new" | "resume";

/**
 * Build a `spawn_session` CONTROL frame for the supervisor.
 *
 * Payload shape per (extended with `session_mode`):
 * ```json
 * {
 *   "action": "spawn_session",
 *   "card_id": "...",
 *   "tug_session_id": "...",
 *   "project_dir": "...",
 *   "session_mode": "new" | "resume"
 * }
 * ```
 *
 * `cardId`, `tugSessionId`, and `projectDir` are required; the server-side
 * supervisor hard-rejects CONTROL frames missing any of them via
 * `send_control_json` (`missing_card_id` / `missing_tug_session_id` /
 * `missing_project_dir` error details), so optional arguments on the client
 * side would only create silent failure modes.
 *
 * `sessionMode` defaults to `"new"` when omitted so callers without an
 * explicit choice get the fresh-by-default behavior. On the server both sides
 * also default to `"new"` when the wire field is absent.
 *
 * `projectDir` is the workspace path the tugcode subprocess will be given
 * as its cwd. The server canonicalizes it via `PathResolver::watch_path()`
 * and echoes the canonical form back in the `spawn_session_ok` CONTROL ack
 * as `workspace_key`. Per, tugdeck reads that ack field directly
 * into `cardSessionBindingStore` rather than attempting to canonicalize
 * client-side — JS path libraries don't match tugcast's firmlink handling,
 * so any client-side derivation would risk producing a string that does
 * not match the one spliced into FILETREE/FILESYSTEM/GIT frames.
 *
 * `permissionMode` is the deck-wide / per-card default permission mode the
 * caller resolved from the tugbank cache at spawn time. When present, it's
 * forwarded as `permission_mode` so tugcast can pass `--permission-mode` to
 * the tugcode subprocess and the spawned claude starts in the right mode from
 * its first instant (rather than tugcode's baseline default, which a
 * post-spawn `permission_mode` frame would otherwise have to correct at
 * runtime, racing the first turn). Omitted when the caller has no resolved
 * mode (a card with neither a per-card mode nor a configured default), and
 * absent on older clients — tugcast treats a missing field as "no override".
 *
 * `tag` is the provisional mnemonic the caller minted "from the drop". When
 * present it's forwarded as `tag`; tugcast stores it on the `LedgerEntry` and
 * claims (or suffixes) it authoritatively at `record_spawn`, echoing the final
 * value back on `session_updated`. Omitted when the caller minted none.
 *
 * `lineId` is the line of work this spawn seats the card on ([P03]). A fresh
 * spawn mints it here, from the drop, and the ledger births a line under that
 * exact id — which is what lets the callsign and the name minted alongside it
 * survive every later id change. A resume sends the line the binding already
 * names. The supervisor requires it for `mode=new`.
 */
export function encodeSpawnSession(
  cardId: string,
  tugSessionId: string,
  projectDir: string,
  sessionMode: SpawnSessionMode = "new",
  permissionMode?: string,
  tag?: string,
  lineId?: string,
): Frame {
  const payload: Record<string, string> = {
    card_id: cardId,
    tug_session_id: tugSessionId,
    project_dir: projectDir,
    session_mode: sessionMode,
  };
  if (permissionMode !== undefined) {
    payload.permission_mode = permissionMode;
  }
  if (tag !== undefined) {
    payload.tag = tag;
  }
  if (lineId !== undefined) {
    payload.line_id = lineId;
  }
  return controlFrame(CONTROL_ACTION_SPAWN_SESSION, payload);
}

/**
 * Build a `close_session` CONTROL frame for the supervisor.
 * See [`encodeSpawnSession`] for payload shape and rationale.
 */
export function encodeCloseSession(cardId: string, tugSessionId: string): Frame {
  return controlFrame(CONTROL_ACTION_CLOSE_SESSION, {
    card_id: cardId,
    tug_session_id: tugSessionId,
  });
}

/**
 * Build a `reset_session` CONTROL frame for the supervisor.
 * See [`encodeSpawnSession`] for payload shape and rationale.
 */
export function encodeResetSession(cardId: string, tugSessionId: string): Frame {
  return controlFrame(CONTROL_ACTION_RESET_SESSION, {
    card_id: cardId,
    tug_session_id: tugSessionId,
  });
}

/**
 * Build a `list_sessions` CONTROL request frame.
 *
 * The picker passes the user's typed path (the value originally recorded
 * at `record_spawn` time on the server). The supervisor matches against
 * the ledger's `project_dir` column — no client-side canonicalization is
 * needed. The response broadcasts `list_sessions_ok` carrying
 * `{ project_dir, sessions: SessionRow[] }` ordered by `last_used_at
 * DESC`. Errors broadcast `list_sessions_err { project_dir, reason }`.
 */
export function encodeListSessions(projectDir: string): Frame {
  return controlFrame(CONTROL_ACTION_LIST_SESSIONS, {
    project_dir: projectDir,
  });
}

/**
 * Build a `resolve_sessions` CONTROL request frame — "which of these sessions
 * does the ledger hold?" ([D132]).
 *
 * The read behind every citation chip. Each id is either a full session uuid
 * (from `Tug-Session-Id`, or a legacy one-line trailer) or the 8-char short id
 * a citation records, which the **server** expands against the whole ledger —
 * the client's caches only know the sessions this run happened to list, and
 * resolvability is a fact about the reference rather than about that.
 *
 * The response broadcasts `resolve_sessions_ok { sessions: [{ queried,
 * session }], unknown: string[] }`, keyed by the asked-for spelling because a
 * short id and the row's full id are different strings. `unknown` is the
 * negative answer, and it is load-bearing: it is what lets a caller cache a
 * miss rather than re-ask on every repaint.
 */
export function encodeResolveSessions(ids: readonly string[]): Frame {
  return controlFrame(CONTROL_ACTION_RESOLVE_SESSIONS, { ids });
}


/**
 * Build a `trash_session` CONTROL request frame.
 *
 * The supervisor deletes the matching ledger row, moves the session's
 * Claude Code JSONL to in-place trash (recoverable for 7 days),
 * broadcasts a `session_updated { removed: true }` push, and emits a
 * `trash_session_ok` (or `_err`) ack. Refused for `state="live"` rows —
 * the user must close the card first.
 */
export function encodeTrashSession(sessionId: string, projectDir?: string): Frame {
  return controlFrame(
    CONTROL_ACTION_TRASH_SESSION,
    projectDir !== undefined
      ? // `project_dir` lets the supervisor trash an external session
        // (no ledger row to look the directory up from). Harmless for
        // ledger rows — the row path never consults it.
        { session_id: sessionId, project_dir: projectDir }
      : { session_id: sessionId },
  );
}

/**
 * Rename a **line** ([P11]). An empty / whitespace-only `name` clears the name
 * (tugcast trims + treats blank as `None`). tugcast writes the line and
 * broadcasts `session_updated` so the chooser + Z4B chip pick it up.
 *
 * The address is the line's id, not a session's: the name is the
 * conversation's title, and a rename that landed on a segment would be lost
 * the next time the card's claude id changed. A name another line already
 * wears is TAKEN from it — the newest `/rename` wins, the previous holder
 * falls back to its callsign, and `rename_session_ok` carries a `displaced`
 * list naming the lines it was taken from, so the loss is announced rather
 * than silent.
 */
export function encodeRenameSession(lineId: string, name: string): Frame {
  return controlFrame(CONTROL_ACTION_RENAME_SESSION, {
    line_id: lineId,
    name,
  });
}

/**
 * Mark a session in or out of the Overview ([P05], [Q01]).
 *
 * From-now-on semantics: tugcast stops recording facts and writing posts for a
 * private session and excludes it from the Operator's reads; marking it public
 * again resumes from that moment, and nothing already written is scrubbed. The
 * ledger write broadcasts `session_updated` so the atom's marker shows the
 * resting state, and `set_session_private_ok` acks the transition.
 */
export function encodeSetSessionPrivate(sessionId: string, isPrivate: boolean): Frame {
  return controlFrame(CONTROL_ACTION_SET_SESSION_PRIVATE, {
    session_id: sessionId,
    private: isPrivate,
  });
}

/**
 * Build a `trash_project_dir_sessions` CONTROL request frame.
 *
 * Drops every non-live row whose `project_dir` matches the given path
 * and moves each row's JSONL to in-place trash. Used by the recents-
 * eviction → ledger-eviction coupling: when a dev recent-projects
 * entry ages out, the matching ledger rows go too. Emits one
 * `session_updated { removed: true }` per dropped row plus
 * `trash_project_dir_sessions_ok { project_dir, count }` on success.
 */
export function encodeTrashProjectDirSessions(projectDir: string): Frame {
  return controlFrame(CONTROL_ACTION_TRASH_PROJECT_DIR_SESSIONS, {
    project_dir: projectDir,
  });
}

/**
 * Build a `request_replay` CONTROL frame per [D12].
 *
 * The supervisor's handler looks up the live tugcode subprocess for the
 * given `tugSessionId` and forwards `{"type":"request_replay"}` to its
 * stdin. Tugcode's IPC loop runs `runReplay()` against the on-disk JSONL,
 * which streams `replay_started` / `add_user_message` / `assistant_text`
 * / `turn_complete` / `replay_complete` frames back through CODE_OUTPUT.
 *
 * Idempotent at three layers:
 *   1. Supervisor — no-op if the entry isn't `Live`.
 *   2. Tugcode — `runReplay`'s re-entrancy guard drops a request that
 *      arrives mid-replay; the in-flight bracket's events satisfy it.
 *   3. Reducer ([D04]) — `msg_id` dedupe means a redundant replay's
 *      `turn_complete` events fold into the same `TurnEntry` rather than
 *      duplicating transcript.
 *
 * Used by `cardServicesStore._construct` whenever a fresh
 * `CodeSessionStore` is built for an existing resume binding (HMR,
 * Maker > Reload, future card mounts). The fresh store has no
 * replay history of its own; this verb tells the supervisor "send me
 * the JSONL again so I can rehydrate."
 *
 * The optional `window` bounds the replay by recency — the default
 * cold-resume load sends `{ lastTurns: DEFAULT_REPLAY_WINDOW_TURNS }`
 * so a long session loads only its most relevant tail. The supervisor
 * forwards the window verbatim; tugcode reports the resulting slice on
 * `replay_complete`. Absent ⇒ the whole session (legacy).
 */
export function encodeRequestReplay(
  tugSessionId: string,
  window?: ReplayWindow,
): Frame {
  return controlFrame(CONTROL_ACTION_REQUEST_REPLAY, {
    tug_session_id: tugSessionId,
    ...(window !== undefined ? { window } : {}),
  });
}

/**
 * Build a `record_turn_telemetry` CONTROL frame.
 *
 * Tugdeck → tugcast: the reducer dispatches this from
 * `handleTurnComplete` (live path only — replayed turns are not
 * re-persisted) carrying the per-turn cost + multi-clock timing
 * block. The supervisor persists it to the sqlite SessionLedger so
 * the next resume can inline it back onto the replayed
 * `turn_complete` event. See plan `#step-20-3-3` / `#step-20-3-4`.
 *
 * Fire-and-forget at the wire level — no ack frame is broadcast.
 * The reducer doesn't wait on confirmation; the row's reason for
 * existing is to survive the next reload, not the next render.
 */
export function encodeRecordTurnTelemetry(input: {
  tugSessionId: string;
  msgId: string;
  telemetry: import("./lib/code-session-store/telemetry").TurnTelemetry;
  endedAt: number;
}): Frame {
  return controlFrame(CONTROL_ACTION_RECORD_TURN_TELEMETRY, {
    tug_session_id: input.tugSessionId,
    msg_id: input.msgId,
    telemetry: input.telemetry,
    ended_at: input.endedAt,
  });
}

/**
 * Build a `record_context_breakdown` CONTROL frame.
 *
 * Tugdeck → tugcast: the reducer dispatches this for every
 * `context_breakdown` event it consumes — both live frames from
 * tugcode and the bind-time attach the supervisor re-emits from the
 * persisted ledger row. The supervisor stores the payload verbatim
 * in the `context_breakdown_latest` table (UPSERT keyed by
 * `tug_session_id`); the next bind reads it back to seed the
 * popover before any new frame arrives.
 *
 * Fire-and-forget at the wire level — no ack frame is broadcast.
 * The popover's local snapshot is already current; persistence is
 * for the next reload, not the next render.
 */
export function encodeRecordContextBreakdown(input: {
  tugSessionId: string;
  payload: import("./lib/code-session-store/types").ContextBreakdownSnapshot;
  capturedAt: number;
}): Frame {
  return controlFrame(CONTROL_ACTION_RECORD_CONTEXT_BREAKDOWN, {
    tug_session_id: input.tugSessionId,
    payload: {
      context_max: input.payload.contextMax,
      categories: input.payload.categories,
    },
    captured_at: input.capturedAt,
  });
}

/**
 * One row of the `list_session_state_changes_ok` response — a single
 * indicator-tone triple transition persisted by the supervisor.
 * `at_ms` is the wall-clock millisecond when the triple landed on the
 * snapshot; the field order mirrors the writer's payload.
 *
 * Wire shape — keep in lockstep with
 * `tugrust/crates/tugcast/src/session_ledger.rs::SessionStateChangeRow`.
 */
export interface SessionStateChangeWireRow {
  at_ms: number;
  phase: import("./lib/code-session-store/types").CodeSessionPhase;
  transport_state: import("./lib/code-session-store/types").TransportState;
  interrupt_in_flight: boolean;
}

/**
 * Build a `record_session_state_change` CONTROL frame.
 *
 * Tugdeck → tugcast: the per-card `CodeSessionStore.dispatch` wrapper
 * compares prev/new triple after every reduce and emits this for every
 * change. The supervisor resolves `tug_session_id → claude_session_id`
 * and appends one row to `session_state_changes`. The SQL layer dedupes
 * against the most-recent persisted row as a race safety-net; the
 * client-side compare is the primary dedupe.
 *
 * Fire-and-forget at the wire level — no ack frame is broadcast.
 * Persistence is for the next reload (and the popover's history view),
 * not the next render.
 */
export function encodeRecordSessionStateChange(input: {
  tugSessionId: string;
  atMs: number;
  phase: import("./lib/code-session-store/types").CodeSessionPhase;
  transportState: import("./lib/code-session-store/types").TransportState;
  interruptInFlight: boolean;
}): Frame {
  return controlFrame(CONTROL_ACTION_RECORD_SESSION_STATE_CHANGE, {
    tug_session_id: input.tugSessionId,
    at_ms: input.atMs,
    phase: input.phase,
    transport_state: input.transportState,
    interrupt_in_flight: input.interruptInFlight,
  });
}

/**
 * Build a `list_session_state_changes` CONTROL request frame.
 *
 * Tugdeck → tugcast read: the popover reader (Step 20.4.9) asks the
 * supervisor for the persisted history for a given `tug_session_id`.
 * The response is `list_session_state_changes_ok { tug_session_id,
 * rows }`, oldest-first by insertion order. Unknown sessions surface
 * as an empty `rows` array, not an error frame — the client renders
 * the same "no history yet" UI for both.
 */
export function encodeListSessionStateChanges(tugSessionId: string): Frame {
  return controlFrame(CONTROL_ACTION_LIST_SESSION_STATE_CHANGES, {
    tug_session_id: tugSessionId,
  });
}

/**
 * Decoded `list_session_state_changes_ok` response payload. Correlated
 * to the request by `tug_session_id` (echoed verbatim from the request).
 */
export interface ListSessionStateChangesOk {
  tug_session_id: string;
  rows: SessionStateChangeWireRow[];
}

/**
 * Who wrote a Overview post. An unrecognized spelling is a parse failure at
 * the edge rather than a row rendered in the wrong voice.
 */
export type OverviewAuthor = "observer" | "operator" | "user" | "tripwire";

const OVERVIEW_AUTHORS: readonly string[] = [
  "observer",
  "operator",
  "user",
  "tripwire",
];

/**
 * What a ref chip points at. Each kind has its own chip action, so a kind
 * with no action to offer is dropped at parse instead of rendered inert.
 */
export type OverviewRefKind =
  | "session"
  | "file"
  | "commit"
  | "plan"
  | "brief"
  | "arc"
  // Read for life ([F19]): `overview_posts.refs` is stored JSON, so every ref
  // written before the word moved spells this. Nothing writes it any more.
  | "dash";

const OVERVIEW_REF_KINDS: readonly string[] = [
  "session",
  "file",
  "commit",
  "plan",
  "brief",
  "arc",
  "dash",
];

/** One clickable provenance chip on a post. */
export interface OverviewRef {
  kind: OverviewRefKind;
  target: string;
}

/**
 * One Overview post as it travels on `FeedId.OVERVIEW` and as the
 * `list_overview_posts_ok` tail returns it — the same shape on both wires,
 * so one parse serves both.
 *
 * `id` is the ledger rowid, absent on a transient post (broadcast so the
 * card can stop waiting, never written, because an infrastructure hiccup
 * is not history). `request_id` appears only on an Operator post answering
 * a specific question.
 */
/**
 * One image a user attached to a question, as the post carries it: an
 * absolute path tugcast wrote the bytes to, plus the media type they were
 * decoded as.
 *
 * The bytes do not ride the wire twice. They went up once with the question
 * and came to rest beside the ledger; the card reads them back through
 * `/api/fs/blob`, the same route the viewer cards stream a file with.
 */
export interface OverviewAttachmentWire {
  path: string;
  media_type: string;
}

export interface OverviewPostWire {
  id?: number;
  at_ms: number;
  author: OverviewAuthor;
  session_id?: string;
  wake_reason?: string;
  body: string;
  refs: OverviewRef[];
  /** How long the agent turn that wrote the post took; absent on a user
   *  question and on rows written before tugcast recorded it. */
  elapsed_ms?: number;
  /** The project directory the post's refs and prose paths are spelled
   *  relative to — the narrated session's, or the Operator's default repo. A
   *  user question carries it too (it is the root the card's annotator
   *  resolves a typed path against); absent only on rows written before
   *  tugcast recorded it, whose refs render inert rather than resolve against
   *  a guessed root. */
  project_dir?: string;
  /** Images composed with a user's question. Absent on every other post. */
  attachments?: OverviewAttachmentWire[];
  request_id?: string;
  transient: boolean;
}

/** Decoded `list_overview_posts_ok` response payload (app-scoped). */
export interface ListOverviewPostsOk {
  posts: OverviewPostWire[];
  /** Whether history continues past the oldest post in `posts`. */
  has_more?: boolean;
  /**
   * The request's own `before_id`, echoed verbatim — absent for a tail.
   *
   * This response is a CONTROL **broadcast** with no request correlation of
   * its own, which cost nothing while the only read was an idempotent tail.
   * A page is not idempotent: applied twice it prepends twice. So the echo
   * is how a client tells a tail from a page, and its own page from anyone
   * else's — see `OverviewStore`'s `pendingBefore`.
   */
  before_id?: number;
}

/**
 * Request a page of Overview history. App-scoped — no session id.
 *
 * No `beforeId` is the TAIL: the newest posts, which is what the store asks
 * for on mount and after a reconnect. A `beforeId` is the page immediately
 * older than that ledger rowid — keyset rather than offset, because posts
 * keep arriving while a reader pages backwards and an offset would slide
 * under them. `limit` defaults server-side to the standard tail length.
 *
 * The response is `list_overview_posts_ok { posts, has_more, before_id }`,
 * posts oldest-first within the page.
 */
export function encodeListOverviewPosts(opts?: {
  beforeId?: number;
  limit?: number;
}): Frame {
  const params: Record<string, number> = {};
  if (opts?.beforeId !== undefined) params.before_id = opts.beforeId;
  if (opts?.limit !== undefined) params.limit = opts.limit;
  return controlFrame("list_overview_posts", params);
}

/**
 * A question for the Operator, on `OVERVIEW_INPUT`. `requestId` correlates the
 * answer: tugcast echoes it on the answer post (and on a transient failure
 * post), which is how the card knows which pending row to clear. App-scoped —
 * a question is asked of the channel, not of a session.
 */
/**
 * One image going UP with a question — the composer's already-downsampled
 * bytes, base64, plus the media type the downsample produced. The pair an
 * Anthropic image block takes, so nothing between here and the model
 * re-encodes it.
 */
export interface OverviewInputAttachment {
  mediaType: string;
  /** Base64, no `data:` prefix. */
  data: string;
}

export function encodeOverviewInput(
  body: string,
  requestId: string,
  attachments: readonly OverviewInputAttachment[] = [],
  refs: readonly OverviewRef[] = [],
): Frame {
  // Both optional arrays are omitted rather than sent empty, so the frame a
  // question typed without a picture and without an `@` atom produces stays
  // byte-identical to what it was before either existed.
  const payload: Record<string, unknown> = { body, requestId };
  if (attachments.length > 0) payload.attachments = attachments;
  if (refs.length > 0) payload.refs = refs;
  return {
    feedId: FeedId.OVERVIEW_INPUT,
    flags: FrameFlags.DATA,
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  };
}

/**
 * Decode one post from an already-parsed JSON value; null on a shape the
 * card cannot render. Refs with an unknown kind are dropped individually —
 * a chip nobody can act on is worse than no chip — but the post itself
 * survives, since its body is the news.
 */
export function parseOverviewPost(value: unknown): OverviewPostWire | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.body !== "string") return null;
  if (typeof p.author !== "string" || !OVERVIEW_AUTHORS.includes(p.author)) {
    return null;
  }
  // An attachment the card cannot point at is no attachment: a tile whose
  // `src` is a relative path or an empty media type paints a broken image
  // where a picture was promised, so a malformed entry is dropped and the
  // rest of the post still renders.
  const attachments: OverviewAttachmentWire[] = Array.isArray(p.attachments)
    ? p.attachments.flatMap((raw): OverviewAttachmentWire[] => {
        if (typeof raw !== "object" || raw === null) return [];
        const a = raw as Record<string, unknown>;
        if (typeof a.path !== "string" || !a.path.startsWith("/")) return [];
        if (typeof a.media_type !== "string" || a.media_type.length === 0) {
          return [];
        }
        return [{ path: a.path, media_type: a.media_type }];
      })
    : [];
  const refs: OverviewRef[] = Array.isArray(p.refs)
    ? p.refs.flatMap((raw): OverviewRef[] => {
        if (typeof raw !== "object" || raw === null) return [];
        const r = raw as Record<string, unknown>;
        if (typeof r.kind !== "string" || !OVERVIEW_REF_KINDS.includes(r.kind)) {
          return [];
        }
        if (typeof r.target !== "string" || r.target.length === 0) return [];
        return [{ kind: r.kind as OverviewRefKind, target: r.target }];
      })
    : [];
  return {
    ...(typeof p.id === "number" ? { id: p.id } : {}),
    at_ms: typeof p.at_ms === "number" ? p.at_ms : 0,
    author: p.author as OverviewAuthor,
    ...(typeof p.session_id === "string" ? { session_id: p.session_id } : {}),
    ...(typeof p.wake_reason === "string"
      ? { wake_reason: p.wake_reason }
      : {}),
    body: p.body,
    refs,
    ...(typeof p.elapsed_ms === "number" && p.elapsed_ms >= 0
      ? { elapsed_ms: p.elapsed_ms }
      : {}),
    ...(typeof p.project_dir === "string" && p.project_dir.startsWith("/")
      ? { project_dir: p.project_dir }
      : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(typeof p.request_id === "string" ? { request_id: p.request_id } : {}),
    transient: p.transient === true,
  };
}

/** Parse a OVERVIEW feed frame's payload; null on malformed/foreign shapes. */
export function parseOverviewFrame(payload: Uint8Array): OverviewPostWire | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload));
    // The current line rides the same feed under its own tag ([B04]). A post
    // reader answers null for it rather than trying to make a post out of it,
    // which is what lets one feed carry two shapes.
    if (
      typeof value === "object" &&
      value !== null &&
      (value as Record<string, unknown>).kind === SESSION_CURRENT_KIND
    ) {
      return null;
    }
    return parseOverviewPost(value);
  } catch {
    return null;
  }
}

/**
 * The `kind` tag on a current-line frame, spelled as tugcast's
 * `SessionCurrentLine` spells it.
 */
export const SESSION_CURRENT_KIND = "session_current";

/**
 * The per-turn line under a live session's name, as it travels on `OVERVIEW`.
 *
 * A sibling of the post rather than a field on it: the Observer answers both
 * from one reading, and a wake that writes this and posts nothing is the
 * ordinary case rather than the odd one. Already in the standing sentence's
 * register when it arrives, so nothing here trims or cases it.
 */
export interface SessionCurrentLineWire {
  session_id: string;
  at_ms: number;
  current: string;
}

/**
 * Decode one current line from an `OVERVIEW` frame; null on anything else,
 * including a post. The tag is checked rather than inferred from the fields,
 * so a shape that merely resembles one is not read as one.
 */
export function parseSessionCurrentLineFrame(
  payload: Uint8Array,
): SessionCurrentLineWire | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (typeof value !== "object" || value === null) return null;
    const v = value as Record<string, unknown>;
    if (v.kind !== SESSION_CURRENT_KIND) return null;
    if (typeof v.session_id !== "string" || v.session_id.length === 0) {
      return null;
    }
    if (typeof v.current !== "string" || v.current.length === 0) return null;
    return {
      session_id: v.session_id,
      at_ms: typeof v.at_ms === "number" ? v.at_ms : 0,
      current: v.current,
    };
  } catch {
    return null;
  }
}

/**
 * One row of the `list_digest_lines_ok` response — one digest line from
 * tugcast's in-memory per-session deque, oldest-first.
 */
export interface DigestLineWireRow {
  id: number;
  at_ms: number;
  beat: number;
  text: string;
  /**
   * The line's kind, spelled as {@link DigestFramePayload.kind} spells it.
   *
   * The tail carries it for the same reason the live frame does — it is what
   * the masthead's ladder switches on — so a card mounting mid-turn reads the
   * same ladder a card that watched the turn reads.
   */
  kind?: string;
  scopes: string[];
}

/** Decoded `list_digest_lines_ok` response payload (app-scoped). */
export interface ListDigestLinesOk {
  lines: DigestLineWireRow[];
}

/**
 * Request the digest tail. App-scoped — no session id. The response is
 * `list_digest_lines_ok { lines }`; the digest store sends this once on
 * mount, then stays live off the DIGEST feed.
 */
export function encodeListDigestLines(): Frame {
  return controlFrame("list_digest_lines", {});
}

/**
 * Decoded live `DIGEST` feed frame — one line as broadcast by tugcast's
 * digest bridge (Spec S01).
 */
export interface DigestFramePayload {
  text: string;
  /**
   * What the line is an account of — `ask`, `said`, `tool`, `result`,
   * `shell`, `turn`, `notice`, `wait` (the digester's `DigestKind`).
   *
   * It took the place of the retired `intent` pin, and it is the one thing on
   * this payload the masthead's ladder cannot be built without: an ask and a
   * tool line are both `text`, so without a kind the deck can only answer
   * with the newest line of any sort.
   */
  kind?: string;
  scopes: string[];
  beat: number;
  at: number;
}

/** Parse a DIGEST feed frame's payload; null on malformed/foreign shapes. */
export function parseDigestFrame(payload: Uint8Array): DigestFramePayload | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (p.type !== "digest" || typeof p.text !== "string" || p.text.length === 0) {
      return null;
    }
    return {
      text: p.text,
      ...(typeof p.kind === "string" && p.kind.length > 0
        ? { kind: p.kind }
        : {}),
      scopes: Array.isArray(p.scopes)
        ? p.scopes.filter((s): s is string => typeof s === "string")
        : [],
      beat: typeof p.beat === "number" ? p.beat : 0,
      at: typeof p.at === "number" ? p.at : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Decoded `ACTIVITY` feed frame — one binned per-session channel sample
 * (Spec S02). tugcode emits `activity_delta` with the stream-derived rate
 * channels; the cast sampler adds the OS gauge channels; tugcast splices
 * `tug_session_id` and re-tags `FeedId::ACTIVITY`. `channels` is keyed by
 * the deck's canonical channel names — the gauge wire keys (`cpu_pct`,
 * `rss_bytes`, `disk_read_bps`/`disk_write_bps`) are normalized here so the
 * store records one `disk` (read+write summed), `cpu`, `memory`.
 */
export interface ActivityFramePayload {
  tug_session_id: string;
  channels: Record<string, number>;
}

/** Wire channel key → canonical store channel; unlisted keys are dropped. */
const ACTIVITY_WIRE_CHANNELS: Readonly<Record<string, string>> = {
  text: "text",
  tokens: "tokens",
  tools: "tools",
  subagents: "subagents",
  cpu_pct: "cpu",
  rss_bytes: "memory",
  disk_read_bps: "disk",
  disk_write_bps: "disk",
};

/**
 * Parse an `ACTIVITY` feed frame's payload into canonical channel samples;
 * null on a malformed / foreign / session-less shape. Disk read+write fold
 * into a single `disk` channel (bytes/sec total). Non-finite / non-number
 * channel values are skipped.
 */
export function parseActivityFrame(
  payload: Uint8Array,
): ActivityFramePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const sessionId = p.tug_session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof p.channels !== "object" || p.channels === null) return null;
  const wire = p.channels as Record<string, unknown>;
  const channels: Record<string, number> = {};
  for (const [wireKey, canonical] of Object.entries(ACTIVITY_WIRE_CHANNELS)) {
    const v = wire[wireKey];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    channels[canonical] = (channels[canonical] ?? 0) + v;
  }
  if (Object.keys(channels).length === 0) return null;
  return { tug_session_id: sessionId, channels };
}

/**
 * Decoded `list_session_state_changes_err` response payload.
 */
export interface ListSessionStateChangesErr {
  tug_session_id: string;
  reason: string;
}

/**
 * What one segment cost, summed over its committed turns — the ledger's
 * `SessionUsage`, keep in lockstep with the Rust struct.
 *
 * `tokens` is every token the model consumed (input, output and both cache
 * columns), which is what the app's other token figures mean. `activeMs` is
 * the agent's working time rather than wall clock — the number the agent
 * footer prints. Cost is deliberately not carried: it is populated for some
 * models and zero for others.
 */
export interface SessionUsage {
  turns: number;
  tokens: number;
  activeMs: number;
}

/**
 * Decode a wire `usage` object, from either frame that carries one. Undefined
 * for an absent or malformed value — a segment with no telemetry says nothing
 * rather than zero, and a surface reading this is expected to render the two
 * the same way.
 */
export function decodeSessionUsage(raw: unknown): SessionUsage | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const turns = obj.turns;
  const tokens = obj.tokens;
  const activeMs = obj.active_ms;
  if (
    typeof turns !== "number" ||
    typeof tokens !== "number" ||
    typeof activeMs !== "number"
  ) {
    return undefined;
  }
  return { turns, tokens, activeMs };
}

/**
 * Decoded `session_updated` push payload. The supervisor emits these on
 * every successful ledger write. `removed: true` means the row was
 * deleted; otherwise `fields` holds the post-write row state.
 */
export interface SessionUpdatedPush {
  session_id: string;
  fields?: SessionRow;
  removed?: boolean;
  /**
   * What the segment cost, summed over its committed turns — carried BESIDE
   * the row because it is a `SUM` over another ledger table rather than a
   * `sessions` column. Absent for a segment that recorded no telemetry, which
   * is a real state and not a zero. Every push carries it, so a client that
   * replaces its cached entry wholesale never downgrades the figure.
   */
  usage?: SessionUsage;
}

/**
 * Type guard + decoder for `session_updated` push frames. Returns `null`
 * if the payload is missing its `action` discriminant or the wrong action.
 * Validation is shape-only — fields' structural correctness is the caller's
 * responsibility (the type assertion is the contract).
 */
export function decodeSessionUpdated(payload: unknown): SessionUpdatedPush | null {
  if (typeof payload !== "object" || payload === null) return null;
  const obj = payload as Record<string, unknown>;
  if (obj.action !== "session_updated") return null;
  const sessionId = obj.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const removed = obj.removed === true ? true : undefined;
  const rawFields = obj.fields as
    | Parameters<typeof normalizeSessionRow>[0]
    | undefined;
  const fields = rawFields === undefined ? undefined : normalizeSessionRow(rawFields);
  return removed
    ? { session_id: sessionId, removed: true }
    : { session_id: sessionId, fields, usage: decodeSessionUsage(obj.usage) };
}

/**
 * Decoded `resolve_sessions_ok` response payload ([D132]).
 *
 * `found` maps the id as **asked** to the ledger row that answers it — the two
 * differ whenever the ask was a citation's 8-char short id. `unknown` names the
 * ids this ledger holds no row for, which is a durable answer rather than a
 * silence: a citation written on another machine is unresolvable, and saying so
 * is what stops the client asking again forever.
 */
export interface ResolveSessionsOk {
  found: readonly { queried: string; session: SessionRow; usage?: SessionUsage }[];
  unknown: readonly string[];
}

/**
 * Type guard + decoder for `resolve_sessions_ok`. Entries missing a `queried`
 * string or a `session` object are dropped rather than failing the frame — a
 * partial answer resolves the chips it can and leaves the rest pending, which
 * is strictly better than discarding every answer over one bad row.
 */
export function decodeResolveSessionsOk(payload: unknown): ResolveSessionsOk | null {
  if (typeof payload !== "object" || payload === null) return null;
  const obj = payload as Record<string, unknown>;
  if (obj.action !== "resolve_sessions_ok") return null;
  const found: { queried: string; session: SessionRow; usage?: SessionUsage }[] = [];
  if (Array.isArray(obj.sessions)) {
    for (const entry of obj.sessions) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const queried = e.queried;
      if (typeof queried !== "string" || queried.length === 0) continue;
      if (typeof e.session !== "object" || e.session === null) continue;
      found.push({
        queried,
        session: normalizeSessionRow(
          e.session as Parameters<typeof normalizeSessionRow>[0],
        ),
        usage: decodeSessionUsage(e.usage),
      });
    }
  }
  const unknown = Array.isArray(obj.unknown)
    ? obj.unknown.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  return { found, unknown };
}
