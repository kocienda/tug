/**
 * tugproto/control — the CONTROL request actions the deck sends, as one list.
 *
 * Every CONTROL frame the deck builds names its `action` from
 * {@link ControlAction}, so a misspelled or retired action is a type error
 * rather than a frame tugcast silently re-broadcasts. tugcast's side of the
 * same vocabulary is the `ControlAction` enum in
 * `tugrust/crates/tugcast-core/src/control.rs`, and a tugcast-core unit test
 * reads {@link CONTROL_ACTIONS} below as text and compares the two sets — so
 * keep it one string literal per line.
 *
 * Pure constants — no React, no DOM, no Node/Bun API.
 *
 * @module tugproto/control
 */

/** Every CONTROL action the deck sends. */
export const CONTROL_ACTIONS = [
  // Router-internal: answered on the connection, never forwarded.
  "subscribe_feeds",

  // Supervisor: session lifecycle.
  "spawn_session",
  "close_session",
  "reset_session",
  "list_sessions",
  "list_card_bindings",
  "resolve_sessions",
  "request_replay",

  // Supervisor: arcs.
  "bind_arc",
  "arc_resume",
  "arc_run",
  "arc_stop",
  "unbind_arc",

  // Supervisor: changesets, landings and joins.
  "changeset_git_init",
  "changeset_commit",
  "changeset_push",
  "changeset_claim",
  "changeset_disclaim",
  "changeset_refresh",
  "changeset_draft_request",
  "changeset_draft_cancel",
  "changeset_draft_set",
  "landing_receipt",
  "changeset_join",
  "changeset_join_resolve",
  "changeset_join_resolve_base",
  "changeset_join_resolve_base_undo",
  "changeset_join_question_answer",
  "changeset_discard",
  "changeset_delete_documents",
  "changeset_replay",

  // Supervisor: deck placement.
  "deck_seatings",
  "deck_log",

  // Supervisor: session rows.
  "trash_session",
  "rename_session",
  "set_session_private",
  "trash_project_dir_sessions",

  // Supervisor: telemetry records and reads.
  "record_turn_telemetry",
  "record_context_breakdown",
  "record_session_state_change",
  "list_session_state_changes",
  "list_digest_lines",
  "list_overview_posts",
  "list_shell_exchanges",
  "list_refs",

  // `dispatch_action`: replies to a `/api/eval` or an ask, settled by id.
  "eval-response",
  "ask-response",

  // `dispatch_action`: host, auth, and Claude Code installation.
  "check_auth",
  "check_host_tools",
  "offer_host_tools",
  "install_claude",
  "claude_download_resume",
  "claude_download_pause",
  "claude_download_cancel",
  "check_claude_version",
  "update_claude",
  "claude_sign_in",
  "claude_logout",
] as const;

/** A CONTROL request action the deck may send. */
export type ControlAction = (typeof CONTROL_ACTIONS)[number];
