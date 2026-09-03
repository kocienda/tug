/**
 * Public types for `CodeSessionStore` — the per-Session-card L02 store that
 * owns Claude Code turn state.
 *
 * [D03] three-identifier model
 * [D04] transcript + streaming
 * [D07] full sequence substrate — a turn is an ordered sequence of typed
 *       `Message`s; the snapshot exposes the in-flight turn as
 *       `activeTurn` (and the committed turns as `transcript[].messages`)
 *       so consumers iterate the sequence rather than reading paired
 *       fields. Paired `userMessage` / `assistant` / `thinking` /
 *       `toolCalls` aggregation retires.
 * [D11] effect-list reducer
 */

import type { AtomSegment } from "../tug-atom-img";
import type { CardSessionMode } from "../card-session-binding-store";
import type { JobItem } from "./select-jobs";
import type { GoalState } from "./select-goal";

export type { CardSessionMode } from "../card-session-binding-store";

/**
 * Discrete phases of the Claude Code turn state machine. Terminal
 * outcomes (`success` / `interrupted`) live on `TurnEntry.result`
 * rather than the phase — a completed turn always returns to `idle`
 * once its entry is committed, so there is no `complete` or
 * `interrupted` phase.
 *
 * `replaying` is the phase for the JSONL replay window bracketed by
 * `replay_started` / `replay_complete`. While `replaying`,
 * `canSubmit` and `canInterrupt` are both `false` and the live-frame
 * handlers drop their inputs (replay events flow through dedicated
 * handlers; the bracket guarantees ordering).
 *
 * `waking` is the phase for a spontaneous mid-session resume bracketed
 * by `wake_started` and the next `turn_complete`. Closes [PPF-01]:
 * before this phase existed, content events arriving from idle in
 * response to an async deferred-completion trigger (Monitor timeout,
 * CronCreate firing, ScheduleWakeup arriving) were silently dropped
 * by the `handleTextDelta` / `handleTurnComplete` guards. The bracket
 * mirrors the replay pattern but uses claude's existing `turn_complete`
 * as the implicit close (no `wake_complete` frame on the wire).
 * See `arc/tugplan-session-wake.md` [D01].
 */
export type CodeSessionPhase =
  | "idle"
  | "submitting"
  | "awaiting_first_token"
  | "streaming"
  | "tool_work"
  | "awaiting_approval"
  | "replaying"
  | "waking"
  | "errored";

/**
 * Verbatim forward of the SDK's `SDKTaskNotificationMessage` payload
 * (`@anthropic-ai/claude-agent-sdk/sdk.d.ts:1659-1668`), minus the
 * `type:"system"` / `subtype:"task_notification"` envelope. Set by
 * `handleWakeStarted` on the reducer state and cleared by
 * `handleTurnComplete`'s `waking → idle` commit branch.
 *
 * Slice 1 has no consumers — the field is set, surfaced on the
 * snapshot, and cleared without being read anywhere. Slice 2 will
 * render a trigger-aware chip / banner from it. The shape is pinned
 * to the SDK type so a future SDK upgrade surfaces as a type-level
 * drift (caught by the Step 5 drift test) rather than a silent
 * field-rename.
 */
export interface WakeTrigger {
  taskId: string;
  toolUseId: string;
  status: "completed" | "failed" | "stopped";
  summary: string;
  outputFile: string;
}

/**
 * Health of the WebSocket transport, orthogonal to `phase`. The
 * reducer treats `transportState` as a separate axis ([D01]) so a
 * card that is idle but offline can still gate submit on the wire,
 * and so reconnect doesn't have to invent a "transport_lost" phase
 * that contaminates the turn-lifecycle vocabulary.
 *
 * - `online`     — wire is up; submit is allowed (subject to phase).
 * - `offline`    — wire is down. The user cannot submit.
 *                  Set on `transport_close` for every phase ([D06]).
 * - `restoring`  — wire is back up but the per-card binding has not
 *                  yet been re-acked by the supervisor. Set on
 *                  `transport_open`; cleared by `transport_settled`
 *                  once `cardSessionBindingStore` confirms the bind.
 */
export type TransportState = "online" | "offline" | "restoring";

// ---------------------------------------------------------------------------
// Message sequence substrate ([D07])
// ---------------------------------------------------------------------------

/**
 * Discriminant of a {@link Message}. The substrate is a flat ordered
 * sequence of these — interleaving (text → tool → text) is preserved
 * by `messages` array position, not by paired fields. Adding a new
 * kind is a union extension plus a reducer handler plus a renderer.
 */
export type MessageKind =
  | "user_message"
  | "assistant_text"
  | "assistant_thinking"
  | "system_note"
  | "tool_use"
  | "shell_exchange"
  | "refs_result";

/**
 * Fields every `Message` carries. `messageKey` is the React-row /
 * subscription identity, stable from mint through every subsequent
 * mutation (streaming append, `tool_result` landing on a `tool_use`,
 * etc.). Derivation per [D07]:
 *
 *  - `user_message`: `${turnKey}-user`, keyed on the message's *own*
 *    `turnKey`. A turn opens with one (the opener), but steering merges
 *    additional user messages into a turn ([P06]/[P07]); each keeps its
 *    own queue-time `turnKey`, so their keys stay distinct within the
 *    turn (the "one per turn" assumption is retired).
 *  - wire-derived (`assistant_text` / `assistant_thinking` /
 *    `tool_use`): `${msg_id}-b${block_index}` — intrinsically unique
 *    within a session, mirrors the wire's `(msg_id, block_index)`
 *    coordinate.
 *  - `system_note`: `${turnKey}-sys${seq}` where `seq` is a monotonic
 *    per-turn counter ({@link ScratchEntry.systemNoteSeq} in the
 *    reducer).
 *
 * `createdAt` is the wall-clock at mint time; consumers needing a
 * stable timestamp for display read this instead of re-deriving from
 * turn boundaries. Replay events synthesize it from the JSONL anchor.
 */
export interface MessageBase {
  messageKey: string;
  createdAt: number;
}

export interface UserMessage extends MessageBase {
  kind: "user_message";
  text: string;
  attachments: ReadonlyArray<AtomSegment>;
  /**
   * Who wrote this message — the user, or the wheel opening a stage.
   *
   * Stamped on the Message rather than read off its turn, and required so
   * every mint site has to answer. A turn the wheel opened can carry the
   * user's own words: a message typed while that turn is in flight is queued
   * and picked up mid-bracket, and reading attribution from the turn gave the
   * user's interjection the wheel's name.
   */
  origin: "user" | "wheel";
  /**
   * Wall-clock ms when `send()` was dispatched. Distinct from
   * `TurnEntry.endedAt` — the "submitted at" time the user-row
   * timestamp display reads. Carried on the Message so the data
   * source can derive the user row's timestamp without reaching
   * back into turn-level metadata.
   */
  submitAt: number;
}

export interface AssistantText extends MessageBase {
  kind: "assistant_text";
  /** Mutates by append during streaming; replaced wholesale on
   *  `is_partial: false`. */
  text: string;
}

export interface AssistantThinking extends MessageBase {
  kind: "assistant_thinking";
  text: string;
}

