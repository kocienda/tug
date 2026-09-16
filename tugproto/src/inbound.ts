/**
 * tugproto/inbound — the client → tugcode CODE_INPUT message contract,
 * authored ONCE and imported by both tugdeck (the sender) and tugcode (the
 * receiver) ([#step-13c1]).
 *
 * Before this module the contract was authored twice — `tugdeck/protocol.ts`
 * and `tugcode/types.ts` — and tugcode mirrored the verb set in three more
 * places (the `isInboundMessage` allowlist, a per-type guard, and a hand-
 * written branch in `main.ts`'s dispatch). A missed allowlist edit was a
 * *silent* failure ("Invalid message type", the sheet hangs). Here the verb
 * vocabulary is one list ({@link INBOUND_VERBS}); `isInboundMessage` and the
 * tugcode dispatch registry derive from it, so adding a verb can't drift.
 *
 * `tugproto` is a source-only shared dir at the repo root — no build, no
 * publish. Both bundlers resolve it via the `@tugproto/*` path alias (tsconfig
 * `paths` for both; an extra Vite `resolve.alias` for tugdeck). Pure types +
 * pure runtime helpers — no React, no DOM, no Node/Bun API.
 *
 * **Payload strictness.** Where the two sides historically diverged, this
 * module uses the SENDER-permissive type so neither side breaks: `mode` is a
 * bare `string`, `answers` is `Record<string, unknown>`, `updatedInput` is
 * `unknown`. The receiver (tugcode) narrows at its handler boundary — the
 * correct place to validate JSON off the wire.
 *
 * @module tugproto/inbound
 */

// ---------------------------------------------------------------------------
// Content blocks — the Anthropic content-block wire shape carried on
// `user_message`. tugcode forwards `content` verbatim to the Agent SDK.
// ---------------------------------------------------------------------------

export interface ContentBlockText {
  type: "text";
  text: string;
}

export interface ContentBlockImageSourceBase64 {
  type: "base64";
  media_type: string;
  data: string;
}

export interface ContentBlockImage {
  type: "image";
  source: ContentBlockImageSourceBase64;
}

export type ContentBlock = ContentBlockText | ContentBlockImage;

// ---------------------------------------------------------------------------
// Per-verb payload interfaces
// ---------------------------------------------------------------------------

/** Handshake: the client announces its protocol version on connect. */
export interface ProtocolInit {
  type: "protocol_init";
  version: number;
}

/** A user turn — an Anthropic content-block array forwarded to the SDK. */
export interface UserMessage {
  type: "user_message";
  content: ContentBlock[];
}

/** Approve / deny a pending `can_use_tool` permission request. */
export interface ToolApproval {
  type: "tool_approval";
  request_id: string;
  decision: "allow" | "deny";
  /** On allow: optional override of the tool input. */
  updatedInput?: Record<string, unknown>;
  /** On deny: a human-readable reason. */
  message?: string;
  /** On allow: the SDK `PermissionUpdate[]` durable-scope suggestion, opaque. */
  updatedPermissions?: unknown[];
}

/**
 * Answer a pending `AskUserQuestion`. Two mutually-exclusive outcomes:
 *  - Answer the questions: `answers` maps question text → the chosen option
 *    label (free text rides here too, as a verbatim string).
 *  - Decline (`Chat about this`): `response` carries a freeform reply and
 *    `answers` is omitted. tugcode resolves the tool with the reply (distinct
 *    from an interrupt). See `tugcode/control.ts` `formatQuestionAnswer`.
 */
export interface QuestionAnswer {
  type: "question_answer";
  request_id: string;
  answers?: Record<string, string>;
  /** Decline path: a freeform reply that resolves the tool instead of answering. */
  response?: string;
}