/**
 * Subdued note inside a turn — Step 8's scheduled-prompt rendering is
 * the first user, with `source: "scheduled"`. Future kinds
 * (`compact_boundary` / `wake_summary`) extend the `source` union
 * without changing the substrate shape.
 *
 * `stage` is the arc's boundary divider: the server rotated this card
 * onto a fresh claude session for the next stage of an arc, and the row
 * marks where one stage ended and the next began. Its text is composed by
 * `stageNoteText` in `stages.ts`.
 *
 * `arc` is an arc gesture's quiet line ([P12]): the server derived one
 * sentence from the arc-log — created, run declared, step started, closed,
 * a round — and it arrived while this turn was streaming, so it belongs
 * INSIDE the turn, between the tool calls it happened among. That is what
 * makes an arc read as a conversation: "step 1/3 started" above the work,
 * "step 1/3 closed" below it, the wheel's next ask after. A note arriving
 * with no turn open falls back to its own quiet ink row instead
 * (`handleArcNote`).
 */
export interface SystemNote extends MessageBase {
  kind: "system_note";
  text: string;
  source: "scheduled" | "compact" | "notice" | "stage" | "arc" | "other";
  /**
   * On a `notice`, which subsystem spoke (e.g. `"base-motion"`) — the row's
   * attribution label. Tug started this turn, and the row says so rather than
   * letting the words read as the user's.
   */
  noticeOrigin?: string;
}

/**
 * Tool call as a Message in the sequence. Carries the same fields
 * `ToolCallState` carried in the paired substrate, plus the
 * `MessageBase` identity. Mutations follow copy-on-write per [D07]'s
 * mutation discipline — the reducer shallow-clones the Message and
 * the messages-array slot; other Messages stay reference-identical.
 */
export interface ToolUseMessage extends MessageBase {
  kind: "tool_use";
  toolUseId: string;
  toolName: string;
  input: unknown;
  status: "pending" | "done" | "error";
  result: unknown | null;
  structuredResult: unknown | null;
  /** Spawning `Agent` call's `toolUseId`; `undefined` for a top-level call. */
  parentToolUseId?: string;
  /**
   * Wall-clock ms between the `tool_use` event and the matching
   * `tool_result`. `null` while pending; remains `null` if the turn
   * ended before the result arrived.
   */
  toolWallMs: number | null;
}

/**
 * The single content of a `shell`-origin turn ([P06], Spec S04): one settled
 * (or in-flight) `$`-route command/output exchange. Distinct *non-context ink*
 * ([P11]) — a shell exchange records what the user *did*, not what Claude
 * knows. `exitCode === null` marks an in-flight exchange (minted on
 * `exchange_started`, before the command settles) OR a killed/timed-out one;
 * the settled row is distinguished from in-flight by the turn's committed flag
 * on the data-source side ([P12]).
 */
export interface ShellExchangeMessage extends MessageBase {
  kind: "shell_exchange";
  /** The tugcast `exchange_id` — correlation key for started → complete. */
  exchangeId: string;
  command: string;
  /** Combined stdout+stderr, ANSI-bearing. Empty until the exchange settles. */
  output: string;
  /** `null` while in flight, and for a killed / timed-out exchange. */
  exitCode: number | null;
  /** cwd at exec time. */
  cwd: string;
  /** cwd after the command (a `cd` sticks). `null` while in flight. */
  cwdAfter: string | null;
  startedAtMs: number;
  /** `null` while in flight; set when the exchange settles. */
  settledAtMs: number | null;
  /**
   * True when the PATH classifier silently routed a command-shaped line here
   * from the prompt entry ([P09]). The row renders a `→ shell` auto-route
   * attribution with a one-click "send to Claude instead". Client-side only —
   * not persisted in the shell ledger.
   */
  autoRouted?: boolean;
}

/** One window of a matched line: text, and the column it starts at. */
export interface PreviewSegment {
  /** 0-based char offset of `text` within the source line. */
  col: number;
  /** The window's text. */
  text: string;
}

/**
 * What the feed sends of a matched line.
 *
 * Not the line itself: a search over a real tree hits minified bundles and
 * `.jsonl` fixtures whose every "line" is the whole file, so the producer
 * keeps a window around each match and records `lineLen` for what it left
 * out. Segments are ascending and non-overlapping; a line short enough to
 * show whole arrives as one segment at `col: 0`.
 */
export interface LinePreview {
  /** Char length of the whole source line. */
  lineLen: number;
  /** The windows kept, ascending by `col`. */
  segments: readonly PreviewSegment[];
  /** Matches on the line no kept window covers (an excerpt-budget cap). */
  elidedMatches: number;
}

/**
 * One numbered file reference, as the `refs` feed sends it.
 *
 * `path` is relative to the run's `root`; joining the two is the view
 * layer's job, because a row's path must be absolute to be clickable.
 * `line` is 1-based and `columns` are 0-based half-open `[start, end)`
 * char offsets into **the whole source line** — not into `preview`, which
 * carries only windows of that line. A span finds its window by the
 * window's own `col`, which is what lets the same offsets drive both the
 * row's highlight and the editor's reveal into the real file.
 */
export interface TextRef {
  index: number;
  path: string;
  line: number | null;
  columns: ReadonlyArray<readonly [number, number]>;
  preview: LinePreview | null;
}

/**
 * The single content of a `refs`-origin turn: one `/match` or `/search`
 * run and every reference it found. Non-context ink — a search is the
 * user's own investigation of their files, and it reaches Claude only
 * through the block's Share gesture.
 *
 * The message is replaced in place as rows stream in, so `refs` grows
 * while `inFlight` is true and freezes when the run settles.
 */
export interface RefsResultMessage extends MessageBase {
  kind: "refs_result";
  /** Fences streaming frames and the ledger clobber. */
  runId: string;
  opKind: "match" | "search";
  /** The command line as the user typed it — the block's header. */
  command: string;
  /** Workspace root every ref's `path` is relative to. */
  root: string;
  refs: ReadonlyArray<TextRef>;
  /** True from `refs_started` until the run settles. */
  inFlight: boolean;
  /** True when the run was stopped rather than finishing. */
  cancelled: boolean;
  /** A reason the run produced nothing — an unparseable pattern. */
  notice: string | null;
  startedAtMs: number;
  /** `null` while in flight. */
  settledAtMs: number | null;
}

/**
 * Discriminated union of every Message kind. Iteration is the substrate's
 * primary access pattern — consumers `messages.filter(m => m.kind === ...)`
 * or `messages[0]?.kind === "user_message"` instead of reaching for
 * paired fields.
 */
export type Message =
  | UserMessage
  | AssistantText
  | AssistantThinking
  | SystemNote
  | ToolUseMessage
  | RefsResultMessage
  | ShellExchangeMessage;

/**
 * Intrinsic, stated origin of a turn container (`tuglaws/turn-metric.md`
 * S01). `user` — a genuine user submission (carries a `user_message`,
 * renders `#u` + `#a`). `assistant` — a wake, a `/compact` continuation, a
 * `--continue` leading orphan, or any orphan assistant output (no user
 * message, renders `#a` only). Shell (`#s`) is reserved by the addressing
 * scheme but not a value here this phase.
 *
 * Origin is set by the turn's opener and is NEVER inferred from
 * `messages[0]` — a code-constructed turn can never masquerade as a user
 * action ([P01]).
 *
 * `shell` — a `$`-route command/output exchange ([P06], activating the
 * reserved `#s` addressing). A shell turn carries exactly one
 * `shell_exchange` Message and is visually distinct non-context ink ([P11]);
 * it is NOT part of Claude's context.
 *
 * `refs` — a `/match` or `/search` run (`#r`), the second ink origin. Like
 * `shell` it records what the user did, carries exactly one message, and is
 * not part of Claude's context.
 *
 * `wheel` — a turn the wheel opened on the user's behalf: an arc
 * arc's stage prompt, seated by tugcast rather than typed. It lays out
 * exactly as a `user` turn (a `#u` row and an `#a` row) and is part of
 * Claude's context; what differs is who speaks in the `#u` row, which the
 * transcript says rather than letting the row read as the user's words.
 */
export type TurnOrigin = "user" | "assistant" | "shell" | "refs" | "wheel";

/**
 * True for an origin whose turns are **non-context ink**: a record of what
 * the user did, never sent to Claude.
 *
 * The one predicate the transcript's insertion helpers, the row layout, and
 * the loaded-turn counter all read. Three hand-written copies of
 * `origin === "shell"` is how the count in the metadata row starts lying
 * the day a second ink origin lands.
 */
export function isInkOrigin(origin: TurnOrigin): boolean {
  return origin === "shell" || origin === "refs";
}

/**
 * Per-turn token + cost figures, frozen onto the committed `TurnEntry`
 * at `turn_complete`.
 *
 * The four token fields are the turn's LAST tool-loop iteration's
 * `usage` — `cost_update.usage`, which tugcode emits from the turn's
 * most recent `message_delta`. They are NOT `result.usage`:
 * `result.usage` is the SUM of `usage` across every API call of the
 * turn, so a K-tool-call turn over-reports by ~K×. The last
 * iteration's `input + cache_read + cache_creation + output` IS the
 * resident context window after the turn — `turnWindowTokens` reads
 * exactly that.
 *
 * Only `totalCostUsd` is a delta (`total_cost_usd` IS
 * cumulative-per-session, so the committed value is `after − before`).
 * See `extractTurnCost`. Zeros for a turn that received no
 * `cost_update` event, or an interrupted turn whose only iteration was
 * a degenerate zero-usage stop — the transcript window-walk
 * (`deriveContextWindows`) carries the prior window forward for those.
 */
export interface TurnCost {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
}

/**
 * Typed terminal state of a turn — strictly richer than the legacy
 * `TurnEntry.result` (`"success" | "interrupted"`). Used by lifecycle
 * coordinators to distinguish a clean completion from each failure
 * mode without re-reading `lastError`.
 *
 * - `complete`       — `turn_complete` with `result: "success"`.
 * - `interrupted`    — user pressed Stop; `handleInterrupt` ran.
 * - `error`          — `turn_complete` with `result: "error"` outside the
 *                       transport-lost path.
 * - `transport_lost` — turn was in flight when the transport closed.
 */
export type TurnEndReason =
  | "complete"
  | "interrupted"
  | "error"
  | "transport_lost";

/**
 * Why an interrupt fired when it wasn't a plain user Stop. Both values name an
 * app-level flow that stops every turn before it changes app-wide state:
 * `"logout"` before `claude auth logout`, `"configure-tug"` before the Configure Tug wizard
 * takes the whole app modal. The end-state badge names the flow so a turn the
 * user didn't personally stop doesn't read as an anonymous "Interrupted".
 */
export type InterruptReason = "logout" | "configure-tug";

/**
 * Immutable transcript entry appended once per completed turn.
 * `result === "interrupted"` covers both user-initiated stop
 * (`turn_complete(error)`) and any preserved-text interrupt path.
 *
 * [D07] sequence-substrate shape: `messages` is the ordered Message
 * sequence the wire produced (preserving multi-msgId iterations
 * faithfully). Paired fields (`userMessage` / `thinking` / `assistant`
 * / `toolCalls`) retired — consumers iterate `messages` and filter by
 * `kind` instead.
 */
export interface TurnEntry {
  /**
   * Stable React-key seed for this turn's row(s). Generated at
   * `handleSend` (or `handleWakeStarted`) and preserved unchanged
   * across the inflight → committed transition. The transcript data
   * source uses it to mint `idForIndex` so React keys for the
   * streaming row stay identical when it becomes the committed row —
   * preventing the cell wrapper from unmounting at `turn_complete`,
   * which previously caused `scrollTop` to silently clamp to 0.
   *
   * Distinct from `msgId`: `msgId` is the wire-correlation identifier
   * assigned by the backend (used to match streaming frames to their
   * turn); `turnKey` is a client-only key, generated at submit time,
   * meaningful only to React reconciliation.
   */
  turnKey: string;
  msgId: string;
  /**
   * Ink only: the `msgId` of the transcript turn this row was written after,
   * stamped server-side on the ledger row at write time and replayed with it.
   *
   * A durable ink row's position is a written fact, not something re-derived
   * from clocks at every boot — restore seats an anchored row immediately
   * after the last entry whose `msgId` matches. `undefined` for a live row,
   * for a row written before the anchor column existed, and for a session
   * whose transcript held no assistant turn yet; those fall back to timestamp
   * placement, which degrades position and never loses a row.
   */
  anchorMsgId?: string;
  /**
   * Intrinsic origin of this turn ([P01], S01). Set by the turn's opener,
   * never inferred from `messages[0]`. `"user"` → a genuine user submission
   * (renders a `#u` user row + `#a` assistant row); `"assistant"` → a wake /
   * continuation / orphan (renders `#a` only, no user row). Row layout and
   * per-row addressing key on this field.
   */
  origin: TurnOrigin;
  /**
   * True when this turn committed during a replay window (`phase ===
   * "replaying"` at `turn_complete`) — i.e. it is reconstructed
   * history, not a turn the user watched stream. Renderers use it to
   * pick the collapsed-history presentation for tool blocks; live
   * turns leave it unset.
   */
  replayed?: boolean;
  /**
   * Claude's user-prompt-record `uuid` for this turn — the `/rewind`
   * anchor ([#step-7-1]/[#step-7-3]). Captured from the live `prompt_anchor`
   * frame (steady-state) or `add_user_message.promptUuid` (replay /
   * mid-turn snapshot), both surfaced additively by tugcode. It is the value
   * `session_rewind.promptUuid` takes — NOT `msgId` (that is claude's
   * *assistant* message id). `undefined` for turns whose anchor never
   * arrived (older sessions, wake turns with no user submission); such turns
   * are simply not rewind-targetable.
   */
  promptUuid?: string;
  /**
   * Ordered Message sequence — the wire's arrival order, preserving
   * the interleaving of text / thinking / tool_use across every
   * `msg_id` iteration of the turn ([D07]). Each Message carries a
   * stable `messageKey` for per-Message React identity and PropertyStore
   * subscriptions.
   *
   * A `user`-origin turn opens with a `user_message` Message; an
   * `assistant`-origin turn (wake / continuation / orphan) naturally
   * doesn't (its `messages` opens with `assistant_text` or
   * `assistant_thinking`). Consumers gate on user-row presence via the
   * turn's {@link origin}, NOT by inspecting `messages[0]` ([P01]).
   */
  messages: ReadonlyArray<Message>;
  /**
   * @deprecated Use {@link turnEndReason}. Derived from `turnEndReason`
   * so the two never diverge (`"complete"` → `"success"`; everything
   * else → `"interrupted"`). Kept in place for incremental consumer
   * migration; remove once all callers have moved.
   */
  result: "success" | "interrupted";
  /**
   * Why an interrupted turn was stopped, when it wasn't a plain user Stop.
   * See {@link InterruptReason} — the marker refines the Z1B end-state so it
   * names the app-level flow that stopped the turn rather than reading a bare
   * "Interrupted". Absent for a normal interrupt and for every non-
   * interrupted turn. Live-only: the replay path never revives it (the
   * marker is not persisted to JSONL).
   */
  interruptReason?: InterruptReason;
  endedAt: number;