/**
 * Interrupt the in-flight turn.
 *
 * `retract` marks a pull-back: the user cancelled their submission before
 * claude produced any answer content (the reducer's CASE A pull-down), so
 * the prompt must leave the conversation entirely — not just stop it.
 * Claude's SDK persists the prompt to the session JSONL on receipt and its
 * `interrupt` verb keeps it in history (appending an
 * `"[Request interrupted by user]"` marker), so tugcode honors `retract` by
 * truncating the session JSONL at the prompt's record and silently
 * respawning `--resume` once the interrupt's `result` echo lands — the same
 * in-place conversation-rewind path as `session_rewind`. Absent/false ⇒ a
 * plain stop (CASE B), which keeps the turn in history.
 */
export interface Interrupt {
  type: "interrupt";
  retract?: boolean;
}

/** The session permission modes claude accepts. */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "auto"
  | "dontAsk"
  | "delegate";

/** Set the session permission mode. */
export interface PermissionModeMessage {
  type: "permission_mode";
  mode: PermissionMode;
}

/** Switch the active model. */
export interface ModelChange {
  type: "model_change";
  model: string;
}

/**
 * Set the reasoning-effort level ([#step-4]). claude has no live effort control
 * subtype, so tugcode applies it by respawning with `--effort` + `--resume`.
 */
export interface EffortChange {
  type: "effort_change";
  effort: string;
}

/**
 * Add a working directory ([#step-13c]). Like `effort_change`, claude exposes
 * no live add-directory verb over the bridge, so tugcode respawns claude with
 * the dir in `--add-dir` (+ `--resume`).
 */
export interface AddDirectory {
  type: "add_directory";
  directory: string;
}

/**
 * What a fresh session is *for*, when the server-driven arc starts it rather
 * than the user.
 *
 * Present only on a rotation tugcast originates: a plain `/new` from the deck
 * carries no stage, and must stay byte-identical on the wire.
 */
export interface SessionStageSpec {
  /**
   * The stage label. `devise` / `review` / `implement` are the arc's three;
   * any other word is a rotation no arc is driving, and the transcript's
   * divider renders whatever it is given.
   */
  name: string;
  /**
   * The document the arc opened on, repo-relative. Absent on a rotation with
   * no arc behind it, and the divider omits it rather than showing a blank.
   */
  document?: string;
  /** The plan the stage drives, once one exists. */
  plan?: string;
  /**
   * The arc this rotation belongs to — what the stage's claude reads as
   * `TUG_ARC`. **Absent is what clears it**: a rotation carrying no `arc`
   * spawns claude with no arc variable at all, which is how a rotation with
   * no arc behind it tells the stage skills that nothing is driving them.
   */
  arc?: string;
  /**
   * The reasoning effort the fresh session runs at. Applied before the spawn,
   * so the level rides that one spawn instead of costing a second respawn
   * through an effort change behind it. Absent leaves the level as it is.
   */
  effort?: string;
  /**
   * The inclusive step range a *continued* implement stage walks, spelled
   * `N-M` ([P07]). Present only on a rotation the runner composed from a
   * measured context reading at a step boundary; absent on every other stage,
   * which is what tells a continued stage from a first one.
   *
   * Echoed on the rotation's `session_segment` announcement so the transcript's divider can
   * read `implement, continued · steps N–M` ([B13]) without re-deriving a range
   * the runner already computed.
   */
  steps?: string;
  /**
   * The stage's opening prompt — the `user_message` the runner sends right
   * behind this command. Echoed on the rotation's `session_segment` announcement so the
   * deck can open the turn it is about to watch: a turn nobody in the deck
   * submitted has no pending turn there, and the reducer drops every frame
   * of a turn it did not open.
   */
  prompt?: string;
}

/** Fork / continue / new the conversation ([D10]). */
export interface SessionCommand {
  type: "session_command";
  command: "fork" | "continue" | "new";
  /**
   * Set by an arc rotation on `command: "new"`, announcing the fresh session
   * as a stage rather than a stranger. Absent on every deck-originated
   * command.
   */
  stage?: SessionStageSpec;
}