  /**
   * Pure wall-clock duration of the turn: `endedAt - submitAt`
   * (`submitAt` carried on the opening `user_message` Message for a
   * normal turn, or on the wake bracket's `ActiveTurnSnapshot` for a
   * wake turn that commits with no user message).
   * Indisputable; covers everything.
   */
  wallClockMs: number;
  /**
   * Cumulative ms paused on a `TugInlineDialog` waiting for the user's
   * answer. Covers BOTH permission prompts and `AskUserQuestion`
   * question dialogs — the time the turn was blocked on user input.
   */
  awaitingApprovalMs: number;
  /**
   * Cumulative ms with the transport disconnected (`offline` OR
   * `restoring`) during this turn. The cleanest objective signal —
   * the transport authoritatively knows when it lost service.
   */
  transportDowntimeMs: number;
  /**
   * Machine-doing-work duration. Stored directly so consumers don't
   * recompute: `wallClockMs - awaitingApprovalMs - transportDowntimeMs`,
   * clamped ≥ 0. The "assistant response time" reported in the UI.
   */
  activeMs: number;

  /**
   * Submit-to-first-`assistant_delta` latency. `null` if the turn
   * produced no assistant output (e.g. tool-only or interrupted).
   */
  ttftMs: number | null;
  /**
   * Submit-to-first-`tool_use` latency. `null` if the turn produced no
   * tool calls.
   */
  ttftcMs: number | null;
  /**
   * Number of transport reconnects observed during this turn.
   * Companion to `transportDowntimeMs`.
   */
  reconnectCount: number;
  /**
   * Longest single inter-event silence across this turn, in ms.
   * Diagnostic — informs any future stream-idle heuristic.
   */
  maxStreamGapMs: number;
  /**
   * Typed terminal state. Strictly richer than {@link result}; consumers
   * SHOULD prefer this field. The reducer derives `result` from this
   * value.
   */
  turnEndReason: TurnEndReason;
  /**
   * Per-turn delta of cumulative `cost_update` fields. Zeros for a turn
   * that received no `cost_update`. See {@link TurnCost}.
   */
  cost: TurnCost;
  /**
   * Honest post-compaction resident window ([P01], Spec S04) — present
   * only on a turn that carried a `compact_boundary`. Holds
   * `sessionInitTokens + compact_boundary.post_tokens` (base + Claude's
   * post-compaction conversation figure), NOT raw `post_tokens`. Consumed
   * by `deriveContextWindows` as `window(N)` for this turn so CONTEXT drops
   * in place with no one-turn lag; it never enters {@link cost} (which
   * stays the real, zero-usage `TurnCost`) so it can't masquerade as usage.
   */
  compactionPostTotal?: number;
}

/** One selectable answer in a {@link PendingAsk}. */
export interface PendingAskOption {
  /** Opaque id returned to the caller verbatim. Never shown to the user. */
  value: string;
  label: string;
  description?: string;
}

/**
 * A question put to the human by a process outside the turn stream, over
 * tugcast's `/api/ask`. The caller blocks until it is answered.
 *
 * `title` and `description` are caller-supplied and rendered as plain text
 * below chrome the caller cannot reach — a question arriving over loopback must
 * not be able to dress itself up as one of the app's own prompts.
 */
export interface PendingAsk {
  /** Correlates the answer with the blocked caller. */
  requestId: string;
  title: string;
  description: string | null;
  options: ReadonlyArray<PendingAskOption>;
  /**
   * The answer to commit if nobody intervenes, or `null` when the question
   * genuinely needs a human.
   *
   * A caller sets it when going ahead is the honest default and the dialog
   * exists only so someone at the keyboard can say otherwise. The dialog then
   * counts {@link countdownSecs} down and commits the *selected* option — the
   * countdown decides when, never what, so a developer who moves the selection
   * and walks away still gets what they picked.
   */
  unattendedChoice: string | null;
  /** Seconds the countdown runs for. Non-null exactly when {@link unattendedChoice} is. */
  countdownSecs: number | null;
}

/**
 * Decoded `control_request_forward` event from CODE_OUTPUT. Surfaced on the
 * snapshot via `pendingApproval` or `pendingQuestion` while the store is in
 * `awaiting_approval`. The shape is intentionally loose — downstream UI
 * code interprets the fields per the stream-json contract.
 *
 * `decision_reason` and `permission_suggestions` are explicit optional
 * fields because T3.4.b's permission prompt will read them directly;
 * everything else still passes through via the indexed signature for
 * forward-compat.
 */
export interface ControlRequestForward {
  request_id: string;
  is_question: boolean;
  tool_name?: string;
  /**
   * The `tool_use_id` of the tool call this dialog is blocked on. The
   * `control_request_forward` wire event already carries it (confirmed
   * across the catalog from v2.1.104 onward — tugcode copies it from
   * the SDK's `can_use_tool` request for BOTH permission and question
   * forwards), and `extractForward` keeps it on the stored record. The
   * tool-call header id-joins this against a `ToolUseMessage.toolUseId`
   * to paint that row's lifecycle dot `awaiting` ([Q01] of
   * arc/block-header.md). Typed here (previously reachable only
   * via the index signature).
   */
  tool_use_id?: string;
  input?: unknown;
  question?: string;
  options?: ReadonlyArray<unknown>;
  decision_reason?: string;
  permission_suggestions?: ReadonlyArray<unknown>;
  [key: string]: unknown;
}

/**
 * Telemetry snapshot captured from `cost_update` frames. Everything past
 * `totalCostUsd` is nullable because the reducer only accepts numeric
 * payloads and real fixtures may omit individual fields. `usage` and
 * `modelUsage` stay `unknown` on purpose so renderers can reach into
 * the live wire shape without the store gatekeeping forward-compat
 * fields.
 */
export interface CostSnapshot {
  totalCostUsd: number;
  numTurns: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  usage: unknown | null;
  modelUsage: unknown | null;
}

/**
 * Live retry state, set from an `api_retry` frame and cleared at the
 * next turn boundary (`cost_update` / `turn_complete`). Claude's SDK
 * owns the retry loop; this is purely the in-flight announcement the
 * session-card banner mirrors.
 *
 * `deadline` is epoch-ms (`arrival + retry_delay_ms`), computed in the
 * impure store wrapper so the reducer stays time-free. `error` is the
 * raw category string from claude (`rate_limit`, `overloaded`,
 * `authentication_failed`, …); `errorStatus` is the nullable HTTP
 * status. Both feed `classifyApiRetry` at the banner-spec layer.
 */
export interface ApiRetryState {
  attempt: number;
  maxRetries: number;
  deadline: number;
  error: string;
  errorStatus: number | null;
}

/**
 * A model declined a turn and the SDK retried on a fallback model (non-fatal).
 * Set from a `model_refusal_fallback` frame and cleared at the next turn
 * boundary; the transient-notice surface shows it as a one-shot bulletin.
 */
export interface RefusalFallbackState {
  originalModel: string;
  fallbackModel: string;
}

/**
 * The most recent `unknown_event` tugcode forwarded — claude streamed a
 * top-level event type this build doesn't translate. Drives a soft warn
 * banner so a forward-incompatible stream is visible rather than silently
 * dropped. `at` is the reducer-stamped `Date.now()` of receipt, keyed by
 * the banner's Dismiss so a click suppresses this exact notice while a
 * fresh unknown type (new `at`) re-raises. `originalType` is the raw type
 * claude sent; `payloadHexPreview` is tugcode's bounded hex peek at the
 * payload, surfaced for operator diagnosis.
 */
export interface UnknownEventState {
  originalType: string;
  payloadHexPreview: string;
  at: number;
}

/**
 * The four-token `usage` shape carried by a `streaming_usage` /
 * `cost_update` frame, decoded to camelCase. Mirrors {@link TurnCost}
 * minus the dollar cost — dollars are cumulative-per-session and only
 * land with the terminal `cost_update`, so the live shape omits them.
 *
 * Used both as the live in-flight usage value (the streaming
 * document's `telemetry.liveTurnUsage` path) and as the minimal
 * structural input to the window helpers in `end-state.ts`
 * ({@link TurnCost} is structurally assignable to it).
 */
export interface LiveMessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * Per-category identity carried by the `context_breakdown` wire frame
 * — the static half of the breakdown. Mirrors tugcode's wire-frame
 * `ContextBreakdownCategoryId` enum.
 *
 * `messages` is intentionally absent: it is feed-derived
 * (`window - sessionInit`), assembled tugdeck-side, never on the wire.
 * `mcp_tools` is intentionally absent — Tug treats MCP as out of scope.
 */
export type ContextBreakdownCategoryId =
  | "system_prompt"
  | "system_tools"
  | "custom_agents"
  | "memory_files"
  | "skills"
  | "autocompact_buffer";

/**
 * One per-category slice of the breakdown. Mirrors the wire-frame
 * shape (snake_case `id` enum, label string, numeric token count).
 */
export interface ContextBreakdownCategory {
  id: ContextBreakdownCategoryId;
  label: string;
  tokens: number;
}

/**
 * Reducer projection of the most-recent `context_breakdown` wire
 * frame. Drives the Session card's Context popover when present. The
 * popover paints the categories in array order; `contextMax` is the
 * model's context-window cap (so the renderer can compute the
 * free-space remainder).
 *
 * The `autocompact_buffer` category is conditional — present only
 * when the user has Claude Code's autocompact setting enabled.
 * Absence means one fewer slice and a larger free-space remainder.
 *
 * Reference is preserved across snapshot rebuilds while the reducer's
 * `lastContextBreakdown` field doesn't change — [L02] consumers see
 * `Object.is` stability during quiescent renders.
 */
export interface ContextBreakdownSnapshot {
  contextMax: number;
  categories: ReadonlyArray<ContextBreakdownCategory>;
}

/**
 * A user message submitted while a turn was already running — held in
 * the reducer's `queuedSends` FIFO and dispatched on the next idle
 * (`handleTurnComplete(success)` flushes the head). `turnKey` is minted
 * at the queueing `send` and travels with the entry so the flushed
 * turn keeps the same React-key seed.
 *
 * Surfaced on `CodeSessionSnapshot.queuedSends` so the transcript can
 * paint one ghost row per queued send.
 */
export interface QueuedSend {
  text: string;
  atoms: ReadonlyArray<AtomSegment>;
  turnKey: string;
  /**
   * Who wrote it, carried across the queue gap so the flushed / picked-up
   * `UserMessage` is stamped with the sender rather than with whoever's turn
   * it happens to land inside.
   */
  origin: "user" | "wheel";
  /**
   * Wall-clock time the user hit submit — stamped at the queueing `send`,
   * not at the flush. It becomes the flushed turn's `UserMessage`
   * `createdAt`/`submitAt`, so the Z1 timestamp reads the moment the user
   * posted and the turn sorts against shell rows ([D111]) by submission
   * rather than by dispatch. A shell exchange run while this send sat
   * queued therefore stays BELOW it, live and after the flush alike.
   */
  queuedAt: number;
}

/**
 * Public projection of the in-flight turn ([D07]). Mirrors
 * `TurnEntry`'s sequence shape so consumers iterate
 * `activeTurn.messages` the same way they iterate `turn.messages` for
 * committed rows — one substrate, two lifecycle slots.
 *
 * `origin` is the turn's intrinsic attribution (S01, [P01]): `"user"`
 * (opens with a `user_message`) or `"assistant"` (a wake / continuation /
 * orphan — `messages` opens with `assistant_text` / `assistant_thinking`,
 * no user submission). Consumers gate on user-row presence via `origin`,
 * never by inspecting `messages[0]`.
 */
export interface ActiveTurnSnapshot {
  turnKey: string;
  submitAt: number;
  origin: TurnOrigin;
  /**
   * When true, this in-flight turn is suppressed from the transcript (the
   * `/compact` seed) — the data source emits zero rows for it.
   */
  suppressed: boolean;
  /**
   * Live, mutates as wire events land. Per [D07] copy-on-write: a
   * mutation shallow-clones the affected Message + the messages array
   * slot; other Messages stay reference-identical so downstream
   * consumers comparing `messages[i]` by reference can detect changes.
   */
  messages: ReadonlyArray<Message>;
}

/**
 * A single denied tool call, decoded (camelCase) from a `cost_update`'s
 * `permission_denials[]`. The source — permission rule vs. auto-mode
 * classifier — is not distinguished on the wire; both populate the same array.
 */
export interface PermissionDenial {
  /** Tool that was denied, e.g. `"Bash"`, `"WebFetch"`. */
  toolName: string;
  /** The denied tool call's id — the dedup key across repeated frames. */
  toolUseId: string;
  /** The tool input that was blocked (e.g. `{ command: "curl …" }`). */
  toolInput: Record<string, unknown>;
}

/**
 * Public snapshot returned by `CodeSessionStore.getSnapshot()`. Stable
 * reference between dispatches that produce no change — callers can use
 * `useSyncExternalStore` without tearing ([D11]).
 */
/**
 * Per-turn code diff-stat preview for the `/rewind` sheet ([#step-7-3]),
 * keyed by `promptUuid`. Populated lazily from a `rewind_preview` →
 * `rewind_preview_result` round-trip ([#step-7-1]) — one entry per turn the
 * sheet has fetched, cached for the session so re-opening the sheet doesn't
 * re-fetch. `loading` is true between the request and its result.
 */
export interface RewindTurnPreview {
  loading: boolean;
  canRewind: boolean;
  filesChanged?: ReadonlyArray<string>;
  insertions?: number;
  deletions?: number;
  error?: string;
  /**
   * Whether the CONVERSATION dimension can rewind to this turn ([#step-7-3]):
   * `false` when its chop range crosses a `/compact` boundary (or would leave
   * no retained turns) — the same condition tugcode refuses at apply time.
   * The picker disables such rows so it never offers a turn that would error.
   * `undefined` while loading / not reported (treated as rewindable).
   */
  conversationRewindable?: boolean;
}