/** Stop a running subagent task. */
export interface StopTask {
  type: "stop_task";
  task_id: string;
}

/**
 * End every piece of work the session's claude is doing — its background
 * tasks, its scheduled wakes, and every process in its group — and respawn
 * it `--resume` so the card stays bound ([P04]).
 *
 * `task_ids` are the jobs tugcast's supervisor holds open for this session;
 * tugcode keeps no open-job set of its own, so the ids ride the verb and each
 * gets a best-effort `stop_task` before the group is reaped ([P12]). tugcode
 * answers with `stop_all_work_done { tug_session_id }` once the respawn's
 * handshake acks — the frame the supervisor's quiet wait turns on.
 */
export interface StopAllWork {
  type: "stop_all_work";
  task_ids: string[];
}

/**
 * A recency window for a replay request, expressed entirely in turns
 * (the canonical unit — see `tuglaws/turn-metric.md`). Bounds the replay
 * to a turn range so a long session loads only the most relevant tail
 * rather than the whole transcript:
 *
 *   - `{ lastTurns: N }` — the most recent N committed turns: the default
 *     cold-resume load. Bounds the load by intent, independent of turn
 *     density.
 *   - `{ turnRange: [start, end) }` — an explicit half-open turn-index
 *     range (the general form). Backward paging ("load previous") sends
 *     `[firstLoadedTurnIndex − N, firstLoadedTurnIndex]` — the N turns
 *     immediately older than the current oldest-loaded turn, which prepend
 *     above the view.
 *
 * Absent ⇒ load the whole session (the legacy, unbounded behavior).
 */
export type ReplayWindow =
  | { lastTurns: number }
  | { turnRange: [number, number] };

/**
 * One session in a replay's lineage — a stage of an arc, or the
 * conversation the arc was handed off from.
 *
 * `stage` and its companions are absent on an entry that ran no stage (the
 * chain's head, before the arc started), which is what tells the replay
 * whether to draw a divider above that session's turns.
 */
export interface ReplayLineageEntry {
  /** Claude's own id for the session — the JSONL to replay. */
  sessionId: string;
  /** Which stage of the arc this session ran, if any. */
  stage?: string;
  /** The model selector the rotation set, or empty for the account default. */
  model?: string;
  /** The document the arc opened on, repo-relative. */
  document?: string;
  /** The name the arc is keyed by. */
  arc?: string;
}

/** Ask tugcode to replay the session JSONL ([D12]). */
export interface RequestReplay {
  type: "request_replay";
  /**
   * Optional recency window. When present, tugcode translates and
   * emits only the requested turn range and reports the window in
   * `replay_complete` (`firstLoadedTurnIndex` / `totalTurns` /
   * `hasOlder`). Absent ⇒ the full session (backward-compatible).
   */
  window?: ReplayWindow;
  /**
   * Optional ordered lineage — oldest ancestor first, the session being
   * resumed last. Present only for an arc, whose stages each own their
   * own JSONL: tugcode replays each in order, emitting a stage divider at
   * every boundary, so a relaunched card re-renders the whole arc rather
   * than only its last stage ([P10]).
   *
   * Absent ⇒ replay this session alone, which is byte-identical to the
   * behavior before lineage existed. The `window` applies to the session
   * being resumed; the ancestors replay whole. A `turnRange` window is a
   * backward page over a transcript the ancestors are already in, so tugcode
   * ignores the lineage there and emits the tip's older turns alone.
   */
  lineage?: ReplayLineageEntry[];
}

/**
 * Abort the in-flight replay (the user cancelled a load-previous / load-all
 * before it finished). tugcode stops pulling the translator at its next
 * time-slice yield and closes the bracket with `replay_complete{aborted:true}`,
 * so the client discards the partial older batch and leaves the prior
 * loaded window intact. A no-op when no replay is in flight.
 */