/**
 * Outcome of an applied `session_rewind` ([#step-7-2]/[#step-7-3]) — the
 * `rewind_result` ack relayed by tugcode. `newSessionId` is present only for
 * a successful fork (the card→session rebind target). The sheet reads
 * `lastRewindResult` to dismiss on success / surface an error, and to drive
 * the fork rebind.
 */
export interface RewindResultAck {
  promptUuid: string;
  scope: "conversation" | "code" | "both";
  canRewind: boolean;
  error?: string;
  newSessionId?: string;
}

export interface CodeSessionSnapshot {
  phase: CodeSessionPhase;
  transportState: TransportState;

  /**
   * True while the user-initiated interrupt round-trip is in flight —
   * set when `interrupt()` is dispatched during an active turn and
   * cleared when the matching `turn_complete` (or terminal phase
   * change) lands. The Z2 status-row indicator promotes its dot to
   * "caution" + ring-pulse while this is true so the user can see
   * their stop request hasn't been lost between request and ack.
   */
  interruptInFlight: boolean;

  tugSessionId: string;
  displayLabel: string;
  /**
   * The `"new" | "resume"` discriminator carried on the per-card
   * `CardSessionBinding` and threaded onto the snapshot so pure
   * derivations can branch on the user's intent at session-open
   * time. Stable for the lifetime of the store — the mode is captured
   * once at construction from the binding `cardServicesStore` reads
   * and never changes thereafter; a re-bind (close + reopen) builds
   * a fresh services bag with a fresh store.
   *
   * Consumed today by `deriveSessionCardBannerSpec` to suppress the
   * "Loading session…" banner during the JSONL replay round-trip
   * for new sessions (where there is no JSONL to replay). Branch 1
   * (the cold-boot preflight beat) is gated upstream — only resume
   * mode triggers `notifyResumeBindingLanded()` — so the helper
   * does not need to read `sessionMode` to keep that branch
   * resume-only.
   */
  sessionMode: CardSessionMode;

  /**
   * Committed turns this resume requested: the default window, or deeper for
   * a faithful restore to a saved anchor parked above it. The load bar reads
   * this as the restore progress denominator (turns committed of turns
   * requested), so it reflects the real load size, not a fixed default.
   * Constant for the store's life (set at construction from the resume
   * request). Turns are the canonical unit (`tuglaws/turn-metric.md`).
   */
  restoreWindowTurns: number;

  activeMsgId: string | null;
  canSubmit: boolean;
  canInterrupt: boolean;
  pendingApproval: ControlRequestForward | null;
  pendingQuestion: ControlRequestForward | null;
  /**
   * A question raised from outside the turn stream — a command-line tool asking
   * for consent before it does something disruptive, delivered over `/api/ask`.
   *
   * Unlike `pendingApproval` / `pendingQuestion`, this does not come from the
   * turn stream and does not belong to any turn: one usually arrives while the
   * session sits idle. It therefore drives a lifecycle *overlay* and leaves
   * `phase`, `canSubmit`, and `canInterrupt` alone — the composer stays live
   * while the dialog is up.
   */
  pendingAsk: PendingAsk | null;
  /**
   * User messages submitted while a turn was running, in submit order
   * — the reducer's FIFO of held sends, drained head-first on each
   * `turn_complete(success)`. Empty between turns and whenever nothing
   * is queued. The transcript paints one ghost row per entry; consumers
   * needing only the count read `.length`.
   *
   * The reducer rebuilds the array only on enqueue / flush / clear, so
   * the reference is `Object.is`-stable across quiescent snapshot
   * rebuilds ([L02]).
   */
  queuedSends: ReadonlyArray<QueuedSend>;

  transcript: ReadonlyArray<TurnEntry>;

  /**
   * Lazily-fetched, session-cached per-turn diff-stat previews for the
   * `/rewind` sheet ([#step-7-3]), keyed by `promptUuid`. The reducer is the
   * sole writer (folding `rewind_preview_result` frames); the sheet reads it
   * via the store snapshot ([L02]). Empty until the sheet requests a preview.
   * Reference-stable across dispatches that don't touch it.
   */
  rewindPreviews: ReadonlyMap<string, RewindTurnPreview>;

  /**
   * The most recent applied-rewind ack ([#step-7-3]) — `null` until a
   * `session_rewind` completes. The sheet observes the transition to dismiss
   * on success (and rebind the card on a fork). Carries its `promptUuid` so a
   * stale ack from a prior rewind can be told apart from the current one.
   */
  lastRewindResult: RewindResultAck | null;

  /**
   * The in-flight turn — set the moment `send()` (or
   * `handleWakeStarted`) opens a turn and cleared exactly when the
   * matching `TurnEntry` commits to `transcript`
   * (`turn_complete(success)` / `turn_complete(error)` / interrupt).
   *
   * Drives every in-flight row in the Session card transcript: the data
   * source iterates `activeTurn.messages` the same way it iterates
   * `turn.messages` for committed turns — one substrate, two lifecycle
   * slots ([D07]).
   *
   * The reference is rebuilt on every state-changing reducer tick that
   * touches the in-flight turn (text delta, tool result, new Message
   * mint) per [D07]'s copy-on-write mutation discipline. Quiescent
   * dispatches reuse the prior reference so `useSyncExternalStore`
   * consumers ([L02]) get `Object.is` stability.
   */
  activeTurn: ActiveTurnSnapshot | null;

  /**
   * One-shot restore slot — carries a prompt (text + atoms) the
   * prompt-entry editor can seed back into its document for re-edit.
   * Two paths populate it:
   *
   *   - **CASE A interrupt** — the user pulls a turn back before any
   *     answer-channel content has begun (`firstAssistantDeltaAt ===
   *     null && firstToolUseAt === null`; thinking does not cross the
   *     line). `handleInterrupt` captures the in-flight `user_message`
   *     here, clears the in-flight turn and the queue, and returns
   *     `phase` to `idle`.
   *   - **Queued-send cancel** — `cancelQueuedSend` un-sends one
   *     never-dispatched queued submission and routes its prompt here.
   *
   * Consumed by the prompt entry via
   * {@link CodeSessionStore.consumePendingDraftRestore} once it has
   * applied the restore — and only when the editor is empty, so a
   * cancel never clobbers in-progress content. The consume call is
   * what transitions this slot back to `null`; until then it survives
   * subsequent snapshot rebuilds so a remount or late mount of the
   * prompt entry still picks it up.
   *
   * The reference is preserved across snapshot rebuilds while the slot
   * is non-null so `useSyncExternalStore` consumers ([L02]) get
   * `Object.is` stability — a `useLayoutEffect` keyed on the slot's
   * identity fires once per restore, not on every parent render.
   *
   * The wire's `turn_complete(error)` that arrives after a CASE A
   * interrupt round-trip does NOT clear or repopulate this slot — the
   * reducer's `pendingCaseAEchoes` gate suppresses that echo and skips
   * appending a transcript entry, so a CASE A interrupt produces zero
   * `TurnEntry` regardless of the wire echo's timing.
   */
  pendingDraftRestore: {
    text: string;
    atoms: ReadonlyArray<AtomSegment>;
  } | null;

  /**
   * A click on a known slash command in the transcript parks it here for
   * the prompt entry to seed as a ready-to-run command draft. `name` is
   * the bare command name (no leading slash — the value an editor command
   * atom carries); `args` is the trailing argument text (`""` when none).
   * Set by {@link CodeSessionStore.insertCommandDraft}, cleared by
   * {@link CodeSessionStore.consumePendingCommandInsert} once the prompt
   * entry has seeded the editor. Survives snapshot rebuilds until consumed
   * (like {@link pendingDraftRestore}) so a late- or re-mounted prompt
   * entry still picks it up.
   */
  pendingCommandInsert: {
    name: string;
    args: string;
  } | null;

  /**
   * A jot dragged from the Jots card onto (or double-clicked into) the prompt
   * entry parks its text here for the entry to insert. `at` is the drop point
   * in client coordinates (resolved to a document offset), or `null` for
   * append semantics. Set by {@link CodeSessionStore.insertJot}, cleared
   * by {@link CodeSessionStore.consumePendingJotInsert} once inserted.
   * Survives snapshot rebuilds until consumed so a re-mounted entry still
   * picks it up.
   */
  pendingJotInsert: {
    text: string;
    at: { x: number; y: number } | null;
  } | null;

  /**
   * An atom the transcript asked the composer to carry — a file annotation
   * inserted as an atom rather than as its path text. Set by
   * {@link CodeSessionStore.insertAtomDraft}, cleared by
   * {@link CodeSessionStore.consumePendingAtomInsert} once the prompt entry
   * has inserted it. Survives snapshot rebuilds until consumed so a re-mounted
   * entry still picks it up.
   */
  pendingAtomInsert: AtomSegment | null;

  lastCost: CostSnapshot | null;
  /**
   * Live API-retry announcement, or `null` when no retry is in flight.
   * Set from an `api_retry` frame and cleared at the next turn boundary.
   * The session-card banner derives its tone + countdown from this.
   */
  apiRetry: ApiRetryState | null;
  /**
   * Most recent model-refusal fallback, or `null`. Set from a
   * `model_refusal_fallback` frame and cleared at the next turn boundary;
   * the transient-notice surface shows it as a one-shot bulletin.
   */
  refusalFallback: RefusalFallbackState | null;
  /**
   * True when the latest turn's output was truncated at the token ceiling
   * (`stop_reason: "max_tokens"`). Set per-turn, cleared at the boundary; the
   * transient-notice surface shows it as a one-shot bulletin.
   */
  outputTruncated: boolean;
  /**
   * The most recent forward-incompatible `unknown_event`, or `null` when
   * none has arrived. Drives the lowest-precedence soft warn banner;
   * dismissed by `at`, so a fresh unknown type re-raises.
   */
  unknownEvent: UnknownEventState | null;
  /**
   * The latest compaction's summary: the transcript renders a carry-forward
   * summary block (`summary` body, `preTokens` label when latched). Set by a
   * native `compact_summary` frame or the legacy seed-block replay path;
   * latest-wins. `null` for uncompacted sessions.
   */
  compactionSeed: {
    summary: string;
    preTokens: number | null;
  } | null;
  /**
   * Tool calls denied during this session — by a permission rule or the
   * auto-mode classifier — accumulated across turns from each `cost_update`'s
   * `permission_denials`, most-recent last, deduped by `toolUseId`. Feeds the
   * session card's `/permissions` Recently-denied tab. Empty until a denial lands;
   * runtime-only (not persisted), so a fresh / resumed session starts empty.
   */
  permissionDenials: readonly PermissionDenial[];
  /**
   * `window(0)` — the resident context before any turn (system prompt
   * + tools + agents + memory + skills). Captured by the reducer as
   * the `observedInput` of the session's first telemetry iteration
   * (first `streaming_usage` frame; first `cost_update` as fallback)
   * and never overwritten. `null` until the first frame lands.
   *
   * The transcript window-walk uses it as the prior window for turn 1,
   * so `sessionInitTokens + Σ perTurn = window(latest)` telescopes
   * exactly. Persisted via `TurnTelemetry` so a resumed session
   * restores it.
   */
  sessionInitTokens: number | null;
  /**
   * Most-recent `/context`-style per-category token breakdown for this
   * session. Populated by `context_breakdown` events from tugcode
   * (live path) and by the supervisor's bind-time attach from the
   * persisted `context_breakdown_latest` ledger row (resume path).
   * `null` until the first frame lands — the popover renders its
   * 20.4.7.C `cost_update`-derived fallback view in that case.
   *
   * The reference is preserved across snapshot rebuilds while the
   * reducer's underlying field doesn't change — `useSyncExternalStore`
   * consumers ([L02]) get `Object.is` stability during quiescent
   * renders.
   */
  lastContextBreakdown: ContextBreakdownSnapshot | null;
  lastError: {
    cause:
      | "session_state_errored"
      | "transport_closed"
      | "wire_error"
      | "session_unknown"
      | "session_not_owned"
      | "resume_failed";
    message: string;
    at: number;
  } | null;

  /**
   * Outcome of the most recent JSONL replay window. `null` until the
   * first `replay_complete` lands; populated on every
   * `replay_complete` thereafter — including the success path
   * (`kind: "success"`, empty `message`) so telemetry / dev-surface
   * readers can distinguish a clean replay from each error variant by
   * `kind` alone.
   *
   * The `SessionRestoring` placeholder reads this for the timeout-state
   * copy (`kind === "replay_timeout"`); cleared back to `null` on the
   * next `replay_started` so the field always reflects the most
   * recent window's outcome rather than accumulating history.
   */
  lastReplayResult: LastReplayResult | null;

  /**
   * MONOTONIC: has any replay window ever closed on this store?
   * Unlike `lastReplayResult` (cleared when the next window opens),
   * this never resets. Distinguishes the INITIAL resume replay
   * (transcript not yet reconstructed) from a later reconnect
   * catch-up window — consumers like the transcript host's
   * deferred-content hold key off it.
   */
  replayEverCompleted: boolean;

  /**
   * Recency-window metadata from the most recent `replay_complete`:
   * which slice of the session is loaded and whether older turns remain
   * to page in. `null` until a windowed replay completes (a full /
   * legacy replay reports no window). The transcript derives the "load
   * previous" affordance from `hasOlder`.
   */
  replayWindow: ReplayWindowMeta | null;

  /**
   * Wall-clock (epoch ms) of the session's first real turn — when the
   * conversation began. Session-level (unlike {@link replayWindow}, it is
   * NOT null on a full load): every success `replay_complete` carries it,
   * windowed or not, and a backward-paging bracket reports the same value,
   * so once known it is stable. `null` until the first replay completes,
   * or if no entry carried a parseable timestamp. The dev transcript's
   * permanent Z0 strip renders it as "Session created".
   */
  sessionCreatedAtMs: number | null;

  /**
   * True while a load-previous (older-range) replay bracket is in flight
   * — from the `begin_load_previous` dispatch (the instant the user
   * activates "load previous") until its `replay_complete` (commit or
   * abort). Drives the load-previous modal sheet's lifetime and hides
   * the affordance during the load. Mirrors the reducer's internal
   * `replayPrependActive`.
   */
  loadingPrevious: boolean;

  /**
   * Determinate progress for the in-flight load-previous, in **turns**:
   * `loadingPreviousLoaded` of `loadingPreviousTarget`. Both `0` when no
   * load is in flight. Drives the load sheet's progress bar in the same
   * "N of M" form as the initial restore sheet.
   */
  loadingPreviousTarget: number;
  loadingPreviousLoaded: number;