export interface CancelReplay {
  type: "cancel_replay";
}

/**
 * `/rewind` diff-stat preview ([#step-7-1]). `promptUuid` is claude's
 * user-prompt-record uuid — the rewind anchor, not the session-card `msgId`.
 */
export interface RewindPreview {
  type: "rewind_preview";
  promptUuid: string;
}

/**
 * Apply a `/rewind` ([#step-7-1]/[#step-7-2]). `scope` selects the dimension(s);
 * `fork` (conversation/both only) selects a forked copy over destructive
 * in-place.
 */
export interface SessionRewind {
  type: "session_rewind";
  promptUuid: string;
  scope: "conversation" | "code" | "both";
  fork?: boolean;
}

/** Request the `/skills` inventory ([#step-12d]); answered by `request_id`. */
export interface SkillsInventoryQuery {
  type: "skills_inventory_query";
  request_id: string;
}

/** Request the `/hooks` inventory ([#step-12c]); answered by `request_id`. */
export interface HooksQuery {
  type: "hooks_query";
  request_id: string;
}

/**
 * Ask a `/btw` side question — a one-shot query answered from the live
 * conversation with no tools, never entering history. tugcode forwards it as
 * a `control_request { subtype: "side_question", question }` on Claude's
 * stdin; the reply comes back as a `side_question_answer` frame keyed by
 * `request_id`. Works idle or mid-turn (the control-request round-trip is
 * turn-state-independent).
 */
export interface SideQuestion {
  type: "side_question";
  request_id: string;
  question: string;
}

// ---------------------------------------------------------------------------
// The union + the verb vocabulary (single source of truth)
// ---------------------------------------------------------------------------

/** Every message the client can send to tugcode over CODE_INPUT. */
export type InboundMessage =
  | ProtocolInit
  | UserMessage
  | ToolApproval
  | QuestionAnswer
  | Interrupt
  | PermissionModeMessage
  | ModelChange
  | EffortChange
  | AddDirectory
  | SessionCommand
  | StopTask
  | StopAllWork
  | RequestReplay
  | CancelReplay
  | RewindPreview
  | SessionRewind
  | SkillsInventoryQuery
  | HooksQuery
  | SideQuestion;

/**
 * The canonical list of inbound verb names — the ONE place the verb set is
 * declared. `isInboundMessage` and tugcode's dispatch registry derive from it,
 * so a new verb is admitted/dispatched by adding it here (+ its payload type +
 * the union member above), never by editing a separate allowlist. Keep in sync
 * with {@link InboundMessage} (co-located, one file).
 */
export const INBOUND_VERBS = [
  "protocol_init",
  "user_message",
  "tool_approval",
  "question_answer",
  "interrupt",
  "permission_mode",
  "model_change",
  "effort_change",
  "add_directory",
  "session_command",
  "stop_task",
  "stop_all_work",
  "request_replay",
  "cancel_replay",
  "rewind_preview",
  "session_rewind",
  "skills_inventory_query",
  "hooks_query",
  "side_question",
] as const satisfies ReadonlyArray<InboundMessage["type"]>;

/** A recognized inbound verb name. */
export type InboundVerb = (typeof INBOUND_VERBS)[number];

const INBOUND_VERB_SET: ReadonlySet<string> = new Set(INBOUND_VERBS);

/** Whether `name` is a recognized inbound verb. */
export function isInboundVerb(name: string): name is InboundVerb {
  return INBOUND_VERB_SET.has(name);
}

/**
 * Whether `msg` is a recognized inbound message — an object whose `type` is a
 * known verb. Derived from {@link INBOUND_VERBS}, so the allowlist can't drift
 * from the verb set. Per-payload field validation is the receiver's job (it
 * narrows the discriminated union in the handler).
 */
export function isInboundMessage(msg: unknown): msg is InboundMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const type = (msg as { type?: unknown }).type;
  return typeof type === "string" && isInboundVerb(type);
}