  /**
   * True from the moment a resume binding is acknowledged via
   * `CodeSessionStore.notifyResumeBindingLanded()` until the *first
   * of*: `phase` becomes `"replaying"`, `lastReplayResult` lands,
   * `transportState` changes away from `"online"`, or
   * `REPLAY_PREFLIGHT_TIMEOUT_MS` elapses. Drives the cold-boot
   * preflight banner copy that bridges the wait between binding
   * rehydrate and the first `replay_started` event.
   */
  replayPreflightActive: boolean;

  /**
   * True after `REPLAY_SOFT_BUDGET_MS` while `phase === "replaying"`
   * without leaving the phase. Reset when phase leaves replaying
   * (or on the next `replay_started`). Drives count-aware banner
   * copy per [D10] — the banner can promote from generic
   * "Loading session…" to "Loading session… (N turns)"
   * once the user has been waiting long enough that progress detail
   * is reassuring rather than noisy.
   */
  replaySoftBudgetElapsed: boolean;

  /**
   * True for `REPLAY_TIMEOUT_DWELL_MS` after `phase` transitions out
   * of `"replaying"` while `lastReplayResult.kind === "replay_timeout"`.
   * Drives the timeout-state banner copy. The dwell exists so the
   * timeout reason has a moment to register with the user before
   * the banner dismisses.
   */
  replayTimeoutDwellActive: boolean;

  /**
   * Closed awaiting-approval intervals observed within the current
   * in-flight turn, as `[startMs, endMs]` pairs in chronological order.
   * Cleared at every new turn start (`send`); appended to whenever a
   * dialog (permission or question) closes. Sits alongside the scalar
   * `TurnEntry.awaitingApprovalMs` accumulator — the array is the
   * authoritative shape for live-derivation (it can be unioned with
   * the other yellow axes' intervals to correctly handle overlap),
   * while the scalar continues to drive the committed entry.
   *
   * Reference is preserved across snapshot rebuilds while the array
   * doesn't change; per [L02] `useSyncExternalStore` consumers get
   * `Object.is` stability during quiescent renders.
   */
  awaitingApprovalIntervals: ReadonlyArray<readonly [number, number]>;
  /**
   * Wall-clock ms when the current awaiting-approval dialog (permission
   * or question) opened, or `null` if no dialog is open. Mirrors the
   * reducer's `awaitingApprovalSince` field under the spec's per-turn
   * vocabulary so live-derivation helpers read it under the same
   * naming as the matching intervals array.
   */
  awaitingApprovalSegmentStartedAt: number | null;
  /**
   * Closed transport-downtime intervals observed within the current
   * in-flight turn (both `offline` and `restoring` count as
   * non-online), as `[startMs, endMs]` pairs in chronological order.
   * Cleared at every new turn start (`send`); appended to whenever the
   * transport returns to `online` (`transport_settled`). Sits
   * alongside the scalar `TurnEntry.transportDowntimeMs` accumulator
   * with the same dual-source contract as
   * {@link awaitingApprovalIntervals}.
   */
  transportDowntimeIntervals: ReadonlyArray<readonly [number, number]>;
  /**
   * Wall-clock ms when the transport first left `online` (to
   * `offline` or `restoring`), or `null` while online. Mirrors the
   * reducer's `transportNonOnlineSince` under the spec's per-turn
   * vocabulary.
   */
  transportDowntimeSegmentStartedAt: number | null;
  /**
   * Closed interrupt-in-flight intervals observed within the current
   * turn, as `[startMs, endMs]` pairs. In practice each turn carries
   * at most one such interval — the user presses Stop once and the
   * subsequent `turn_complete` ends both the segment and the turn —
   * so the array's length is usually 0 (no interrupt happened) or 1
   * (CASE B interrupt ran to completion). The array shape is uniform
   * with the other two axes so {@link deriveInflightActiveMs} can
   * union them generically.
   */
  interruptInFlightIntervals: ReadonlyArray<readonly [number, number]>;
  /**
   * Trigger metadata for the in-flight wake turn (`phase === "waking"`),
   * `null` otherwise. Populated by `handleWakeStarted` from the wire
   * `wake_started.wake_trigger` payload and cleared by
   * `handleTurnComplete`'s `waking → idle` commit branch.
   *
   * Slice 1 has no React consumers. The reference is preserved across
   * snapshot rebuilds while the underlying reducer field doesn't change,
   * so future `useSyncExternalStore` consumers ([L02]) get `Object.is`
   * stability during quiescent renders.
   */
  wakeTrigger: WakeTrigger | null;
  /**
   * Session-lifetime background-jobs ledger — the Z2 JOBS cell's
   * feed. Rows accumulate across turns and survive turn commits;
   * cleared by session reset or the user's explicit Clear (terminal
   * rows only). The reference is passed through from the reducer
   * unchanged so identity is stable across quiescent snapshot
   * rebuilds ([L02]). Read via `useJobsState`.
   */
  jobs: ReadonlyArray<JobItem>;
  /**
   * The session's one `/goal`, or null — reduced from `/goal …`
   * submissions, `goal_feedback` frames, and the goal cycle's commit
   * (see `select-goal.ts`). Live-only: replay never populates it. The
   * reference passes through from the reducer unchanged for `Object.is`
   * stability across quiescent rebuilds ([L02]). Read via `useGoalState`.
   */
  goal: GoalState | null;
  /**
   * Wall-clock ms when the user-initiated interrupt round-trip
   * started (`interrupt()` from a content-bearing phase — CASE B), or
   * `null` while no interrupt is in flight. Mirrors the semantics of
   * the existing `interruptInFlight` boolean (which is the latched
   * state); this field is the entry-side timestamp the live-clock
   * helper uses to compute the open-segment duration.
   */
  interruptInFlightSegmentStartedAt: number | null;
}

/**
 * Result of the most recent JSONL replay window. Each `kind` value
 * matches the wire-side `replay_complete.error.kind` enum exactly,
 * plus a `"success"` value that the wire never sets (it is inferred
 * client-side when `replay_complete` arrives without an `error`
 * payload).
 */
export interface LastReplayResult {
  kind:
    | "success"
    | "jsonl_missing"
    | "jsonl_unreadable"
    | "jsonl_malformed"
    | "replay_timeout";
  /** Human-readable detail; empty string on the success path. */
  message: string;
  /** Number of turns committed during this replay window. */
  count: number;
  /** `Date.now()` at the moment `replay_complete` landed. */
  at: number;
}

/**
 * Recency-window metadata from the most recent `replay_complete` — which
 * slice of the session is currently loaded. `null` until a windowed
 * replay completes (a full / legacy replay reports no window). Drives the
 * "load previous" affordance and faithful restore.
 */
export interface ReplayWindowMeta {
  /**
   * Absolute index (counting from the oldest committed turn) of the
   * oldest turn currently loaded. `0` means the very first turn is
   * loaded. The boundary for the next backward-paging request, and the
   * base the transcript adds to a row's window-relative turn index so each
   * row is addressed by its true session turn, not its position within the
   * loaded slice.
   */
  firstLoadedTurnIndex: number;
  /** The whole session's committed-turn count, independent of the window. */
  totalTurns: number;
  /** Whether any turns precede the loaded window (older turns to page in). */
  hasOlder: boolean;
}
